# Project Instructions — dsh-self-plugin-manager

本文件是本项目的**项目级指令**，只描述"这个项目怎么工作"。
Agent 的通用行为规则在 `~/.dsh/AGENTS.md`，工作区级说明在上级 `../AGENTS.md`。

## 项目目标

为 DeepSeek Harness **0.2.0-rc.2** 提供一个设置页内的「自安装插件」视图与管理能力：
权威归属判定、运行健康、宿主兼容信息，以及受 DPIP 前置校验约束的更新与回滚。

上游方案文件是工作区根目录的 `插件制作方案_v2_落地实施计划.md`；
其中对本机 API 的假设已被实测修正，**以代码与 `verify/` 为准**。

## 技术栈

- Node.js ≥ 22.19.0（本机 v24.19.0），**纯 ESM，零构建、零运行时第三方依赖**。
- Cordis 4（`@deepseek-ai/cordis`）插件与 Service 模型。
- 宿主服务：`pluginManager`（必需）、`profileContext`（可选读取）。
- 浏览器半边是手写纯 JS 产物，经 `window.__ModuleLoader__.load` 加载，
  **只** `require('react')`。
- 测试：`node:test`；装配验证：`verify/*.mjs`。

## 项目结构约定

| 路径 | 约定 |
| --- | --- |
| `lib/wire.js` | Remote 方法表的**唯一事实来源**；Host 标记与 codec 也在这里 |
| `lib/scan.js`、`lib/health.js`、`lib/gate.js`、`lib/update.js`、`lib/registry.js` | **纯函数**，除 `update.js` 的读写日志外不得有 I/O；服务只做编排（`registry.js` 只构造 argv、解析输出、判定 registry 计划，进程由 `service.js` 启动） |
| `lib/service.js` | Cordis Service：只做 I/O 编排与门禁裁决，不放算法 |
| `lib/json-safe.js` | 所有跨 Gateway 的返回值都要经过它 |
| `client.js` | 浏览器半边；描述符表是 `lib/wire.js` 的**副本**（无法 import），由测试卡住漂移 |
| `cordis.patch.yml` | Host 行；`id`、`name` 必须与 `package.json` 的 `name` 一致 |
| `test/` | `node:test`；断言预期结果，不写描述性测试 |
| `verify/` | `wiring`（描述符被真实 registry 接受）→ `activation`（真实 Cordis 装配）→ `dispatch`（真实 Gateway 调度） |

## 修改原则

- **写路径的约束不得放宽**：`lib/gate.js` 的四条裁决（不可读即拒、
  `BLOCKED`/`QUARANTINED`/`ROLLBACK_REQUIRED` 拒绝、`ACTIVE` 放行、
  其余需显式 ack）是安全契约。放宽任何一条都属于破坏性变更，需先与用户确认。
- **不得新增任意 spec 入口**：安装的 spec 只能由 Host 从
  `<已知包名>@<Host 自己解析或记录的版本>` 拼出。
- **不得用 `pluginManager.inspect()` 解析已安装包的版本（2026-10-15 实测）。**
  宿主对 profile 已持有的任何包名**先拒绝、后询问 registry**，返回
  `problem: 'already-installed'`（`dsh-plugin-manager/lib/index.js` 的 `known`
  集合 = bundles + dependencies + 安装锚点）；而本插件能操作的 bundle 按定义都是
  已安装的。宿主也没有第二个只读入口（全部方法面见 `lib/registry.js` 顶部注释），
  `BundleInfo` 里没有"最新版本"字段。因此版本只能自己问：`lib/registry.js` 构造
  `pnpm view <name> version --json`，在 profile 目录内运行，registry 计划来自
  `pluginManager.registries()`。
