# 企业智能体基座设计方案（基于 dsh）

| | |
|---|---|
| 状态 | 待评审 |
| 日期 | 2026-09-25 |
| 基线 | dsh `0.1.7-rc.1`（Node.js v24.20.0） |
| 范围 | **企业智能体的基座**（非最终应用）：基础配置 + 便捷启动 + 容器交付 |

> **本文已被统一设计整合。** 现行为 [`2026-09-25-unified-agent-base-design.md`](2026-09-25-unified-agent-base-design.md)：本文的【基座通用】§4 与 §5 的决策部分已合并进那份文档的 N1–N29 与 §11；**本文 §3【dsh 专有】仍是 dsh 适配器的唯一事实来源，请继续按实测证据维护**。逐条映射见统一设计附录 A。
>
> 本文正文里的制品名 `dsh-agent-base/` 是当时**单 harness 设计**的名称，已由统一制品 `agent-base` 取代（见统一设计 §12.6）；正文按历史原件保留，不做改写。

---

## 阅读指南

本文档刻意把内容分成三类，**因为它们的老化速度不同**：

| 标记 | 含义 | 老化速度 | 评审关注点 |
|---|---|---|---|
| **【dsh 专有】** | dsh 平台的机制与约束，全部有实测证据 | **快** —— 随上游版本变化 | 事实是否准确；dsh 升级时要复核 |
| **【基座通用】** | 任何 agent 框架下企业基座都该有的东西 | **慢** —— 跨框架长期成立 | 是否有遗漏；是否过度设计 |
| **【本项目决策】** | 我们在上述两者之上做的取舍 | 中 | 是否符合业务需要 |

**为什么要这样分**：如果混在一起写，一年后没人分得清"这条是 dsh 逼我们的，还是我们自己选的"。前者升级就能改，后者要重新决策。分开标记后，dsh 换版本时只需复核 **【dsh 专有】** 一节。

另外，**本次全部关键机制均在真实环境实测**，不是从文档推断的。证据见 §3.11，可复现步骤见附录 A。

---

## 1. 目标与范围

### 1.1 目标

做**企业智能体的基座**——不是最终应用。基座的成功标准是：

> **一个新的企业智能体可以从它便捷地启动。**

基座本身不承载业务价值，它由"从它派生的应用有多省事"来证明。

### 1.2 基座与应用的边界（本设计的核心约束）

**基座不是应用。** 基座里**不含任何业务智能体**；业务智能体是从基座**派生**出来的独立产物。

| | 基座 | 应用（企业智能体） |
|---|---|---|
| 是什么 | 可复用的启动底座 | 某个具体业务场景的智能体 |
| 含什么 | 基础配置、基础镜像、模板、脚手架、校验、文档 | `agent.yml`、`mcp.yml`、`skills/` |
| 谁维护 | 平台团队 | 业务团队 |
| 变更频率 | 低 | 高 |
| 版本 | 基座自己的版本号 | 各自独立 |

**派生关系**：

```
        基座（本设计）
        ├── 基础镜像   ──FROM────▶  应用的镜像
        ├── 模板/脚手架 ──生成────▶  应用的 agent.yml / mcp.yml / skills/
        └── 校验工具   ──检查────▶  应用的配置
```

**为什么这条边界是核心约束**：

- 基座里一旦混入业务智能体，它就从"底座"退化成"一个包含两个示例的应用"——别人无法判断**哪些是该继承的、哪些只是某个示例的选择**
- 参考实现（示例）**可以**放在基座仓库内，但必须放在明确的 `examples/` 目录，并在 README 写明"**这不是基座的一部分，可整个删除**"
- 应用是派生到**基座之外**的独立产物，不回头修改基座

### 1.3 "便捷"的定义（重要，先说清）

便捷**不是**"耗时越短越好"。把便捷定义成工期会直接导致砍掉该有的文档与校验，做出没人敢用的东西。便捷指的是**心智负担低**：

| 维度 | 含义 |
|---|---|
| 概念负担 | 业务开发者需要理解的框架概念越少越好 |
| 局部性 | 改一个业务相关的东西，只动一个文件 |
| 可发现性 | 想知道"某个能力怎么配"，能查到 |
| 防错性 | 配错时明确报错；踩过的坑在结构上被挡住，而不是靠人记得 |
| 开箱可用 | 复制模板即可跑，不留 TODO |
| 可接手性 | 新人 + 文档就能上手，不需要读框架源码 |

### 1.4 便捷性的可检查代理指标

用这些替代"分钟数"这类工期指标：

| 指标 | 目标 |
|---|---|
| 新建一个智能体要写/改几个文件 | ≤ 3 |
| 需要理解的框架概念数 | ≤ 4 |
| 需要读 dsh 源码或上游文档 | 0 |
| 配置错误时的反馈 | 显式失败 + 指出文件与行（**当前 dsh 是静默警告，必须补校验**，见 §3.11 实验 A） |
| 复制模板后 | 开箱可跑，无 TODO |
| 新增智能体是否需要声明依赖 | 不需要 |

### 1.5 明确不做（本阶段）

为避免过度设计，以下一律不做：

