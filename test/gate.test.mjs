/**
 * DPIP gate tests.
 *
 * The fixtures mirror the shipped `FilePluginStateStore` and the DPIP branch of
 * `evaluateOperation`, including the case that matters most: a document that
 * exists but cannot be parsed must be refused, never read as "nothing is
 * recorded here".
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { evaluateGate, readGateState, recordedState } from '../lib/gate.js'

/** Build an injected reader over a fixed byte string. */
function reader(text, error) {
  return () => {
    if (error !== undefined) throw error
    return text
  }
}

/** An ENOENT-shaped error, as `readFileSync` produces for an absent document. */
function enoent() {
  return Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' })
}

test('an absent state document is an empty, readable store', () => {
  const gate = readGateState({ directory: 'C:/x', readFile: reader(undefined, enoent()) })
  assert.equal(gate.readable, true)
  assert.deepEqual(gate.states, {})
  assert.equal(gate.problem, null)
})

test('a valid document is parsed, BOM included', () => {
  const gate = readGateState({
    directory: 'C:/x',
    readFile: reader('\uFEFF{"dsh-ops":{"state":"ACTIVE","updatedAt":"t"}}'),
  })
  assert.equal(gate.readable, true)
  assert.equal(recordedState(gate.states, 'dsh-ops'), 'ACTIVE')
})

test('a document that cannot be parsed is unreadable, not empty', () => {
  for (const text of ['not json', '[1,2,3]', 'null', '"a string"']) {
    const gate = readGateState({ directory: 'C:/x', readFile: reader(text) })
    assert.equal(gate.readable, false, `expected ${text} to be refused`)
    assert.deepEqual(gate.states, {})
    assert.equal(typeof gate.problem, 'string')
  }
})

test('a read failure other than ENOENT is unreadable', () => {
  const gate = readGateState({
    directory: 'C:/x',
    readFile: reader(undefined, Object.assign(new Error('EACCES'), { code: 'EACCES' })),
  })
  assert.equal(gate.readable, false)
  assert.equal(gate.problem, 'EACCES')
})

test('a malformed record yields no state without becoming unreadable', () => {
  const gate = readGateState({ directory: 'C:/x', readFile: reader('{"p":null,"q":"text","r":{}}') })
  assert.equal(gate.readable, true)
  assert.equal(recordedState(gate.states, 'p'), null)
  assert.equal(recordedState(gate.states, 'q'), null)
  assert.equal(recordedState(gate.states, 'r'), null)
})

test('an unreadable document refuses every write', () => {
  const decision = evaluateGate({ gate: { readable: false, states: {} }, name: 'anything' })
  assert.equal(decision.decision, 'refuse')
  assert.equal(decision.reason, 'gate-state-unreadable')
  assert.equal(decision.coverage, 'unknown')
})

test('the states the security layer denies are refused here too', () => {
  for (const state of ['BLOCKED', 'QUARANTINED', 'ROLLBACK_REQUIRED']) {
    const decision = evaluateGate({ gate: { readable: true, states: { p: { state } } }, name: 'p' })
    assert.equal(decision.decision, 'refuse', `${state} must be refused`)
    assert.equal(decision.reason, `gate-state-${state.toLowerCase()}`)
  }
})

test('ACTIVE is the only state treated as covered', () => {
  const decision = evaluateGate({ gate: { readable: true, states: { p: { state: 'ACTIVE' } } }, name: 'p' })
  assert.equal(decision.decision, 'allow-covered')
  assert.equal(decision.coverage, 'active')
})

test('an uncovered plugin is allowed only as allow-uncovered', () => {
  for (const states of [{}, { p: { state: 'UNTRUSTED' } }, { p: { state: 'FAILED' } }, { p: { state: 'DISCOVERED' } }]) {
    const decision = evaluateGate({ gate: { readable: true, states }, name: 'p' })
    assert.equal(decision.decision, 'allow-uncovered')
    assert.equal(decision.coverage, 'uncovered')
  }
})
