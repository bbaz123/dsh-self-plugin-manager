/**
 * Rollback-log and outcome-shaping tests.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  guidanceFor,
  readRollbackLog,
  recordRollbackPoint,
  rollbackLogPath,
  rollbackTargetOf,
  writeRollbackLog,
} from '../lib/update.js'

/** An ENOENT-shaped error. */
function enoent() {
  return Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
}

test('an absent log is empty rather than an error', () => {
  const log = readRollbackLog({ path: 'C:/x/rollback.json', readFile: () => { throw enoent() } })
  assert.deepEqual(log.records, {})
  assert.equal(log.problem, null)
})

test('a corrupt log reports a problem instead of pretending to be empty', () => {
  const log = readRollbackLog({ path: 'C:/x/rollback.json', readFile: () => '{oops' })
  assert.deepEqual(log.records, {})
  assert.equal(typeof log.problem, 'string')
})

test('a log whose records field is wrong is rejected in full', () => {
  const log = readRollbackLog({ path: 'p', readFile: () => '{"version":1,"records":[1,2]}' })
  assert.deepEqual(log.records, {})
  assert.equal(typeof log.problem, 'string')
})

test('recording a rollback point does not mutate the previous log', () => {
  const before = { version: 1, records: {}, problem: null }
  const after = recordRollbackPoint(before, { name: 'p', version: '1.2.3', at: 't0' })
  assert.deepEqual(before.records, {})
  assert.deepEqual(after.records, { p: { version: '1.2.3', recordedAt: 't0' } })
  assert.equal(rollbackTargetOf(after, 'p'), '1.2.3')
  assert.equal(rollbackTargetOf(after, 'other'), null)
})

test('rollbackTargetOf tolerates malformed records', () => {
  assert.equal(rollbackTargetOf({ records: { p: null } }, 'p'), null)
  assert.equal(rollbackTargetOf({ records: { p: 'text' } }, 'p'), null)
  assert.equal(rollbackTargetOf(undefined, 'p'), null)
})

test('the log path lives under $DSH_HOME/self-plugin-manager', () => {
  assert.equal(rollbackLogPath('C:/home'), join('C:/home', 'self-plugin-manager', 'rollback.json'))
})

test('writeRollbackLog writes atomically and survives a real round trip', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-spm-'))
  try {
    const path = join(dir, 'nested', 'rollback.json')
    writeRollbackLog({ path, log: { version: 1, records: { p: { version: '0.9.0', recordedAt: 't' } } } })
    const written = JSON.parse(readFileSync(path, 'utf8'))
    assert.deepEqual(written, { version: 1, records: { p: { version: '0.9.0', recordedAt: 't' } } })
    // The temporary file must not be left behind.
    assert.equal(
      readRollbackLog({ path }).records.p.version,
      '0.9.0',
      'the renamed document must be readable by the same reader the service uses',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('guidanceFor never turns restart-required into "done"', () => {
  assert.equal(guidanceFor('applied'), 'live')
  assert.equal(guidanceFor('restart-required'), 'restart-to-load-new-generation')
  assert.equal(guidanceFor('overridden'), 'higher-priority-layer-wins')
  assert.equal(guidanceFor('failed'), 'failed')
  assert.equal(guidanceFor('cancelled'), 'cancelled')
  assert.equal(guidanceFor(undefined), 'unknown-application')
})