- **`lib/registry.js` 的 argv 与 registry 计划不得放宽。** 包名必须过
  `isSafePackageName`、registry URL 必须过 `isSafeRegistryUrl` 后才可进入命令行
  （Windows 上命令经 `cmd.exe` 执行）；私有首问 registry 不得被换成公共镜像
  （`isPublicRegistry` 只放行 npm 官方源与部署自己声明的 fallback）。
  这是本插件**唯一**的子进程，必须是只读的 `pnpm view`；不得在这里加入安装、
  写文件或第二个子进程入口。改动这个文件后必须跑 `npm run verify:registry`。
- **不得把 DPIP 前置校验描述成「已受 DPIP 保护」**：它是前置校验，
  不是审批（见 README 安全契约一节）。
- **`restart-required` 不等于生效**：不得在 UI、文案或测试里把它当作已完成。
  这条同时约束验证会话：`restart-required` 的变更**不得**创建验证会话
  （`shouldAutoVerify()` 是唯一裁决点），否则新会话验证的是尚未加载的旧代码。
- **`autoVerify` 必须保持默认 `false`**：建会话并给 Agent 发问是代用户执行的动作，
  只能由用户在 `cordis.patch.yml` 里显式打开。不得为了提高"自动化程度"把它改成默认开启。
- **不得引入任何"最低成本/最便宜模型"的推断**：0.2.0-rc.2 不向插件暴露 token 价格
  （`ModelCatalogModel` / `LlmModelInfo` / `LlmResolvedModelInfo` 均无价格字段，
  `llm.imageRequestPricing` 只给图像计价）。`chooseVerificationModel()` 的 `source`
  只允许 `configured` / `deployment-default` / `first-routable` / `unresolved` 四个值，
  **不得**新增或改写成语义上暗示成本排序的取值，也不得用模型名做猜测。
- 改动 `lib/wire.js` 的 `REMOTE_METHODS` 后，必须同步 `client.js` 的同名表，
  并让 `test/wire.test.mjs` 的漂移检查保持通过。
- 改 `cordis.patch.yml` 的 `name` 写错会让**整个 profile 启动失败**
  （`assertEntriesActivated`），不是只影响本插件。
- health 判据只允许映射真实存在的信号；**不得**为了让界面好看而把
  `null` 相位渲染成正常。
- **测试与验证里的替身（stub）必须与真实实现逐条同形。** 已实测的三处：
  `pluginManager.listVersionExemptions()` 是**同步**方法（返回对象、不是 Promise，
  见 `dsh-plugin-manager/lib/index.js`），桩就不能写成 `async`；
  `sessionController.prompt(request, signal)` 的 `signal` 是**必填**的
  （实现第一行就 `signal.throwIfAborted()`），桩就必须像真实实现那样解引用它；
  `pluginManager.inspect()` 对已安装包名返回的是 `refused('already-installed')`，
  桩**必须**返回这个拒绝而不是 `accepted`——`test/service.test.mjs` 与
  `verify/dispatch.mjs` 的 inspect 桩现在都返回真实拒绝形状，另有一条用例断言
  `calls.inspect` 为空，防止有人再把它接回 check/update。
  **桩比真实实现更宽松 = 把真实缺陷变成假绿**：2026-10-12 为此让线上页签报
  `overview: gateway/internal: ...catch is not a function`；2026-10-15 又因为
  inspect 桩恒返回 `accepted`，让「检查更新 / 更新」从上线起就必然报
  `inspect-already-installed`，直到真实点击才暴露。
- **注入的 CSS 必须先证明"它匹配得到元素"。** 首版把 42 条规则全部写成
  `[data-dsh-self-plugins] .dsp-x`，而 `installStyles()` 把该属性加在 **`<style>` 元素自己**
  上（`<head>` 里、无子元素）——于是**一条规则都没生效**，页签基本是浏览器默认样式，
  而我把它当作"做完了"。规则：作用域属性必须加在**渲染出来的根元素**上；
  `test/client.test.mjs` 现有两条机械守卫（用到的 class 必须有规则、规则必须被用到）
  与一条"作用域属性确实出现在渲染代码里"的守卫——**不得删除或放宽这三条**。
