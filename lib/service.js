/**
 * The Host half of the self-installation plugin manager.
 *
 * One implementation serves the Settings tab and, through the same methods, any
 * other caller the Gateway admits. Everything the tab renders is computed here
 * from the plugin manager's own recorded state; the Client only projects.
 *
 * @module dsh-self-plugin-manager/service
 */

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Service } from '@deepseek-ai/cordis'
import { bindTypertRemote } from '@deepseek-ai/dsh-typert-protocol'
import { evaluateGate, readGateState } from './gate.js'
import { jsonSafe } from './json-safe.js'
import {
  REGISTRY_LOOKUP_TIMEOUT_MS,
  classifyRegistryFailure,
  continuesToNextRegistry,
  isSafePackageName,
  parsePnpmViewVersion,
  pnpmViewInvocation,
  registryPlan,
} from './registry.js'
import { detectRuntimeVersion } from './runtime.js'
import { buildOverview, sourceKindOf, writeBlockReason } from './scan.js'
import {
  guidanceFor,
  readRollbackLog,
  recordRollbackPoint,
  rollbackLogPath,
  rollbackTargetOf,
  writeRollbackLog,
} from './update.js'
import { chooseVerificationModel, shouldAutoVerify, verificationPrompt, verificationTitle } from './verify.js'
import { NAMESPACE, markRemoteMethods } from './wire.js'

/** Effective defaults; the patch row overrides them per field. */
export const DEFAULT_SETTINGS = Object.freeze({
  writesEnabled: true,
  gateStateDir: '',
  storageDir: '',
  autoVerify: false,
  verifyModelProvider: '',
  verifyModel: '',
})

/** Directory holding the DPIP state document, relative to `$DSH_HOME`. */
export const OPERATION_SECURITY_DIR = 'operation-security'

/**
 * Host-side service published as `ctx.selfPlugins` and as the Gateway
 * namespace `selfPlugins`.
 */
export class SelfPluginsService extends Service {
  /**
   * @param ctx - owning Cordis context.
   * @param config - validated row config.
   */
  constructor(ctx, config = {}) {
    super(ctx, NAMESPACE)
    // Publish the Cordis key to the Gateway; without this the Host dispatcher
    // refuses the call as an unbound Service.
    this.typertRemote = bindTypertRemote(this, NAMESPACE)
    this.settings = { ...DEFAULT_SETTINGS, ...(config ?? {}) }
  }

  /** The plugin manager service, or `undefined` outside a profile. */
  get manager() {
    return this.ctx.get('pluginManager')
  }

  /** Launch-time profile facts, or `undefined`. */
  get profile() {
    return this.ctx.get('profileContext')
  }

  /** `$DSH_HOME` as this process resolved it. */
  home() {
    const fromProfile = this.profile?.home
    if (typeof fromProfile === 'string' && fromProfile !== '') return fromProfile
    const fromEnv = process.env.DSH_HOME
    if (typeof fromEnv === 'string' && fromEnv !== '') return fromEnv
    return join(homedir(), '.dsh')
  }

  /** Directory holding `plugin-state.json`. */
  gateDirectory() {
    const override = this.settings.gateStateDir
    if (typeof override === 'string' && override !== '') return override
    return join(this.home(), OPERATION_SECURITY_DIR)
  }

  /** Path of the rollback log. */
  logPath() {
    const override = this.settings.storageDir
    if (typeof override === 'string' && override !== '') return join(override, 'rollback.json')
    return rollbackLogPath(this.home())
  }

  /**
   * Read the profile manifest's dependency table.
   * @returns `{ dependencies, bundles, problem }`.
   */
  readProfileManifest() {
    const dir = this.profile?.dir
    if (typeof dir !== 'string' || dir === '') {
      return { dependencies: {}, bundles: [], problem: 'profile-directory-unknown' }
    }
    try {
      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
      const dependencies = manifest?.dependencies
      const bundles = manifest?.dsh?.profile?.bundles
      return {
        dependencies: dependencies !== null && typeof dependencies === 'object' ? dependencies : {},
        bundles: Array.isArray(bundles) ? bundles : [],
        problem: null,
      }
    } catch {
      return { dependencies: {}, bundles: [], problem: 'profile-manifest-unreadable' }
    }
  }

