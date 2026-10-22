/**
 * Service-level tests for the write path, run against a stub plugin manager.
 *
 * These exercise the decisions the plan's E1-a contract depends on without
 * touching the live profile: a corrupt DPIP document refuses, a denied DPIP
 * state refuses, an uncovered plugin needs an explicit acknowledgement, the
 * rollback point is written before the install, and a failed install restores
 * the previous log instead of leaving a rollback target that never existed.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SelfPluginsService } from '../lib/service.js'

/** One self-installed bundle, shaped like a real `listBundles()` row. */
function selfBundle(overrides = {}) {
  return {
    name: 'demo-plugin',
    version: '1.0.0',
    description: 'demo',
    installed: true,
    removable: true,
    optional: false,
    enabled: true,
    rows: [{ rowId: 'demo', moduleName: 'demo-plugin', entryId: 'include:demo' }],
    overrides: [],
    ...overrides,
  }
}

/** Build an isolated harness: temp profile, temp gate directory, stub manager. */
function harness(options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-spm-svc-'))
  const profileDir = join(root, 'profile')
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(
    join(profileDir, 'package.json'),
    JSON.stringify({
      name: 'dsh-profile-web',
      dependencies: options.dependencies ?? { 'demo-plugin': '1.0.0' },
      dsh: { profile: { bundles: ['demo-plugin'] } },
    }),
  )
  const gateDir = join(root, 'operation-security')
  mkdirSync(gateDir, { recursive: true })
  if (options.gateDocument !== undefined) {
    writeFileSync(join(gateDir, 'plugin-state.json'), options.gateDocument)
  }
  const storageDir = join(root, 'state')
  const calls = { install: [], inspect: [], view: [] }
  // A mutable installed version, so a successful install is observable through
  // the same inventory the service reads back.
  const state = { version: options.version ?? '1.0.0' }
  const viewResult = options.viewResult ?? {
    stdout: '"2.0.0"',
    stderr: '',
    exitCode: 0,
    timedOut: false,
    spawnError: null,
    detail: null,
  }
  const manager = {
    async listBundles() {
      return options.bundles ?? [selfBundle({ version: state.version })]
    },
    async listPlugins() {
      return options.plugins ?? [
        { entryId: 'include:demo', moduleName: 'demo-plugin', enabled: true, fiberPhase: 'active' },
      ]
    },
    // Faithful to the contract: `listVersionExemptions()` is the one
    // SYNCHRONOUS member of this service's surface — it returns its object, not
    // a Promise. A stub that returned a Promise here hid a real runtime
    // TypeError (`.catch is not a function`) from the whole suite.
    listVersionExemptions() {
      if (options.exemptionsThrows === true) throw new Error('compatibility file unreadable')
      if (options.exemptionsAsync === true) {
        return Promise.resolve(options.exemptions ?? { exemptions: {}, warnings: [] })
      }
      return options.exemptions ?? { exemptions: {}, warnings: [] }
    },
    // Faithful to the real contract: `pluginManager.inspect()` refuses every
    // name the profile already holds (`problem: 'already-installed'`) before it
    // asks any registry — and every bundle this service can act on is held by
    // definition. The stub used to answer `accepted` here, which is what let the
    // broken call ship; the refusal shape means a regression fails the caller's
    // own assertions instead of passing silently.
    async inspect(spec) {
      calls.inspect.push(spec)
      return { status: 'refused', problem: 'already-installed', reason: `${spec} is already installed` }
    },
    async registries() {
      if (options.registriesThrows === true) throw new Error('registry plan unreadable')
      return options.registries ?? { registry: null, fallbackRegistries: [], resolved: null }
    },
    async installBundle(spec, installOptions) {
      calls.install.push({ spec, options: installOptions })
      if (options.installThrows === true) throw new Error('pnpm exploded')
      const result = options.installResult ?? {
        changed: true,
        application: 'applied',
        stage: 'install',
        target: spec,
      }
      if (result.application !== 'failed' && result.application !== 'cancelled') {
        state.version = spec.slice(spec.lastIndexOf('@') + 1)
      }
      return result
    },
  }
  const ctx = new Context()
  ctx.provide('pluginManager', manager)
  ctx.provide('profileContext', {
    name: 'web',
    dir: profileDir,
    home: root,
    patchPath: join(profileDir, 'cordis.patch.yml'),
    installAnchor: profileDir,
    cwd: root,
    startedBundles: [],
    overlays: [],
    telemetryDisabledEnv: undefined,
  })
  const sessionCalls = { create: [], modelCatalog: 0, selectModel: [], rename: [], prompt: [], promptSignals: [] }
  if (options.sessionController !== false) {
    ctx.provide('sessionController', {
      async create(request) {
        sessionCalls.create.push(request)
        return { sessionId: options.sessionId === undefined ? 'sess-1' : options.sessionId }
      },
      async modelCatalog() {
        sessionCalls.modelCatalog += 1
        if (options.modelCatalogThrows === true) throw new Error('catalog unavailable')
        return options.modelCatalog ?? { default: { provider: 'dp', model: 'dm' }, groups: [] }
      },
      async selectModel(request) {
        sessionCalls.selectModel.push(request)
        return { selected: request }
      },
      rename(request) {
        sessionCalls.rename.push(request)
        return { title: request.title, seq: 1 }
      },
      async prompt(request, signal) {
        // Faithful to the contract: the real implementation dereferences the
        // signal on entry (`signal.throwIfAborted()`), so a caller that omits it
        // must fail here too rather than only in production.
        signal.throwIfAborted()
        sessionCalls.prompt.push(request)
        sessionCalls.promptSignals.push(signal)
        if (options.promptThrows === true) throw new Error('agent refused the prompt')
        return { accepted: true }
      },
    })
  }
  const service = new SelfPluginsService(ctx, {
    writesEnabled: options.writesEnabled !== false,
    gateStateDir: gateDir,
    storageDir,
    autoVerify: options.autoVerify === true,
    verifyModelProvider: options.verifyModelProvider ?? '',
    verifyModel: options.verifyModel ?? '',
  })
  // The process boundary only: the real method spawns `pnpm view`, and its
  // argument vector is pinned separately by `test/registry.test.mjs`, so
  // replacing the spawn here cannot hide an argv bug. `options.view` may be a
  // function to answer each registry question differently.
  service.runPnpmView = async (name, registry) => {
    calls.view.push({ name, registry: registry ?? null })
    if (typeof options.view === 'function') return options.view(name, registry, calls.view.length)
    return viewResult
  }
  const logPath = join(storageDir, 'rollback.json')
  return {
    service,
    calls,
    sessionCalls,
    logPath,
    gateDir,
    profileDir,
    state,
    readLog: () => JSON.parse(readFileSync(logPath, 'utf8')),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

test('overview attributes bundles and reports the gate', async () => {
  const h = harness({
    bundles: [
      selfBundle(),
      {
        name: '@deepseek-ai/dsh-base',
        version: '0.2.0-rc.2',
        installed: false,
        removable: false,
        optional: false,
        enabled: true,
        readOnlyReason: 'management-required',
        rows: [{ rowId: 'plugin-manager', moduleName: '@deepseek-ai/dsh-plugin-manager', entryId: 'include:pm' }],
        overrides: [],
      },
    ],
    plugins: [
      { entryId: 'include:demo', moduleName: 'demo-plugin', enabled: true, fiberPhase: 'active' },
      { entryId: 'include:pm', moduleName: '@deepseek-ai/dsh-plugin-manager', enabled: true, fiberPhase: 'active' },
    ],
  })
  try {
    const overview = await h.service.overview()
    assert.equal(overview.available, undefined)
    assert.equal(overview.profileName, 'web')
    assert.equal(overview.counts.self, 1)
    assert.equal(overview.counts.shipped, 1)
    assert.equal(overview.bundles[0].origin, 'self')
    assert.equal(overview.bundles[0].writeAllowed.update, true)
    assert.equal(overview.bundles[1].writeAllowed.update, false)
    assert.equal(overview.gate.readable, true)
  } finally {
    h.cleanup()
  }
})

test('a disabled write path refuses both actions', async () => {
  const h = harness({ writesEnabled: false })
  try {
    const update = await h.service.update('demo-plugin', true)
    assert.equal(update.ok, false)
    assert.equal(update.reason, 'writes-disabled')
    const rollback = await h.service.rollback('demo-plugin', true)
    assert.equal(rollback.reason, 'writes-disabled')
    assert.equal(h.calls.install.length, 0)
  } finally {
    h.cleanup()
  }
})

test('a corrupt DPIP document refuses every write (fail closed)', async () => {
  const h = harness({ gateDocument: '{ not json' })
  try {
    const update = await h.service.update('demo-plugin', true)
    assert.equal(update.ok, false)
    assert.equal(update.reason, 'gate-state-unreadable')
    assert.equal(h.calls.install.length, 0)
  } finally {
    h.cleanup()
  }
})

test('a denied DPIP state refuses regardless of acknowledgement', async () => {
  for (const state of ['BLOCKED', 'QUARANTINED', 'ROLLBACK_REQUIRED']) {
    const h = harness({ gateDocument: JSON.stringify({ 'demo-plugin': { state } }) })
    try {
      const update = await h.service.update('demo-plugin', true)
      assert.equal(update.ok, false, `${state} must be refused`)
      assert.equal(update.reason, `gate-state-${state.toLowerCase()}`)
      assert.equal(h.calls.install.length, 0)
    } finally {
      h.cleanup()
    }
  }
})

test('an uncovered plugin needs the explicit acknowledgement', async () => {
  const h = harness()
  try {
    const refused = await h.service.update('demo-plugin', undefined)
    assert.equal(refused.ok, false)
    assert.equal(refused.reason, 'uncovered-not-acknowledged')
    assert.equal(h.calls.install.length, 0)

    const allowed = await h.service.update('demo-plugin', true)
    assert.equal(allowed.ok, true)
    assert.equal(allowed.coverage, 'uncovered')
    assert.equal(h.calls.install.length, 1)
  } finally {
    h.cleanup()
  }
})

test('an ACTIVE DPIP state proceeds without an acknowledgement', async () => {
  const h = harness({ gateDocument: JSON.stringify({ 'demo-plugin': { state: 'ACTIVE' } }) })
  try {
    const update = await h.service.update('demo-plugin', undefined)
    assert.equal(update.ok, true)
    assert.equal(update.coverage, 'active')
  } finally {
    h.cleanup()
  }
})

test('update records the rollback point before installing the resolved version', async () => {
  const h = harness()
  try {
    const update = await h.service.update('demo-plugin', true)
    assert.equal(update.ok, true)
    assert.equal(update.fromVersion, '1.0.0')
    assert.equal(update.toVersion, '2.0.0')
    assert.equal(update.guidance, 'live')
    assert.equal(update.application, 'applied')
    assert.deepEqual(h.calls.install, [{ spec: 'demo-plugin@2.0.0', options: { enabled: true } }])
    assert.deepEqual(h.readLog().records['demo-plugin'].version, '1.0.0')
  } finally {
    h.cleanup()
  }
})

test('the installed spec is always resolved from the registry, never supplied by the caller', async () => {
  const h = harness()
  try {
    await h.service.update('demo-plugin', true)
    assert.equal(h.calls.install[0].spec, 'demo-plugin@2.0.0')
    // Only the bare package name is ever handed to the registry lookup.
    assert.deepEqual(h.calls.view, [{ name: 'demo-plugin', registry: null }])
  } finally {
    h.cleanup()
  }
})

test('the Host pre-install check is never used for an installed bundle', async () => {
  const h = harness()
  try {
    // The real `pluginManager.inspect()` refuses every installed name, so using
    // it here is a defect that used to surface as `inspect-already-installed`.
    await h.service.check('demo-plugin')
    await h.service.update('demo-plugin', true)
    assert.deepEqual(h.calls.inspect, [])
  } finally {
    h.cleanup()
  }
})

test('an already-current bundle installs nothing', async () => {
  const h = harness({ viewResult: { stdout: '"1.0.0"', stderr: '', exitCode: 0, timedOut: false, spawnError: null } })
  try {
    const update = await h.service.update('demo-plugin', true)
    assert.equal(update.ok, true)
    assert.equal(update.changed, false)
    assert.equal(update.guidance, 'already-current')
    assert.equal(h.calls.install.length, 0)
  } finally {
    h.cleanup()
  }
})

test('a failed install removes the rollback point it just wrote', async () => {
  const h = harness({ installResult: { changed: false, application: 'failed', stage: 'install', target: 'x' } })
  try {
    const update = await h.service.update('demo-plugin', true)
    assert.equal(update.ok, false)
    assert.equal(update.guidance, 'failed')
    const log = h.readLog()
    assert.deepEqual(log.records, {}, 'a failed install must not leave a rollback target behind')
  } finally {
    h.cleanup()
  }
})

test('a throwing install is reported, not crashed through', async () => {
  const h = harness({ installThrows: true })
  try {
    const update = await h.service.update('demo-plugin', true)
    assert.equal(update.ok, false)
    assert.equal(update.guidance, 'install-threw')
    assert.match(update.detail, /pnpm exploded/)
  } finally {
    h.cleanup()
  }
})

test('rollback needs a recorded point and then installs exactly that version', async () => {
  const h = harness()
  try {
    const withoutPoint = await h.service.rollback('demo-plugin', true)
    assert.equal(withoutPoint.ok, false)
    assert.equal(withoutPoint.reason, 'no-rollback-point')

    await h.service.update('demo-plugin', true)
    assert.equal(h.state.version, '2.0.0')

    const rollback = await h.service.rollback('demo-plugin', true)
    assert.equal(rollback.ok, true)
    assert.equal(rollback.fromVersion, '2.0.0')
    assert.equal(rollback.toVersion, '1.0.0')
    assert.equal(h.calls.install.at(-1).spec, 'demo-plugin@1.0.0')
  } finally {
    h.cleanup()
  }
})

test('a shipped bundle and a local dependency are both refused', async () => {
  const shipped = harness({
    bundles: [selfBundle({ name: 'other', installed: false, removable: false })],
  })
  const local = harness({ dependencies: { 'demo-plugin': 'link:C:/Users/x/demo' } })
  try {
    const shippedUpdate = await shipped.service.update('other', true)
    assert.equal(shippedUpdate.reason, 'not-self-installed')

    const localUpdate = await local.service.update('demo-plugin', true)
    assert.equal(localUpdate.reason, 'local-source-dependency')
    assert.equal(local.calls.install.length, 0)

    const localCheck = await local.service.check('demo-plugin')
    assert.equal(localCheck.ok, false)
    assert.equal(localCheck.reason, 'local-source-dependency')
  } finally {
    shipped.cleanup()
    local.cleanup()
  }
})

test('an unknown bundle is refused before any registry call', async () => {
  const h = harness()
  try {
    const update = await h.service.update('nope', true)
    assert.equal(update.reason, 'unknown-bundle')
    assert.equal(h.calls.view.length, 0)
  } finally {
    h.cleanup()
  }
})

test('check reports the resolved latest version without installing', async () => {
  const h = harness()
  try {
    const result = await h.service.check('demo-plugin')
    assert.equal(result.ok, true)
    assert.equal(result.currentVersion, '1.0.0')
    assert.equal(result.latestVersion, '2.0.0')
    assert.equal(result.registry, null)
    assert.deepEqual(result.registriesAsked, [null])
    assert.equal(h.calls.install.length, 0)
    assert.deepEqual(h.calls.view, [{ name: 'demo-plugin', registry: null }])
  } finally {
    h.cleanup()
  }
})

test('a registry that cannot answer refuses the check with a named reason and its detail', async () => {
  const h = harness({
    viewResult: {
      stdout: '{"error":{"code":"ERR_PNPM_FETCH_404","message":"GET https://registry.test/demo-plugin: Not Found - 404"}}',
      stderr: '',
      exitCode: 1,
      timedOut: false,
      spawnError: null,
    },
  })
  try {
    const result = await h.service.check('demo-plugin')
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'registry-not-found')
    assert.match(result.detail, /404/)
    assert.equal(h.calls.install.length, 0)

    const update = await h.service.update('demo-plugin', true)
    assert.equal(update.ok, false)
    assert.equal(update.reason, 'registry-not-found')
    assert.match(update.detail, /404/)
    assert.equal(h.calls.install.length, 0)
  } finally {
    h.cleanup()
  }
})

test('a public first registry falls through to the declared fallback', async () => {
  const h = harness({
    registries: {
      registry: 'https://registry.npmjs.org/',
      fallbackRegistries: ['https://registry.npmmirror.com/'],
      resolved: null,
    },
    view: (name, registry) =>
      registry === 'https://registry.npmjs.org/'
        ? { stdout: '{"error":{"code":"ERR_PNPM_META_FETCH_FAIL"}}', stderr: '', exitCode: 1, timedOut: false, spawnError: null }
        : { stdout: '"3.4.5"', stderr: '', exitCode: 0, timedOut: false, spawnError: null },
  })
  try {
    const result = await h.service.check('demo-plugin')
    assert.equal(result.ok, true)
    assert.equal(result.latestVersion, '3.4.5')
    assert.equal(result.registry, 'https://registry.npmmirror.com/')
    assert.deepEqual(result.registriesAsked, ['https://registry.npmjs.org/', 'https://registry.npmmirror.com/'])
  } finally {
    h.cleanup()
  }
})

test('a private first registry never falls through to a public mirror', async () => {
  const h = harness({
    registries: {
      registry: 'https://npm.corp.example/',
      fallbackRegistries: ['https://registry.npmmirror.com/'],
      resolved: 'https://npm.corp.example/',
    },
    view: () => ({ stdout: '', stderr: 'fetch failed', exitCode: 1, timedOut: false, spawnError: null }),
  })
  try {
    const result = await h.service.check('demo-plugin')
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'registry-network')
    assert.deepEqual(h.calls.view, [{ name: 'demo-plugin', registry: 'https://npm.corp.example/' }])
  } finally {
    h.cleanup()
  }
})