- 私有 npm registry、bundle 版本矩阵治理
- 多团队 CI 黄金快照门禁
- 细粒度审批策略设计
- 多层 bundle 拆分（`corp-base` + `corp-domain`）

这些都是**验证成功后**才需要的东西，在基座阶段是纯负担。

---

## 2. 总体架构

### 2.1 分层与派生关系

```
                    【基座通用】                     【本项目决策】

    ┌──────────────────────────────────────────────────────────────┐
    │  基座对外的 4 个概念（业务语言）                                │
    │  智能体  ·  技能  ·  连接器  ·  人设与边界                       │
    └───────────────────────────┬──────────────────────────────────┘
                                │ 由基座吸收掉框架细节
                                ▼
    ┌──────────────────────────── 基座仓库 ──────────────────────────┐
    │                                                              │
    │  base/home/       企业基础层（不变量，烤进镜像）  ← 【dsh 专有】  │
    │  base/image/      基础镜像 + entrypoint          ← 【基座通用】  │
    │  base/template/   新智能体的起始骨架              ← 【基座通用】  │
    │  tools/           脚手架 + 校验 + 验收            ← 【基座通用】  │
    │  docs/            文档体系                        ← 【基座通用】  │
    │  examples/        ⚠ 应用示例，非基座本体                       │
    └───────────────────────────┬──────────────────────────────────┘
                                │ 派生（见 §1.2）
                                ▼
    ┌──────────────────── 应用（基座之外）────────────────────────────┐
    │  my-agent/                                                    │
    │  ├── agent.yml     人设与边界        ← 业务开发者只碰这里          │
    │  ├── mcp.yml       连接器                                      │
    │  └── skills/       技能                                        │
    └──────────────────────────────────────────────────────────────┘
```

核心不变量：

> **基座不含业务智能体；应用派生到基座之外，且不回头修改基座。**

这条是结构的保证。一旦业务开发者需要改 `base/`，说明抽象没做对——他应该只写 `agent.yml` / `mcp.yml` / `skills/`。

### 2.2 E2E：从基座到**验证可用**的智能体

本项目里"端到端"指的是这条路径走通，并且**结果经过验证**：

```
基座  ──派生──▶  应用（智能体）  ──验证──▶  可用
```

**"可用"不等于"能启动"**，而是下面六关全过：

| # | 关 | 判据 | 手段 |
|---|---|---|---|
| 1 | 配置合法 | patch 目标都存在；必需项齐全；取值合法 | 静态检查 `--dump-config` |
| 2 | 能启动 | 无 `patch: entry not found`；无 `skipping profile bundle` | 启动日志 |
| 3 | 模型可达 | provider 路由解析成功 + 凭据解析成功 + 一次最小推理有返回 | 探针任务 |
| 4 | 技能被加载 | 声明的技能进入会话目录 | 探针任务 |
| 5 | 连接器可达 | MCP server 连接成功，工具出现在工具列表 | 探针任务 |
| 6 | 能完成任务 | 冒烟任务退出码 0，输出符合预期 | 冒烟任务 |

**验证能力必须在基座里，不能在应用里。** 因为"智能体可用"是基座对外的唯一承诺；而应用作者既没有能力、也不该自己判断"配置是否真的生效"——§3.12 的静默失败清单正是这类问题的来源。

对应交付物：`tools/verify.mjs`，一条命令输出六关的通过/失败。

### 2.3 模型层：provider/model 的通用设计

**原则：能力（有哪些 provider 可用）是企业不变量；选择（这次用哪个 provider/model）是应用可变。**

| 放什么 | 放哪 | 理由 |
|---|---|---|
| 企业可用的 provider 路由（官方 / 内网网关 / 自托管） | home 层：`dsh-llm-pi-ai` 的 `providers` | 企业不变量 |
| 默认 provider/model | home 层给保守默认，**值从环境变量读** | 应用可用 `--patch`（最高优先级）覆盖 |
| 应用自己的偏好 | 应用 `agent.yml` | 可变 |
| 会话临时切换 | `/model` | dsh 原生能力 |
| 密钥 | 配置里**只写引用名**（`apiKeyEnv`） | 配置与密钥分离 |

**不写死任何 provider。** 官方 API、内网 OpenAI 兼容网关、自托管服务器，在本设计里都只是**一条路由配置**。dsh 侧的机制细节见 §3.13。

---

## 3. 【dsh 专有】平台机制与实测结论

> **本节全部内容随 dsh 版本变化。dsh 升级时只需复核本节。**

### 3.1 profile 与四层配置合成

一个 profile 是 `$DSH_HOME/profiles/<name>/` 下的目录：

| 文件 | 作用 |
|---|---|
| `package.json` | 声明 `dsh.profile.bundles`（有序数组）与 `dsh.profile.patchReload` |
| `cordis.yml` | profile 根，出厂即空数组 `[]`，不应编辑 |
| `cordis.patch.yml` | 该 profile 的用户层 |
| `pnpm-workspace.yaml` | `nodeLinker: hoisted`、`autoInstallPeers: false` |

**四层合成顺序（后者覆盖前者，实测确认）**：

