/**
 * Lossless-JSON normalisation for Remote results.
 *
 * The Host result encoder copies plain objects field by field and leaves an
 * `undefined` value in place, while `JSON.stringify` then silently drops that
 * key and the Client's own uplink check rejects nested `undefined`. Every value
 * this plugin returns crosses the Gateway, so it is normalised once, here,
 * instead of relying on which layer happens to tolerate what: `undefined` keys
 * are dropped, non-finite numbers become `null`, and only plain objects and
 * arrays survive as containers.
 *
 * @module dsh-self-plugin-manager/json-safe
 */

/**
 * Deep-copy a value into a lossless-JSON shape.
 * @param value - candidate value.
 * @returns a JSON-safe copy; `undefined` becomes `null` at the root.
 */
export function jsonSafe(value) {
  if (value === undefined) return null
  if (value === null) return null
  const kind = typeof value
  if (kind === 'string' || kind === 'boolean') return value
  if (kind === 'number') return Number.isFinite(value) ? value : null
  if (kind !== 'object') return null
  if (Array.isArray(value)) return value.map((item) => jsonSafe(item))
  const copy = {}
  for (const key of Object.keys(value)) {
    const item = value[key]
    if (item === undefined) continue
    copy[key] = jsonSafe(item)
  }
  return copy
}
