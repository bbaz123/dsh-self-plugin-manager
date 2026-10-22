/**
 * Registry resolution for the self-installation manager: pure functions only.
 * The one process this plugin starts is spawned by `service.js`, which builds
 * its argument vector here.
 *
 * **Why this module exists.** The Host's `pluginManager.inspect(spec)` refuses
 * any package the profile already holds: DSH 0.2.0-rc.2 answers
 * `problem: 'already-installed'` before it ever asks a registry
 * (`dsh-plugin-manager/lib/index.js`). That is the right answer for a
 * pre-install check of a *new* spec, and a useless one for "is there a newer
 * version of something I already have" — every bundle this plugin can act on is
 * installed by definition. The Host exposes no other way to ask; its whole
 * surface is `cancelInstall` / `inspect` / `installBundle` / `listBundles` /
 * `listPlugins` / `listVersionExemptions` / `registries` / `removeBundle` /
 * `setBundleEnabled` / `setPluginEnabled` / `setVersionExemption` /
 * `waitForInstall`, and `BundleInfo` carries no "latest version" field.
 *
 * So this plugin asks the way the Host asks for itself: `pnpm view <name>
 * version --json`, run inside the profile directory, so the same `.npmrc`,
 * proxy, and authentication settings apply as to an install. `pnpm` is invoked
 * with a bare package name the caller cannot choose freely (see
 * `service.findSelfBundle`) and with a registry that must pass
 * {@link isSafeRegistryUrl}; every argument is validated here because on
 * Windows the command goes through `cmd.exe` (see {@link pnpmViewInvocation}).
 *
 * @module dsh-self-plugin-manager/registry
 */

/**
 * Upper bound on one registry question. Mirrors the Host's `inspectTimeoutMs`
 * default so a check behaves like the Host's own pre-install lookup.
 */
export const REGISTRY_LOOKUP_TIMEOUT_MS = 20_000

/** Addresses treated as the public npm registry. */
const PUBLIC_REGISTRIES = Object.freeze(['https://registry.npmjs.org', 'http://registry.npmjs.org'])

/** npm package name shape; deliberately excludes every shell metacharacter. */
const PACKAGE_NAME = /^(?:@[A-Za-z0-9][A-Za-z0-9._~-]*\/)?[A-Za-z0-9][A-Za-z0-9._~-]*$/

/** One version as a registry would print it. */
const VERSION = /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]*)?$/

/** Characters that could change the meaning of a command line. */
const UNSAFE_URL_CHARACTERS = /["'`%^&|<>\\\s]/

/**
 * Whether a package name is safe to pass as a command argument.
 * @param name - candidate package name.
 * @returns true for npm-shaped names with no shell metacharacters.
 */
export function isSafePackageName(name) {
  return typeof name === 'string' && PACKAGE_NAME.test(name)
}

/**
 * Whether a registry URL is safe to pass as a command argument.
 * @param url - candidate registry URL.
 * @returns true for a trim-clean http(s) URL with no shell metacharacter.
 */
export function isSafeRegistryUrl(url) {
  if (typeof url !== 'string' || url === '' || url.trim() !== url) return false
  if (UNSAFE_URL_CHARACTERS.test(url)) return false
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:'
  } catch {
    return false
  }
}

/**
 * Compare registries the way pnpm does: case-insensitive, no trailing slash.
 * @param url - registry URL, or `null` for "pnpm's own configuration".
 * @returns the comparable form, or `null`.
 */
export function normalizeRegistry(url) {
  if (typeof url !== 'string') return null
  const trimmed = url.trim().replace(/\/+$/, '')
  return trimmed === '' ? null : trimmed.toLowerCase()
}

/**
 * Whether leaving this registry for another one is allowed at all.
 *
 * Only the public npm registry and registries the deployment itself declared as
 * fallbacks qualify. A private first registry keeps the question to itself, so
 * a private package name never leaks into a public mirror.
 * @param address - the address the first question would go to.
 * @param fallbacks - the deployment's declared fallbacks.
 * @returns true when another registry may be asked after this one.
 */
export function isPublicRegistry(address, fallbacks = []) {
  const normalized = normalizeRegistry(address)
  if (normalized === null) return false
  if (PUBLIC_REGISTRIES.includes(normalized)) return true
  return fallbacks.some((fallback) => normalizeRegistry(fallback) === normalized)
}

/**
 * Build the ordered list of registries to ask.
 *
 * The first entry is the configured registry, or `null` for pnpm's own
 * configuration (the Host's `registries().registry` may be `null`, and the
 * Host's `resolved` names what pnpm's own configuration points at). Fallbacks
 * are appended only while the first address is public, and never twice.
 * @param registries - the Host's `pluginManager.registries()` answer, or `null`.
 * @returns registry entries, each a URL string or `null`.
 */
