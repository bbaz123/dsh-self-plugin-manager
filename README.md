# dsh-self-plugin-manager

DSH 自安装插件管理器：在 **设置 → 插件** 中新增一个 **「自安装插件」** 页签，
把「哪些插件是这个 profile 自己装的」「它们现在是否健康」「能不能更新/回滚」三件事
一次说清，并且**只读数据来自权威记录**而非目录扫描。

目标宿主：**DeepSeek Harness 0.2.0-rc.2**。

---

## 它做什么

| 能力 | 数据来源 |
| --- | --- |
| **自安装归属**：区分 profile 自装插件与 DSH 自带插件 | `pluginManager.listBundles()` 的 `installed` / `removable` / `optional`，与 profile `package.json` 的依赖表交叉验证 |
| **运行健康** | Loader 的 `PluginFiberPhase`（`active` / `failed` / `pending` / `loading` / `unloading` / `null`）＋ `BundleInfo.error` |
| **宿主兼容** | `pluginManager.listVersionExemptions()` 的豁免记录＋当前运行版本（由本机可解析的 `@deepseek-ai/dsh-*` 包版本得出，并回报来源） |
| **更新** | 本插件按宿主同款方式询问 registry（`pnpm view <name> version --json`，在 profile 目录内），再 `installBundle('<name>@<version>')` |
| **回滚** | 回到本插件自己记录的「上一次变更前」的精确版本 |
| **更新后验证会话**（默认关闭） | `sessionController.create → selectModel → rename → prompt` |
| **DPIP 前置校验** | 读取 `$DSH_HOME/operation-security/plugin-state.json` |

---

## 安全契约（请先读这一节）

**写路径不受 DSH 既有审批门禁覆盖。** 实测事实（对本机 0.2.0-rc.2 安装产物核对）：

- `@deepseek-ai/dsh-operation-security` 只挂在**工具管线**上
  （`ctx.on('tools/pre-execute')` + `ctx.tools.guard()`），因此它看不到任何 Gateway 调用；
- 它的检测器匹配 `dsh plugin …` shell 命令与动态 Cordis 生命周期工具，
  **没有** `plugin_manager` 的规则；
- `@deepseek-ai/dsh-plugin-manager` 服务内部没有安全或审批钩子；
- DSH 自带的 Web Plugins 页同样是直接调用 `remote.pluginManager.*` 的。

所以本插件的「更新 / 回滚」是一条**额外的写通道**，唯一守着它的是本插件的
`lib/gate.js`：

1. `plugin-state.json` **不可读 / 损坏 → 一律拒绝**（fail closed，与安全层
   `pluginStateUnknown` 的语义一致）；
2. 状态为 `BLOCKED` / `QUARANTINED` / `ROLLBACK_REQUIRED` → **拒绝**；
3. 状态为 `ACTIVE` → 放行；
4. 其余（含「没有任何 DPIP 记录」）→ 需要调用方显式传
   `acknowledgedUncovered: true`，UI 以此强制一次逐动作的二次确认。

第 4 条**不等于一次 DPIP 审批**：安全层对这种插件返回的是 `ask`，
而本插件只能把它变成一次用户点击，无法代替 DPIP 的来源核验、制品完整性校验、
依赖审查与隔离安装。**README、UI 与代码注释都不得把它描述为已受 DPIP 保护。**

另外，安装动作本身**不接受任意 spec**：

- `update` 只能给**包名**；版本由本插件问 registry 得到（见下），调用方无法指定它；
- `rollback` 只能回到本插件记录的精确版本；
- `link:` / `file:` / `workspace:` 本地依赖一律拒绝更新与回滚
  （否则会把开发者的 checkout 换成 registry 上的另一个包）；
- 不提供「安装新插件」入口。

### 「检查更新」为什么自己问 registry（2026-10-15 实测）

**宿主的 `pluginManager.inspect(spec)` 不能用来查已安装包的版本。** 它在询问
registry **之前**就先拒绝：`known` 集合 = profile 的 `bundles` + `dependencies`
+ 安装锚点的 dependencies，命中即返回 `problem: 'already-installed'`
（`dsh-plugin-manager/lib/index.js`；`name@latest` 之类的写法也没用，解析后仍取裸包名）。
本插件能操作的对象按定义都在这个集合里，所以用 `inspect()` 实现「检查更新」必然报
`inspect-already-installed`——这正是首版上线的缺陷。宿主也没有第二个只读入口：
它的全部方法只有 `cancelInstall` / `inspect` / `installBundle` / `listBundles` /
`listPlugins` / `listVersionExemptions` / `registries` / `removeBundle` /
`setBundleEnabled` / `setPluginEnabled` / `setVersionExemption` / `waitForInstall`，
且 `BundleInfo` 里没有「最新版本」字段。

