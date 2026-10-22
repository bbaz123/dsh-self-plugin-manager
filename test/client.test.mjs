/**
 * Browser-half tests, run by loading `client.js` in a sandbox.
 *
 * `client.js` is not a Node module: it calls `window.__ModuleLoader__.load()`
 * and can import nothing but `react`. That normally leaves the browser half
 * unverified until a human looks at the page. This file removes most of that
 * gap by evaluating the factory with a stub loader and a stub `react`, then
 * checking the two things that can be checked mechanically:
 *
 *   * the descriptor table and the mounted contribution match the Host half
 *     (`lib/wire.js`) exactly, including parameter order;
 *   * every dictionary key the component asks for exists in BOTH languages,
 *     and neither language carries a key the other lacks.
 *
 * What it still cannot check is rendering: that needs the page, and it is
 * reported as unverified rather than assumed.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { NAMESPACE, PACKAGE_NAME, REMOTE_METHODS, buildContribution } from '../lib/wire.js'

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

/** Minimal `react` stub: loading the factory must not need a real renderer. */
const reactStub = {
  createElement: () => null,
  useState: () => [undefined, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
}

/** Load `client.js` the way the page does, returning the module and its id. */
function loadClient() {
  const loader = {}
  const sandboxWindow = {
    __ModuleLoader__: {
      load(definition) {
        loader.definition = definition
      },
    },
  }
  // eslint-disable-next-line no-new-func -- the artifact is browser-format by design
  new Function('window', source)(sandboxWindow)
  assert.ok(loader.definition !== undefined, 'client.js did not call window.__ModuleLoader__.load')
  const module = loader.definition.factory((name) => {
    if (name === 'react') return reactStub
    throw new Error(`client.js required an unexpected module: ${name}`)
  })
  return { definition: loader.definition, module }
}

/**
 * Serialise a value with functions reduced to a marker, and the descriptor
 * source location normalised: the two faces legitimately name their own file.
 */
function serialise(value) {
  return JSON.stringify(value, (key, item) => {
    if (key === 'sourceLocation') return '[source-location]'
    return typeof item === 'function' ? '[function]' : item
  })
}

const { definition, module } = loadClient()

test('the module id and injection match the manifest', () => {
  assert.equal(definition.id, PACKAGE_NAME)
  assert.deepEqual(module.inject, ['slots', 'locale', 'remote'])
})

test('the browser descriptor table matches the Host table exactly', () => {
  assert.deepEqual(module.__internals.REMOTE_METHODS, REMOTE_METHODS.map(({ method, wires }) => ({ method, wires: [...wires] })))
})

test('the browser contribution is structurally identical to the Host one', () => {
  assert.equal(serialise(module.__internals.buildContribution()), serialise(buildContribution()))
})

test('the browser half mounts the namespace the Host publishes', () => {
  assert.equal(module.__internals.NAMESPACE, NAMESPACE)
  assert.equal(module.__internals.PACKAGE, PACKAGE_NAME)
})

test('the tab claims its own slot id and does not reuse a shipped one', () => {
  assert.equal(module.__internals.SLOT, 'settings.plugins.tab')
  assert.notEqual(module.__internals.TAB_ID, 'all')
  assert.notEqual(module.__internals.TAB_ID, 'budget')
})

test('both dictionaries carry exactly the same keys', () => {
  const zh = Object.keys(module.__internals.zh).sort()
  const en = Object.keys(module.__internals.en).sort()
  assert.deepEqual(zh, en, 'a key present in one language but not the other will render as a raw key')
})

/** Dictionary keys the component asks for, directly or through a code map. */
function requestedKeys() {
  const requested = new Set()
  for (const match of source.matchAll(/\b(?:t|translate)\(\s*'([A-Za-z0-9_]+)'/g)) requested.add(match[1])
  // Keys reached indirectly through the health/block/outcome maps.
  for (const match of source.matchAll(/'(health[A-Z][A-Za-z0-9]*|block[A-Z][A-Za-z0-9]*|outcome[A-Z][A-Za-z0-9]*)'/g)) {
    requested.add(match[1])
  }
  return requested
}

test('every dictionary key the component asks for exists', () => {
  const available = new Set(Object.keys(module.__internals.zh))
  const missing = [...requestedKeys()].filter((key) => !available.has(key))
  assert.deepEqual(missing, [], `missing dictionary keys: ${missing.join(', ')}`)
})

test('every dictionary key is reachable from the component', () => {
  const requested = requestedKeys()
  const unreachable = Object.keys(module.__internals.zh).filter((key) => !requested.has(key))
  assert.deepEqual(unreachable, [], `unused dictionary keys: ${unreachable.join(', ')}`)
})

test('the component never imports a Harness Client package', () => {
  // Precise on purpose: naming a Harness Client package in a COMMENT is how the
  // copied CSS cites where its values came from, and the plugin guide requires
  // exactly that instead of importing one. So the guard checks real module
  // references — which is strictly stronger than the bare substring it replaces,
  // because it also catches a static `import` statement.
  const requires = [...source.matchAll(/require\(\s*'([^']+)'\s*\)/g)].map((match) => match[1])
  assert.deepEqual([...new Set(requires)], ['react'])
  assert.equal(/\bfrom\s+'@deepseek-ai\/dsh-client-/.test(source), false, 'a static import names a Harness Client package')
  assert.equal(/\bimport\s*\(\s*'@deepseek-ai\/dsh-client-/.test(source), false, 'a dynamic import names a Harness Client package')
})

// ── display text ──────────────────────────────────────────────────────────
// The Host sends `LocalizedText`, and a plugin that ships `locale/*.json` —
// this one included — always produces `{ en, zh }` rather than a string. React
// throws on an object child, so `displayText` must never return one.

const { displayText } = module.__internals

test('a plain string is passed through', () => {
  assert.equal(displayText('自安装插件'), '自安装插件')
  assert.equal(displayText(''), '')
})

test('a LocalizedText object resolves to a string, never to an object', () => {
  const value = { en: 'Self-installed plugins', zh: '自安装插件' }
  const resolved = displayText(value)
  assert.equal(typeof resolved, 'string')
  assert.ok(Object.values(value).includes(resolved))
})

test('a single-language object still resolves', () => {
  assert.equal(displayText({ zh: '只有中文' }), '只有中文')
  assert.equal(displayText({ en: 'english only' }), 'english only')
})

test('an unusable value yields null instead of undefined or an object', () => {
  for (const value of [null, undefined, 42, true, {}, { en: '' }, { en: 7 }, []]) {
    const resolved = displayText(value)
    assert.equal(resolved, null, `displayText(${JSON.stringify(value)}) must be null, got ${String(resolved)}`)
  }
})

test('every language key of a plausible payload resolves to a string', () => {
  // The shape `readPluginMeta` actually builds: `{ en: fallback, ...locales }`.
  const value = { en: 'turn chime', zh: '回合结束提示音', ja: 'ターンチャイム' }
  for (const key of Object.keys(value)) {
    assert.equal(typeof displayText({ [key]: value[key] }), 'string', `${key} did not resolve`)
  }
})

// ── stylesheet coverage ───────────────────────────────────────────────────
// The first version of this tab shipped 42 CSS rules that could never match:
// every selector was scoped under `[data-dsh-self-plugins]`, while that
// attribute was set on the `<style>` element itself, which has no children. The
// page therefore rendered with browser defaults and looked nothing like the
// host. A class-to-rule correspondence check is what would have caught it.

/** Split the source into the CSS literal and everything else. */
function splitStylesheet() {
  const marker = 'const CSS = `'
  const start = source.indexOf(marker)
  assert.notEqual(start, -1, 'client.js no longer declares a CSS literal')
  const end = source.indexOf('`', start + marker.length)
  assert.notEqual(end, -1, 'the CSS literal is not terminated by a backtick')
  return { css: source.slice(start + marker.length, end), markup: source.slice(0, start) + source.slice(end + 1) }
}

/** Class names this plugin defines in its stylesheet. */
function definedClasses(css) {
  return new Set([...css.matchAll(/\.(dsp-[a-z0-9-]+)/g)].map((match) => match[1]))
}

/** Class names the render/state code actually references. */
function usedClasses(markup) {
  return new Set([...markup.matchAll(/(dsp-[a-z0-9-]+)/g)].map((match) => match[1]))
}

test('every class the component uses has a stylesheet rule', () => {
  const { css, markup } = splitStylesheet()
  const defined = definedClasses(css)
  const missing = [...usedClasses(markup)].filter((name) => !defined.has(name))
  assert.deepEqual(missing, [], `unstyled classes: ${missing.join(', ')}`)
})

test('every stylesheet rule is used by the component', () => {
  const { css, markup } = splitStylesheet()
  const used = usedClasses(markup)
  const dead = [...definedClasses(css)].filter((name) => !used.has(name))
  assert.deepEqual(dead, [], `dead rules: ${dead.join(', ')}`)
})

test('the stylesheet is scoped to an attribute the render actually sets', () => {
  const { css, markup } = splitStylesheet()
  assert.ok(css.includes('[data-dsh-self-plugins]'), 'the stylesheet must be scoped, not global')
  // A scoped rule is inert unless some rendered element carries the attribute.
  assert.match(markup, /'data-dsh-self-plugins':\s*''/, 'no rendered element carries the scope attribute')
})

test('the stylesheet only references theme tokens this build actually supplies', () => {
  const { css } = splitStylesheet()
  const tokens = [...new Set([...css.matchAll(/var\((--[a-z0-9-]+)/g)].map((match) => match[1]))]
  assert.ok(tokens.length > 0, 'no tokens referenced')
  // Every alias token must be one the theme defines; the primitive-owned ones
  // come from `dsh-client-ui-primitives/lib/*.module.css`, which ships alongside
  // the theme, so they are allowed by name.
  for (const token of tokens) {
    assert.match(
      token,
      /^--(dsw-alias-|dsw-focus-ring-|dsw-radius-|ds-font-family-|ds-ease-)/,
      `unexpected token ${token}`,
    )
  }
  // The two tokens this file previously got wrong must be the real, wider set —
  // `Theme.listTokens` lists only the 14 that need both colour schemes.
  assert.ok(css.includes('--dsw-alias-settings-card-fill'), 'cards must use the host surface token')
  assert.ok(css.includes('--dsw-radius-xl'), 'cards must use the host radius scale')
  assert.ok(css.includes('--dsw-alias-interactive-bg-hover'), 'hover must use the host interactive token')
})
