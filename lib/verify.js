/**
 * Automatic post-update verification session — the pure decision helpers.
 *
 * Two decisions live here because they are the parts worth testing without a
 * live session controller:
 *
 *   1. **Whether** to start a verification session at all. A change that needs a
 *      process restart has not loaded its new JavaScript generation, so a fresh
 *      session would verify the OLD code and could report a misleading PASS.
 *   2. **Which model** to run it on.
 *
 * On (2), a boundary that must not be papered over: DeepSeek Harness 0.2.0-rc.2
 * exposes **no token pricing for any model**. `ModelCatalogModel` carries only
 * `{ id, name, description?, reasoning? }`, and `LlmModelInfo` /
 * `LlmResolvedModelInfo` add only context, output cap, modalities and reasoning.
 * The one pricing accessor on the `llm` service, `imageRequestPricing()`, prices
 * *images* for a route, not text tokens. The only price table on this machine
 * belongs to the third-party `dsh-budget` plugin's own configuration.
 *
 * So "cheapest model" cannot be computed from the shipped API, and this module
 * does not fake it: it uses an explicitly configured route when the operator
 * gives one, otherwise the deployment default, and it always reports which of
 * those happened so the caller can say so instead of implying a cost ranking.
 *
 * @module dsh-self-plugin-manager/verify
 */

/** Title prefix of the session this plugin creates. */
export const VERIFICATION_TITLE_PREFIX = '插件更新验证'

/**
 * Decide whether a completed change warrants a verification session.
 * @param input - `{ enabled, application }`.
 * @returns `{ run, reason }`; `reason` is `null` when `run` is true.
 */
export function shouldAutoVerify({ enabled, application }) {
  if (enabled !== true) return { run: false, reason: 'auto-verify-disabled' }
  if (application === 'applied') return { run: true, reason: null }
  if (application === 'restart-required') return { run: false, reason: 'restart-required-first' }
  if (application === 'overridden') return { run: false, reason: 'change-not-live' }
  if (application === 'cancelled') return { run: false, reason: 'change-cancelled' }
  return { run: false, reason: 'change-not-applied' }
}

/**
 * Pick the route for the verification session.
 *
 * `source` is part of the contract: `configured` and `deployment-default` are
 * facts about what was chosen, and none of the four values claims a cost rank.
 * @param input - `{ provider, model, catalog }`.
 * @returns `{ selection, source }` where `selection` may be `null`.
 */
export function chooseVerificationModel({ provider, model, catalog }) {
  if (typeof provider === 'string' && provider !== '' && typeof model === 'string' && model !== '') {
    return { selection: { provider, model }, source: 'configured' }
  }
  const fallback = catalog?.default
  if (
    fallback !== null &&
    typeof fallback === 'object' &&
    typeof fallback.provider === 'string' &&
    fallback.provider !== '' &&
    typeof fallback.model === 'string' &&
    fallback.model !== ''
  ) {
    return { selection: { provider: fallback.provider, model: fallback.model }, source: 'deployment-default' }
  }
  const group = Array.isArray(catalog?.groups) ? catalog.groups[0] : undefined
  const first = Array.isArray(group?.models) ? group.models[0] : undefined
  if (typeof group?.id === 'string' && group.id !== '' && typeof first?.id === 'string' && first.id !== '') {
    return { selection: { provider: group.id, model: first.id }, source: 'first-routable' }
  }
  return { selection: null, source: 'unresolved' }
}

/**
 * The prompt the verification session receives.
 *
 * The three questions are the ones the original plan named (loaded / running /
 * returning results); the restart caveat is stated inside the prompt because a
 * model that reports PASS while the new generation is not loaded would make the
 * whole feature worse than not having it.
 * @param input - `{ name, fromVersion, toVersion }`.
 * @returns the prompt text.
 */
export function verificationPrompt({ name, fromVersion, toVersion }) {
  return [
    '插件更新验证',
    '',
    `插件：${String(name)}`,
    `版本：${String(fromVersion ?? '未知')} → ${String(toVersion ?? '未知')}`,
    '',
    '请核实以下三项，逐条给出结论与依据：',
    '1. 是否加载：该插件对应的行是否在 设置 → 插件 的清单里，且状态不是 failed；',
    '2. 是否运行：它声明的功能是否实际可用；',
    '3. 是否返回结果：触发一次它的主要能力，确认返回的是结果而不是错误。',
    '',
    '最后只输出一行结论：PASS 或 FAIL。',
    '注意：如果 DSH 提示需要重启才能加载新的 JS 世代，请如实说明，并且**不要**在这种情况下判 PASS。',
  ].join('\n')
}

/**
 * Title for the verification session.
 * @param name - bundle name.
 * @returns the title.
 */
export function verificationTitle(name) {
  return `${VERIFICATION_TITLE_PREFIX}：${String(name)}`
}
