/**
 * Health mapping tests.
 *
 * The assertions pin the mapping decisions that matter: `null` is "unknown",
 * never "healthy"; a bundle's own load error outranks its rows; and an
 * unaddressable row is reported as unmeasured rather than as a pass.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { judgeBundle, judgeFiberPhase, judgePlugin, summarise, worstOf } from '../lib/health.js'

test('judgeFiberPhase maps every documented phase', () => {
  assert.deepEqual(judgeFiberPhase('active'), { level: 'ok', code: 'running' })
  assert.deepEqual(judgeFiberPhase('failed'), { level: 'error', code: 'fiber-failed' })
  assert.deepEqual(judgeFiberPhase('pending'), { level: 'idle', code: 'awaiting-load' })
  assert.deepEqual(judgeFiberPhase('loading'), { level: 'busy', code: 'loading' })
  assert.deepEqual(judgeFiberPhase('unloading'), { level: 'busy', code: 'unloading' })
})

test('a missing fiber is unknown, not healthy', () => {
  for (const phase of [null, undefined]) {
    const judgement = judgeFiberPhase(phase)
    assert.equal(judgement.level, 'unknown')
    assert.equal(judgement.code, 'no-live-fiber')
  }
})

test('an unrecognised phase is reported verbatim instead of guessed', () => {
  const judgement = judgeFiberPhase('reticulating')
  assert.equal(judgement.level, 'unknown')
  assert.equal(judgement.code, 'unrecognised-phase:reticulating')
})

test('worstOf keeps the most severe judgement', () => {
  assert.deepEqual(worstOf([{ level: 'ok' }, { level: 'error' }, { level: 'idle' }]), { level: 'error' })
  assert.deepEqual(worstOf([{ level: 'ok' }, { level: 'busy' }]), { level: 'busy' })
  assert.deepEqual(worstOf([]), { level: 'unknown', code: 'no-rows' })
})

test('judgePlugin honours the effective enablement before the phase', () => {
  assert.deepEqual(judgePlugin({ enabled: false, fiberPhase: 'active' }), { level: 'disabled', code: 'disabled-entry' })
  assert.deepEqual(judgePlugin({ enabled: true, fiberPhase: 'active' }), { level: 'ok', code: 'running' })
  assert.deepEqual(judgePlugin(undefined), { level: 'unknown', code: 'not-in-inventory' })
})

test('judgeBundle lets the bundle error outrank its rows', () => {
  const plugins = new Map([['include:x', { enabled: true, fiberPhase: 'active' }]])
  const judgement = judgeBundle(
    { enabled: true, error: { code: 'not-bundle', diagnostic: 'no bundle patch' }, rows: [{ entryId: 'include:x' }] },
    plugins,
  )
  assert.equal(judgement.level, 'error')
  assert.equal(judgement.code, 'not-bundle')
  assert.equal(judgement.detail, 'no bundle patch')
})

test('judgeBundle reports a deselected bundle as disabled', () => {
  const judgement = judgeBundle({ enabled: false, rows: [{ entryId: 'include:x' }] }, new Map())
  assert.deepEqual(judgement, { level: 'disabled', code: 'deselected-bundle' })
})

test('judgeBundle never reads an unmeasurable row set as healthy', () => {
  assert.deepEqual(judgeBundle({ enabled: true, rows: [] }, new Map()), {
    level: 'unknown',
    code: 'bundle-declares-no-rows',
  })
  assert.deepEqual(judgeBundle({ enabled: true, rows: [{ rowId: 'a', moduleName: 'm' }] }, new Map()), {
    level: 'unknown',
    code: 'no-addressable-row',
  })
})

test('judgeBundle picks up a failed row through the inventory', () => {
  const plugins = new Map([['include:x', { enabled: true, fiberPhase: 'failed' }]])
  assert.deepEqual(judgeBundle({ enabled: true, rows: [{ entryId: 'include:x' }] }, plugins), {
    level: 'error',
    code: 'fiber-failed',
  })
})

test('summarise counts origins and problem levels', () => {
  const summary = summarise([
    { origin: 'self', health: { level: 'ok' } },
    { origin: 'self', health: { level: 'error' } },
    { origin: 'shipped', health: { level: 'unknown' } },
  ])
  assert.deepEqual(summary, { total: 3, self: 2, shipped: 1, error: 1, disabled: 0, unknown: 1 })
})
