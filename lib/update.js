/**
 * The rollback point log and the shaping of a plugin manager `ChangeResult`.
 *
 * Why a log of our own: the plugin manager snapshots `package.json` and
 * `pnpm-lock.yaml` and restores them when an operation fails, but a *successful*
 * version change leaves no record of what the previous version was. Without
 * that record "rollback" has no target, so this module records it — before the
 * install runs, never after, so a failed install is still recoverable.
 *
 * The log is a plugin-owned JSON document under `$DSH_HOME`, written
 * tmp-file-then-rename. It deliberately does not use the `storageDomain`
 * service: that service is optional and DSH starts a composition's rows
 * concurrently, so a non-injecting lookup can lose the race and degrade
 * silently — a failure mode this workspace has already paid for once.
 *
 * @module dsh-self-plugin-manager/update
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Schema version of the log document. */
export const ROLLBACK_LOG_VERSION = 1

/** Directory name under `$DSH_HOME`. */
export const STATE_DIR_NAME = 'self-plugin-manager'

/** File name of the log document. */
export const ROLLBACK_FILE_NAME = 'rollback.json'

/**
 * Absolute path of the rollback log.
 * @param home - `$DSH_HOME`.
 * @returns the log file path.
 */
export function rollbackLogPath(home) {
  return join(home, STATE_DIR_NAME, ROLLBACK_FILE_NAME)
}

/**
 * Read the rollback log.
 * @param options - `{ path, readFile? }`.
 * @returns `{ version, records, problem }`; an absent log is empty, a corrupt
 *   one keeps its records empty and reports `problem` so the UI can say so.
 */
export function readRollbackLog({ path, readFile = readFileSync }) {
  try {
    const raw = JSON.parse(String(readFile(path, 'utf8')).replace(/^\uFEFF/, ''))
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('not an object')
    const records = raw.records
    if (records === null || typeof records !== 'object' || Array.isArray(records)) {
      return { version: ROLLBACK_LOG_VERSION, records: {}, problem: 'records field is not an object' }
    }
    return { version: ROLLBACK_LOG_VERSION, records, problem: null }
  } catch (error) {
    if (error?.code === 'ENOENT') return { version: ROLLBACK_LOG_VERSION, records: {}, problem: null }
    return { version: ROLLBACK_LOG_VERSION, records: {}, problem: 'rollback log could not be read' }
  }
}

/**
 * Write the rollback log atomically.
 * @param options - `{ path, log, writeFile?, rename?, mkdir? }`.
 */
export function writeRollbackLog({
  path,
  log,
  writeFile = writeFileSync,
  rename = renameSync,
  mkdir = mkdirSync,
}) {
  mkdir(dirname(path), { recursive: true })
  const document = { version: ROLLBACK_LOG_VERSION, records: log.records ?? {} }
  const temporary = `${path}.tmp`
  writeFile(temporary, JSON.stringify(document, null, 2), 'utf8')
  rename(temporary, path)
}

/**
 * Return a new log with the rollback point for one bundle recorded.
 * @param log - current log.
 * @param entry - `{ name, version, at }`.
 * @returns a new log object.
 */
export function recordRollbackPoint(log, { name, version, at }) {
  return {
    version: ROLLBACK_LOG_VERSION,
    records: { ...(log.records ?? {}), [name]: { version, recordedAt: at } },
    problem: null,
  }
}

/**
 * Read the recorded rollback target for one bundle.
 * @param log - current log.
 * @param name - bundle name.
 * @returns the recorded version, or `null`.
 */
export function rollbackTargetOf(log, name) {
  const record = log?.records?.[name]
  if (record === null || typeof record !== 'object' || Array.isArray(record)) return null
  return typeof record.version === 'string' && record.version !== '' ? record.version : null
}

/**
 * Translate a `ChangeResult.application` into the guidance the tab shows.
 *
 * `restart-required` in particular must never be rendered as "done": the new
 * package files are on disk but the running process still holds the old module
 * generation.
 * @param application - the value from `ChangeResult`.
 * @returns a stable guidance code.
 */
export function guidanceFor(application) {
  switch (application) {
    case 'applied':
      return 'live'
    case 'restart-required':
      return 'restart-to-load-new-generation'
    case 'overridden':
      return 'higher-priority-layer-wins'
    case 'failed':
      return 'failed'
    case 'cancelled':
      return 'cancelled'
    default:
      return 'unknown-application'
  }
}
