/**
 * DPIP pre-check for the write path.
 *
 * Why this exists at all: `pluginManager`'s write methods are reachable from a
 * browser over the Gateway, and a Gateway call does **not** pass through the
 * tool pipeline. Verified on this installation:
 *
 *   * `@deepseek-ai/dsh-operation-security` contributes only
 *     `ctx.on('tools/pre-execute', …)` and `ctx.tools.guard(…)`
 *     (`src/index.ts`), so it never sees a Remote call;
 *   * its detector matches `dsh plugin …` shell commands and the dynamic
 *     Cordis lifecycle tools, and has **no** rule for `plugin_manager`
 *     (`src/detector.ts`);
 *   * `@deepseek-ai/dsh-plugin-manager`'s own service contains no security or
 *     approval hook (its only "approval" is pnpm build-script permission).
 *
 * The read-only Web page nevertheless calls `remote.pluginManager.*` directly,
 * so this plugin's write path is an additional unapproved entry point unless it
 * brings its own check. This module is that check. It mirrors
 * `FilePluginStateStore` (BOM stripping, absent-vs-corrupt distinction) and
 * `evaluateOperation`'s DPIP branch, so the two agree on what must be refused.
 *
 * It is deliberately NOT presented as equivalent to a DPIP approval: a plugin
 * with no completed run is `ask` in the security layer, and this module can
 * only return `allow-uncovered`, which the caller must acknowledge explicitly.
 *
 * @module dsh-self-plugin-manager/gate
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** File name inside the operation-security directory. */
export const STATE_FILE_NAME = 'plugin-state.json'

/** States the security layer refuses outright (`evaluateOperation`, DPIP branch). */
export const REFUSING_STATES = Object.freeze(['BLOCKED', 'QUARANTINED', 'ROLLBACK_REQUIRED'])

/** The one state that means a completed plugin lifecycle run covers the plugin. */
export const COVERING_STATE = 'ACTIVE'

/**
 * Read the DPIP state document.
 * @param options - `{ directory, readFile? }`; `readFile` is injectable for tests.
 * @returns `{ readable, path, states, problem }`.
 */
export function readGateState({ directory, readFile = readFileSync }) {
  const path = join(directory, STATE_FILE_NAME)
  try {
    const text = readFile(path, 'utf8')
    const raw = JSON.parse(String(text).replace(/^\uFEFF/, ''))
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw Object.assign(new Error('state document is not an object'), { corrupt: true })
    }
    return { readable: true, path, states: raw, problem: null }
  } catch (error) {
    // An absent document is an empty store; anything else must be refused rather
    // than read as "nothing is recorded" — the same distinction the security
    // layer draws between ENOENT and a corrupt document.
    if (error?.code === 'ENOENT') return { readable: true, path, states: {}, problem: null }
    return { readable: false, path, states: {}, problem: describeReadFailure(error) }
  }
}

/**
 * Extract one plugin's recorded state from a parsed document.
 * @param states - the parsed document.
 * @param name - plugin (bundle) name.
 * @returns the DPIP state string, or `null` when the plugin is not recorded.
 */
export function recordedState(states, name) {
  const record = states?.[name]
  if (record === null || typeof record !== 'object' || Array.isArray(record)) return null
  return typeof record.state === 'string' && record.state !== '' ? record.state : null
}

/**
 * Decide whether one write may proceed.
 *
 * `allow-covered` is the only outcome the security layer would also allow;
 * `allow-uncovered` is the `ask` branch, which this plugin can only turn into a
 * user-facing acknowledgement, never into a real approval.
 * @param input - `{ gate, name }` where `gate` is a {@link readGateState} result.
 * @returns `{ decision, state, coverage, reason }`.
 */
export function evaluateGate({ gate, name }) {
  if (gate?.readable !== true) {
    return {
      decision: 'refuse',
      state: null,
      coverage: 'unknown',
      reason: 'gate-state-unreadable',
    }
  }
  const state = recordedState(gate.states, name)
  if (state !== null && REFUSING_STATES.includes(state)) {
    return { decision: 'refuse', state, coverage: 'refusing', reason: `gate-state-${state.toLowerCase()}` }
  }
  if (state === COVERING_STATE) {
    return { decision: 'allow-covered', state, coverage: 'active', reason: 'dpip-active' }
  }
  return {
    decision: 'allow-uncovered',
    state,
    coverage: 'uncovered',
    reason: state === null ? 'no-dpip-record' : `dpip-state-${state.toLowerCase()}`,
  }
}

/** Turn a read failure into a short, non-throwing diagnostic. */
function describeReadFailure(error) {
  if (error instanceof SyntaxError) return 'state document is not valid JSON'
  const message = error instanceof Error ? error.message : String(error)
  return message === '' ? 'state document could not be read' : message
}
