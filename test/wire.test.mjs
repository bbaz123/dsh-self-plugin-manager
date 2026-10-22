/**
 * Remote-surface tests, including the two drift guards that protect values
 * whose mismatch is not a cosmetic defect:
 *
 *   * `client.js` cannot import `lib/wire.js` (it is loaded through
 *     `window.__ModuleLoader__.load`), so its descriptor table is a copy; the
 *     two tables must be compared mechanically rather than trusted.
 *   * the patch row's `id`/`name` and the `name` in `package.json` must match,
 *     because a row whose module name does not resolve fails the whole profile
 *     at startup (`assertEntriesActivated`), not just this plugin.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { NAMESPACE, PACKAGE_NAME, REMOTE_METHODS, buildContribution, markRemoteMethods, strictCodec } from '../lib/wire.js'
import { SelfPluginsService } from '../lib/service.js'

const clientSource = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const patchSource = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const indexSource = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')

/** Extract the `REMOTE_METHODS` literal embedded in `client.js`. */
function clientMethodTable() {
  const start = clientSource.indexOf('const REMOTE_METHODS = [')
  assert.notEqual(start, -1, 'client.js no longer declares REMOTE_METHODS')
  const end = clientSource.indexOf('\n    ]', start)
  assert.notEqual(end, -1, 'client.js REMOTE_METHODS block is not terminated as expected')
  const block = clientSource.slice(start, end)
  const pattern = /\{\s*method:\s*'([^']+)',\s*wires:\s*\[([^\]]*)\]\s*\}/g
  const table = []
  for (const match of block.matchAll(pattern)) {
    const wires = match[2]
      .split(',')
      .map((field) => field.trim().replace(/^'|'$/g, ''))
      .filter((field) => field !== '')
    table.push({ method: match[1], wires })
  }
  return table
}

test('package name is one value everywhere it is asserted', () => {
  assert.equal(manifest.name, PACKAGE_NAME)
  assert.match(patchSource, new RegExp(`^\\s+name: '${PACKAGE_NAME}'$`, 'm'), 'the patch row must name this package')
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(manifest.exports['./client'].default, './client.js')
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.ok(
    manifest.dsh.client.inject.includes('@deepseek-ai/dsh-api-remotes'),
    'the Client half must activate after the Remote assembly it depends on',
  )
})

test('the host row config declares only keys the Config schema accepts', () => {
  const configBlock = patchSource.slice(patchSource.indexOf('config:'))
  const declared = [...configBlock.matchAll(/^ {8}([A-Za-z][A-Za-z0-9]*):/gm)].map((match) => match[1])
  assert.ok(declared.length > 0, 'the patch row declares no config keys')
  for (const key of declared) {
    assert.match(indexSource, new RegExp(`\\b${key}\\b`), `Config schema does not mention ${key}`)
  }
})

test('the Client descriptor table matches lib/wire.js', () => {
  assert.deepEqual(
    clientMethodTable(),
    REMOTE_METHODS.map(({ method, wires }) => ({ method, wires: [...wires] })),
  )
})

test('the Client half mounts the same namespace the Host publishes', () => {
  assert.match(clientSource, new RegExp(`const NAMESPACE = '${NAMESPACE}'`))
  assert.match(clientSource, new RegExp(`const PACKAGE = '${PACKAGE_NAME}'`))
})

test('strictCodec carries exactly what the two shipped validators require', () => {
  const codec = strictCodec('x#y')
  assert.equal(codec.mode, 'strict')
  assert.equal(codec.typeSymbol, 'x#y')
  assert.equal(typeof codec.create, 'function')
  assert.equal(Object.isFrozen(codec), true)
})

test('buildContribution produces one descriptor per method with unique ids', () => {
  const contribution = buildContribution()
  assert.equal(contribution.package, PACKAGE_NAME)
  assert.deepEqual(
    contribution.descriptors.map((descriptor) => descriptor.method),
    REMOTE_METHODS.map(({ method }) => method),
  )
  const ids = new Set(contribution.descriptors.map((descriptor) => descriptor.id))
  assert.equal(ids.size, contribution.descriptors.length)
  for (const descriptor of contribution.descriptors) {
    assert.equal(descriptor.invocation.kind, 'direct')
    assert.equal(descriptor.service, NAMESPACE)
    for (const parameter of descriptor.parameters) {
      assert.equal(parameter.source, 'json')
      assert.equal(parameter.wire, parameter.name)
      assert.equal(parameter.codec.mode, 'strict')
    }
  }
})

test('markRemoteMethods is readable by the shipped remoteMethods()', () => {
  class Subject {
    overview() {}
    check(name) {
      return name
    }
  }
  markRemoteMethods(Subject.prototype, ['overview', 'check'])
  const markers = remoteMethods(new Subject())
  assert.deepEqual(markers.map((marker) => marker.method), ['overview', 'check'])
  assert.equal(markers[0].invocation.kind, 'direct')
})

test('the service exposes exactly the declared Remote methods', () => {
  const ctx = new Context()
  const service = new SelfPluginsService(ctx, {})
  const markers = remoteMethods(service).map((marker) => marker.method)
  assert.deepEqual(markers, REMOTE_METHODS.map(({ method }) => method))
  for (const marker of markers) {
    assert.equal(typeof service[marker], 'function')
  }
})
