/**
 * Attribution and view-model tests.
 *
 * The bundle fixtures are trimmed copies of a real `pluginManager.listBundles()`
 * payload taken from this machine, so the attribution rule is tested against
 * the shapes the Host actually returns rather than against invented ones.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildOverview,
  bundleOrigin,
  gateCoverageOf,
  sourceKindOf,
  writeBlockReason,
} from '../lib/scan.js'

/** Assert no `undefined` survives anywhere in a payload. */
function assertNoUndefined(value, path = '$') {
  if (value === undefined) throw new Error(`undefined at ${path}`)
  if (value === null || typeof value !== 'object') return
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoUndefined(item, `${path}[${String(index)}]`))
    return
  }
  for (const [key, item] of Object.entries(value)) assertNoUndefined(item, `${path}.${key}`)
}

test('origin comes from the recorded installation state, not the name', () => {
  assert.equal(bundleOrigin({ installed: false, removable: false, optional: false }), 'shipped')
  assert.equal(bundleOrigin({ installed: false, removable: false, optional: true }), 'shipped-optional')
  assert.equal(bundleOrigin({ installed: true, removable: true }), 'self')
})

test('a local link dependency is never offered a registry version change', () => {
  assert.equal(sourceKindOf('link:C:/Users/x/plugin'), 'local')
  assert.equal(sourceKindOf('file:../plugin'), 'local')
  assert.equal(sourceKindOf('workspace:*'), 'local')
  assert.equal(sourceKindOf('dsh-ops'), 'registry')
  assert.equal(sourceKindOf(undefined), 'registry')
})

test('the refusal table matches the plan’s E1-a contract', () => {
  const base = {
    origin: 'self',
    writesEnabled: true,
    gateReadable: true,
    gateRefusing: false,
    gateState: null,
    sourceKind: 'registry',
    rollbackTarget: '1.0.0',
  }
  assert.equal(writeBlockReason(base, 'update'), null)
  assert.equal(writeBlockReason({ ...base, origin: 'shipped' }, 'update'), 'not-self-installed')
  assert.equal(writeBlockReason({ ...base, writesEnabled: false }, 'update'), 'writes-disabled')
  assert.equal(writeBlockReason({ ...base, gateReadable: false }, 'update'), 'gate-state-unreadable')
  assert.equal(
    writeBlockReason({ ...base, gateRefusing: true, gateState: 'QUARANTINED' }, 'update'),
    'gate-state-quarantined',
  )
  // A recorded but permitting state must not block: ACTIVE is a state too.
  assert.equal(writeBlockReason({ ...base, gateState: 'ACTIVE' }, 'update'), null)
  assert.equal(writeBlockReason({ ...base, sourceKind: 'local' }, 'update'), 'local-source-dependency')
  assert.equal(writeBlockReason({ ...base, rollbackTarget: null }, 'rollback'), 'no-rollback-point')
  // A rollback target is irrelevant to an update.
  assert.equal(writeBlockReason({ ...base, rollbackTarget: null }, 'update'), null)
})

test('gate coverage is derived once, on the Host', () => {
  assert.equal(gateCoverageOf(false, null), 'unknown')
  assert.equal(gateCoverageOf(true, 'ACTIVE'), 'active')
  assert.equal(gateCoverageOf(true, 'BLOCKED'), 'refusing')
  assert.equal(gateCoverageOf(true, null), 'uncovered')
})

test('buildOverview assembles a JSON-safe view model', () => {
  const bundles = [
    {
      name: 'dsh-ops',
      version: '0.2.9',
      description: 'ops tools',
      installed: true,
      removable: true,
      optional: false,
      enabled: true,
      rows: [{ rowId: 'dsh-ops-shell', moduleName: 'dsh-ops/shell', entryId: 'include:dsh-ops-shell' }],
      overrides: [],
    },
    {
      name: '@deepseek-ai/dsh-base',
      version: '0.2.0-rc.2',
      description: 'core',
      installed: false,
      removable: false,
      optional: false,
      enabled: true,
      readOnlyReason: 'management-required',
      rows: [{ rowId: 'plugin-manager', moduleName: '@deepseek-ai/dsh-plugin-manager', entryId: 'include:plugin-manager' }],
      overrides: ['tools'],
    },
  ]
  const plugins = [
    { entryId: 'include:dsh-ops-shell', moduleName: 'dsh-ops/shell', enabled: true, fiberPhase: 'active' },
    { entryId: 'include:plugin-manager', moduleName: '@deepseek-ai/dsh-plugin-manager', enabled: true, fiberPhase: 'active' },
    { entryId: 'include:broken', moduleName: 'broken', enabled: true, fiberPhase: 'failed' },
  ]
  const overview = buildOverview({
    bundles,
    plugins,
    exemptions: { exemptions: {}, warnings: [] },
    runtimeVersion: '0.2.0-rc.2',
    runtimeVersionSource: 'pluginManager.listVersionExemptions',
    profileName: 'web',
    profileDependencies: { 'dsh-ops': '0.2.9' },
    gate: { readable: true, path: 'C:/x/plugin-state.json', states: {} },
    rollback: { records: { 'dsh-ops': { version: '0.2.8', recordedAt: 't' } } },
    writesEnabled: true,
    config: { logPath: 'C:/x/rollback.json' },
  })

  assertNoUndefined(overview)
  assert.equal(overview.counts.total, 2)
  assert.equal(overview.counts.self, 1)
  assert.equal(overview.counts.shipped, 1)
  assert.equal(overview.counts.unaddressedFailures, 1)
  assert.deepEqual(overview.unaddressedFailures, [{ entryId: 'include:broken', moduleName: 'broken' }])

  const [self, shipped] = overview.bundles
  assert.equal(self.name, 'dsh-ops')
  assert.equal(self.origin, 'self')
  assert.equal(self.health.level, 'ok')
  assert.equal(self.rollbackTarget, '0.2.8')
  assert.deepEqual(self.writeAllowed, { update: true, rollback: true })
  assert.equal(self.gateCoverage, 'uncovered')

  assert.equal(shipped.origin, 'shipped')
  assert.equal(shipped.readOnlyReason, 'management-required')
  assert.equal(shipped.writeAllowed.update, false)
  assert.equal(shipped.writeBlock.update, 'not-self-installed')
})

test('a bundle error survives into the payload as a refusal-independent fact', () => {
  const overview = buildOverview({
    bundles: [
      {
        name: 'p',
        version: '1.0.0',
        installed: true,
        removable: true,
        enabled: true,
        error: { code: 'not-bundle', diagnostic: 'no patch' },
        rows: [],
        overrides: [],
      },
    ],
    plugins: [],
    gate: { readable: true, states: {} },
    rollback: { records: {} },
    writesEnabled: true,
  })
  assert.equal(overview.bundles[0].health.level, 'error')
  assert.equal(overview.bundles[0].error.code, 'not-bundle')
  assert.equal(overview.counts.error, 1)
})
