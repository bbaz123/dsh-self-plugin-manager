/**
 * Which DeepSeek Harness runtime this process is actually running on.
 *
 * Needed by the compatibility view: `setVersionExemption` takes the exact
 * runtime version, and the CLI/tool that grants an exemption prints it, but no
 * Cordis Service exposes it (`pluginManager.listVersionExemptions()` returns
 * only `{ exemptions, warnings }` on the wire). The `@deepseek-ai/dsh-*`
 * packages are released in lockstep, so any resolvable shipped package's
 * version is the runtime version; the specifier that answered is returned
 * alongside it so the answer is auditable rather than asserted.
 *
 * @module dsh-self-plugin-manager/runtime
 */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

/**
 * Shipped packages checked in order. The first is the Gateway itself, which any
 * Web profile necessarily has; the rest are progressively less specific.
 */
export const VERSION_SOURCES = Object.freeze([
  '@deepseek-ai/dsh-api-gateway/package.json',
  '@deepseek-ai/dsh-typert-protocol/package.json',
  '@deepseek-ai/dsh-package-manifest/package.json',
])

/**
 * Resolve the running Harness version.
 * @param options - `{ readFile?, resolve? }` for tests.
 * @returns `{ version, source }`; both `null` when nothing resolved.
 */
export function detectRuntimeVersion({ readFile = readFileSync, resolve = (spec) => require.resolve(spec) } = {}) {
  for (const spec of VERSION_SOURCES) {
    try {
      const manifestPath = resolve(spec)
      const parsed = JSON.parse(readFile(manifestPath, 'utf8'))
      const version = parsed?.version
      if (typeof version === 'string' && version !== '') return { version, source: spec }
    } catch {
      // A missing or malformed candidate simply moves on to the next one; the
      // compatibility view renders `null` rather than inventing a version.
    }
  }
  return { version: null, source: null }
}