test('a missing pnpm is reported once, not retried against another registry', async () => {
  const h = harness({
    registries: { registry: 'https://registry.npmjs.org/', fallbackRegistries: ['https://registry.npmmirror.com/'], resolved: null },
    viewResult: { stdout: '', stderr: '', exitCode: null, timedOut: false, spawnError: 'ENOENT' },
  })
  try {
    const result = await h.service.check('demo-plugin')
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'pnpm-missing')
    assert.equal(h.calls.view.length, 1)
  } finally {
    h.cleanup()
  }
})

test('an unreadable registry plan still asks pnpm own configuration', async () => {
  const h = harness({ registriesThrows: true })
  try {
    const result = await h.service.check('demo-plugin')
    assert.equal(result.ok, true)
    assert.equal(result.latestVersion, '2.0.0')
    assert.deepEqual(h.calls.view, [{ name: 'demo-plugin', registry: null }])
  } finally {
    h.cleanup()
  }
})

test('the verification session is off by default and creates nothing', async () => {
  const h = harness()
  try {
    const update = await h.service.update('demo-plugin', true)
    assert.equal(update.ok, true)
    assert.deepEqual(update.verification, { started: false, reason: 'auto-verify-disabled' })
    assert.equal(h.sessionCalls.create.length, 0)
    assert.equal(h.sessionCalls.prompt.length, 0)
  } finally {
    h.cleanup()
  }
})

