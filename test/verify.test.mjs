/**
 * Automatic verification-session decision tests.
 *
 * The two decisions here are the ones a wrong answer would make worse than no
 * feature at all: starting a session against a generation that is not loaded,
 * and claiming a cost ranking the Harness cannot compute.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  VERIFICATION_TITLE_PREFIX,
  chooseVerificationModel,
  shouldAutoVerify,
  verificationPrompt,
  verificationTitle,
} from '../lib/verify.js'

test('the switch is off unless it was explicitly turned on', () => {
  assert.deepEqual(shouldAutoVerify({ enabled: false, application: 'applied' }), {
    run: false,
    reason: 'auto-verify-disabled',
  })
  assert.deepEqual(shouldAutoVerify({ enabled: undefined, application: 'applied' }), {
    run: false,
    reason: 'auto-verify-disabled',
  })
})

test('only a change that actually took effect starts a session', () => {
  assert.deepEqual(shouldAutoVerify({ enabled: true, application: 'applied' }), { run: true, reason: null })
  // The new JavaScript generation is not loaded yet: verifying now would test
  // the old code and could report a misleading PASS.
  assert.deepEqual(shouldAutoVerify({ enabled: true, application: 'restart-required' }), {
    run: false,
    reason: 'restart-required-first',
  })
  assert.deepEqual(shouldAutoVerify({ enabled: true, application: 'overridden' }), {
    run: false,
    reason: 'change-not-live',
  })
  assert.deepEqual(shouldAutoVerify({ enabled: true, application: 'cancelled' }), {
    run: false,
    reason: 'change-cancelled',
  })
  assert.deepEqual(shouldAutoVerify({ enabled: true, application: 'failed' }), {
    run: false,
    reason: 'change-not-applied',
  })
  assert.deepEqual(shouldAutoVerify({ enabled: true, application: undefined }), {
    run: false,
    reason: 'change-not-applied',
  })
})

test('an explicitly configured route wins', () => {
  const chosen = chooseVerificationModel({
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    catalog: { default: { provider: 'p', model: 'm' }, groups: [] },
  })
  assert.deepEqual(chosen, { selection: { provider: 'deepseek-official', model: 'deepseek-flash' }, source: 'configured' })
})

test('a half-configured route falls through to the deployment default', () => {
  for (const pair of [{ provider: 'p', model: '' }, { provider: '', model: 'm' }, { provider: '', model: '' }]) {
    const chosen = chooseVerificationModel({
      provider: pair.provider,
      model: pair.model,
      catalog: { default: { provider: 'dp', model: 'dm' }, groups: [] },
    })
    assert.deepEqual(chosen, { selection: { provider: 'dp', model: 'dm' }, source: 'deployment-default' })
  }
})

test('the fallback ladder is deterministic and never empty when a catalog exists', () => {
  const chosen = chooseVerificationModel({
    provider: '',
    model: '',
    catalog: { groups: [{ id: 'g1', name: 'G', models: [{ id: 'only', name: 'Only' }] }] },
  })
  assert.deepEqual(chosen, { selection: { provider: 'g1', model: 'only' }, source: 'first-routable' })
})

test('an unusable catalog yields no selection rather than a guess', () => {
  for (const catalog of [undefined, null, {}, { groups: [] }, { default: { provider: '', model: '' }, groups: [] }]) {
    assert.deepEqual(chooseVerificationModel({ provider: '', model: '', catalog }), {
      selection: null,
      source: 'unresolved',
    })
  }
})

test('no source value claims a cost ranking', () => {
  const sources = ['configured', 'deployment-default', 'first-routable', 'unresolved']
  for (const source of sources) {
    assert.equal(/cheap|lowest|cost|price/i.test(source), false, `${source} must not imply a cost ranking`)
  }
})

test('the prompt states the three checks and the restart caveat', () => {
  const prompt = verificationPrompt({ name: 'dsh-ops', fromVersion: '0.2.9', toVersion: '0.3.0' })
  assert.match(prompt, /dsh-ops/)
  assert.match(prompt, /0\.2\.9 → 0\.3\.0/)
  assert.match(prompt, /是否加载/)
  assert.match(prompt, /是否运行/)
  assert.match(prompt, /是否返回结果/)
  assert.match(prompt, /PASS 或 FAIL/)
  // Without this the feature could certify an unloaded generation.
  assert.match(prompt, /不要.*判 PASS/)
})

test('the prompt tolerates an unknown version without emitting undefined', () => {
  const prompt = verificationPrompt({ name: 'x', fromVersion: null, toVersion: undefined })
  assert.equal(prompt.includes('undefined'), false)
  assert.equal(prompt.includes('null'), false)
  assert.match(prompt, /未知 → 未知/)
})

test('the session title is derived from the plugin name', () => {
  assert.equal(verificationTitle('dsh-ops'), `${VERIFICATION_TITLE_PREFIX}：dsh-ops`)
})