因此版本由 `lib/registry.js` + `service.resolveLatest()` 自己问，方式与宿主自己的
预检一致：在 **profile 目录内** 运行 `pnpm view <name> version --json`，所以同一份
`.npmrc`、代理与认证设置生效；registry 顺序来自 `pluginManager.registries()`
（配置项 → 声明的 fallback）。

三条约束是刻意的：

- **只读**：`pnpm view` 只询问并打印，不安装、不写 profile 文件；这是本插件**唯一**
  的子进程。
- **参数不可注入**：包名由 `findSelfBundle()` 限定为已在 profile 清单里的名字，
  且必须通过 `isSafePackageName()`；registry URL 必须通过 `isSafeRegistryUrl()`。
  Windows 上命令经 `cmd.exe` 执行（npm 的 pnpm 垫片是 `pnpm.cmd`，Node 不能直接执行），
  因此这两个校验是命令行的安全边界。
- **私有源不外泄**：只有首问地址是公共的（npm 官方源，或部署自己声明的 fallback）
  才允许转问下一个 registry；私有源的包名不会被拿去问公共镜像。

---

## 更新后的验证会话（`autoVerify`，**默认关闭**）

打开 `autoVerify` 后，每一次**真正生效**的版本变更（更新或回滚）都会：

1. `sessionController.create({})` 建一个会话；
2. 选模型（见下）；`selectModel`；
3. `rename` 为 `插件更新验证：<包名>`；
4. `prompt` 一条验证任务：**是否加载 / 是否运行 / 是否返回结果**，最后要求一行 `PASS` 或 `FAIL`，
   并在提示里明确要求：**若 DSH 提示需要重启才能加载新的 JS 世代，不得判 PASS**。

三条边界是刻意的：

- **默认关闭。** 建会话并给 Agent 发问是**代你执行**的动作，因此只有你在 `cordis.patch.yml`
  里显式打开才会发生；配置开关比 UI 开关更难被误触。
- **`restart-required` 不触发。** 此时新的 JS 世代还没加载，新会话验证的是**旧代码**，
  有可能报出误导性的 PASS。这类变更只返回 `verification.reason = "restart-required-first"`。
- **不声称"最低成本"。** 见下。

### 为什么没有「自动选最低成本模型」

实测（0.2.0-rc.2）：**Harness 不向插件暴露任何 token 价格**。

| 候选来源 | 实际字段 |
| --- | --- |
| `sessionController.modelCatalog()` → `ModelCatalogModel` | `id` / `name` / `description?` / `reasoning?` |
| `llm.listModels()` → `LlmModelInfo` | `provider` / `id` / `name` / `description?` / `inputModalities?` |
| `llm.resolveModelInfo()` → `LlmResolvedModelInfo` | 上述 + `context?` / `defaultMaxTokens?` / `reasoning?` / `systemPromptUpdate?` / `toolUpdate?` |
| `llm.imageRequestPricing()` | 只给**图像** token 计价，与文本单价无关 |

本机唯一的价格表属于第三方插件 `dsh-budget` 自己的配置。因此**成本排序无法从被支持的 API 算出**，
本插件不用「名字里有 mini/flash 就便宜」这类猜测去冒充它。

实际行为：`verifyModelProvider` + `verifyModel` **两者都设置**时用你指定的路由
（`modelSource: "configured"`），否则用 `modelCatalog()` 的部署默认
（`"deployment-default"`），再否则用第一个可路由模型（`"first-routable"`）。
`modelSource` 会随结果一并返回，四种取值都不含任何成本含义。想固定用某个便宜路由，就在这里指名。

---

## 结构与两侧

```
dsh-self-plugin-manager/
├── package.json          dsh.bundle.patch + dsh.client + icon + locale 导出
├── cordis.patch.yml      Host 行（含 writesEnabled 开关与风险说明）
├── client.js             浏览器半边（经 window.__ModuleLoader__.load 加载）
├── lib/
│   ├── index.js          插件入口：apply() + Config
│   ├── service.js        SelfPluginsService：overview/check/update/rollback
│   ├── scan.js           纯函数：归属判定与视图模型组装
│   ├── health.js         纯函数：fiber 相位 / bundle error → 健康判据
│   ├── gate.js           DPIP 前置校验（镜像 FilePluginStateStore 语义）
│   ├── registry.js       纯函数：registry 计划、pnpm view 的 argv、输出解析与失败归因
│   ├── update.js         回滚点日志与 ChangeResult 归因
│   ├── runtime.js        运行版本探测（回报来源）
│   ├── wire.js           Remote 方法表 + 手写 @Remote 标记 + 无依赖 strict codec
│   └── json-safe.js      Remote 结果的无损 JSON 归一化
├── test/                 node --test
└── verify/               wiring / activation / dispatch 三档真实装配验证
```