test('a change needing a restart never starts a verification session', async () => {
  const h = harness({
    autoVerify: true,
    installResult: { changed: true, application: 'restart-required', stage: 'install', target: 'x' },
  })
  try {
    const update = await h.service.update('demo-plugin', true)
    assert.equal(update.guidance, 'restart-to-load-new-generation')
    assert.deepEqual(update.verification, { started: false, reason: 'restart-required-first' })
    assert.equal(h.sessionCalls.create.length, 0, 'a session here would verify the OLD generation')
  } finally {
    h.cleanup()
  }
})

test('an applied change creates, titles, routes and prompts a verification session', async () => {
  const h = harness({ autoVerify: true })
  try {
    const update = await h.service.update('demo-plugin', true)
    assert.equal(update.verification.started, true)
    assert.equal(update.verification.sessionId, 'sess-1')
    assert.equal(update.verification.title, '插件更新验证：demo-plugin')
    assert.deepEqual(update.verification.model, { provider: 'dp', model: 'dm' })
    assert.equal(update.verification.modelSource, 'deployment-default')
    assert.deepEqual(h.sessionCalls.create, [{}])
    assert.deepEqual(h.sessionCalls.selectModel, [{ sessionId: 'sess-1', provider: 'dp', model: 'dm' }])
    assert.deepEqual(h.sessionCalls.rename, [{ sessionId: 'sess-1', title: '插件更新验证：demo-plugin' }])
    assert.equal(h.sessionCalls.prompt.length, 1)
    const prompt = h.sessionCalls.prompt[0]
    assert.equal(prompt.sessionId, 'sess-1')
    assert.equal(prompt.mode, 'queue')
    assert.equal(typeof prompt.requestId, 'string')
    assert.equal(prompt.content.length, 1)
    assert.match(prompt.content[0].text, /demo-plugin/)
    assert.match(prompt.content[0].text, /1\.0\.0 → 2\.0\.0/)
  } finally {
    h.cleanup()
  }
})

