/**
 * Health judgement for one bundle or one plugin row — pure, no I/O.
 *
 * DeepSeek Harness 0.2.0-rc.2 exposes exactly two authoritative liveness
 * signals, and neither is a callable probe:
 *
 *   * `PluginFiberPhase` on a Loader entry — `pending` | `loading` | `active` |
 *     `failed` | `unloading` | `null` (no live root fiber at all);
 *   * `BundleInfo.error` from the plugin manager, set when a selected bundle
 *     itself cannot load.
 *
 * The self-installation plan that this plugin implements originally specified
 * `import(plugin)` followed by a plugin-provided `healthCheck()` returning
 * `{status, latency}`. No such protocol exists in rc.2, so this module maps the
 * signals that do exist rather than inventing a probe whose absence would look
 * like a passing check.
 *
 * @module dsh-self-plugin-manager/health
 */

/** Judgement levels ordered worst-last, so `worstOf` can compare by index. */
export const LEVELS = Object.freeze(['unknown', 'ok', 'idle', 'busy', 'disabled', 'error'])

/**
 * Map one root-fiber phase onto a health judgement.
 * @param phase - `PluginFiberPhase` value, or `undefined` when absent.
 * @returns `{ level, code }`.
 */
export function judgeFiberPhase(phase) {
  switch (phase) {
    case 'active':
      return { level: 'ok', code: 'running' }
    case 'failed':
      return { level: 'error', code: 'fiber-failed' }
    case 'pending':
      return { level: 'idle', code: 'awaiting-load' }
    case 'loading':
      return { level: 'busy', code: 'loading' }
    case 'unloading':
      return { level: 'busy', code: 'unloading' }
    case null:
    case undefined:
      // Deliberately not an error: the phase never distinguishes "never started"
      // from "already disposed", so reporting a failure here would be a guess.
      return { level: 'unknown', code: 'no-live-fiber' }
    default:
      return { level: 'unknown', code: `unrecognised-phase:${String(phase)}` }
  }
}

/**
 * Pick the worst judgement in a list, ignoring unknown noise when something
 * better is present.
 * @param judgements - candidate judgements.
 * @returns the worst judgement, or `{ level: 'unknown', code: 'no-rows' }`.
 */
export function worstOf(judgements) {
  let worst
  for (const judgement of judgements) {
    if (judgement === undefined) continue
    if (worst === undefined || LEVELS.indexOf(judgement.level) > LEVELS.indexOf(worst.level)) {
      worst = judgement
    }
  }
  return worst ?? { level: 'unknown', code: 'no-rows' }
}

/**
 * Judge one plugin inventory row (a Loader entry).
 * @param plugin - `PluginInventoryEntry`-shaped row, or `undefined`.
 * @returns `{ level, code }`.
 */
export function judgePlugin(plugin) {
  if (plugin === undefined) return { level: 'unknown', code: 'not-in-inventory' }
  if (plugin.enabled === false) return { level: 'disabled', code: 'disabled-entry' }
  return judgeFiberPhase(plugin.fiberPhase)
}

/**
 * Judge one bundle from its own load outcome plus the phases of its rows.
 *
 * A bundle's own `error` outranks every row: the rows cannot be trusted to
 * describe health while the bundle that declares them failed to load.
 * @param bundle - `BundleInfo`-shaped bundle.
 * @param pluginByEntryId - Map from entry id to `PluginInventoryEntry`.
 * @returns `{ level, code, detail? }`.
 */
export function judgeBundle(bundle, pluginByEntryId) {
  if (bundle.error !== undefined && bundle.error !== null) {
    const code = typeof bundle.error?.code === 'string' ? bundle.error.code : 'bundle-error'
    const detail =
      typeof bundle.error?.diagnostic === 'string' && bundle.error.diagnostic !== ''
        ? bundle.error.diagnostic
        : undefined
    return { level: 'error', code, ...(detail === undefined ? {} : { detail }) }
  }
  if (bundle.enabled === false) return { level: 'disabled', code: 'deselected-bundle' }
  const rows = Array.isArray(bundle.rows) ? bundle.rows : []
  if (rows.length === 0) return { level: 'unknown', code: 'bundle-declares-no-rows' }
  const judgements = rows.map((row) =>
    row.entryId === undefined ? undefined : judgePlugin(pluginByEntryId.get(row.entryId)),
  )
  if (judgements.every((judgement) => judgement === undefined)) {
    // Every row is unaddressable in the live inventory — the bundle contributes
    // no running entry, which is a real observation, not a missing measurement.
    return { level: 'unknown', code: 'no-addressable-row' }
  }
  return worstOf(judgements)
}

/**
 * Aggregate per-bundle judgements into counts for the tab header.
 * @param bundles - judged bundles carrying `health`.
 * @returns `{ total, self, shipped, error, disabled, unknown }`.
 */
export function summarise(bundles) {
  const summary = { total: bundles.length, self: 0, shipped: 0, error: 0, disabled: 0, unknown: 0 }
  for (const bundle of bundles) {
    if (bundle.origin === 'self') summary.self += 1
    else summary.shipped += 1
    if (bundle.health?.level === 'error') summary.error += 1
    if (bundle.health?.level === 'disabled') summary.disabled += 1
    if (bundle.health?.level === 'unknown') summary.unknown += 1
  }
  return summary
}