```
① bundle 层      profile package.json 的 dsh.profile.bundles，按数组顺序，后写胜
② profile 层     $DSH_HOME/profiles/<n>/cordis.patch.yml
③ home 层        $DSH_HOME/cordis.patch.yml          ← 覆盖所有 profile
④ --patch        启动参数，可重复                      ← 最高优先级
```

### 3.2 patch 语义（这是最容易踩坑的地方）

| 语义 | 说明 |
|---|---|
| 定位方式 | 按 `id` 定位，可穿越嵌套 group |
| **`config` 替换** | **整体替换，不是深合并**。改一个字段也要重述整个 config |
| `disabled` | 关闭某个 row |
| `insert:` | 插入新 row（新插件） |
| `!!js` | 允许 JS 表达式，可读 `process.env` |
| 冲突 | 同一 row 后写胜 |
| **目标不存在** | **只打警告，exit 0，继续运行**（见 §3.11 实验 A） |

最后一条是 dsh 最危险的特性：**配置失效是静默的**。

### 3.3 bundle 契约

- 任意 npm 包声明 `dsh.bundle.patch` 即可成为 bundle
- 该字段**可以是字符串，也可以是路径数组**（`@deepseek-ai/dsh-web-app` 用了 5 个 patch 文件）
- 解析根：**dsh 安装目录** 或 **profile 目录**
- **bundle 之间不可嵌套** —— profile 的 `bundles` 是扁平列表，没有"依赖推导"

### 3.4 模块解析根（实测）

| 层 | 解析根 |
|---|---|
| profile 层 / bundle 层 | dsh 安装目录，或 `profiles/<n>/node_modules` |
| **home 层** | **`$DSH_HOME/node_modules`** |

**这条的直接价值**：home 层引用的插件装在 `$DSH_HOME/node_modules` 一次，**所有 profile 自动可见**，无需每个 profile 声明依赖。

### 3.5 出厂模板与脚手架

- 出厂模板：`acp`、`web`、`headless`、`sdk`、`sdk-minimal`
- 共同基础：`@deepseek-ai/dsh-base`
- 创建自定义 profile：`dsh <name> --from-default-profile <template>`
- 检查配置：`--dump-config`、`--dump-default-config`、`--dump-config-schema`
- 插件管理：`dsh plugin --profile <name> <pnpm-args…>`

### 3.6 skills 发现

`@deepseek-ai/dsh-skill-filesystem` 按 rank 顺序扫描六个根：

| Rank | 来源 | 路径 |
|---|---|---|
| 100 | project-dsh | `<projectRoot>/.dsh/skills` |
| 200 | project-agents | `<projectRoot>/.agents/skills` |
| 300 | custom | `Config.customSkillDirs` |
| 400 | user-dsh | `<DSH_HOME>/skills` |
| 500 | user-agents | `<DSH_AGENTS_HOME>/skills` |
| 600 | bundled | `Config.bundledSkillDir` |

- skill 形式：目录 bundle `<name>/SKILL.md`，或平铺 `<name>.md`
- frontmatter 必填 `name`、`description`；可选 `whenToUse`、`metadata`、`disable-model-invocation`、`user-invocable`
- **不支持**嵌套发现（`**/SKILL.md`）
- `watch: true`（默认）会监视根目录，编辑正文无需重启
- 目录与正文分离：每次加载重新读文件，无需缓存失效

### 3.7 MCP

`@deepseek-ai/dsh-mcp-client`，**每台服务器配置一条 row**：

| 字段 | 说明 |
|---|---|
| `transport` | 必填，`stdio` 或 `streamable-http` |
| `serverName` | 必填，工具命名空间，`[A-Za-z0-9_-]{1,32}`，同一注册作用域内唯一 |
| `command`/`args`/`env`/`cwd` | stdio 传输 |
| `url`/`headers` | streamable-http 传输 |
| `toolCallTimeoutMs` | 默认 60000 |
| `failOnStartupError` | 默认 `false` —— 连不上时 harness 仍启动，只是缺工具 |
| `reconnect.*` | 默认启用；`maxAttempts: 10` 连续失败后**移除该服务器工具** |

- 工具名形如 `mcp__<serverName>__<tool>`
- 服务器指令作为字面文本进入系统提示词
- 不支持 MCP 提示词模板
- 资源发现/读取由配套的 `dsh-mcp-resources` 提供

### 3.8 权限与沙箱

- `dsh-permission-presets`：具名预设把**沙箱模式 + 审批策略**捆绑为一组；保留名 `custom`、`auto` 不可用
- `dsh-sandbox-policy`：部署默认值 + 逐会话覆盖，所有限制能力共用同一份策略
- **无审批应答者时按 fail closed 处理** —— 无人值守的容器场景，审批策略必须显式设为自动放行，否则会卡死
- 沙箱实现 `landlock` **仅 Linux**；macOS 上无 OS 级沙箱

#### 3.8.1 审批接缝的确切形态（实测，A6b 的前置）