test('an explicitly configured route is used and reported as configured', async () => {
  const h = harness({ autoVerify: true, verifyModelProvider: 'deepseek-official', verifyModel: 'deepseek-flash' })
  try {
    const update = await h.service.update('demo-plugin', true)
    assert.equal(update.verification.modelSource, 'configured')
    assert.deepEqual(h.sessionCalls.selectModel, [
      { sessionId: 'sess-1', provider: 'deepseek-official', model: 'deepseek-flash' },
    ])
  } finally {
    h.cleanup()
  }
})

test('a rejected prompt is reported without losing the session identity', async () => {
  const h = harness({ autoVerify: true, promptThrows: true })
  try {
    const update = await h.service.update('demo-plugin', true)
    assert.equal(update.ok, true, 'the install still succeeded')
    assert.equal(update.verification.started, false)
    assert.equal(update.verification.reason, 'prompt-rejected')
    assert.equal(update.verification.sessionId, 'sess-1')
    assert.match(update.verification.detail, /agent refused/)
  } finally {
    h.cleanup()
  }
})

test('a missing session controller is reported instead of thrown through', async () => {
  const h = harness({ autoVerify: true, sessionController: false })
  try {
    const update = await h.service.update('demo-plugin', true)
    assert.equal(update.ok, true)
    assert.deepEqual(update.verification, { started: false, reason: 'session-controller-unavailable' })
  } finally {
    h.cleanup()
  }
})