  /** Read the live inventory in one pass. */
  async readInventory() {
    const manager = this.manager
    const [bundles, plugins, exemptions] = await Promise.all([
      manager.listBundles(),
      manager.listPlugins(),
      this.readExemptions(manager),
    ])
    return { bundles: bundles ?? [], plugins: plugins ?? [], exemptions }
  }

  /**
   * Read the profile's version exemptions.
   *
   * `listVersionExemptions()` is the one member of this service whose surface is
   * **synchronous**: it returns its `{ exemptions, warnings }` object directly
   * rather than a Promise (`dsh-plugin-manager/lib/index.js`), so it has no
   * `.catch`. Reading it through an `await` accepts both shapes, which stays
   * correct whichever way the owner changes it.
   * @param manager - the plugin manager service.
   * @returns the exemption record, or `null` when it could not be read.
   */
  async readExemptions(manager) {
    try {
      return (await manager.listVersionExemptions()) ?? null
    } catch {
      // The overview stays useful without exemptions; "could not read" is
      // reported as `null` rather than as an empty record.
      return null
    }
  }

  /**
   * Read-only tab payload. Performs no network call and no state change.
   * @returns the overview view model.
   */
  async overview() {
    const manager = this.manager
    if (manager === undefined) {
      return jsonSafe({ available: false, reason: 'plugin-manager-unavailable' })
    }
    const [inventory, gate, log] = await Promise.all([
      this.readInventory(),
      Promise.resolve(readGateState({ directory: this.gateDirectory() })),
      Promise.resolve(readRollbackLog({ path: this.logPath() })),
    ])
    const manifest = this.readProfileManifest()
    const detected = detectRuntimeVersion()
    const declared =
      inventory.exemptions !== null && typeof inventory.exemptions?.runtimeVersion === 'string'
        ? inventory.exemptions.runtimeVersion
        : null
    return buildOverview({
      bundles: inventory.bundles,
      plugins: inventory.plugins,
      exemptions: inventory.exemptions,
      runtimeVersion: declared ?? detected.version,
      runtimeVersionSource: declared === null ? detected.source : 'pluginManager.listVersionExemptions',
      profileName: this.profile?.name ?? null,
      profileDependencies: manifest.dependencies,
      gate,
      rollback: { records: log.records },
      writesEnabled: this.settings.writesEnabled === true,
      config: {
        writesEnabled: this.settings.writesEnabled === true,
        autoVerify: this.settings.autoVerify === true,
        verifyModelProvider: this.settings.verifyModelProvider,
        verifyModel: this.settings.verifyModel,
        gateStateDir: this.gateDirectory(),
        logPath: this.logPath(),
        profileDir: this.profile?.dir ?? null,
        profileManifestProblem: manifest.problem,
        rollbackLogProblem: log.problem,
      },
    })
  }

  /**
   * Resolve what the registry currently offers for one bundle. One bounded
   * network question, read-only; never installs anything.
   *
   * Deliberately **not** `pluginManager.inspect()`: the Host refuses every name
   * the profile already holds (`problem: 'already-installed'`), and every bundle
   * this method can be called for is held by definition. See `lib/registry.js`.
   * @param name - bundle (package) name.
   * @returns `{ ok, name, currentVersion, latestVersion, registry }` or a refusal.
   */
  async check(name) {
    const manager = this.manager
    if (manager === undefined) return jsonSafe({ ok: false, name, reason: 'plugin-manager-unavailable' })
    const found = await this.findSelfBundle(name)
    if (!found.ok) return jsonSafe({ ok: false, name, reason: found.reason })
    if (found.sourceKind === 'local') return jsonSafe({ ok: false, name, reason: 'local-source-dependency' })
    const currentVersion = found.bundle.version ?? null
    const latest = await this.resolveLatest(name)
    if (latest.ok !== true) {
      return jsonSafe({
        ok: false,
        name,
        currentVersion,
        reason: latest.reason,
        detail: latest.detail ?? null,
        registriesAsked: latest.registries ?? [],
      })
    }
    return jsonSafe({
      ok: true,
      name,
      currentVersion,
      latestVersion: latest.version,
      registry: latest.registry ?? null,
      registriesAsked: latest.registries ?? [],
      reason: null,
      detail: null,
    })
  }