| 项 | 实测形态 | 来源 |
|---|---|---|
| 服务方法 | `ctx.approval.request(req: ApprovalRequest): Promise<ApprovalOutcome>` | 随包 API 目录（`dsh-tool-cordis` 的 `api-catalog`） |
| 结果取值 | `allowed-once` \| `rejected` \| `cancelled` \| `unavailable`（**unavailable = 无应答者 ⇒ fail-closed**） | `dsh-user-approval` 的 `types.d.ts` |
| 事件接缝 | `approval/request` 是 **waterfall**；`'approval/request'(req, next) => Promise<ApprovalOutcome>` | 同上 |
| 原生审计事件 | 会话事件 `approval/asked`（log-only）+ `approval/decided`（带 `id` 配对与 `outcome`） | `dsh-session` 的 `SessionEventMap` |
| 插件注册命令 | `ctx.commands.register(definition): () => void` | 同上 API 目录 |
| 插件装载 | profile patch 的 `insert` row，`name` **必须指向入口文件**（见 §3.11 实验 H） | 本仓库探针 `make dsh-approval-probe` |

**⚠️ 关键实测（这条改变了 A6b 的做法）**：原生审批审计事件**不在**统一轨迹映射所读的那条 `--json`
事件流里（`danger-full-access` 与 `ask` 两种模式下都是 0 条），会话文件在本次运行里也只写了
`session` 引导事件。因此**另一侧的「谁放行了」不能靠事后映射拿到** —— 要么建基座不变量插件脚手架、
让插件当场把 `approval.decision` 写进轨迹，要么改读会话文件（通道②，需 zstd，且本次实测里面没有内容）。
两条路都不是「加一个映射」那么小；做法与前置见路线图 §30 A6b。

### 3.9 热重载（HMR）—— 迭代速度的关键

`@deepseek-ai/dsh-hmr` 用一个统一队列热重载**插件源码与 profile 配置**。

**关键差异（实测确认）**：

| 组合包 | HMR 状态 |
|---|---|
| tui | **启用**（base 在存在 `profileContext` 时以 `root: []` 启用） |
| **headless / SDK / ACP** | **在 YAML 中显式禁用**，需 profile patch 重新启用 |

直接推论：**本地迭代应在 tui 上做，容器只用于验证交付契约。** 不要试图在容器里做迭代。

### 3.10 凭据

`@deepseek-ai/dsh-credentials-local`，查找优先级：

```
启动环境变量  >  凭据存储文件  >  项目 .env  >  harness home 的 .env
```

- 存储路径可配置：`config.path: /absolute/path/.credentials.yaml`
- 变更自动重载，跨重启保留
- **已知限制**：文件权限**无法对 agent 隔离** —— agent 的工具进程以同一 OS 用户运行

### 3.11 实测证据（可复现，方法见附录 A）

环境：`DSH_HOME` 指向工作区内的临时目录，profile 只挂 `@deepseek-ai/dsh-base`。

| 实验 | 操作 | 结果 | 对设计的含义 |
|---|---|---|---|
| **A** | profile 层 patch 的目标 = home 层 `insert` 的行 | `dsh: [.../cordis.patch.yml] patch: entry "lab-probe-todo" not found`，**exit 0 继续运行**，home 层取值胜出 | home 层钉住的 row，**领域层改不动**；且失效是静默的 |
| **B** | `--patch` 与 home 层同改一个 row | `--patch` 胜出 | `--patch` 是最高层 |
| **C** | `--patch` 的目标 = home 层 `insert` 的行 | 成功覆盖 | `--patch` 是唯一逃生通道 |
| **D** | home 层用 `!!js process.env.X ?? 'fallback'` | patch 生效；`--dump-config` 输出**未求值**的表达式 | 黄金快照只能抓结构性漂移，抓不到环境变量引起的取值漂移 |
| **E** | home 层 `insert` 一个只存在于 `$DSH_HOME/node_modules` 的包 | 解析成功 | 企业插件装一次全局可见 |
| **F** | 权限模式 `danger-full-access` 下跑一次带工具调用的一次性会话，统计原生 `--json` 事件类型 | `session/status/text/tool_call/tool_result/final`，**审批记录 0 条** | 放行模式下压根不发生审批，轨迹里自然没有 |
| **G** | 权限模式 `ask` 下重跑同一实验 | 同上，**审批记录仍是 0 条**；会话文件只有 `session` 引导事件 | 审批审计事件**不在**我们读的通道里 ⇒ 事后映射拿不到「谁放行」 |
| **H** | profile patch `insert` 一个**相对路径** row：`./plugins/ab-probe`（目录）vs `./plugins/ab-probe/index.js`（入口文件） | 目录 ⇒ `failed to import`（ESM 无目录解析）；入口文件 ⇒ `apply` 执行、`ctx.commands.register` 返回 disposer | 基座插件脚手架可行，但 row 的 `name` **必须指入口文件** |

> F/G/H 由 `make dsh-approval-probe` 一并复现（探针脚本即证据；**不放进默认回归**，因为它要真跑 dsh）。

### 3.12 【dsh 专有】静默失败清单（必须写进 troubleshooting 文档）