test('a session that was not created is reported and nothing is prompted', async () => {
  const h = harness({ autoVerify: true, sessionId: '' })
  try {
    const update = await h.service.update('demo-plugin', true)
    assert.deepEqual(update.verification, { started: false, reason: 'session-create-failed' })
    assert.equal(h.sessionCalls.prompt.length, 0)
    assert.equal(h.sessionCalls.rename.length, 0)
  } finally {
    h.cleanup()
  }
})

test('a failed model selection keeps the session and still prompts', async () => {
  const h = harness({ autoVerify: true, modelCatalogThrows: true })
  try {
    const update = await h.service.update('demo-plugin', true)
    assert.equal(update.verification.started, true)
    assert.equal(update.verification.model, null)
    assert.equal(update.verification.modelSource, 'unresolved')
    assert.match(update.verification.modelProblem, /catalog unavailable/)
    assert.equal(h.sessionCalls.selectModel.length, 0)
    assert.equal(h.sessionCalls.prompt.length, 1, 'the session is still usable on the deployment default')
  } finally {
    h.cleanup()
  }
})

test('a rollback that takes effect is verified too', async () => {
  const h = harness({ autoVerify: true })
  try {
    await h.service.update('demo-plugin', true)
    const rollback = await h.service.rollback('demo-plugin', true)
    assert.equal(rollback.ok, true)
    assert.equal(rollback.verification.started, true)
    assert.equal(h.sessionCalls.prompt.length, 2)
    assert.match(h.sessionCalls.prompt[1].content[0].text, /2\.0\.0 → 1\.0\.0/)
  } finally {
    h.cleanup()
  }
})

