/**
 * Host dispatch verification: does the *live* Gateway dispatcher resolve and
 * call this plugin's Remote endpoints?
 *
 * `verify/wiring.mjs` proves the descriptors are accepted by the registry.
 * This script proves the other half: the Host resolves the endpoint with no
 * generated strict definition present (SRC derivation from the prototype marker
 * and the method signature), binds it to the published Service, passes the wire
 * arguments through, and returns the encoded result.
 *
 * Without this, a passing registry check could still leave a tab whose every
 * call fails with `gateway/service-unavailable`.
 *
 * Run: node verify/dispatch.mjs
 */

import { Context } from '@deepseek-ai/cordis'
import { TypertRegistry } from '@deepseek-ai/dsh-typert-registry'
import TypertGatewayService from '@deepseek-ai/dsh-api-gateway'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, Config } from '../lib/index.js'

let failures = 0

/** Run one assertion group. */
async function check(label, body) {
  try {
    await body()
    console.log(`PASS ${label}`)
  } catch (error) {
    failures += 1
    console.error(`FAIL ${label}`)
    console.error(`     ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Throw unless `condition`. */
function assert(condition, message) {
  if (condition !== true) throw new Error(message)
}

const scratch = mkdtempSync(join(tmpdir(), 'dsh-spm-dispatch-'))

const installed = {
  name: 'demo-plugin',
  version: '1.0.0',
  installed: true,
  removable: true,
  enabled: true,
  rows: [{ rowId: 'demo', moduleName: 'demo-plugin', entryId: 'include:demo' }],
  overrides: [],
}

const ctx = new Context()
new TypertRegistry(ctx)
new TypertGatewayService(ctx)
ctx.provide('pluginManager', {
  async listBundles() {
    return [installed]
  },
  async listPlugins() {
    return [{ entryId: 'include:demo', moduleName: 'demo-plugin', enabled: true, fiberPhase: 'active' }]
  },
  // Synchronous on purpose: the real `listVersionExemptions()` returns its
  // object directly, so an `async` stub here would hide the very TypeError this
  // file exists to catch.
  listVersionExemptions() {
    return { exemptions: {}, warnings: [] }
  },
  // Faithful to the real contract: `pluginManager.inspect()` refuses every name
  // the profile already holds, so a regression that reaches for it shows up here
  // as a refused update instead of a silent success.
  async inspect(spec) {
    return { status: 'refused', problem: 'already-installed', reason: `${spec} is already installed` }
  },
  async registries() {
    return { registry: null, fallbackRegistries: [], resolved: null }
  },
  async installBundle(spec) {
    return { changed: true, application: 'applied', stage: 'install', target: spec }
  },
})
ctx.provide('profileContext', {
  name: 'dispatch-check',
  dir: process.cwd(),
  // A throwaway home: the write path records rollback points under
  // `$DSH_HOME/self-plugin-manager/`, and a verification run must not leave
  // that state inside the project.
  home: scratch,
  patchPath: '',
  installAnchor: process.cwd(),
  cwd: process.cwd(),
  startedBundles: [],
  overlays: [],
  telemetryDisabledEnv: undefined,
})
const sessions = { create: 0, rename: [], prompt: [], promptSignals: [], selectModel: [] }
ctx.provide('sessionController', {
  async create() {
    sessions.create += 1
    return { sessionId: 'gateway-session' }
  },
  async modelCatalog() {
    return { default: { provider: 'dp', model: 'dm' }, groups: [] }
  },
  async selectModel(request) {
    sessions.selectModel.push(request)
    return { selected: request }
  },
  rename(request) {
    sessions.rename.push(request)
    return { title: request.title, seq: 1 }
  },
  async prompt(request, signal) {
    // Faithful to the contract: the real implementation dereferences the signal
    // on entry, so a caller that omits it must fail here too.
    signal.throwIfAborted()
    sessions.prompt.push(request)
    sessions.promptSignals.push(signal)
    return { accepted: true }
  },
})
apply(
  ctx,
  Config({ gateStateDir: join(scratch, 'operation-security'), storageDir: join(scratch, 'state'), autoVerify: true }),
)

// The process boundary only. The real method spawns `pnpm view`; that is
// exercised for real by `verify/registry.mjs`, which needs a network and a
// `pnpm` on PATH, while this script must stay offline and test dispatch.
ctx.get('selfPlugins').runPnpmView = async () => ({
  stdout: '"2.0.0"',
  stderr: '',
  exitCode: 0,
  timedOut: false,
  spawnError: null,
  detail: null,
})

// `ctx.typertGateway.invoke()` returns the encoded *value*; the `{ ok, value }`
// envelope is added by the carrier, so these checks read the payload directly.
await check('the Gateway resolves the SRC endpoint to the published Service', async () => {
  const overview = await ctx.typertGateway.invoke({ namespace: 'selfPlugins', method: 'overview', args: {} })
  assert(overview.bundles[0].name === 'demo-plugin', 'the bundle did not survive dispatch')
  assert(overview.counts.self === 1, `expected one self-installed bundle, got ${String(overview.counts.self)}`)
})

await check('the wire arguments reach the method by name', async () => {
  const change = await ctx.typertGateway.invoke({
    namespace: 'selfPlugins',
    method: 'update',
    args: { name: 'demo-plugin', acknowledgedUncovered: true },
  })
  assert(change.action === 'update', `unexpected action ${String(change.action)}`)
  assert(change.ok === true, `the update failed: ${JSON.stringify(change)}`)
  assert(change.toVersion === '2.0.0', `the resolved version did not arrive: ${String(change.toVersion)}`)
  assert(
    readFileSync(join(scratch, 'state', 'rollback.json'), 'utf8').includes('1.0.0'),
    'the rollback point was not recorded under the configured storage directory',
  )
})

await check('a successful update creates and prompts the verification session', async () => {
  assert(sessions.create === 1, `expected one session, got ${String(sessions.create)}`)
  assert(sessions.selectModel.length === 1, 'the deployment default was not selected')
  assert(sessions.selectModel[0].sessionId === 'gateway-session', 'the session was not routed')
  assert(sessions.rename.length === 1 && sessions.rename[0].title.includes('demo-plugin'), 'the session was not titled')
  assert(sessions.prompt.length === 1, 'the verification prompt was not admitted')
  assert(sessions.prompt[0].content[0].text.includes('1.0.0 → 2.0.0'), 'the prompt does not name the version change')
})

await check('a refusal is a normal result, not a transport failure', async () => {
  const refusal = await ctx.typertGateway.invoke({
    namespace: 'selfPlugins',
    method: 'update',
    args: { name: 'not-installed', acknowledgedUncovered: true },
  })
  assert(refusal.ok === false, 'the refusal payload must carry ok:false')
  assert(refusal.reason === 'unknown-bundle', `unexpected reason ${String(refusal.reason)}`)
  assert(sessions.create === 1, 'a refused update must not create a verification session')
})

await check('the DPIP gate is applied on the Host, not only in the UI', async () => {
  // No acknowledgement and no recorded DPIP state: the Host must refuse even
  // though the caller reached the endpoint directly.
  const refusal = await ctx.typertGateway.invoke({
    namespace: 'selfPlugins',
    method: 'update',
    args: { name: 'demo-plugin' },
  })
  assert(refusal.ok === false, 'an unacknowledged uncovered plugin must be refused')
  assert(refusal.reason === 'uncovered-not-acknowledged', `unexpected reason ${String(refusal.reason)}`)
})

await check('an unknown method is refused by the dispatcher', async () => {
  let error
  try {
    await ctx.typertGateway.invoke({ namespace: 'selfPlugins', method: 'nope', args: {} })
  } catch (caught) {
    error = caught
  }
  assert(error !== undefined, 'an unknown method must not silently succeed')
})

await check('an unrelated namespace is refused by the dispatcher', async () => {
  let error
  try {
    await ctx.typertGateway.invoke({ namespace: 'notOurNamespace', method: 'overview', args: {} })
  } catch (caught) {
    error = caught
  }
  assert(error !== undefined, 'an unknown namespace must not silently succeed')
})

rmSync(scratch, { recursive: true, force: true })

if (failures > 0) {
  console.error(`\n${String(failures)} check(s) failed`)
  process.exitCode = 1
} else {
  console.log('\nall dispatch checks passed')
}
