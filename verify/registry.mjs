/**
 * Live registry verification: does the real `pnpm view` path answer for a bundle
 * the profile already holds?
 *
 * This is the check the Host cannot provide. `pluginManager.inspect()` refuses
 * every already-installed name (`problem: 'already-installed'`), so the plugin
 * asks the registry itself, and this script runs **that** question for real:
 * the real `runPnpmView` spawns the real `pnpm` in a real profile directory and
 * the real parser reads its answer. Nothing here is stubbed except the Host
 * service itself, which is not what is under test.
 *
 * It needs a network and a `pnpm` on PATH, so it is deliberately not part of
 * `npm run verify`.
 *
 * Run: npm run verify:registry
 * Override the subject or the registry with `DSH_SPM_VERIFY_PACKAGE` and
 * `DSH_SPM_VERIFY_REGISTRY`.
 */

import { Context } from '@deepseek-ai/cordis'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SelfPluginsService } from '../lib/service.js'

let failures = 0

/** Run one assertion group. */
async function check(label, body) {
  try {
    const value = await body()
    console.log(`PASS ${label}${value === undefined ? '' : ` — ${String(value)}`}`)
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

const subject = process.env.DSH_SPM_VERIFY_PACKAGE ?? 'dsh-ops'
const configuredRegistry = process.env.DSH_SPM_VERIFY_REGISTRY ?? null
const scratch = mkdtempSync(join(tmpdir(), 'dsh-spm-registry-'))
const profileDir = join(scratch, 'profile')
mkdirSync(profileDir, { recursive: true })
writeFileSync(
  join(profileDir, 'package.json'),
  JSON.stringify({
    name: 'dsh-profile-verify',
    dependencies: { [subject]: '0.0.0' },
    dsh: { profile: { bundles: [subject] } },
  }),
)

const ctx = new Context()
ctx.provide('pluginManager', {
  async listBundles() {
    return [
      {
        name: subject,
        version: '0.0.0',
        installed: true,
        removable: true,
        optional: false,
        enabled: true,
        rows: [],
        overrides: [],
      },
    ]
  },
  async listPlugins() {
    return []
  },
  // Synchronous on purpose: the real member returns its object, not a Promise.
  listVersionExemptions() {
    return { exemptions: {}, warnings: [] }
  },
  async registries() {
    return { registry: configuredRegistry, fallbackRegistries: [], resolved: null }
  },
  async inspect(spec) {
    throw new Error(`inspect() must never be called for an installed bundle (${spec})`)
  },
  async installBundle(spec) {
    throw new Error(`a check must install nothing, but installBundle(${spec}) was called`)
  },
})
ctx.provide('profileContext', {
  name: 'verify-registry',
  dir: profileDir,
  home: scratch,
  patchPath: '',
  installAnchor: profileDir,
  cwd: scratch,
  startedBundles: [],
  overlays: [],
  telemetryDisabledEnv: undefined,
})

const service = new SelfPluginsService(ctx, {
  writesEnabled: false,
  gateStateDir: join(scratch, 'operation-security'),
  storageDir: join(scratch, 'state'),
})

await check(`the real pnpm asks the registry for ${subject}`, async () => {
  const check = await service.check(subject)
  assert(check.ok === true, `the check was refused: ${check.reason ?? 'unknown'} — ${check.detail ?? ''}`)
  assert(
    typeof check.latestVersion === 'string' && /^\d+\.\d+\.\d+/.test(check.latestVersion),
    `unexpected version ${String(check.latestVersion)}`,
  )
  assert(check.currentVersion === '0.0.0', `unexpected installed version ${String(check.currentVersion)}`)
  return `${check.currentVersion} → ${check.latestVersion} (registry ${String(check.registry)})`
})

await check('the same question resolves the update target, and installs nothing', async () => {
  const resolved = await service.resolveLatest(subject)
  assert(resolved.ok === true, `resolveLatest refused: ${String(resolved.reason)}`)
  return `resolved ${resolved.version} after asking ${JSON.stringify(resolved.registries)}`
})

rmSync(scratch, { recursive: true, force: true })

if (failures > 0) {
  console.error(`\n${String(failures)} check(s) failed`)
  process.exitCode = 1
} else {
  console.log('\nall live registry checks passed')
}