test('overview reports the auto-verify configuration', async () => {
  const off = harness()
  const on = harness({ autoVerify: true, verifyModelProvider: 'p', verifyModel: 'm' })
  try {
    assert.equal((await off.service.overview()).config.autoVerify, false)
    const overview = await on.service.overview()
    assert.equal(overview.config.autoVerify, true)
    assert.equal(overview.config.verifyModel, 'm')
    assert.equal(overview.config.verifyModelProvider, 'p')
  } finally {
    off.cleanup()
    on.cleanup()
  }
})

test('the synchronous listVersionExemptions() shape is read without .catch', async () => {
  // Regression for the live failure:
  // `读取失败: overview: gateway/internal: manager.listVersionExemptions(...).catch is not a function`.
  const h = harness({ exemptions: { exemptions: { 'p@1.0.0': ['0.2.0-rc.2'] }, warnings: [] } })
  try {
    const overview = await h.service.overview()
    assert.deepEqual(overview.exemptions.exemptions, { 'p@1.0.0': ['0.2.0-rc.2'] })
  } finally {
    h.cleanup()
  }
})

test('an asynchronous listVersionExemptions() shape keeps working', async () => {
  const h = harness({ exemptionsAsync: true, exemptions: { exemptions: {}, warnings: ['unreadable record'] } })
  try {
    const overview = await h.service.overview()
    assert.deepEqual(overview.exemptions.warnings, ['unreadable record'])
  } finally {
    h.cleanup()
  }
})