| 现象 | 真实原因 | 排查方式 |
|---|---|---|
| 改了配置没生效 | patch target id 不存在 | 看 stderr 有无 `patch: entry not found`；用校验工具 |
| 插件没加载 | `peerDependencies` 与 dsh 版本不符，被**跳过加载** | stderr 有 `skipping profile bundle`；`dsh plugin allow-version` |
| 工具没出现 | MCP server 连接失败，`failOnStartupError: false` 时静默降级 | 查日志 + 用 `--dump-config` 确认 row 存在 |
| 行为与本地不一致 | macOS 无 landlock 沙箱；容器内有 | 见 §5.5 本地/容器差异 |

### 3.13 模型层与提供方路由

| 组件 | 职责 |
|---|---|
| `@deepseek-ai/dsh-llm` | **提供方无关**的模型调用服务。本身不含任何提供方协议代码、也没有配置；必须与至少一个适配器同挂。按请求中的 `provider` 名选择路由 |
| `@deepseek-ai/dsh-llm-deepseek` | 直连 DeepSeek 的适配器，配置 `apiKeyEnv` |
| **`@deepseek-ai/dsh-llm-pi-ai`** | **通用路由适配器**：一份 `providers` 字典把请求路由到 pi-ai 提供方目录、**OpenAI 兼容网关**或**自托管服务器** |
| `@deepseek-ai/dsh-agent-default-model` | 为新 agent 提供默认 `{ provider, model, reasoningEffort? }` |
| `@deepseek-ai/dsh-client-ui-model-selection` | 会话级 `/model` 切换，按 provider 分组 |
| `@deepseek-ai/dsh-llm-retry` | 重跑失败请求，支持按路由的 `retryPolicy` |

**`dsh-llm-pi-ai` 的 `providers` 字典就是整个配置面**，每个键是一个路由名（请求用该名选择），可指向完全不同的端点与协议：

| 字段 | 含义 |
|---|---|
| `apiKeyEnv` | **按请求经凭据 seam 解析的引用** —— 配置文件绝不包含密钥；解析为空则该请求以 `MISSING_CREDENTIAL` 失败 |
| `baseURL` | 路由上所有模型的端点 |
| `api` | 协议格式（如 `openai-completions`），仅目录不提供的路由需要 |
| `models` / `modelOverrides` | 整体替换该路由目录 / 只重塑个别模型 |
| `compat` | 端点无法识别时的协议兼容开关（如 `thinkingFormat`） |
| `displayName` | 选择器界面显示名 |
| `retryPolicy` | 该路由自有的重试策略 |
| `defaultContextWindow` / `defaultMaxTokens` | 未描述模型的容量与输出回退值 |

**三个对本设计关键的特性**：

1. **provider 与凭据按请求解析 → 改路由下一个请求即生效，无需重启**
2. **两个适配器可同时挂载**（路由名不冲突），因此"官方直连"与"内网网关"可以并存
3. **手工声明的路由键若不符合凭据记录文法（小写连字符标识符），无法走登录流程认证** —— 这类路由必须用 `apiKeyEnv`

**配置形态（这就是"不写死 provider"的样子）**：

```yaml
- name: '@deepseek-ai/dsh-llm'
- name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      corp-gateway:                    # 内网 OpenAI 兼容网关
        displayName: 企业网关
        apiKeyEnv: CORP_GATEWAY_API_KEY
        api: openai-completions
        baseURL: https://gateway.corp.example/v1
        models:
          - id: corp-think
            contextWindow: 262144
      self-hosted:                     # 自托管
        apiKeyEnv: SELF_HOSTED_KEY
        api: openai-completions
        baseURL: http://vllm.internal:8000/v1
```

**已知限制**：`dsh-agent-default-model` **不验证目录成员资格**。模型是否真的可用由发起请求的消费者负责诊断 —— 这正是 §2.2 把"模型可达"列为基座侧探针验证项的原因。

---

## 4. 【基座通用】企业智能体基座应具备的能力

> **本节与框架无关。** 换掉 dsh，这些结论依然成立；dsh 只是其中一种实现方式。评审时请重点看这里是否有遗漏或过度设计。

### 4.1 统一且可版本化的智能体定义单元

**要求**：一个智能体 = 一个目录，目录本身可 diff、可 code review、可回滚。

**理由**：智能体的行为（人设、技能、连接器）是**工程资产**，不是运维参数。如果它只存在于控制台的输入框里，就没有评审、没有回滚、没有审计。

### 4.2 概念收敛：把框架概念映射为业务词汇

**要求**：业务开发者需要理解的概念 ≤ 4 个，且必须是业务语言。

**理由**：这是"便捷"的核心。框架必然有自己的概念体系（层、补丁、作用域、注册表……），但业务开发者不该为此付费。

映射示例（本项目取值）：

| 业务开发者说 | 框架里对应什么 |
|---|---|
| 我的智能体 | 一个 agent 目录 + 启动时的配置合成 |
| 它会哪些技能 | `SKILL.md` 目录 bundle |
| 它能连哪些系统 | MCP 服务器配置记录 |
| 它是谁、边界在哪 | persona + 工具白名单 |

### 4.3 能力目录（Capability Catalog）

**要求**：一份文档，列出**所有可配置的能力**、字段、默认值、取值范围、以及在哪个文件里配。

**理由**：没有它，业务开发者只能靠读源码或问人。"可发现性"是便捷性的支柱之一。

