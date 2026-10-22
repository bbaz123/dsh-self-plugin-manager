/**
 * Activation verification: does the plugin mount and answer in a real Cordis
 * context, with the config schema the Loader will actually apply?
 *
 * Run before installing, because a row that throws at activation fails the
 * whole profile (`assertEntriesActivated`), not just this plugin.
 *
 * Run: node verify/activation.mjs
 */

import { Context } from '@deepseek-ai/cordis'
import { apply, Config, inject, name } from '../lib/index.js'
import { SelfPluginsService } from '../lib/service.js'

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

/** Assert `body` throws. */
function assertThrows(body, message) {
  let threw = false
  try {
    body()
  } catch {
    threw = true
  }
  assert(threw, message)
}

let context

await check('the module declares the Host dependency the profile must satisfy', () => {
  assert(name === 'self-plugin-manager', `unexpected plugin name ${String(name)}`)
  assert(Array.isArray(inject) && inject.includes('pluginManager'), 'inject must require pluginManager')
})

await check('the config schema accepts an empty row and applies documented defaults', () => {
  const defaults = Config({})
  assert(defaults.writesEnabled === true, 'writesEnabled must default to true')
  assert(defaults.gateStateDir === '', 'gateStateDir must default to the empty override')
  assert(defaults.storageDir === '', 'storageDir must default to the empty override')
  // Creating a session and prompting an Agent is an action taken on the
  // operator's behalf, so it must stay off until the patch layer enables it.
  assert(defaults.autoVerify === false, 'autoVerify must default to false')
  assert(defaults.verifyModelProvider === '' && defaults.verifyModel === '', 'the verification route must default to unset')
})

await check('the config schema rejects a wrong type instead of coercing it', () => {
  assertThrows(() => Config({ writesEnabled: 'yes' }), 'a string writesEnabled must be rejected')
  assertThrows(() => Config({ gateStateDir: 7 }), 'a numeric gateStateDir must be rejected')
})

await check('apply() mounts the service under its Cordis key', () => {
  context = new Context()
  context.provide('pluginManager', {
    async listBundles() {
      return [
        {
          name: 'demo-plugin',
          version: '1.0.0',
          installed: true,
          removable: true,
          enabled: true,
          rows: [{ rowId: 'demo', moduleName: 'demo-plugin', entryId: 'include:demo' }],
          overrides: [],
        },
      ]
    },
    async listPlugins() {
      return [{ entryId: 'include:demo', moduleName: 'demo-plugin', enabled: true, fiberPhase: 'active' }]
    },
    // Synchronous on purpose: the real `listVersionExemptions()` returns its
    // object directly. An `async` stub here is what let a real
    // `.catch is not a function` TypeError pass every check.
    listVersionExemptions() {
      return { exemptions: {}, warnings: [] }
    },
  })
  context.provide('profileContext', {
    name: 'dry-run',
    dir: process.cwd(),
    home: process.cwd(),
    patchPath: '',
    installAnchor: process.cwd(),
    cwd: process.cwd(),
    startedBundles: [],
    overlays: [],
    telemetryDisabledEnv: undefined,
  })
  apply(context, Config({}))
  const service = context.get('selfPlugins')
  assert(service !== undefined && service !== null, 'ctx.selfPlugins was not published')
})

await check('the mounted service answers overview() over the real inventory', async () => {
  const overview = await context.get('selfPlugins').overview()
  assert(overview.counts.self === 1, `expected one self-installed bundle, got ${String(overview.counts.self)}`)
  assert(overview.bundles[0].name === 'demo-plugin', 'the bundle name did not survive the projection')
  assert(overview.runtimeVersion !== null, 'the runtime version should resolve from the installed packages')
})

await check('the write path is inert without a plugin manager', async () => {
  const bare = new Context()
  const service = new SelfPluginsService(bare, {})
  const overview = await service.overview()
  assert(overview.available === false, 'overview must report unavailability rather than throw')
  assert(overview.reason === 'plugin-manager-unavailable', `unexpected reason ${String(overview.reason)}`)
})

if (failures > 0) {
  console.error(`\n${String(failures)} check(s) failed`)
  process.exitCode = 1
} else {
  console.log('\nall activation checks passed')
}
