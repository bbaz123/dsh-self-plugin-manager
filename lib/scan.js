/**
 * Build the tab's read-only view model from the plugin manager's own inventory.
 *
 * Why this module exists instead of a filesystem scan: the self-installation
 * plan this plugin implements specified scanning `~/.dsh/plugins` for
 * `manifest.json` files. That directory does not exist on a 0.2.0-rc.2 profile,
 * and the authoritative list of installed bundles already exists behind
 * `pluginManager.listBundles()` / `listPlugins()`. Attribution therefore comes
 * from the recorded state, never from a directory listing.
 *
 * Every function here is pure: the service does the I/O and hands the raw
 * payloads in, so the attribution rules stay unit-testable.
 *
 * @module dsh-self-plugin-manager/scan
 */

import { judgeBundle, judgePlugin, summarise } from './health.js'
import { jsonSafe } from './json-safe.js'

/**
 * Classify where a bundle came from.
 *
 * Verified against a live `listBundles()` payload: bundles DSH itself supplies
 * report `installed: false`, while every bundle the profile added reports
 * `installed: true` (and, in every observed case, `removable: true`).
 * @param bundle - `BundleInfo`-shaped bundle.
 * @returns `'self'` | `'shipped-optional'` | `'shipped'`.
 */
export function bundleOrigin(bundle) {
  if (bundle?.installed === true) return 'self'
  if (bundle?.optional === true) return 'shipped-optional'
  return 'shipped'
}

/**
 * How one self-installed dependency was declared, read from the profile's own
 * `package.json`.
 *
 * A `link:`/`file:` dependency points at a directory on this machine, so
 * "updating" it from a registry would replace the developer's checkout with an
 * unrelated package — it must never be offered.
 * @param spec - the dependency specifier, or `undefined`.
 * @returns `'local'` | `'registry'`.
 */
export function sourceKindOf(spec) {
  if (typeof spec !== 'string') return 'registry'
  return /^(link|file|workspace):/.test(spec) ? 'local' : 'registry'
}

/**
 * Explain, in a stable code the Client localises, why one write action is
 * unavailable. Returns `null` when the action is permitted.
 * @param context - gate/config/origin facts for the bundle.
 * @param action - `'update'` or `'rollback'`.
 * @returns a reason code, or `null`.
 */
export function writeBlockReason(context, action) {
  if (context.origin !== 'self') return 'not-self-installed'
  if (context.writesEnabled !== true) return 'writes-disabled'
  if (context.gateReadable !== true) return 'gate-state-unreadable'
  // Only the states the security layer denies may block here: `ACTIVE` is a
  // recorded state too, and it is the one outcome that permits the write.
  if (context.gateRefusing === true) return `gate-state-${String(context.gateState ?? '').toLowerCase()}`
  if (context.sourceKind === 'local') return 'local-source-dependency'
  if (action === 'rollback' && (context.rollbackTarget === null || context.rollbackTarget === undefined)) {
    return 'no-rollback-point'
  }
  return null
}

/**
 * Summarise the DPIP gate verdict for one bundle, so the Client never has to
 * re-derive it from the raw state string.
 * @param gateReadable - whether the state document could be read.
 * @param state - the recorded DPIP state, or `null`.
 * @returns `'unknown'` | `'refusing'` | `'active'` | `'uncovered'`.
 */
export function gateCoverageOf(gateReadable, state) {
  if (gateReadable !== true) return 'unknown'
  if (state === 'ACTIVE') return 'active'
  if (typeof state === 'string' && state !== '') return 'refusing'
  return 'uncovered'
}

/**
 * Assemble the complete payload the Settings tab renders.
 * @param input - raw inventory plus local facts (see `lib/service.js`).
 * @returns a JSON-safe view model.
 */