### 4.4 静态校验与运行时验收

**要求（静态）**：配置错误必须**显式失败**，并指出文件与位置。必须能检测：
- 引用了不存在的目标
- 必需项缺失
- 取值不合法（如 MCP 服务器名不符合命名空间规则）
- 声明的凭据没有对应的环境变量

**要求（运行时）**：必须有能力验证一个智能体**真的可用**，而不只是"启动没报错"——模型可达、技能被加载、连接器可达、冒烟任务能完成（六关见 §2.2）。

**理由（静态）**：**如果框架的失败模式是静默的，基座必须补上这一层。** 否则"便捷"是假的 —— 用户以为改了，其实没生效，然后在别处浪费时间排查。

**理由（运行时）**："启动成功"与"可用"是两件事。缺了运行时验收，"端到端"就退化成"能起来"，而使用者真正要知道的是**它能不能干活**。

### 4.5 脚手架与开箱可跑的模板

**要求**：一条命令从模板生成新智能体，生成结果**开箱即跑，无 TODO**。

**理由**：留 TODO 的模板等同于没有模板 —— 它把决策负担又还给了使用者，而且每个人填得不一样。

### 4.6 参考实现示例（≥2 个，且与基座本体明确分离）

**要求**：至少两个**完整可跑**的示例智能体，覆盖不同的能力组合（如：纯技能型 / 带外部系统连接型）。

**要求（边界）**：示例是**应用**，不是基座。必须放在独立的 `examples/` 目录，并在其 README 中写明"**这不是基座的一部分，可整个删除**"。

**理由**：模板教会"骨架长什么样"，示例教会"怎么组合"。只有一个示例时，使用者会把它当成唯一正确答案；而示例若与基座本体混放，使用者会分不清**哪些是必须继承的、哪些只是某个示例的选择**。

### 4.7 凭据与配置分层管理

**要求**：
- 凭据与配置**分离**，凭据永不进镜像、永不进仓库
- 明确的查找优先级，且**环境变量优先**
- 配置中引用凭据用变量，不写字面值

**理由**：企业环境下凭据来源多样（K8s Secret、Vault、CI 变量），基座不能把某一种写死。

### 4.8 一致的本地/交付双入口

**要求**：同一份智能体定义，本地开发与容器交付都能用；两者行为差异必须**显式记录**。

**理由**："本地能跑，容器不能跑"是这类基座最常见的失败。差异不可能为零（沙箱、HMR、网络都不同），但必须**已知且写在文档里**，而不是靠人踩。

### 4.9 交付契约

**要求**：明确约定容器化智能体的外部契约：
- 退出码语义
- stdout / stderr 的分工（哪些是给机器读的，哪些是给人读的）
- 日志位置与保留策略
- 健康检查方式
- 需要可写卷的路径

**理由**：企业集成需要稳定的契约。stdout 混入日志会破坏调用方解析，这类问题必须在基座层面定死。

### 4.10 可观测与轨迹留存

**要求**：能回答"这个智能体为什么这么决策" —— 保留完整会话轨迹（输入、工具调用、结果、最终输出），且可导出。

**理由**：企业场景下，智能体的输出要能被审计和追责。

### 4.11 文档体系

**要求**（最小集）：

| 文档 | 回答的问题 |
|---|---|
| overview | 这是什么、封装了什么、边界在哪 |
| quickstart | 怎么最快跑通第一个 |
| concepts | 概念映射表（§4.2） |
| capability catalog | 有哪些能力可配（§4.3） |
| skills / connectors | 两类扩展点怎么用 |
| deploy | 镜像、环境变量、凭据、卷 |
| troubleshooting | **失败模式清单**（含框架静默失败） |
| conventions | 纪律：哪层能放什么、不能放什么 |

**理由**：文档是"可接手性"的唯一实现方式。缺 troubleshooting 的文档体系等于没有文档 —— 新手卡住时无处可查。

### 4.12 分层纪律的显式化

**要求**：每一层的**职责边界**必须写在配置文件注释里，而不只是写在文档里。

**理由**：文档会被跳过，注释在被编辑时就在眼前。特别是"这一层不能放什么"必须写清楚，否则该层会随时间膨胀成"什么都有、谁都不敢动"的单体文件。

### 4.13 版本与变更管理

**要求**：基座自身有版本号与变更记录；上游依赖的版本策略明确（POC 阶段可用范围，稳定后精确锁定）。

**理由**：基座是别人依赖的东西，它变了别人要知道变了什么。

---

## 5. 【本项目决策】落地到 dsh 的具体设计

### 5.1 关键决策及依据