- **界面样式只能照抄宿主，不要自创数值。** 数值来源按优先级：
  ① 同插槽的官方页签（本插件是 `settings.plugins.tab`，参照
  `dsh-client-ui-settings-plugin-inventory/lib/client.js` 里内联的 CSS 模块）；
  ② `@deepseek-ai/dsh-client-ui-primitives/lib/*.module.css`（磁盘上就是可读的独立文件）。
  `Theme.listTokens` 只列 **14 个"需自备明暗两套"** 的令牌，不是完整词表：
  `--dsw-alias-border-l3/l4`、`--dsw-radius-xs/sm/md/xl`、
  `--dsw-alias-settings-card-fill/stroke`、`--dsw-alias-interactive-bg-hover/active`、
  `--dsw-alias-button-primary-fill/hover`、`--dsw-alias-label-tertiary`、
  `--dsw-alias-label-primary-foreground`、`--dsw-alias-bg-module-platform`、
  `--dsw-alias-state-business-primary`、`--dsw-focus-ring-color/width`、
  `--ds-font-family-code`、`--ds-ease-in-out` 都在宿主实际使用中。
  仍**不得** `require` 任何 Harness Client 包——照抄 markdown/CSS 并把 class 换成自己的前缀。

## 构建 / 测试 / 检查命令

```powershell
npm test          # node --test "test/*.test.mjs"
npm run check     # 逐文件 node --check + 全部测试
npm run verify    # wiring + activation + dispatch（需要 DSH 安装）
npm run verify:registry   # 真实 pnpm + 真实 registry（需要网络与 PATH 上的 pnpm）
```

本机另有两条组合层检查：

```powershell
dsh --profile web --dump-config                       # 退出码 0 且含 id: self-plugin-manager
```

```text
plugin_manager list_bundles                           # 本 bundle 的 enabled / installed / rows
cordis_inspect_query  client Slots  settings.plugins.tab   # occupants 中应出现 id: self-installed
```

## 需要谨慎修改的区域

- `cordis.patch.yml` 的 `config` 键必须与 `lib/index.js` 的 `Config` 模式一致
  （`test/wire.test.mjs` 有机械检查）。
- `node_modules/@deepseek-ai/*` 是**指向本机 DSH 安装的目录链接**，不是副本，
  `.gitignore` 已排除。新克隆的仓库需要重建：
  `powershell -c "New-Item -ItemType Junction -Path <项目>/node_modules/@deepseek-ai/<pkg> -Target <DSH安装>/node_modules/@deepseek-ai/<pkg>"`
  需要 `cordis`、`dsh-typert-protocol`、`dsh-typert-registry`、`dsh-api-gateway`、
  `schemastery` 五个。
  用链接而非副本是刻意的：DSH 升级后插件立即与宿主使用同一份协议实现。
- `lib/gate.js` 的解析语义**必须继续镜像** `FilePluginStateStore`：
  剥离 BOM、`ENOENT` 视为空、其他失败视为不可读。
- `writesEnabled` 默认 `true`。这是用户明确选择的写路径范围；
  若只想保留只读视图，把该键改为 `false` 即可，无需改代码。

## 验证要求

- 任何 `lib/` 或 `client.js` 改动后必须运行 `npm run check` 与 `npm run verify`，
  并在汇报中给出实际输出。
- 改动 `cordis.patch.yml`、包名或依赖链接后，必须额外运行
  `dsh --profile web --dump-config` 并确认退出码为 0。
- 涉及写路径的改动，必须在 `verify/dispatch.mjs` 里保留
  「Host 侧门禁生效」的用例。
- 改动 `lib/registry.js` 或 `service.js` 的版本解析后，必须额外运行
  `npm run verify:registry`（真实 pnpm + 真实 registry），并在汇报中给出输出；
  只跑 stub 用例不足以证明这条路真的通。
- 未能执行的验证必须在汇报中明确标注为"未验证"。