test('a throwing listVersionExemptions() degrades to null instead of failing the whole page', async () => {
  const h = harness({ exemptionsThrows: true })
  try {
    const overview = await h.service.overview()
    assert.equal(overview.exemptions, null, '"could not read" must not be reported as "none"')
    assert.equal(overview.bundles.length, 1, 'the rest of the overview must still render')
    assert.equal(typeof overview.runtimeVersion, 'string', 'the version falls back to the detected one')
  } finally {
    h.cleanup()
  }
})

test('a declared runtime version outranks the detected one and names its source', async () => {
  const h = harness({ exemptions: { exemptions: {}, warnings: [], runtimeVersion: '9.9.9' } })
  try {
    const overview = await h.service.overview()
    assert.equal(overview.runtimeVersion, '9.9.9')
    assert.equal(overview.runtimeVersionSource, 'pluginManager.listVersionExemptions')
  } finally {
    h.cleanup()
  }
})

test('the verification prompt receives the cancellation signal the contract requires', async () => {
  const h = harness({ autoVerify: true })
  try {
    const update = await h.service.update('demo-plugin', true)
    assert.equal(update.verification.started, true, 'prompt() must not have thrown for a missing signal')
    const signal = h.sessionCalls.promptSignals[0]
    assert.ok(signal !== undefined, 'prompt() was called without its required signal')
    assert.equal(signal.aborted, false)
  } finally {
    h.cleanup()
  }
})
