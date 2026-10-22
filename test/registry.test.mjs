/**
 * Unit tests for the registry-resolution helpers.
 *
 * These pin the two things a stubbed process runner cannot catch: the argument
 * vector handed to `pnpm` (including the Windows shell need) and the refusal
 * semantics that decide whether another registry is asked at all.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  REGISTRY_LOOKUP_TIMEOUT_MS,
  classifyRegistryFailure,
  continuesToNextRegistry,
  isPublicRegistry,
  isSafePackageName,
  isSafeRegistryUrl,
  normalizeRegistry,
  parsePnpmViewVersion,
  pnpmViewInvocation,
  registryPlan,
} from '../lib/registry.js'

test('the argument vector asks one registry for one package version', () => {
  assert.deepEqual(pnpmViewInvocation('demo-plugin', null, 'linux'), {
    command: 'pnpm',
    args: ['view', 'demo-plugin', 'version', '--json'],
    shell: false,
  })
  assert.deepEqual(pnpmViewInvocation('@scope/demo', 'https://registry.npmjs.org/', 'darwin'), {
    command: 'pnpm',
    args: ['view', '@scope/demo', 'version', '--json', '--registry', 'https://registry.npmjs.org/'],
    shell: false,
  })
  // The npm shim is `pnpm.cmd` on Windows and Node cannot run a .cmd without a
  // shell, so this one platform goes through cmd.exe — with a single command
  // string, because Node 24 deprecates an args array together with `shell: true`
  // (DEP0190: Node would concatenate it unescaped).
  assert.deepEqual(pnpmViewInvocation('demo-plugin', null, 'win32'), {
    command: 'pnpm view demo-plugin version --json',
    args: [],
    shell: true,
  })
  assert.equal(
    pnpmViewInvocation('demo-plugin', 'https://registry.npmjs.org/', 'win32').command,
    'pnpm view demo-plugin version --json --registry https://registry.npmjs.org/',
  )
})

test('a timeout bound exists for exactly one registry question', () => {
  assert.equal(REGISTRY_LOOKUP_TIMEOUT_MS, 20_000)
})

test('package names that could reach a shell are refused', () => {
  for (const name of ['demo-plugin', '@scope/demo.plugin', 'a_b~c', 'Demo9']) {
    assert.equal(isSafePackageName(name), true, name)
  }
  for (const name of [
    '',
    'demo plugin',
    'demo&calc',
    'demo"x',
    "demo'x",
    'demo|calc',
    'demo>out',
    'demo%PATH%',
    'demo^escape',
    '-demo',
    '@scope/',
    '@scope/demo name',
    '../../etc',
    undefined,
    null,
    7,
  ]) {
    assert.equal(isSafePackageName(name), false, String(name))
  }
})

test('only a trim-clean http(s) registry URL is accepted', () => {
  for (const url of ['https://registry.npmjs.org/', 'https://registry.npmjs.org', 'http://localhost:4873/']) {
    assert.equal(isSafeRegistryUrl(url), true, url)
  }
  for (const url of [
    '',
    ' registry.npmjs.org',
    'registry.npmjs.org',
    'https://x/ y',
    'https://x/"y"',
    'https://x/y%20z',
    'https://x/y^z',
    'https://x/y&z',
    'ftp://registry.npmjs.org/',
    undefined,
  ]) {
    assert.equal(isSafeRegistryUrl(url), false, String(url))
  }
})

test('registry addresses compare the way pnpm writes them', () => {
  assert.equal(normalizeRegistry('https://Registry.NPMJS.org'), 'https://registry.npmjs.org')
  assert.equal(normalizeRegistry('https://registry.npmjs.org///'), 'https://registry.npmjs.org')
  assert.equal(normalizeRegistry(null), null)
  assert.equal(normalizeRegistry('/'), null)
})

test('only a public first registry may be left for another one', () => {
  const fallbacks = ['https://registry.npmmirror.com/']
  assert.equal(isPublicRegistry('https://registry.npmjs.org/', fallbacks), true)
  assert.equal(isPublicRegistry('https://registry.npmmirror.com', fallbacks), true)
  assert.equal(isPublicRegistry('https://npm.corp.example/', fallbacks), false)
  assert.equal(isPublicRegistry(null, fallbacks), false)
})

test('the plan asks the configured registry first and its fallbacks after', () => {
  assert.deepEqual(
    registryPlan({
      registry: 'https://registry.npmjs.org/',
      fallbackRegistries: ['https://registry.npmmirror.com/', 'https://registry.npmjs.org'],
      resolved: null,
    }),
    ['https://registry.npmjs.org/', 'https://registry.npmmirror.com/'],
  )
})

test('a private first registry keeps the question to itself', () => {
  assert.deepEqual(
    registryPlan({
      registry: 'https://npm.corp.example/',
      fallbackRegistries: ['https://registry.npmmirror.com/'],
      resolved: 'https://npm.corp.example/',
    }),
    ['https://npm.corp.example/'],
  )
})

test('pnpm-owned configuration is asked once even when its address is also a fallback', () => {
  assert.deepEqual(
    registryPlan({
      registry: null,
      fallbackRegistries: ['https://registry.npmmirror.com/'],
      resolved: 'https://registry.npmmirror.com/',
    }),
    [null],
  )
  // An unreadable address for a pnpm-owned registry cannot be proven public, so
  // nothing is asked after it either.
  assert.deepEqual(
    registryPlan({ registry: null, fallbackRegistries: ['https://registry.npmmirror.com/'], resolved: null }),
    [null],
  )
})

test('an unusable registry plan degrades to pnpm own configuration', () => {
  assert.deepEqual(registryPlan(null), [null])
  assert.deepEqual(registryPlan({ registry: 'not a url', fallbackRegistries: ['also bad'] }), [null])
})

test('a version is read from every shape pnpm answers with', () => {
  assert.equal(parsePnpmViewVersion('"1.2.3"'), '1.2.3')
  assert.equal(parsePnpmViewVersion('"1.2.3"\n'), '1.2.3')
  assert.equal(parsePnpmViewVersion('1.2.3'), '1.2.3')
  assert.equal(parsePnpmViewVersion('v1.2.3'), '1.2.3')
  assert.equal(parsePnpmViewVersion('["1.0.0","2.0.0"]'), '2.0.0')
  assert.equal(parsePnpmViewVersion('["1.0.0"]'), '1.0.0')
  assert.equal(parsePnpmViewVersion('{"version":"3.0.0"}'), '3.0.0')
  assert.equal(parsePnpmViewVersion('0.3.0-rc.1'), '0.3.0-rc.1')
})

test('anything that is not an answer is not read as a version', () => {
  for (const stdout of [
    '',
    '   ',
    'not json',
    '{"error":{"code":"ERR_PNPM_FETCH_404"}}',
    '{"version":"not-a-version"}',
    '{"version":2}',
    'Progress: resolved 1',
    undefined,
  ]) {
    assert.equal(parsePnpmViewVersion(stdout), null, String(stdout))
  }
})

test('a failure is attributed to the registry only when it really is', () => {
  assert.equal(classifyRegistryFailure({ timedOut: true }), 'timeout')
  assert.equal(classifyRegistryFailure({ spawnError: 'ENOENT' }), 'pnpm-missing')
  assert.equal(
    classifyRegistryFailure({ stdout: '{"error":{"code":"ERR_PNPM_FETCH_404"}}', exitCode: 1 }),
    'not-found',
  )
  assert.equal(
    classifyRegistryFailure({ stderr: 'GET https://x/y: Not Found - 404', exitCode: 1 }),
    'not-found',
  )
  assert.equal(
    classifyRegistryFailure({ stdout: '{"error":{"code":"ERR_PNPM_META_FETCH_FAIL"}}', exitCode: 1 }),
    'network',
  )
  assert.equal(classifyRegistryFailure({ stderr: 'getaddrinfo ENOTFOUND', exitCode: 1 }), 'network')
  assert.equal(classifyRegistryFailure({ stderr: 'some unexpected failure', exitCode: 1 }), 'unknown')
  assert.equal(classifyRegistryFailure({ exitCode: 1 }), 'unknown')
  assert.equal(classifyRegistryFailure(undefined), 'unknown')
})

test('only a registry-attributable failure justifies asking the next one', () => {
  assert.equal(continuesToNextRegistry('not-found'), true)
  assert.equal(continuesToNextRegistry('network'), true)
  assert.equal(continuesToNextRegistry('timeout'), true)
  assert.equal(continuesToNextRegistry('pnpm-missing'), false)
  assert.equal(continuesToNextRegistry('unknown'), false)
})