export function buildOverview(input) {
  const {
    bundles = [],
    plugins = [],
    exemptions = null,
    runtimeVersion = null,
    runtimeVersionSource = null,
    profileName = null,
    profileDependencies = {},
    gate = { readable: false, path: null, states: {} },
    rollback = { records: {} },
    writesEnabled = false,
    config = {},
  } = input

  const pluginByEntryId = new Map()
  for (const plugin of plugins) {
    if (typeof plugin?.entryId === 'string') pluginByEntryId.set(plugin.entryId, plugin)
  }

  const covered = new Set()
  const judged = bundles.map((bundle) => {
    const origin = bundleOrigin(bundle)
    const spec = profileDependencies[bundle.name]
    const sourceKind = origin === 'self' ? sourceKindOf(spec) : 'registry'
    const dependents = Array.isArray(bundle.rows) ? bundle.rows : []
    const rowViews = dependents.map((row) => {
      const plugin = row.entryId === undefined ? undefined : pluginByEntryId.get(row.entryId)
      if (row.entryId !== undefined) covered.add(row.entryId)
      return {
        rowId: row.rowId,
        moduleName: row.moduleName,
        entryId: row.entryId ?? null,
        moduleEnabled: plugin === undefined ? null : plugin.enabled === true,
        fiberPhase: plugin === undefined ? null : (plugin.fiberPhase ?? null),
        health: judgePlugin(plugin),
      }
    })
    const record = rollback.records?.[bundle.name]
    const rollbackTarget = typeof record?.version === 'string' ? record.version : null
    const gateState = gate.states?.[bundle.name] ?? null
    const gateCoverage = gateCoverageOf(gate.readable === true, gateState)
    const common = {
      origin,
      writesEnabled,
      gateReadable: gate.readable === true,
      gateRefusing: gateCoverage === 'refusing',
      gateState,
      sourceKind,
      rollbackTarget,
    }
    return {
      name: bundle.name,
      version: bundle.version ?? null,
      title: bundle.meta?.title ?? null,
      description: bundle.description ?? null,
      origin,
      sourceKind,
      installed: bundle.installed === true,
      removable: bundle.removable === true,
      optional: bundle.optional === true,
      readOnlyReason: bundle.readOnlyReason ?? null,
      enabled: bundle.enabled !== false,
      error: bundle.error === undefined ? null : jsonSafe(bundle.error),
      overrides: Array.isArray(bundle.overrides) ? [...bundle.overrides] : [],
      health: judgeBundle(bundle, pluginByEntryId),
      rows: rowViews,
      gateState,
      gateCoverage,
      rollbackTarget,
      writeBlock: {
        update: writeBlockReason(common, 'update'),
        rollback: writeBlockReason(common, 'rollback'),
      },
      writeAllowed: {
        update: writeBlockReason(common, 'update') === null,
        rollback: writeBlockReason(common, 'rollback') === null,
      },
    }
  })

  // A failed entry no bundle in this payload addresses still matters: the user
  // asked "is anything broken", not "is anything broken inside my list".
  const unaddressedFailures = []
  for (const plugin of plugins) {
    if (typeof plugin?.entryId !== 'string') continue
    if (covered.has(plugin.entryId)) continue
    if (plugin.fiberPhase !== 'failed') continue
    unaddressedFailures.push({ entryId: plugin.entryId, moduleName: plugin.moduleName ?? null })
  }

  const selfBundles = judged.filter((bundle) => bundle.origin === 'self')
  const payload = {
    runtimeVersion,
    runtimeVersionSource,
    profileName,
    writesEnabled,
    config,
    gate: { readable: gate.readable === true, path: gate.path ?? null, states: jsonSafe(gate.states ?? {}) },
    exemptions: exemptions === null ? null : jsonSafe(exemptions),
    rollbackRecords: jsonSafe(rollback.records ?? {}),
    counts: {
      ...summarise(judged),
      selfBundles: selfBundles.length,
      errorEntries: judged.reduce((total, bundle) => total + bundle.rows.filter((row) => row.health.level === 'error').length, 0),
      unaddressedFailures: unaddressedFailures.length,
    },
    unaddressedFailures,
    bundles: judged,
  }
  return jsonSafe(payload)
}