export function registryPlan(registries) {
  const configured = isSafeRegistryUrl(registries?.registry) ? registries.registry : null
  const fallbacks = Array.isArray(registries?.fallbackRegistries)
    ? registries.fallbackRegistries.filter(isSafeRegistryUrl)
    : []
  const resolved = isSafeRegistryUrl(registries?.resolved) ? registries.resolved : null
  const firstAddress = configured ?? resolved

  const plan = [configured]
  if (!isPublicRegistry(firstAddress, fallbacks)) return plan

  for (const fallback of fallbacks) {
    if (normalizeRegistry(fallback) === normalizeRegistry(firstAddress)) continue
    if (plan.some((entry) => normalizeRegistry(entry) === normalizeRegistry(fallback))) continue
    plan.push(fallback)
  }
  return plan
}

/**
 * Build the command that asks one registry for one package's current version.
 *
 * On Windows the npm-provided `pnpm` shim is `pnpm.cmd`, and Node can only
 * execute a `.cmd` through a shell (it searches for `pnpm.exe` only), so the
 * command goes through `cmd.exe` there. Both the name and the registry are
 * validated before they reach this function — {@link isSafePackageName} in
 * `service.resolveLatest`, {@link isSafeRegistryUrl} in
 * {@link registryPlan} — so joining them into a shell command cannot inject
 * anything. On every other platform the child is spawned without a shell.
 * @param name - validated package name.
 * @param registry - validated registry URL, or `null` for pnpm's own config.
 * @param platform - `process.platform` value deciding the shell need.
 * @returns `{ command, args, shell }`.
 */
export function pnpmViewInvocation(name, registry, platform = process.platform) {
  const args = ['view', name, 'version', '--json']
  if (typeof registry === 'string' && registry !== '') args.push('--registry', registry)
  if (platform === 'win32') {
    // A single command string rather than an args array: Node cannot execute the
    // npm-provided `pnpm.cmd` shim without a shell, and on Node 24 passing an
    // args array together with `shell: true` is deprecated (DEP0190) precisely
    // because Node would concatenate it unescaped. Every token here has already
    // been validated to contain no whitespace or shell metacharacter, so the
    // joined command is the same string either way.
    return { command: ['pnpm', ...args].join(' '), args: [], shell: true }
  }
  return { command: 'pnpm', args, shell: false }
}

/**
 * Read the version out of `pnpm view <name> version --json` output.
 * @param stdout - the command's standard output.
 * @returns the version, or `null` when the output is not an answer.
 */
export function parsePnpmViewVersion(stdout) {
  const text = typeof stdout === 'string' ? stdout.trim() : ''
  if (text === '') return null
  try {
    const parsed = JSON.parse(text)
    if (typeof parsed === 'string') return versionOrNull(parsed)
    if (Array.isArray(parsed)) {
      const last = parsed.at(-1)
      return typeof last === 'string' ? versionOrNull(last) : null
    }
    if (parsed !== null && typeof parsed === 'object' && typeof parsed.version === 'string') {
      return versionOrNull(parsed.version)
    }
    return null
  } catch {
    // Not JSON: accept only an output that is nothing but a version.
    return versionOrNull(text)
  }
}

/**
 * Accept a version and normalize away the `v` some registries print.
 * @param value - candidate text.
 * @returns the version, or `null`.
 */
function versionOrNull(value) {
  if (!VERSION.test(value)) return null
  return value.startsWith('v') ? value.slice(1) : value
}

/**
 * Classify why one registry question produced no version.
 * @param run - one `runPnpmView` result.
 * @returns `'timeout'` | `'pnpm-missing'` | `'not-found'` | `'network'` | `'unknown'`.
 */
export function classifyRegistryFailure(run) {
  if (run?.timedOut === true) return 'timeout'
  if (run?.spawnError === 'ENOENT' || run?.spawnError === 'pnpm-missing') return 'pnpm-missing'
  const text = `${run?.stderr ?? ''}\n${run?.stdout ?? ''}`
  if (/ERR_PNPM_FETCH_404|ERR_PNPM_NO_MATCHING_VERSION|E404|Not Found - 404|No matching version/i.test(text)) {
    return 'not-found'
  }
  if (
    /ERR_PNPM_META_FETCH_FAIL|ERR_PNPM_FETCH_|fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|network|timed out/i.test(
      text,
    )
  ) {
    return 'network'
  }
  return 'unknown'
}

/**
 * Whether a failure is attributable to the registry that answered, and so
 * justifies asking the next one. Anything else stops the lookup: a missing
 * `pnpm` is not fixed by another registry, and an unreadable failure is not
 * evidence that the next registry would do better.
 * @param kind - a {@link classifyRegistryFailure} result.
 * @returns true when the next registry may be asked.
 */
export function continuesToNextRegistry(kind) {
  return kind === 'not-found' || kind === 'network' || kind === 'timeout'
}