  /**
   * Install the newest registry version of one already-installed bundle.
   * @param name - bundle (package) name.
   * @param acknowledgedUncovered - must be `true` when the DPIP gate reports no
   *   completed run, which is this plugin's stand-in for the security layer's
   *   `ask` outcome.
   * @returns the change outcome.
   */
  async update(name, acknowledgedUncovered) {
    const assessment = await this.assessWrite(name, 'update')
    if (!assessment.ok) return jsonSafe(refusal('update', name, assessment.reason, assessment))
    const gateDecision = this.resolveGate(assessment, 'update', acknowledgedUncovered)
    if (gateDecision.refused !== null) {
      return jsonSafe(refusal('update', name, gateDecision.refused, assessment))
    }

    const latest = await this.resolveLatest(name)
    if (latest.ok !== true) {
      return jsonSafe(refusal('update', name, latest.reason, assessment, latest.detail ?? null))
    }

    const from = assessment.bundle.version ?? null
    const target = latest.version
    if (target === from) {
      return jsonSafe({
        ok: true,
        action: 'update',
        name,
        fromVersion: from,
        toVersion: target,
        changed: false,
        application: 'applied',
        guidance: 'already-current',
        coverage: assessment.gate.coverage,
        gateState: assessment.gate.state,
      })
    }

    // Record the rollback point BEFORE the install so a failed install is still
    // recoverable; restore the previous log when the install does not succeed.
    const previousLog = readRollbackLog({ path: this.logPath() })
    let logProblem = previousLog.problem
    try {
      writeRollbackLog({
        path: this.logPath(),
        log: recordRollbackPoint(previousLog, { name, version: from ?? '', at: nowIso() }),
      })
    } catch (error) {
      logProblem = `rollback log could not be written: ${messageOf(error)}`
    }

    const result = await this.install(name, target, assessment.bundle.enabled !== false)
    if (result.ok !== true && logProblem === null) {
      try {
        writeRollbackLog({ path: this.logPath(), log: previousLog })
      } catch {
        // Losing the log on a failed install is not worth failing the call; the
        // outcome already reports the install failure itself.
      }
    }
    const payload = outcome('update', name, from, target, result, assessment, logProblem)
    payload.verification = await this.runAutoVerification({
      name,
      fromVersion: from,
      toVersion: target,
      application: payload.application,
    })
    return jsonSafe(payload)
  }

  /**
   * Reinstall the version recorded before the last change to this bundle.
   * @param name - bundle (package) name.
   * @param acknowledgedUncovered - DPIP acknowledgement, as in {@link update}.
   * @returns the change outcome.
   */
  async rollback(name, acknowledgedUncovered) {
    const assessment = await this.assessWrite(name, 'rollback')
    if (!assessment.ok) return jsonSafe(refusal('rollback', name, assessment.reason, assessment))
    const gateDecision = this.resolveGate(assessment, 'rollback', acknowledgedUncovered)
    if (gateDecision.refused !== null) {
      return jsonSafe(refusal('rollback', name, gateDecision.refused, assessment))
    }
    const target = assessment.rollbackTarget
    if (target === null) return jsonSafe(refusal('rollback', name, 'no-rollback-point', assessment))

    const from = assessment.bundle.version ?? null
    if (target === from) {
      return jsonSafe({
        ok: true,
        action: 'rollback',
        name,
        fromVersion: from,
        toVersion: target,
        changed: false,
        application: 'applied',
        guidance: 'already-current',
        coverage: assessment.gate.coverage,
        gateState: assessment.gate.state,
      })
    }
    const result = await this.install(name, target, assessment.bundle.enabled !== false)
    const payload = outcome('rollback', name, from, target, result, assessment, null)
    payload.verification = await this.runAutoVerification({
      name,
      fromVersion: from,
      toVersion: target,
      application: payload.application,
    })
    return jsonSafe(payload)
  }