| 决策 | 取值 | 依据 |
|---|---|---|
| 企业基础配置放哪层 | **home 层** `$DSH_HOME/cordis.patch.yml` | 零配置覆盖所有 profile；`$DSH_HOME/node_modules` 全局可见（实验 E）；业务开发者无需声明依赖 |
| 企业插件放哪 | `$DSH_HOME/node_modules` | 同上 |
| 领域差异怎么表达 | **`--patch` 文件**（待评审，见 §6.2） | `--patch` 是最高层，能覆盖 home 层 insert 的行（实验 C） |
| 本地迭代入口 | `dsh-tui` | HMR 启用（§3.9） |
| 容器交付入口 | `headless` / `sdk` | headless 退出码 + stdout 纯净，适合被调用 |
| **E2E 的"端"** | **基座 → 派生 → 验证可用的智能体**（六关，见 §2.2） | 已定 |
| **模型层设计** | **provider/model 不写死**；通用路由用 `dsh-llm-pi-ai`；**能力在 home 层、选择在应用层**；密钥只写 `apiKeyEnv` 引用（§2.3 / §3.13） | 已定：要求灵活性最好 |
| 静默失败如何兜底 | `tools/validate.mjs`（静态）+ `tools/verify.mjs`（运行时） | 实验 A：dsh 静默通过 |

### 5.2 基座交付物文件清单

**基座仓库里不含任何业务智能体。**

```
dsh-agent-base/              # 基座仓库
├── README.md                      # 这是什么 / 给谁看 / 从零启动一个智能体
├── CHANGELOG.md                   # 基座自身的版本与变更
├── Makefile                       # new-agent / validate / verify / run / image
│
├── docs/
│   ├── 00-overview.md             # 含 §1.2「基座与应用的边界」
│   ├── 01-quickstart.md           # 从零启动第一个智能体
│   ├── 02-concepts.md             # 4 概念 ↔ dsh 机制映射
│   ├── 03-capability-catalog.md   # 能力清单
│   ├── 04-skills.md
│   ├── 05-connectors.md
│   ├── 06-deploy.md
│   ├── 07-troubleshooting.md      # 含 §3.12 静默失败清单
│   └── 08-conventions.md
│
├── base/                          # ★ 基座本体
│   ├── home/                      # 企业基础层（烤进基础镜像）
│   │   ├── cordis.patch.yml       # 每条带注释说明"为什么必须是全企业统一"
│   │   ├── package.json           # 企业插件依赖
│   │   ├── skills/                # 企业通用技能
│   │   └── README.md              # 本层纪律与边界
│   ├── image/
│   │   ├── Dockerfile
│   │   ├── entrypoint.sh          # 选择智能体（方式取决于 §6.2 决策 1）
│   │   └── README.md
│   └── template/                  # 新智能体的起始骨架，开箱可跑、无 TODO
│       ├── agent.yml              # 人设与边界
│       ├── mcp.yml                # 连接器
│       ├── skills/example/SKILL.md
│       ├── .env.example
│       └── README.md              # 这个模板怎么改
│
├── tools/                         # ★ 基座本体
│   ├── new-agent.mjs              # 从 base/template 派生出一个应用
│   ├── validate.mjs               # 静态校验：补 dsh 静默失败的洞
│   ├── verify.mjs                 # ★ 运行时验收：六关（见 §2.2），输出可用/不可用
│   ├── run-local.sh               # 本地 dsh-tui 起一个应用
│   └── README.md
│
├── examples/                      # ⚠ 应用示例，不是基座本体，可整个删除
│   ├── README.md                  # 说明与基座的关系
│   ├── contract-review/           # 纯技能型（合同条款审阅）
│   └── ticket-triage/             # 带外部系统连接型（工单分诊）
│
└── .github/workflows/validate.yml
```

### 5.3 "便捷启动"的验收方式

基座好不好用，由下面这段流程证明。**中途不需要理解任何 dsh 概念**：

```bash
# ① 派生一个新应用（在基座之外，独立目录）
new-agent my-agent                    # 基座提供的脚手架（分发方式取决于 §6.2 决策 3）
cd my-agent

# ② 只写业务内容 —— 三个文件
$EDITOR agent.yml                     # 它是谁、边界在哪、开哪些连接器
$EDITOR mcp.yml                       # 连哪些内部系统
$EDITOR skills/<name>/SKILL.md        # 它会哪些技能

# ③ 静态校验（配置合法 + 无静默失效）
make validate

# ④ 本地跑起来（dsh-tui，HMR 热重载，改完立即生效）
make run

# ⑤ 运行时验收 —— 六关全过才算"可用"，这是 E2E 的终点
make verify

# ⑥ 出交付镜像
make image
```

**验收标准**：这六步能跑通；第 ② 步只需要业务知识、不需要 dsh 知识；第 ⑤ 步给出明确的"可用 / 不可用"结论。

### 5.4 迭代循环

```
① 本地 dsh-tui          ← HMR 启用：改 agent.yml 立即生效，skills 有 watcher
   无需重启即可调「想法」

        ↓ 调通了再走这一步

② 容器 headless          ← HMR 默认关闭，重启生效
   验证「交付契约」：退出码、stdout、端到端产物
```

### 5.5 本地 / 容器差异（必须写进文档，不能靠人踩）

| 差异 | 本地 macOS | 容器 Linux |
|---|---|---|
| OS 沙箱 | 无（landlock 仅 Linux） | 有 |
| HMR | 启用 | 默认禁用 |
| 网络 | 可访问公网 | 视部署环境 |
| 路径 | 宿主路径 | 挂载路径 |

**结论**：本地验证通过 ≠ 容器行为一致。安全相关的行为必须在容器内验证。

### 5.6 home 层纪律（写进文件注释）