两侧通过**本插件自己的** Gateway 命名空间 `selfPlugins` 通信，客户端
**从不**直接调用 `remote.pluginManager` —— 否则 Host 侧的 DPIP 前置校验会被绕过。

### 两个刻意的工程取舍

**不用 `@Remote` 装饰器。** 装饰器需要编译/转译；本插件是零构建的纯 ESM。
`lib/wire.js` 直接写入装饰器会写的那个原型属性
（`'@deepseek-ai/dsh-typert-protocol/remote-methods'`），`verify/wiring.mjs`
用真实的 `remoteMethods()` 证明它可被读取。

**不用 zod 构造 codec。** Gateway Client 要求每个参数 codec 有
`mode: 'strict'`，Typert registry 要求非空 `typeSymbol` 与可调用的 `create`；
这条路径上**没有任何代码会调用 `create()`**（客户端把值直接放进 `args`，
Host 侧按 SRC 派生以 `src-json` 解码）。因此 codec 无需 schema 库。

---

## 安装

```text
plugin_manager install_bundle   target = 本包目录的绝对路径
```

或 CLI：`dsh plugin --profile web add <本包目录>`。

**本机注意（2026-10-12 实测）**：`dsh-ops@0.2.9` 依赖
`@dsh-ops/bash-win32-x64@0.2.1`，该版本在 **npmjs 上存在**，
但配置的 `registry.npmmirror.com` 上只有 `0.0.0-stage`。
因此任何 `pnpm add` 都会在解析阶段失败（`ERR_PNPM_NO_MATCHING_VERSION`），
与本插件无关。绕过方式是一次性指定 registry：

```text
plugin_manager install_bundle  target=<绝对路径>  registry=https://registry.npmjs.org/
```

该参数只作用于本次操作，不修改 `.npmrc`。

安装是 `link:` 方式（`dsh-self-plugin-manager link:<本包目录>`），
**因此本包目录的 `node_modules/@deepseek-ai/*` 是运行时依赖**：
它指向本机 DSH 安装内的同名包，保证插件与宿主使用同一份 `cordis` /
`dsh-typert-protocol`，避免版本漂移。该目录被 `.gitignore` 排除，
新克隆的仓库需先重建（见 `AGENTS.md`）。

---

## 验证

```powershell
npm test                 # node --test，全部单元与 stub 集成用例
npm run check            # 语法检查 + 全部测试
npm run verify           # wiring + activation + dispatch 三档真实装配验证
npm run verify:registry  # 真实 pnpm + 真实 registry（需要网络与 PATH 上的 pnpm）
```

`verify/registry.mjs` 是唯一**真的去问 registry** 的一档：它用真实的
`runPnpmView` 启动真实的 `pnpm`，证明「宿主不能回答的那个问题」这条路真的通
（默认问 `dsh-ops`，可用 `DSH_SPM_VERIFY_PACKAGE` / `DSH_SPM_VERIFY_REGISTRY` 覆盖）。
因为它需要网络，所以不在 `npm run verify` 里。

`verify/dispatch.mjs` 是三档里最有价值的一档：它用**真实的** Host Gateway
调度器调用本插件的端点，证明「没有生成式 strict 定义时 SRC 派生仍然可用」
「wire 参数按名送达」「DPIP 门禁在 Host 侧生效且拒绝是正常结果而非传输故障」。

组合层：

```powershell
dsh --profile web --dump-config   # 退出码 0 且包含 id: self-plugin-manager
```

---

## 已知边界

- **不做**自建下载器、SHA256 自校验、`backup/` 或 `old-version/` 目录：
  pnpm 与 `pluginManager` 已提供 `package.json` + `pnpm-lock.yaml` 的快照与恢复，
  重复实现只会制造第二份真相。
- **不做** API 翻译层（原方案的 `adapter/0.2-to-0.3.ts`）：rc.2 没有这样的机制，
  兼容性由 `peerDependencies` + `engines.dsh` + 精确版本豁免实现。
- `restart-required` **不视为已生效**：改动过已安装包的 JS 世代需要重启进程。
- `autoVerify` 默认关闭；打开后仍不会在 `restart-required` 的变更上建会话。
- 本插件不提供、也不推断模型成本，因此没有「自动选最低成本模型」这一能力。
- 健康判据只映射 rc.2 真实存在的信息；`null` 相位被如实报为「无活动实例」，
  不猜测成失败或成功。
- **「检查更新」依赖 `pnpm` 在 PATH 上且有网络**：两者缺一时如实返回
  `pnpm-missing` / `registry-network` 等拒绝码并附上诊断，而不是假装已是最新。
  版本解析不经过 DPIP 前置校验（它只读、不安装）；写路径仍然经过。
- 插件清单快照为**点击时读取**，不订阅 Loader 变更。