  /**
   * Start the post-change verification session, when it is switched on and the
   * change actually took effect.
   *
   * Session creation and prompting are performed on the operator's behalf, so
   * this whole path is inert unless `autoVerify` is set in the patch layer, and
   * a `restart-required` change never triggers it.
   * @param input - `{ name, fromVersion, toVersion, application }`.
   * @returns `{ started, reason?, sessionId?, title?, model?, modelSource?, detail? }`.
   */
  async runAutoVerification({ name, fromVersion, toVersion, application }) {
    const decision = shouldAutoVerify({ enabled: this.settings.autoVerify === true, application })
    if (decision.run !== true) return { started: false, reason: decision.reason }

    const sessionController = this.ctx.get('sessionController')
    if (sessionController === undefined) return { started: false, reason: 'session-controller-unavailable' }

    let sessionId
    try {
      const created = await sessionController.create({})
      sessionId = created?.sessionId
    } catch (error) {
      return { started: false, reason: 'session-create-threw', detail: messageOf(error) }
    }
    if (typeof sessionId !== 'string' || sessionId === '') {
      return { started: false, reason: 'session-create-failed' }
    }

    let model = null
    let modelSource = 'unresolved'
    let modelProblem = null
    try {
      const catalog = await sessionController.modelCatalog()
      const chosen = chooseVerificationModel({
        provider: this.settings.verifyModelProvider,
        model: this.settings.verifyModel,
        catalog,
      })
      model = chosen.selection
      modelSource = chosen.source
      if (model !== null) await sessionController.selectModel({ sessionId, ...model })
    } catch (error) {
      // The session exists and is still usable on the deployment default; a
      // failed selection must not abort the verification.
      modelProblem = messageOf(error)
    }

    const title = verificationTitle(name)
    try {
      await sessionController.rename({ sessionId, title })
    } catch {
      // A title is cosmetic; a rejected rename must not lose the session.
    }

    try {
      await sessionController.prompt(
        {
          requestId: randomUUID(),
          sessionId,
          mode: 'queue',
          content: [{ type: 'text', text: verificationPrompt({ name, fromVersion, toVersion }) }],
        },
        // `prompt(request, signal)` dereferences the signal on its first line
        // (`signal.throwIfAborted()`), so it is required, not optional.
        new AbortController().signal,
      )
    } catch (error) {
      return {
        started: false,
        reason: 'prompt-rejected',
        sessionId,
        title,
        model,
        modelSource,
        modelProblem,
        detail: messageOf(error),
      }
    }

    return { started: true, sessionId, title, model, modelSource, modelProblem }
  }

  /** Install one exact `<name>@<version>` and classify the result. */
  async install(name, version, enabled) {
    const manager = this.manager
    const spec = `${name}@${version}`
    try {
      const result = await manager.installBundle(spec, { enabled: enabled === true })
      return { ok: result?.application !== 'failed' && result?.application !== 'cancelled', result }
    } catch (error) {
      return { ok: false, result: null, detail: messageOf(error) }
    }
  }

  /**
   * Resolve one bundle's current registry version.
   *
   * The registry plan comes from the Host (`pluginManager.registries()`), so the
   * first question goes to the profile's own configured registry and the same
   * `--registry` selection applies that an install would use. Asking the next
   * registry is allowed only when the first address is public — the npm registry
   * itself, or one the deployment declared as a fallback — so a private registry
   * never leaks its package names to a public mirror.
   * @param name - bundle (package) name.
   * @returns `{ ok, version, registry, registries }` or a refusal with `reason`.
   */
  async resolveLatest(name) {
    const manager = this.manager
    if (manager === undefined) return { ok: false, reason: 'plugin-manager-unavailable', registries: [] }
    const directory = this.profile?.dir
    if (typeof directory !== 'string' || directory === '') {
      return { ok: false, reason: 'profile-directory-unknown', registries: [] }
    }
    if (!isSafePackageName(name)) return { ok: false, reason: 'invalid-package-name', registries: [] }

    let registries = null
    try {
      registries = await manager.registries()
    } catch {
      // An unreadable plan is not fatal: ask pnpm's own configured registry,
      // which is exactly what a `null` entry means.
      registries = null
    }

    const plan = registryPlan(registries)
    const asked = []
    let last = null
    for (let index = 0; index < plan.length; index += 1) {
      const registry = plan[index]
      asked.push(registry)
      const run = await this.runPnpmView(name, registry, directory)
      if (run?.spawnError !== null && run?.spawnError !== undefined && run.spawnError !== 'ENOENT') {
        return { ok: false, reason: 'registry-spawn-failed', detail: registryDetail(run), registries: asked }
      }
      const version = parsePnpmViewVersion(run?.stdout)
      if (version !== null) {
        return { ok: true, version, registry: registry ?? null, registries: asked }
      }
      const kind = classifyRegistryFailure(run)
      last = { kind, detail: registryDetail(run) }
      if (kind === 'pnpm-missing') {
        return { ok: false, reason: 'pnpm-missing', detail: last.detail, registries: asked }
      }
      if (index >= plan.length - 1 || !continuesToNextRegistry(kind)) break
    }
    return { ok: false, reason: `registry-${last?.kind ?? 'unknown'}`, detail: last?.detail ?? null, registries: asked }
  }

