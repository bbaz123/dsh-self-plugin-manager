/**
 * The plugin's Remote surface: one source of truth for what crosses the
 * Gateway, plus the Host-side marker that makes it resolvable.
 *
 * Two faces must agree, and they are built by different mechanisms:
 *
 *   * the **Host** face derives its descriptors at call time (SRC mode) from
 *     the live Service. `@deepseek-ai/dsh-api-gateway` looks the endpoint up in
 *     the Typert registry, finds no generated strict definition for this
 *     package (it ships no `./typert` export), and falls back to deriving the
 *     descriptor from `remoteMethods(service)` plus the method signature. The
 *     marker is normally written by the `@Remote` decorator, which needs the
 *     decorator transform; this module writes the identical prototype property
 *     by hand so the plugin stays plain ESM with no build step.
 *   * the **Client** face mounts a contribution whose parameter codecs
 *     `requireStrictInputs` demands be `{ mode: 'strict' }`. Nothing calls a
 *     codec's `create()` on this path — the Client copies values straight into
 *     `args` and the Host SRC descriptor decodes them as `src-json` — so the
 *     codec needs a non-empty `typeSymbol` and a callable `create`, and nothing
 *     else. That is what {@link strictCodec} returns, with no `zod` dependency.
 *
 * `test/wire.test.mjs` compares this table against the table embedded in
 * `client.js`, which cannot import it because the Client artifact is loaded
 * through `window.__ModuleLoader__.load`.
 *
 * @module dsh-self-plugin-manager/wire
 */

/** The prototype property the shipped `@Remote` decorator writes. */
export const REMOTE_METHOD_DESCRIPTOR = '@deepseek-ai/dsh-typert-protocol/remote-methods'

/** Package name; must equal `package.json` `name` and the patch row `name`. */
export const PACKAGE_NAME = 'dsh-self-plugin-manager'

/** Cordis service key and Gateway namespace. */
export const NAMESPACE = 'selfPlugins'

/**
 * Every Remote method with its wire fields, in declaration order.
 *
 * Parameters are plain identifiers on purpose: the Host's SRC derivation
 * rejects destructuring, defaults, and rest parameters.
 */
export const REMOTE_METHODS = Object.freeze([
  Object.freeze({ method: 'overview', wires: Object.freeze([]) }),
  Object.freeze({ method: 'check', wires: Object.freeze(['name']) }),
  Object.freeze({ method: 'update', wires: Object.freeze(['name', 'acknowledgedUncovered']) }),
  Object.freeze({ method: 'rollback', wires: Object.freeze(['name', 'acknowledgedUncovered']) }),
])

/**
 * Build a dependency-free strict wire codec.
 * @param typeSymbol - non-empty identity the registry validates.
 * @returns a frozen `{ mode, typeSymbol, create }` codec.
 */
export function strictCodec(typeSymbol) {
  return Object.freeze({
    mode: 'strict',
    typeSymbol,
    // Never invoked on this path; present because the registry requires a
    // callable factory on every strict codec.
    create: () => Object.freeze({}),
  })
}

/**
 * Attach the Remote marker to a Service prototype, mirroring what the shipped
 * decorator does through its initializer.
 * @param prototype - the Service class prototype.
 * @param methods - method names to mark; defaults to {@link REMOTE_METHODS}.
 * @returns the same prototype, for chaining.
 */
export function markRemoteMethods(prototype, methods = REMOTE_METHODS.map((entry) => entry.method)) {
  const markers = methods.map((method) =>
    Object.freeze({ method, invocation: Object.freeze({ kind: 'direct' }) }),
  )
  Object.defineProperty(prototype, REMOTE_METHOD_DESCRIPTOR, {
    configurable: true,
    value: Object.freeze({ version: 1, methods: Object.freeze(markers) }),
  })
  return prototype
}

/**
 * Build the Client Remote contribution this package mounts.
 *
 * Used by `verify/wiring.mjs` to exercise the real Gateway Client validator;
 * `client.js` carries the same table inline for the browser.
 * @returns a `TypertRemoteContribution`-shaped object.
 */
export function buildContribution() {
  return {
    package: PACKAGE_NAME,
    descriptors: REMOTE_METHODS.map(({ method, wires }) => ({
      id: `${PACKAGE_NAME}#${NAMESPACE}/${method}`,
      service: NAMESPACE,
      namespace: NAMESPACE,
      method,
      invocation: { kind: 'direct' },
      parameters: wires.map((wire) => ({
        name: wire,
        wire,
        source: 'json',
        acceptsUndefined: true,
        codec: strictCodec(`${PACKAGE_NAME}#${NAMESPACE}/${method}:${wire}`),
      })),
      result: strictCodec(`${PACKAGE_NAME}#${NAMESPACE}/${method}:result`),
      sourceLocation: { file: 'lib/wire.js', line: 1, column: 1 },
    })),
  }
}