**放**：模型路由（`!!js process.env`）、工具开关、企业通用 skills 根、通用 MCP 占位（默认 `disabled: true`）、凭据查找路径。

**不放**：任何不同智能体之间会分叉的东西。

**理由**：home 层钉住的 row 领域层改不动（实验 A），且失败是静默的。一旦把会分叉的东西放进去，智能体之间的差异只能靠 `--patch` 绕过，纪律就崩了。

---

## 6. 待评审决策点

### 6.1 已定（不再评审）

| 决策点 | 结论 |
|---|---|
| E2E 的"端" | **基座 → 派生 → 验证智能体可用**。"可用" = §2.2 的六关，不等于"能启动" |
| 模型层设计 | **provider/model 不写死**。通用路由用 `dsh-llm-pi-ai`；**能力（有哪些 provider）在 home 层，选择（这次用哪个）在应用层**；密钥只写 `apiKeyEnv` 引用 |

### 6.2 待你拍板

| # | 决策点 | 选项 | 倾向 |
|---|---|---|---|
| 1 | 领域差异的表达方式 | **A.** `--patch` 文件 + `AGENT` 环境变量<br>**B.** 每个智能体一个独立 profile | A：一个镜像多智能体，业务开发者更省事<br>代价：智能体身份在启动参数里，不在 profile 文件里 |
| 2 | 参考实现选哪两个业务场景 | 待定 | 建议覆盖"纯技能型"与"带外部系统连接型"各一 |
| 3 | 基座与应用是否分仓 | **A.** 基座独立仓库，应用各自派生到基座之外<br>**B.** 单仓库，应用放 `apps/` 下 | A：§1.2 的边界在结构上成立<br>B：起步快，但边界容易糊掉 |

---

## 7. 风险与已知限制

| 风险 | 说明 | 缓解 |
|---|---|---|
| **基线是 RC 版本** | `0.1.7-rc.1` 为预发布，接口可能变化 | 版本精确固定；升级时复核 §3 全节 |
| **重述腐化** | `config` 整体替换，home 层重述的 row 会随上游结构变化而过期，且**不报错** | `validate.mjs` + 定期复核 §3 |
| **home 层膨胀** | 便利性会诱使把所有配置塞进 home 层 | §5.6 纪律写进文件注释 + 校验工具检查 |
| **静默失败** | patch 目标不存在、插件版本不符、MCP 连不上都不阻断运行 | `validate.mjs` + §3.12 清单 |
| **模型可用性无静态保障** | `dsh-agent-default-model` 不验证目录成员资格；provider 路由写错或凭据缺失只在请求时暴露（`MISSING_CREDENTIAL`） | `verify.mjs` 第 3 关（模型可达）探针 + §6.1 模型层设计 |
| **沙箱能力不齐** | macOS 无 landlock，本地与容器行为不同 | §5.5 + 安全相关行为必须在容器验证 |
| **凭据无法对 agent 隔离** | agent 工具进程以同一 OS 用户运行 | 容器边界由编排层负责，不依赖 dsh 内部隔离 |
| **上游文档缺失** | `npm` 包内无中文/英文 docs 目录，只有包级 README | 本次实测结论即为知识资产，沉淀在 §3 |

---

## 附录 A：实测方法（可复现）

```bash
# 1. 建一个隔离的 DSH_HOME 与最小 profile
LAB=/tmp/dsh-lab; H=$LAB/dsh-home
mkdir -p $H/profiles/lab
cat > $H/profiles/lab/package.json <<'EOF'
{ "name": "dsh-profile-lab", "private": true,
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base"] } } }
EOF
printf '[]\n' > $H/profiles/lab/cordis.yml
printf 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n' \
  > $H/profiles/lab/pnpm-workspace.yaml

# 2. 实验 A：profile 层去改 home 层 insert 的行
cat > $H/profiles/lab/cordis.patch.yml <<'EOF'
- id: lab-probe-todo
  config: { allowParallelInProgress: true }
EOF
cat > $H/cordis.patch.yml <<'EOF'
- insert:
    - id: lab-probe-todo
      name: '@deepseek-ai/dsh-tool-todo'
      config: { allowParallelInProgress: false }
EOF
DSH_HOME=$H dsh --profile lab --dump-config    # 观察 warning 与 exit code

# 3. 实验 B/C：--patch 叠加
DSH_HOME=$H dsh --profile lab --patch ./overlay.yml --dump-config

# 4. 实验 E：只存在于 $DSH_HOME/node_modules 的包能否被解析
SRC="$(npm root -g)/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tool-todo"
mkdir -p $H/node_modules/probe-local-plugin && cp -R "$SRC/." $H/node_modules/probe-local-plugin/
# 然后把该 package.json 的 name 字段改成 probe-local-plugin
cat > $H/cordis.patch.yml <<'EOF'
- insert:
    - id: lab-probe-local
      name: 'probe-local-plugin'
EOF
DSH_HOME=$H dsh --profile lab --dump-config    # 观察 lab-probe-local 是否解析成功
```

环境：dsh `0.1.7-rc.1`、Node.js v24.20.0。实验目录为一次性，验证后清理。