  /**
   * Run one registry question. This is the only process this plugin starts, and
   * it is read-only: `pnpm view` asks a registry and prints; it installs nothing
   * and writes no profile file.
   *
   * The argument vector is built by the pure `pnpmViewInvocation`, which
   * `test/registry.test.mjs` pins. `test/service.test.mjs` replaces only this
   * process boundary, so it cannot hide an argv bug.
   * @param name - validated bundle (package) name.
   * @param registry - registry to ask, or `null` for pnpm's own configuration.
   * @param directory - profile directory the command runs in.
   * @returns `{ stdout, stderr, exitCode, timedOut, spawnError, detail }`.
   */
  runPnpmView(name, registry, directory) {
    const invocation = pnpmViewInvocation(name, registry)
    return new Promise((resolve) => {
      let child
      try {
        child = spawn(invocation.command, invocation.args, {
          cwd: directory,
          shell: invocation.shell,
          env: process.env,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      } catch (error) {
        resolve(failedRun(messageOf(error)))
        return
      }

      let stdout = ''
      let stderr = ''
      let timedOut = false
      let settled = false
      let timer = null
      const finish = (outcome) => {
        if (settled) return
        settled = true
        if (timer !== null) clearTimeout(timer)
        resolve(outcome)
      }

      timer = setTimeout(() => {
        // Only the direct child is signalled. On Windows that is the `cmd.exe`
        // wrapper, so a read-only `pnpm view` may outlive it; it asks a registry
        // and exits on its own, writes no profile file, and can change nothing.
        timedOut = true
        child.kill()
      }, REGISTRY_LOOKUP_TIMEOUT_MS)

      child.stdout?.on('data', (chunk) => {
        stdout += String(chunk)
      })
      child.stderr?.on('data', (chunk) => {
        stderr += String(chunk)
      })
      child.on('error', (error) => {
        finish(
          failedRun(registryDetail({ stdout, stderr, exitCode: null, timedOut, spawnError: error?.code }), {
            stdout,
            stderr,
            timedOut,
            spawnError: error?.code ?? 'spawn-failed',
            detail: messageOf(error),
          }),
        )
      })
      child.on('close', (code) => {
        finish({
          stdout,
          stderr,
          exitCode: code ?? null,
          timedOut,
          spawnError: null,
          detail: registryDetail({ stdout, stderr, exitCode: code ?? null, timedOut }),
        })
      })
    })
  }

  /** Apply the DPIP gate to one assessed write. */
  resolveGate(assessment, action, acknowledgedUncovered) {
    if (assessment.gate.decision === 'refuse') return { refused: assessment.gate.reason }
    if (assessment.gate.decision === 'allow-covered') return { refused: null }
    if (acknowledgedUncovered === true) return { refused: null }
    return { refused: 'uncovered-not-acknowledged' }
  }

  /**
   * Locate one bundle the profile itself installed, plus its dependency spec.
   * @param name - bundle name.
   * @returns `{ ok, bundle, sourceKind }` or a refusal.
   */
  async findSelfBundle(name) {
    if (typeof name !== 'string' || name === '') return { ok: false, reason: 'bundle-name-required' }
    const manager = this.manager
    if (manager === undefined) return { ok: false, reason: 'plugin-manager-unavailable' }
    const bundles = await manager.listBundles()
    const bundle = (bundles ?? []).find((candidate) => candidate?.name === name)
    if (bundle === undefined) return { ok: false, reason: 'unknown-bundle' }
    if (bundle.installed !== true) return { ok: false, reason: 'not-self-installed' }
    const manifest = this.readProfileManifest()
    return { ok: true, bundle, sourceKind: sourceKindOf(manifest.dependencies?.[name]) }
  }

  /**
   * Run every pre-condition for a write and return the facts the caller needs.
   *
   * The refusal reasons come from the same {@link writeBlockReason} table the
   * tab renders, so the button's disabled state and the Host's refusal can
   * never disagree about why.
   */
  async assessWrite(name, action) {
    const found = await this.findSelfBundle(name)
    if (!found.ok) return { ok: false, reason: found.reason }
    const gate = readGateState({ directory: this.gateDirectory() })
    const log = readRollbackLog({ path: this.logPath() })
    const rollbackTarget = rollbackTargetOf(log, name)
    const gateEvaluation = evaluateGate({ gate, name })
    const reason = writeBlockReason(
      {
        origin: 'self',
        writesEnabled: this.settings.writesEnabled === true,
        gateReadable: gate.readable === true,
        gateRefusing: gateEvaluation.coverage === 'refusing',
        gateState: gateEvaluation.state,
        sourceKind: found.sourceKind,
        rollbackTarget,
      },
      action,
    )
    if (reason !== null) return { ok: false, reason, bundle: found.bundle, gate: gateEvaluation }
    return {
      ok: true,
      bundle: found.bundle,
      sourceKind: found.sourceKind,
      gate: gateEvaluation,
      rollbackTarget,
      log,
    }
  }
}

markRemoteMethods(SelfPluginsService.prototype)

/** Build a refusal payload both write methods share. */
function refusal(action, name, reason, assessment, detail = null) {
  return {
    ok: false,
    action,
    name,
    reason,
    detail,
    fromVersion: assessment?.bundle?.version ?? null,
    toVersion: null,
    changed: false,
    application: null,
    guidance: 'refused',
    coverage: assessment?.gate?.coverage ?? 'unknown',
    gateState: assessment?.gate?.state ?? null,
    error: null,
  }
}

/** Build a completed-write payload. */
function outcome(action, name, from, target, result, assessment, logProblem) {
  const change = result?.result ?? null
  return {
    ok: result?.ok === true,
    action,
    name,
    fromVersion: from,
    toVersion: target,
    changed: change?.changed === true,
    application: change?.application ?? 'failed',
    guidance: change === null ? 'install-threw' : guidanceFor(change.application),
    coverage: assessment.gate.coverage,
    gateState: assessment.gate.state,
    bundle: change?.bundle ?? null,
    warnings: Array.isArray(change?.warnings) ? change.warnings : [],
    pendingBuilds: Array.isArray(change?.pendingBuilds) ? change.pendingBuilds : [],
    registries: Array.isArray(change?.registries) ? change.registries : [],
    error: change?.error ?? null,
    logProblem: logProblem ?? null,
    detail: result?.detail ?? null,
  }
}

/** ISO timestamp for the rollback record. */
function nowIso() {
  return new Date().toISOString()
}

/** Short, non-throwing message for an unexpected error. */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/** One registry run that never produced a usable child process. */
function failedRun(detail, extra = {}) {
  return { stdout: '', stderr: '', exitCode: null, timedOut: false, spawnError: 'spawn-failed', detail, ...extra }
}

/** First meaningful diagnostic line of one registry run, capped for the wire. */
function registryDetail(run) {
  if (run?.timedOut === true) return `pnpm view timed out after ${String(REGISTRY_LOOKUP_TIMEOUT_MS)}ms`
  const line = `${run?.stderr ?? ''}\n${run?.stdout ?? ''}`
    .split('\n')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
    .join(' ')
  if (line !== '') return line.slice(0, 400)
  if (run?.exitCode === null || run?.exitCode === undefined) return 'pnpm view produced no output'
  return `pnpm view exited with ${String(run.exitCode)}`
}
