/**
 * Browser half: the Settings → Plugins → 「自安装插件」 tab.
 *
 * Design constraints this file obeys on purpose:
 *
 *   * It imports exactly one module, `react`, from the page's module table. No
 *     `@deepseek-ai/dsh-client-*` package is imported: those change without
 *     notice, this artifact has no type check, and a throwing component blanks
 *     the slot entry (`slot entry crashed in '<slot>'` in the console).
 *   * Styling uses only `--dsw-alias-*` theme tokens, which the theme supplies
 *     for both colour schemes, so no literal colour and no second dark sheet.
 *   * Every read and write goes through this plugin's own Host namespace
 *     `selfPlugins`. It never calls `remote.pluginManager` directly — the write
 *     path must run the Host-side DPIP pre-check in `lib/gate.js`, and a direct
 *     manager call would skip it.
 *   * The Remote descriptor table below is duplicated from `lib/wire.js`
 *     because this artifact is loaded through `window.__ModuleLoader__.load`
 *     and cannot import it. `test/wire.test.mjs` compares the two tables and
 *     fails on drift.
 *
 * @module dsh-self-plugin-manager/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-self-plugin-manager',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Dictionary namespace owned by this plugin. */
    const NS = 'settings.self-installed'
    /** Package name: matches package.json, the patch row id and the bundle id. */
    const PACKAGE = 'dsh-self-plugin-manager'
    /** Gateway namespace published by the Host half. */
    const NAMESPACE = 'selfPlugins'
    /** Slot this plugin contributes one tab to. */
    const SLOT = 'settings.plugins.tab'
    /** Tab key. Deliberately not a shipped id: reusing one replaces that cell. */
    const TAB_ID = 'self-installed'

    // ── Remote wire table ───────────────────────────────────────────────────
    // Keep in sync with REMOTE_METHODS in lib/wire.js.
    const REMOTE_METHODS = [
      { method: 'overview', wires: [] },
      { method: 'check', wires: ['name'] },
      { method: 'update', wires: ['name', 'acknowledgedUncovered'] },
      { method: 'rollback', wires: ['name', 'acknowledgedUncovered'] },
    ]

    /**
     * Build a strict wire codec with no schema dependency.
     *
     * The Gateway Client requires `mode: 'strict'` on every parameter codec and
     * the Typert registry requires a non-empty `typeSymbol` plus a callable
     * `create`. Nothing invokes `create()` on this path: the Client copies
     * values straight into the argument object and the Host SRC descriptor
     * decodes them as `src-json`.
     */
    function strictCodec(typeSymbol) {
      return {
        mode: 'strict',
        typeSymbol,
        create: () => ({}),
      }
    }

    /** The Remote contribution this plugin mounts. */
    function buildContribution() {
      return {
        package: PACKAGE,
        descriptors: REMOTE_METHODS.map((entry) => ({
          id: `${PACKAGE}#${NAMESPACE}/${entry.method}`,
          service: NAMESPACE,
          namespace: NAMESPACE,
          method: entry.method,
          invocation: { kind: 'direct' },
          parameters: entry.wires.map((wire) => ({
            name: wire,
            wire,
            source: 'json',
            acceptsUndefined: true,
            codec: strictCodec(`${PACKAGE}#${NAMESPACE}/${entry.method}:${wire}`),
          })),
          result: strictCodec(`${PACKAGE}#${NAMESPACE}/${entry.method}:result`),
          sourceLocation: { file: 'client.js', line: 1, column: 1 },
        })),
      }
    }

    // ── stylesheet ─────────────────────────────────────────────────────────
    // Values are copied from the shipped design language, not invented:
    //   * page/group/card metrics from the official tab in this very slot
    //     (`dsh-client-ui-settings-plugin-inventory`, its inlined CSS module);
    //   * controls from `dsh-client-ui-primitives/lib/{Button,Tag,StateDot}.module.css`.
    // Classes are renamed under this plugin's own prefix and only theme tokens
    // are referenced, which is exactly what the Harness plugin guide requires
    // instead of importing a Client UI package as a module.
    const STYLE_TAG = 'dsh-self-plugins'
    const CSS = `
[data-dsh-self-plugins].dsp-tab {
  display: flex; flex-direction: column; gap: 14px;
  width: 100%; max-width: 760px; min-width: 0;
  color: var(--dsw-alias-label-primary);
  container: dsp-self-plugins / inline-size;
}
[data-dsh-self-plugins] .dsp-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
[data-dsh-self-plugins] .dsp-title { margin: 0; color: var(--dsw-alias-label-primary); font-size: 14px; font-weight: 400; line-height: 22px; }
[data-dsh-self-plugins] .dsp-facts { margin: 0; display: flex; flex-wrap: wrap; column-gap: 0; row-gap: 4px; color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; font-variant-numeric: tabular-nums; }
[data-dsh-self-plugins] .dsp-facts > * + *::before { content: '·'; color: var(--dsw-alias-label-tertiary); padding: 0 6px; }
[data-dsh-self-plugins] .dsp-facts code { font-family: var(--ds-font-family-code); color: var(--dsw-alias-label-secondary); }
/* Button.module.css — sm size, outline by default and the primary variant. */
[data-dsh-self-plugins] .dsp-btn {
  box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; gap: 4px;
  height: 28px; padding: 0 10px; border: .5px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-sm); cursor: pointer; font: inherit;
  font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-primary); background: transparent;
}
[data-dsh-self-plugins] .dsp-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
[data-dsh-self-plugins] .dsp-btn:focus-visible { outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 2px; }
[data-dsh-self-plugins] .dsp-btn:disabled { cursor: not-allowed; opacity: .4; }
[data-dsh-self-plugins] .dsp-btn-primary { background: var(--dsw-alias-button-primary-fill); border-color: var(--dsw-alias-button-primary-fill); color: var(--dsw-alias-label-primary-foreground); }
[data-dsh-self-plugins] .dsp-btn-primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover); }
/* Notes: a tinted block, never a boxed banner — the host's own note pattern. */
[data-dsh-self-plugins] .dsp-banner { margin: 0; padding: 8px 10px; border: 0; border-radius: var(--dsw-radius-lg); font-size: 12px; line-height: 18px; overflow-wrap: anywhere; color: var(--dsw-alias-label-tertiary); background: var(--dsw-alias-bg-module-platform); }
[data-dsh-self-plugins] .dsp-banner-error { color: var(--dsw-alias-state-error-primary); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent); }
[data-dsh-self-plugins] .dsp-banner-warn { color: var(--dsw-alias-state-warn-primary); background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 10%, transparent); }
[data-dsh-self-plugins] .dsp-group { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
[data-dsh-self-plugins] .dsp-group + .dsp-group { border-top: .5px solid var(--dsw-alias-border-l2); padding-top: 14px; }
[data-dsh-self-plugins] .dsp-group-head { display: flex; align-items: center; gap: 8px; min-height: 36px; color: var(--dsw-alias-label-primary); font-size: 14px; font-weight: 400; line-height: 22px; }
[data-dsh-self-plugins] .dsp-count { color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; font-variant-numeric: tabular-nums; }
/* Two-column card grid, collapsing to one column in a narrow container. */
[data-dsh-self-plugins] .dsp-list { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; margin: 0; padding: 0; list-style: none; }
[data-dsh-self-plugins] .dsp-row { display: flex; flex-direction: column; gap: 2px; min-width: 0; overflow: hidden; padding: 12px 14px; border: .5px solid var(--dsw-alias-settings-card-stroke); border-radius: var(--dsw-radius-xl); background: var(--dsw-alias-settings-card-fill); }
[data-dsh-self-plugins] .dsp-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
[data-dsh-self-plugins] .dsp-row-top { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-width: 0; }
[data-dsh-self-plugins] .dsp-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; font-weight: 500; line-height: 20px; color: var(--dsw-alias-label-primary); }
[data-dsh-self-plugins] .dsp-ver { flex: none; font-family: var(--ds-font-family-code); font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
/* Tag.module.css — neutral capsule. */
[data-dsh-self-plugins] .dsp-chip { display: inline-flex; align-items: center; flex: none; padding: 1px 8px; border: 0; border-radius: 999px; corner-shape: round; font-size: 11px; line-height: 17px; font-weight: 500; white-space: nowrap; color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-module-platform); }
[data-dsh-self-plugins] .dsp-health { display: inline-flex; align-items: center; gap: 5px; flex: none; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
/* StateDot.module.css — a 10px slot painting one 6px currentColor core. */
[data-dsh-self-plugins] .dsp-dot { position: relative; display: inline-block; flex: none; width: 10px; height: 10px; color: var(--dsw-alias-state-idle-primary); }
[data-dsh-self-plugins] .dsp-dot::after { content: ''; position: absolute; inset: 20%; border-radius: 50%; background: currentColor; }
[data-dsh-self-plugins] .dsp-dot-ok { color: var(--dsw-alias-state-success-primary); }
[data-dsh-self-plugins] .dsp-dot-error { color: var(--dsw-alias-state-error-primary); }
[data-dsh-self-plugins] .dsp-dot-busy { color: var(--dsw-alias-label-tertiary); }
[data-dsh-self-plugins] .dsp-dot-unknown { color: var(--dsw-alias-state-warn-primary); }
[data-dsh-self-plugins] .dsp-desc { margin: 0; color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; text-wrap: pretty; overflow-wrap: anywhere; }
[data-dsh-self-plugins] .dsp-meta { display: flex; flex-wrap: wrap; gap: 4px 10px; margin-top: auto; padding-top: 6px; font-size: 11px; line-height: 17px; color: var(--dsw-alias-label-tertiary); }
[data-dsh-self-plugins] .dsp-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 8px; }
[data-dsh-self-plugins] .dsp-note { margin: 0; color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; overflow-wrap: anywhere; }
[data-dsh-self-plugins] .dsp-confirm { display: flex; flex-direction: column; gap: 8px; margin-top: 8px; padding: 10px 12px; border: 0; border-radius: var(--dsw-radius-lg); background: var(--dsw-alias-bg-module-platform); }
[data-dsh-self-plugins] .dsp-confirm strong { color: var(--dsw-alias-label-primary); font-size: 13px; line-height: 20px; }
[data-dsh-self-plugins] .dsp-confirm p { margin: 0; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; overflow-wrap: anywhere; }
[data-dsh-self-plugins] .dsp-outcome { margin-top: 8px; padding: 8px 10px; border: 0; border-radius: var(--dsw-radius-lg); font-size: 12px; line-height: 18px; overflow-wrap: anywhere; color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-module-platform); }
[data-dsh-self-plugins] .dsp-outcome-ok { color: var(--dsw-alias-state-success-primary); background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 8%, transparent); }
[data-dsh-self-plugins] .dsp-outcome-bad { color: var(--dsw-alias-state-error-primary); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent); }
[data-dsh-self-plugins] .dsp-rows { display: flex; flex-direction: column; gap: 4px; margin: 6px 0 0; padding: 0; list-style: none; }
[data-dsh-self-plugins] .dsp-rowline { display: flex; align-items: center; gap: 8px; font-size: 11px; line-height: 17px; color: var(--dsw-alias-label-tertiary); overflow-wrap: anywhere; }
[data-dsh-self-plugins] .dsp-code { padding: 1px 6px; border-radius: var(--dsw-radius-xs); background: var(--dsw-alias-bg-module-platform); color: var(--dsw-alias-label-secondary); font-family: var(--ds-font-family-code); font-size: 12px; line-height: 18px; }
@container dsp-self-plugins (width <= 520px) { [data-dsh-self-plugins] .dsp-list { grid-template-columns: minmax(0, 1fr); } }
`

    /** Install the scoped stylesheet once, returning an exact disposer. */
    function installStyles() {
      const stale = document.querySelector(`style[data-${STYLE_TAG}]`)
      if (stale !== null) stale.remove()
      const element = document.createElement('style')
      element.dataset.dshSelfPlugins = ''
      element.textContent = CSS
      document.head.append(element)
      return () => {
        element.remove()
      }
    }

    // ── dictionaries ───────────────────────────────────────────────────────
    const zh = {
      tab: '自安装插件',
      title: '自安装插件',
      refresh: '刷新',
      loading: '正在读取插件清单…',
      loadError: '读取失败',
      retry: '重试',
      profile: 'Profile',
      runtime: '宿主版本',
      unknownVersion: '未知',
      groupSelf: '本 profile 安装',
      groupShipped: 'DSH 自带',
      emptySelf: '这个 profile 还没有自行安装任何插件。',
      showShipped: '展开',
      hideShipped: '收起',
      healthRunning: '运行中',
      healthFiberFailed: '加载失败',
      healthAwaitingLoad: '等待加载',
      healthLoading: '加载中',
      healthUnloading: '卸载中',
      healthNoFiber: '无活动实例',
      healthDisabled: '已禁用',
      healthDeselected: '未启用',
      healthNoRows: '未声明插件行',
      healthNoAddressableRow: '没有可寻址的插件行',
      healthNotInInventory: '不在清单中',
      healthUnknown: '状态未知',
      originSelf: '自安装',
      originShippedOptional: 'DSH 可选',
      originShipped: 'DSH 自带',
      sourceLocal: '本地 link 依赖',
      rowsTitle: '插件行',
      overridesTitle: '覆盖的内置行',
      readOnly: '只读（管理组件）',
      errorDetail: '错误',
      gateUnreadable: '无法读取 DPIP 状态文档，写操作已被拒绝（fail-closed）。请先修复 operation-security 目录下的 plugin-state.json。',
      gateRefusing: '有插件处于 BLOCKED / QUARANTINED / ROLLBACK_REQUIRED 状态，这些插件的写操作会被拒绝。',
      writesDisabled: '写路径已在配置中关闭（writesEnabled: false），仅提供只读视图。',
      unaddressed: '有 {n} 个不在本清单内的插件行处于加载失败状态。',
      warnings: '警告',
      pendingBuilds: '待批准的构建脚本',
      actionCheck: '检查更新',
      actionUpdate: '更新',
      actionRollback: '回滚到 {v}',
      checking: '检查中…',
      currentVersion: '当前',
      latestVersion: '最新',
      upToDate: '已是最新',
      checkRefused: '无法检查更新',
      confirmUpdateTitle: '确认更新 {name}',
      confirmRollbackTitle: '确认回滚 {name}',
      confirmUpdateBody: '把 {name} 从 {from} 更新到 {to}。此操作会修改 profile 的依赖与 bundle 选择，对所有会话生效。',
      confirmRollbackBody: '把 {name} 从 {from} 回滚到 {to}。',
      confirmNote: '注意：本操作由本插件的 Host 前置校验把关（DPIP 状态），但它不经过工具管线，也不等于一次 DPIP 审批。',
      confirmRun: '确认执行',
      confirmCancel: '取消',
      running: '执行中…',
      outcomeApplied: '已生效',
      outcomeRestart: '需要重启 DSH 才能加载新的 JS 世代，当前不算生效。',
      outcomeOverridden: '被更高优先级的配置层覆盖，未生效。',
      outcomeFailed: '失败',
      outcomeCancelled: '已取消',
      outcomeAlreadyCurrent: '版本未变化，无需操作。',
      autoVerify: '自动验证会话',
      autoVerifyOn: '开',
      autoVerifyOff: '关',
      verificationStarted: '已创建验证会话',
      verificationSkipped: '未创建验证会话',
      blockNotSelf: '不是本 profile 安装的插件',
      blockWritesDisabled: '写路径已关闭',
      blockGateUnreadable: 'DPIP 状态不可读',
      blockGateState: 'DPIP 状态为 {state}，禁止写操作',
      blockLocalSource: '本地 link 依赖不能从 registry 更新或回滚',
      blockNoRollback: '没有记录到回滚点',
      blockUncovered: '需要先确认未覆盖的 DPIP 状态',
      refreshHint: '数据来自 pluginManager 的只读清单。',
      gatePath: 'DPIP 状态文件',
      logPath: '回滚记录',
    }
    const en = {
      tab: 'Self-installed',
      title: 'Self-installed plugins',
      refresh: 'Refresh',
      loading: 'Reading the plugin inventory…',
      loadError: 'Read failed',
      retry: 'Retry',
      profile: 'Profile',
      runtime: 'Harness',
      unknownVersion: 'unknown',
      groupSelf: 'Installed by this profile',
      groupShipped: 'Shipped with DSH',
      emptySelf: 'This profile has not installed any plugin of its own.',
      showShipped: 'Show',
      hideShipped: 'Hide',
      healthRunning: 'running',
      healthFiberFailed: 'load failed',
      healthAwaitingLoad: 'awaiting load',
      healthLoading: 'loading',
      healthUnloading: 'unloading',
      healthNoFiber: 'no live instance',
      healthDisabled: 'disabled',
      healthDeselected: 'deselected',
      healthNoRows: 'declares no rows',
      healthNoAddressableRow: 'no addressable row',
      healthNotInInventory: 'not in inventory',
      healthUnknown: 'unknown',
      originSelf: 'self-installed',
      originShippedOptional: 'optional',
      originShipped: 'shipped',
      sourceLocal: 'local link dependency',
      rowsTitle: 'Plugin rows',
      overridesTitle: 'Overridden built-ins',
      readOnly: 'read-only (management component)',
      errorDetail: 'Error',
      gateUnreadable: 'The DPIP state document cannot be read, so every write is refused (fail-closed). Repair plugin-state.json under operation-security first.',
      gateRefusing: 'Some plugins are BLOCKED / QUARANTINED / ROLLBACK_REQUIRED; their writes will be refused.',
      writesDisabled: 'The write path is switched off in configuration (writesEnabled: false); this view stays read-only.',
      unaddressed: '{n} plugin row(s) outside this list are in a failed state.',
      warnings: 'Warnings',
      pendingBuilds: 'Build scripts awaiting approval',
      actionCheck: 'Check for update',
      actionUpdate: 'Update',
      actionRollback: 'Roll back to {v}',
      checking: 'Checking…',
      currentVersion: 'current',
      latestVersion: 'latest',
      upToDate: 'up to date',
      checkRefused: 'Cannot check for updates',
      confirmUpdateTitle: 'Update {name}',
      confirmRollbackTitle: 'Roll back {name}',
      confirmUpdateBody: 'Move {name} from {from} to {to}. This edits the profile dependencies and bundle selection for every session.',
      confirmRollbackBody: 'Move {name} from {from} back to {to}.',
      confirmNote: 'Note: this action is guarded by this plugin’s own Host pre-check (DPIP state). It does not pass through the tool pipeline and is not a DPIP approval.',
      confirmRun: 'Run',
      confirmCancel: 'Cancel',
      running: 'Running…',
      outcomeApplied: 'applied',
      outcomeRestart: 'DSH must restart to load the new JavaScript generation; this is not live yet.',
      outcomeOverridden: 'A higher-priority configuration layer wins, so nothing changed.',
      outcomeFailed: 'failed',
      outcomeCancelled: 'cancelled',
      outcomeAlreadyCurrent: 'Version unchanged; nothing to do.',
      autoVerify: 'Verification session',
      autoVerifyOn: 'on',
      autoVerifyOff: 'off',
      verificationStarted: 'verification session created',
      verificationSkipped: 'no verification session',
      blockNotSelf: 'not installed by this profile',
      blockWritesDisabled: 'write path disabled',
      blockGateUnreadable: 'DPIP state unreadable',
      blockGateState: 'DPIP state is {state}; writes are refused',
      blockLocalSource: 'a local link dependency cannot be updated from or rolled back to a registry version',
      blockNoRollback: 'no rollback point recorded',
      blockUncovered: 'the uncovered DPIP state must be acknowledged first',
      refreshHint: 'Data comes from the plugin manager’s read-only inventory.',
      gatePath: 'DPIP state file',
      logPath: 'Rollback log',
    }

    // ── helpers ────────────────────────────────────────────────────────────
    const LEVEL_CLASS = {
      ok: 'dsp-dot-ok',
      error: 'dsp-dot-error',
      busy: 'dsp-dot-busy',
      unknown: 'dsp-dot-unknown',
      idle: '',
      disabled: '',
    }

    /** Localise a health code, falling back to the raw code. */
    function healthText(t, health) {
      const map = {
        running: 'healthRunning',
        'fiber-failed': 'healthFiberFailed',
        'awaiting-load': 'healthAwaitingLoad',
        loading: 'healthLoading',
        unloading: 'healthUnloading',
        'no-live-fiber': 'healthNoFiber',
        'disabled-entry': 'healthDisabled',
        'deselected-bundle': 'healthDeselected',
        'bundle-declares-no-rows': 'healthNoRows',
        'no-addressable-row': 'healthNoAddressableRow',
        'not-in-inventory': 'healthNotInInventory',
      }
      const key = map[health?.code]
      return key === undefined ? String(health?.code ?? 'healthUnknown') : t(key)
    }

    function originText(t, bundle) {
      if (bundle.origin === 'self') return t('originSelf')
      if (bundle.origin === 'shipped-optional') return t('originShippedOptional')
      return t('originShipped')
    }

    /** The page's language, lowercased and stripped of any region subtag. */
    function pageLanguage() {
      if (typeof document === 'undefined') return ''
      const raw = typeof document.documentElement?.lang === 'string' ? document.documentElement.lang : ''
      return raw.split('-')[0].toLowerCase()
    }

    /**
     * Resolve one display-text value to a string.
     *
     * The Host sends `LocalizedText`: a string OR `{ en: ..., zh: ... }`. A
     * plugin that ships `locale/*.json` — this one included — always produces
     * the object form, and React throws on an object child. So it is resolved
     * here rather than rendered, with a fallback order that never yields
     * `undefined`.
     * @param value - the value from the payload.
     * @returns a string, or `null` when the value carries no usable text.
     */
    function displayText(value) {
      if (typeof value === 'string') return value
      if (value === null || typeof value !== 'object') return null
      for (const id of [pageLanguage(), 'en', 'zh']) {
        if (id !== '' && typeof value[id] === 'string' && value[id] !== '') return value[id]
      }
      for (const item of Object.values(value)) {
        if (typeof item === 'string' && item !== '') return item
      }
      return null
    }

    /** Localise a write-block reason code. */
    function blockText(t, reason, bundle) {
      if (reason === null || reason === undefined) return null
      const map = {
        'not-self-installed': 'blockNotSelf',
        'writes-disabled': 'blockWritesDisabled',
        'gate-state-unreadable': 'blockGateUnreadable',
        'local-source-dependency': 'blockLocalSource',
        'no-rollback-point': 'blockNoRollback',
        'uncovered-not-acknowledged': 'blockUncovered',
      }
      if (reason.startsWith('gate-state-')) return t('blockGateState', { state: bundle?.gateState ?? '' })
      const key = map[reason]
      return key === undefined ? reason : t(key)
    }

    /** Localise one write outcome. */
    function outcomeText(t, outcome) {
      if (outcome.guidance === 'already-current') return t('outcomeAlreadyCurrent')
      if (outcome.guidance === 'live') return t('outcomeApplied')
      if (outcome.guidance === 'restart-to-load-new-generation') return t('outcomeRestart')
      if (outcome.guidance === 'higher-priority-layer-wins') return t('outcomeOverridden')
      if (outcome.guidance === 'cancelled') return t('outcomeCancelled')
      if (outcome.guidance === 'refused') return blockText(t, outcome.reason, outcome) ?? t('outcomeFailed')
      return t('outcomeFailed')
    }

    /** Describe what happened to the post-change verification session. */
    function verificationText(t, verification) {
      if (verification === null || verification === undefined) return ''
      if (verification.started === true) {
        const route = verification.modelSource ? ` (${verification.modelSource})` : ''
        return ` · ${t('verificationStarted')}: ${verification.title ?? verification.sessionId ?? '?'}${route}`
      }
      return ` · ${t('verificationSkipped')}: ${verification.reason ?? 'unknown'}`
    }

    /** Small labelled value used in the header. */
    function fact(label, value, code) {
      return h(
        'span',
        { key: label },
        h('span', null, `${label} `),
        code === true ? h('code', { className: 'dsp-code' }, value) : h('span', null, value),
      )
    }

    /** One plugin row line inside a bundle card. */
    function RowLine({ t, row }) {
      return h(
        'li',
        { className: 'dsp-rowline' },
        h('span', { className: `dsp-dot ${LEVEL_CLASS[row.health?.level] ?? ''}` }),
        h('span', null, row.rowId),
        h('span', { className: 'dsp-code' }, row.moduleName),
        h('span', null, row.fiberPhase === null ? t('healthUnknown') : row.fiberPhase),
      )
    }

    /** One bundle card, with its own expand / check / confirm state. */
    function BundleRow({ t, call, bundle, onChanged }) {
      const [open, setOpen] = React.useState(false)
      const [check, setCheck] = React.useState(null)
      const [busy, setBusy] = React.useState(null)
      const [pending, setPending] = React.useState(null)
      const [result, setResult] = React.useState(null)

      const needsAck = bundle.gateCoverage !== 'active'

      async function runCheck() {
        setBusy('check')
        setResult(null)
        try {
          const value = await call('check', bundle.name)
          setCheck(value)
        } catch (error) {
          setCheck({ ok: false, reason: 'remote-error', detail: String(error?.message ?? error) })
        } finally {
          setBusy(null)
        }
      }

      async function runAction(action) {
        setBusy(action)
        setResult(null)
        setPending(null)
        try {
          const value = await call(action, bundle.name, needsAck)
          setResult(value)
          await onChanged()
        } catch (error) {
          setResult({ ok: false, guidance: 'failed', detail: String(error?.message ?? error) })
        } finally {
          setBusy(null)
        }
      }

      const latest = check?.ok === true ? check.latestVersion ?? null : null
      const updateAvailable = latest !== null && latest !== bundle.version
      const updateEnabled = bundle.writeAllowed?.update === true && busy === null
      const rollbackEnabled = bundle.writeAllowed?.rollback === true && busy === null

      const actions = []
      if (bundle.origin === 'self') {
        actions.push(
          h(
            'button',
            { key: 'check', type: 'button', className: 'dsp-btn', disabled: busy !== null || bundle.sourceKind === 'local', onClick: runCheck },
            busy === 'check' ? t('checking') : t('actionCheck'),
          ),
        )
        actions.push(
          h(
            'button',
            {
              key: 'update',
              type: 'button',
              className: 'dsp-btn dsp-btn-primary',
              disabled: !updateEnabled,
              title: blockText(t, bundle.writeBlock?.update, bundle) ?? '',
              onClick: () => setPending({ action: 'update', target: latest }),
            },
            t('actionUpdate'),
          ),
        )
        if (bundle.rollbackTarget !== null) {
          actions.push(
            h(
              'button',
              {
                key: 'rollback',
                type: 'button',
                className: 'dsp-btn',
                disabled: !rollbackEnabled,
                title: blockText(t, bundle.writeBlock?.rollback, bundle) ?? '',
                onClick: () => setPending({ action: 'rollback', target: bundle.rollbackTarget }),
              },
              t('actionRollback', { v: bundle.rollbackTarget }),
            ),
          )
        }
        actions.push(
          h('button', { key: 'rows', type: 'button', className: 'dsp-btn', onClick: () => setOpen(!open) }, open ? t('hideShipped') : t('showShipped')),
        )
      }

      // `title` and `description` arrive as `LocalizedText`; resolve before they
      // reach React, which rejects an object child.
      const shownTitle = displayText(bundle.title) ?? bundle.name
      const shownDescription = displayText(bundle.description)

      const metaBits = []
      if (bundle.sourceKind === 'local' && bundle.origin === 'self') metaBits.push(t('sourceLocal'))
      if (bundle.readOnlyReason !== null) metaBits.push(`${t('readOnly')}: ${bundle.readOnlyReason}`)
      if (bundle.overrides.length > 0) metaBits.push(`${t('overridesTitle')}: ${bundle.overrides.length}`)
      if (bundle.rollbackTarget !== null) metaBits.push(`${t('actionRollback', { v: bundle.rollbackTarget })}`)

      return h(
        'div',
        { className: 'dsp-row' },
        h(
          'div',
          { className: 'dsp-row-top' },
          h('span', { className: 'dsp-name' }, shownTitle),
          h('span', { className: 'dsp-ver' }, bundle.version ?? t('unknownVersion')),
          h('span', { className: 'dsp-chip' }, originText(t, bundle)),
          h(
            'span',
            { className: 'dsp-health' },
            h('span', { className: `dsp-dot ${LEVEL_CLASS[bundle.health?.level] ?? ''}` }),
            h('span', null, healthText(t, bundle.health)),
          ),
          bundle.gateState === null ? null : h('span', { className: 'dsp-chip' }, `DPIP ${bundle.gateState}`),
        ),
        shownDescription === null ? null : h('p', { className: 'dsp-desc' }, shownDescription),
        shownTitle === bundle.name ? null : h('p', { className: 'dsp-desc' }, bundle.name),
        metaBits.length === 0 ? null : h('div', { className: 'dsp-meta' }, metaBits.map((bit, index) => h('span', { key: index }, bit))),
        bundle.error === null
          ? null
          : h('div', { className: 'dsp-outcome dsp-outcome-bad' }, `${t('errorDetail')}: ${bundle.error.code ?? 'unknown'}${bundle.error.diagnostic ? ` — ${bundle.error.diagnostic}` : ''}`),
        bundle.health?.detail ? h('div', { className: 'dsp-outcome dsp-outcome-bad' }, bundle.health.detail) : null,
        check !== null && check.ok !== true
          ? h('div', { className: 'dsp-outcome dsp-outcome-bad' }, `${t('checkRefused')}: ${check.reason ?? 'unknown'}${check.detail ? ` — ${check.detail}` : ''}`)
          : null,
        check !== null && check.ok === true && bundle.origin === 'self'
          ? h(
              'div',
              { className: 'dsp-note' },
              `${t('currentVersion')}: ${check.currentVersion ?? t('unknownVersion')} · ${t('latestVersion')}: ${check.latestVersion ?? t('unknownVersion')}${updateAvailable ? '' : ` · ${t('upToDate')}`}`,
            )
          : null,
        actions.length === 0 ? null : h('div', { className: 'dsp-actions' }, actions),
        pending === null
          ? null
          : h(
              'div',
              { className: 'dsp-confirm' },
              h('strong', null, pending.action === 'update' ? t('confirmUpdateTitle', { name: bundle.name }) : t('confirmRollbackTitle', { name: bundle.name })),
              h(
                'p',
                null,
                pending.action === 'update'
                  ? t('confirmUpdateBody', { name: bundle.name, from: bundle.version ?? t('unknownVersion'), to: pending.target ?? t('unknownVersion') })
                  : t('confirmRollbackBody', { name: bundle.name, from: bundle.version ?? t('unknownVersion'), to: pending.target ?? t('unknownVersion') }),
              ),
              h('p', null, t('confirmNote')),
              h(
                'div',
                { className: 'dsp-actions' },
                h(
                  'button',
                  { type: 'button', className: 'dsp-btn dsp-btn-primary', disabled: busy !== null, onClick: () => runAction(pending.action) },
                  busy !== null ? t('running') : t('confirmRun'),
                ),
                h('button', { type: 'button', className: 'dsp-btn', disabled: busy !== null, onClick: () => setPending(null) }, t('confirmCancel')),
              ),
            ),
        result === null
          ? null
          : h(
              'div',
              { className: `dsp-outcome ${result.ok === true ? 'dsp-outcome-ok' : 'dsp-outcome-bad'}` },
              `${result.action ?? ''} ${bundle.version ?? ''} → ${result.toVersion ?? '?'} · ${outcomeText(t, result)}`,
              result.detail ? ` — ${result.detail}` : '',
              Array.isArray(result.warnings) && result.warnings.length > 0 ? ` · ${t('warnings')}: ${result.warnings.join('; ')}` : '',
              Array.isArray(result.pendingBuilds) && result.pendingBuilds.length > 0 ? ` · ${t('pendingBuilds')}: ${result.pendingBuilds.join(', ')}` : '',
              verificationText(t, result.verification),
            ),
        open === true
          ? h(
              'div',
              null,
              h('div', { className: 'dsp-note' }, t('rowsTitle')),
              h('ul', { className: 'dsp-rows' }, bundle.rows.map((row) => h(RowLine, { key: row.rowId, t, row }))),
            )
          : null,
      )
    }

    /** The tab body. */
    function SelfInstalledTab({ t, call }) {
      const [state, setState] = React.useState({ phase: 'loading' })
      const [showShipped, setShowShipped] = React.useState(false)

      const load = React.useCallback(async () => {
        setState((current) => ({ ...current, phase: current.data === undefined ? 'loading' : 'ready' }))
        try {
          const data = await call('overview')
          setState({ phase: 'ready', data })
        } catch (error) {
          setState({ phase: 'error', error: String(error?.message ?? error) })
        }
      }, [call])

      React.useEffect(() => {
        void load()
      }, [load])

      if (state.phase === 'loading') {
        return h(
          'div',
          { className: 'dsp-tab', 'data-dsh-self-plugins': '' },
          h('div', { className: 'dsp-note' }, t('loading')),
        )
      }
      if (state.phase === 'error') {
        return h(
          'div',
          { className: 'dsp-tab', 'data-dsh-self-plugins': '' },
          h('div', { className: 'dsp-outcome dsp-outcome-bad' }, `${t('loadError')}: ${state.error}`),
          h('button', { type: 'button', className: 'dsp-btn', onClick: () => void load() }, t('retry')),
        )
      }
      const data = state.data ?? {}
      if (data.available === false) {
        return h(
          'div',
          { className: 'dsp-tab', 'data-dsh-self-plugins': '' },
          h('div', { className: 'dsp-outcome dsp-outcome-bad' }, data.reason ?? t('loadError')),
        )
      }

      const bundles = Array.isArray(data.bundles) ? data.bundles : []
      const selfBundles = bundles.filter((bundle) => bundle.origin === 'self')
      const shipped = bundles.filter((bundle) => bundle.origin !== 'self')
      const counts = data.counts ?? {}
      const refusing = selfBundles.filter((bundle) => bundle.gateCoverage === 'refusing')

      const banners = []
      if (data.writesEnabled !== true) banners.push(h('div', { key: 'w', className: 'dsp-banner dsp-banner-warn' }, t('writesDisabled')))
      if (data.gate?.readable !== true) banners.push(h('div', { key: 'g', className: 'dsp-banner dsp-banner-error' }, t('gateUnreadable')))
      else if (refusing.length > 0) banners.push(h('div', { key: 'r', className: 'dsp-banner dsp-banner-warn' }, t('gateRefusing')))
      if (Array.isArray(data.unaddressedFailures) && data.unaddressedFailures.length > 0) {
        banners.push(h('div', { key: 'u', className: 'dsp-banner dsp-banner-warn' }, t('unaddressed', { n: data.unaddressedFailures.length })))
      }

      return h(
        'div',
        { className: 'dsp-tab', 'data-dsh-self-plugins': '' },
        h(
          'div',
          { className: 'dsp-head' },
          h(
            'div',
            null,
            h('h2', { className: 'dsp-title' }, t('title')),
            h(
              'p',
              { className: 'dsp-facts' },
              fact(t('profile'), data.profileName ?? t('unknownVersion'), true),
              fact(t('runtime'), data.runtimeVersion ?? t('unknownVersion'), true),
              fact(t('originSelf'), String(counts.self ?? 0)),
              fact(t('groupShipped'), String(counts.shipped ?? 0)),
              fact(t('healthFiberFailed'), String(counts.error ?? 0)),
              fact(
                t('autoVerify'),
                data.config?.autoVerify === true
                  ? `${t('autoVerifyOn')}${data.config?.verifyModel ? ` (${data.config.verifyModelProvider}/${data.config.verifyModel})` : ''}`
                  : t('autoVerifyOff'),
              ),
            ),
          ),
          h('button', { type: 'button', className: 'dsp-btn', onClick: () => void load() }, t('refresh')),
        ),
        banners,
        h(
          'div',
          { className: 'dsp-group' },
          h('div', { className: 'dsp-group-head' }, h('span', null, t('groupSelf')), h('span', { className: 'dsp-count' }, String(selfBundles.length))),
          selfBundles.length === 0
            ? h('div', { className: 'dsp-note' }, t('emptySelf'))
            : h('div', { className: 'dsp-list' }, selfBundles.map((bundle) => h(BundleRow, { key: bundle.name, t, call, bundle, onChanged: load }))),
        ),
        h(
          'div',
          { className: 'dsp-group' },
          h(
            'div',
            { className: 'dsp-group-head' },
            h('span', null, t('groupShipped')),
            h('span', { className: 'dsp-count' }, String(shipped.length)),
            h('button', { type: 'button', className: 'dsp-btn', onClick: () => setShowShipped(!showShipped) }, showShipped ? t('hideShipped') : t('showShipped')),
          ),
          showShipped
            ? h('div', { className: 'dsp-list' }, shipped.map((bundle) => h(BundleRow, { key: bundle.name, t, call, bundle, onChanged: load })))
            : null,
        ),
        h('div', { className: 'dsp-note' }, `${t('refreshHint')} · ${t('gatePath')}: ${data.gate?.path ?? '?'} · ${t('logPath')}: ${data.config?.logPath ?? '?'}`),
      )
    }

    return {
      /** Client services this plugin reads; `remote.selfPlugins` appears after the mount below. */
      inject: ['slots', 'locale', 'remote'],

      /**
       * Register dictionaries, mount the Remote contribution, then contribute
       * the tab.
       * @param ctx - Client root context.
       */
      async apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-self-plugin-manager: dictionaries')
        ctx.effect(() => installStyles(), 'dsh-self-plugin-manager: stylesheet')
        await ctx.remote.$mount(buildContribution())
        ctx.inject([`remote.${NAMESPACE}`], (scope) => {
          const translate = scope.locale.bind(NS)
          const call = async (method, ...args) => {
            const result = await scope.remote[NAMESPACE][method](...args)
            if (!result?.ok) {
              const error = result?.error
              throw new Error(`${method}: ${error?.code ?? 'remote-error'}${error?.message ? `: ${error.message}` : ''}`)
            }
            return result.value
          }
          const slots = scope.get('slots')
          slots.inject(SLOT, () =>
            slots.register(
              {
                name: SLOT,
                id: TAB_ID,
                order: 50,
                label: () => translate('tab'),
                locale: NS,
                inject: () => ({ call, t: translate }),
              },
              SelfInstalledTab,
            ),
          )
        })
      },

      /**
       * Test handles. The Client module loader reads only `inject` and `apply`;
       * these let `test/client.test.mjs` load this factory in a sandbox and
       * check the descriptor table and the dictionaries against the Host half,
       * which are otherwise unverifiable from Node.
       */
      __internals: {
        NS,
        PACKAGE,
        NAMESPACE,
        SLOT,
        TAB_ID,
        REMOTE_METHODS,
        strictCodec,
        buildContribution,
        displayText,
        zh,
        en,
      },
    }
  },
})
