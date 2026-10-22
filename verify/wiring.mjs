/**
 * Composition verification: does the hand-written Remote surface survive the
 * real validators?
 *
 * This is the check the plan called "Phase 0". The plugin deliberately avoids
 * the `@Remote` decorator (which needs a decorator transform) and avoids
 * `zod`-backed codecs (which would add a runtime dependency), so the claim that
 * the shipped Gateway still accepts its descriptors is not obvious and must be
 * demonstrated against the shipped code rather than argued.
 *
 * Run: node verify/wiring.mjs
 */

import { Context } from '@deepseek-ai/cordis'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { TypertRegistry } from '@deepseek-ai/dsh-typert-registry'
import { SelfPluginsService } from '../lib/service.js'
import { NAMESPACE, REMOTE_METHODS, REMOTE_METHOD_DESCRIPTOR, buildContribution } from '../lib/wire.js'

let failures = 0

/**
 * Run one assertion group.
 * @param label - what is being checked.
 * @param body - the check.
 */
async function check(label, body) {
  try {
    await body()
    console.log(`PASS ${label}`)
  } catch (error) {
    failures += 1
    console.error(`FAIL ${label}`)
    console.error(`     ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Throw unless `condition`. */
function assert(condition, message) {
  if (condition !== true) throw new Error(message)
}

const expectedMethods = REMOTE_METHODS.map((entry) => entry.method)

const ctx = new Context()
new TypertRegistry(ctx)
const service = new SelfPluginsService(ctx, {})

await check('Service publishes the Gateway binding the Host dispatcher requires', () => {
  const binding = service.typertRemote
  assert(binding !== undefined && binding !== null, 'typertRemote is absent; bindTypertRemote did not run')
  assert(binding.serviceKey === NAMESPACE, `serviceKey is ${String(binding.serviceKey)}, expected ${NAMESPACE}`)
  assert(binding.namespace === NAMESPACE, `namespace is ${String(binding.namespace)}, expected ${NAMESPACE}`)
  assert(binding.service === service, 'the binding does not point at this service instance')
})

await check('The hand-written prototype marker is read by the shipped remoteMethods()', () => {
  const descriptor = Object.getOwnPropertyDescriptor(SelfPluginsService.prototype, REMOTE_METHOD_DESCRIPTOR)
  assert(descriptor !== undefined, `prototype has no ${REMOTE_METHOD_DESCRIPTOR} property`)
  const markers = remoteMethods(service)
  assert(
    JSON.stringify(markers.map((marker) => marker.method)) === JSON.stringify(expectedMethods),
    `remoteMethods() returned ${JSON.stringify(markers.map((marker) => marker.method))}, expected ${JSON.stringify(expectedMethods)}`,
  )
  for (const marker of markers) {
    assert(marker.invocation?.kind === 'direct', `${marker.method} is not a direct invocation`)
  }
})

await check('Every marked method exists on the prototype with a plain SRC-safe signature', () => {
  for (const { method, wires } of REMOTE_METHODS) {
    const implementation = SelfPluginsService.prototype[method]
    assert(typeof implementation === 'function', `${method} is not a prototype method`)
    // The Host derives SRC parameters from the method name list, so a default or
    // rest parameter would silently change the wire field set.
    assert(
      implementation.length === wires.length,
      `${method} declares ${String(implementation.length)} plain parameters, expected ${String(wires.length)}`,
    )
    const source = implementation.toString().slice(0, implementation.toString().indexOf('{'))
    assert(!source.includes('...'), `${method} uses a rest parameter, which SRC derivation rejects`)
    assert(!source.includes('='), `${method} uses a default parameter, which SRC derivation rejects`)
  }
})

await check('Every parameter codec satisfies the Gateway Client strict-input and registry codec rules', () => {
  // Two shipped validators, both mirrored here:
  //   * api-gateway client `requireStrictInputs` -> every parameter codec must
  //     have `mode === 'strict'`;
  //   * dsh-typert-registry `validateCodec` -> a strict codec needs a non-empty
  //     `typeSymbol` and a callable `create`.
  const contribution = buildContribution()
  for (const descriptor of contribution.descriptors) {
    for (const parameter of descriptor.parameters) {
      assert(parameter.codec.mode === 'strict', `${descriptor.method}/${parameter.wire} codec is not strict`)
      assert(
        typeof parameter.codec.typeSymbol === 'string' && parameter.codec.typeSymbol !== '',
        `${descriptor.method}/${parameter.wire} codec has no typeSymbol`,
      )
      assert(typeof parameter.codec.create === 'function', `${descriptor.method}/${parameter.wire} codec has no create()`)
    }
    assert(descriptor.result.mode === 'strict', `${descriptor.method} result codec is not strict`)
    assert(typeof descriptor.result.create === 'function', `${descriptor.method} result codec has no create()`)
  }
})

await check('The real Typert registry accepts the contribution and publishes its endpoints', () => {
  const dispose = ctx.typert.remotes.register(buildContribution())
  const endpoints = ctx.typert.remotes.list().map((descriptor) => `${descriptor.namespace}/${descriptor.method}`)
  for (const method of expectedMethods) {
    assert(endpoints.includes(`${NAMESPACE}/${method}`), `${NAMESPACE}/${method} was not registered`)
    const stored = ctx.typert.remotes.get(`${NAMESPACE}/${method}`)
    assert(stored !== undefined, `${NAMESPACE}/${method} has no stored descriptor`)
    assert(stored.service === NAMESPACE, `${NAMESPACE}/${method} names service ${String(stored.service)}`)
  }
  return dispose()
})

await check('Registration is withdrawable, so uninstall leaves nothing behind', async () => {
  const before = ctx.typert.remotes.list().length
  const dispose = ctx.typert.remotes.register(buildContribution())
  assert(ctx.typert.remotes.list().length === before + expectedMethods.length, 'registration did not add every endpoint')
  await dispose()
  assert(ctx.typert.remotes.list().length === before, 'disposal left endpoints registered')
})

if (failures > 0) {
  console.error(`\n${String(failures)} check(s) failed`)
  process.exitCode = 1
} else {
  console.log(`\nall wiring checks passed`)
}
