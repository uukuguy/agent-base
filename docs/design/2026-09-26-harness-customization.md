# harness 业务定制调研：可定制点、差距与两层产品模型

| | |
|---|---|
| 状态 | 调研完成，**结论待评审**（本文不含实现；实现项登记在路线图 §23） |
| 日期 | 2026-09-26 |
| 实测对象 | pi `@earendil-works/pi-coding-agent@0.87.1` · dsh `0.1.7-rc.1`（本机 `/opt/homebrew` 安装版全文核对） |
| 触发 | 评审意见：**"智能体开发不只是 skills、MCP，重点是定制 harness，尤其钩子，更深还有 agent loop"**；以及**"agent-base 现在基本是当作一个进程在用，挂上配置在跑，很多具体应用问题解决不了"** |
| 定位澄清 | **agent-base 是底座；最终可用的智能体是它之上的一个更高级容器镜像**，业务开发在上层充分发挥 |

---

## 1. 结论先讲

1. **"一个进程 + 配置"确实不够**，但缺的不是"更多配置字段"，而是**两种形态**：
   **插件（行为代码）** 与 **常驻服务（会话/审批/网关/遥测）**。配置永远覆盖不了审批通道、
   多租户并发、成本熔断、集中审计这四件事（第 6 节逐条给场景）。
2. **基座的正确职责不是把钩子/loop 塞进中性定义**，而是：
   ① 给上层镜像一个**明确的接入缝**（业务代码放哪、怎么被各运行时加载）；
   ② 让上层的深度定制**仍然可声明、可验证**（钩子触发、策略生效、审批留痕都要有判据）；
   ③ 保持底座不变量（轨迹、参数分层、产物只读、不静默失败）。
3. **基座今天在 L2（钩子）只是"传输通了"，L3（loop）与 L4（服务形态）是空白**；
   并且存在 **6 处"文档说有、实现没有"** 的实证缺陷（第 7 节，全部带文件行号）。
4. 两个运行时的深度定制**机制不同、能力也不同**（pi 靠进程内 TS 扩展 + 32 个钩子事件；
   dsh 靠 cordis 插件组合树 + 可替换 Agent + 原生 approval/sandbox/subagent）。
   ⇒ 上层镜像**必须选定主运行时**，跨运行时"完全等价"这条承诺对深度定制不成立（诚实地写进产物口径）。

---

## 2. 目标形态：两层产品模型

```
┌─ 业务层（上层镜像，业务方自由发挥）───────────────────────────────────┐
│  FROM agent-base:<ver>                                              │
│  · 业务代码（任意语言）      · 钩子/策略/审批实现                    │
│  · 自研工具与连接器           · 服务形态（RPC/SDK/API/ACP、多会话）   │
│  · 业务依赖（pip/apt/npm）    · 业务自己的闸门与验收                  │
└─────────────────────────────────────────────────────────────────────┘
            ▲ 只能通过"接入缝"接触底座（下面 5 条是缝的候选内容）
┌─ 基座层（agent-base：不变量 + 契约 + 闸门）──────────────────────────┐
│  · 中性定义 schema 与渲染   · 启动期准备（参数四种给法、只读暂存）     │
│  · 统一轨迹 schema 与发射   · 四道闸门 + 假网关 + conformance        │
│  · provider 抽象与凭据模式  · 基座镜像（运行时 + 依赖预装）           │
└─────────────────────────────────────────────────────────────────────┘
```

**两层各自的判据**（这是本设计要定的核心）：

| 层 | 决定什么 | 判据 |
|---|---|---|
| 基座 | 不变量、架构缝、验收手段 | 四闸门 + conformance 全绿；`core/` 无运行时名；上层不破坏轨迹/参数/产物契约 |
| 上层 | 业务行为（钩子、策略、loop、服务） | **上层的定制必须留下可验证证据**（见 §5 的验收方式），不许"配了没生效" |

**当前缺口（对照上图）**：上门缝只有一条（`harness/<运行时>/`），而且：
- 上层镜像**拿不到闸门工具**（镜像里只拷 `startup.mjs` + `entrypoint.sh`），**无法自证**；
- 上层镜像**无法加钩子**：扩展必须在**渲染产物**里（`settings.extensions`），而渲染是仓库侧工具，镜像里没有；
- 产物可以**烤进镜像**（`ENTRYPOINT` 取 `AGENT_ARTIFACT_DIR`，默认 `/opt/agent-base/artifact`，只要求目录存在）——
  这条已经通，是两层模型的最低门槛。

---

## 3. 定制层次模型（L0–L4）

| 层 | 是什么 | 能解决什么 | pi | dsh | 可移植性 | 验收方式（现状→应有） |
|---|---|---|---|---|---|---|
| **L0** 声明式配置 | 定义 + provider + 连接器 | 用哪个模型、连哪些系统、有哪些技能 | ✅ | ✅ | **两边等价**（基座已保证） | 四闸门（已有） |
| **L1** 薄接入 | 工具/命令注册 | 业务能力变成模型可调用工具 | ✅ `registerTool` | ✅ `ctx.tools.register` | 形状可共享（业务代码共用，接入各写） | 闸门 2 集合断言 + 闸门 3 工具数（已有） |
| **L2** 钩子 | 生命周期介入：模型前后、工具前后、上下文变换、结算续跑 | 审计、脱敏、策略拦截、动态上下文、审批、续跑 | ✅ **39 个事件**（实测：`types.d.ts:979-1017` 的 39 个 `on()` 重载），四类语义（通知/变换/替换/取消） | ✅ 原生 Cordis 扩展点（`agent/pre-step`、`tools/pre-execute`、`agent/turn-stopping`…） | ❌ 各写一份（事件名与语义不同） | **现状：只验"进了产物"** → 应有："钩子确实触发 + 行为生效"（假网关触发 `tool_call`，断言拦截/改写留痕） |
| **L3** loop 定制 | 步骤/终止条件/上下文构造/续跑策略 | 多轮任务不失控、成本与时长可控、自定义编排 | ⚠️ 扩展只能挂回调；真正接管需绕过 `AgentSession` 直接用 `pi-agent-core`（未 re-export，代价：丢会话树与扩展运行时） | ✅ **一等公民**：官方明说"标准 loop 不够时才应自定义 `Agent` 实现"；组合树可 insert/disable/包装 row | ❌ 不可移植 | 应有：loop 策略声明（最大轮次/时长/终止条件）+ 越界行为可断言 |
| **L4** 服务形态 | 长驻、多会话、多用户、远程、多智能体 | 生产可用：并发、隔离、审批卡点、成本归因 | ⚠️ 唯一长驻形态是 **RPC 单会话**；多会话并发需 SDK 多 `AgentSession` 或多进程 | ✅ web / headless / ACP / JSON-RPC SDK / profile；`plugin-manager` 热改；`subagent` 多后端 | ❌ 各自成体系 | 应有：服务面契约（会话生命周期、并发上限、状态外置）+ 对应闸门 |

**读法**：L0/L1 基座已闭环；L2 传输已通、**契约与验收缺**；L3/L4 是空白。
**上层镜像的价值主要落在 L2–L4** —— 这也解释了为什么"当进程用"解决不了实际应用问题。

---

## 4. 两个运行时的定制面（实测事实）

### 4.1 pi（`@earendil-works/pi-coding-agent@0.87.1`）

- **钩子：39 个事件**（实测：`dist/core/extensions/types.d.ts:979-1017` 逐行数出来的 39 个 `on()` 重载）。
  > 口径更正：本轮四份独立调研里有两份给过"24 个""32 个"，都对不上 —— 以 `on()` 重载逐行计数为准（39）。
  > 记在这里是因为**这类数字必须能被复算**，否则"我支持 N 个钩子"这种话没有意义。

  语义分四类：
  - **通知**（返回值忽略）：`agent_start/end/settled`、`session_*`、`tool_execution_*`、`after_provider_response`、`model_select`
  - **变换**：`context`（可改 messages）、`tool_result`、`message_end`、`before_provider_headers`（原地 mutate，`null` 删头）
  - **替换**：`before_provider_request`（返回值即请求体）、`context_with_system`（handler 全权拥有 prompt/tools）、`before_agent_start`（可整段换 system prompt）
  - **取消/续跑**：`tool_call` → `{block,reason,terminate}`（**handler 抛错即阻断工具**，fail-safe）、
    `session_before_compact`、`input`、`project_trust`；`turn_end` / `agent_before_settle` → `{entries,continue}` 可请求续跑
- **loop**：外层 `AgentSession._runAgentPrompt` 驱动，内层 `pi-agent-core` 的 `agentLoop`；
  扩展**只能挂回调**。要真正接管（自决下一步、自调模型）需绕过 `AgentSession` 直接用 `pi-agent-core`
  的 `Agent`（hooks：`streamFn/convertToLlm/transformContext/beforeToolCall/afterToolCall/finishTurn/prepareNextTurn`），
  但该包**未在 exports 里 re-export** ⇒ 代价是丢掉会话树与扩展运行时。折中：`ctx.modelRegistry.streamSimple()` + 事件续跑。
- **工具与权限**：`registerTool`；禁用走 `--tools` / `--exclude-tools` / `--no-tools` / settings `defaultTools` / `setActiveTools()`。
  ⚠️ **`tools.deny` 是 fail-open**：底层只过滤"初始活跃工具名"，运行期 `setActiveTools()` 可以重开 ⇒
  **必须**在 `tool_call` 钩子与网关侧二次加固（基座现在只做了启动参数这一层，见 §7 缺陷 6）。
- **人在环**：`tool_call` + `ctx.ui.confirm/select`，RPC 下有内建 `extension_ui_request` 子协议可跨进程审批。
- **多智能体**：**内核没有**；官方示例用 `spawn` 起 `pi --mode json` 子进程（并行上限 8/4、无配额与隔离）。
- **形态**：TUI / print / json / **RPC（唯一长驻：单会话）** / SDK（进程内多 `AgentSession`）/ 容器。

### 4.2 dsh（`@deepseek-ai/dsh@0.1.7-rc.1`）

**没有统一 hook 总线**：扩展面 = **Cordis 服务注册**（`ctx.<service>.<register>()`）+ **waterfall 事件拦截**。
约 **30 个真实 seam**。

> 口径更正：我最初扫包得到"22 类"，其中 `ctx.seen` 是某包内局部变量的字段（**误报**）、
> `ctx.reflect.provide` 是 Cordis 依赖注入底层（所有 Service 都经它注册，**非业务 seam**）。
> 这份清单以逐包读 README + 源码语义为准。

**业务相关 seam**（其余为 UI/框架层）：

| seam | 作用 |
|---|---|
| `ctx.tools.register` / `guard` / `restrict` / `schemas` | 工具注册表 + 调用策略管道（业务核心） |
| `ctx.commands.register` | 用户 `/` 命令 |
| `ctx.subagents.registerProvider` | 子智能体后端 |
| `ctx.skills.register` / `registerProvider` | 技能来源（内存/文件） |
| `ctx.llm.registerAdapter` / `registerModelDiscovery` | 模型适配器 |
| `ctx.agentPresets.register` | 预设（一组子插件 rows） |
| `permissionPresets`（config 表 + `set()`） | 沙箱模式 × 审批策略捆绑（**纯配置**） |
| `approval/request`（waterfall answerers） | 人审决策链路 |
| `ctx.authorization.registerFlow` | 需人类交付的凭证登录流程 |
| `ctx.storageDomain.open` / `sessionPersistence.open` | 持久化域 / 会话存储 |
| `ctx.webServer.register` / `webhookRuntime.register(rule)` | HTTP 路由 / 外部事件→新建 root Session |
| `ctx.typert.register` + `@Remote` | 生成 Host↔Client RPC 命名空间 |
| `ctx.sessionProjections.register` | 把 session 事件折叠成客户端可见投影 |
| `ctx.invariants.register` | 运行时契约自检 companion |
| `deepseekLlmApiExtensions.register` | 往请求体注入隐藏字段 |

**组合树 / patch 模型**（这是 dsh"定制 harness"的原生手段，语义比我想的严格）：

- 层序：**bundle patch → profile patch → home patch → `--patch`**；bundle 本身就是一个 `insert` 文档。
- row 形状 `{id, insert?, name?, config?, disabled?, inject?, group?}`：
  **`insert` 带 id** → 追加进该 group 的子列表（立即建索引，后续层可再命中）；**非 insert 必须给 `id`**。
- **`name` 只是断言**（不匹配就 warn + skip，不改模块）；其余键**整键覆盖**（"last write winning per row"）；`id` 不可改。
- **没有 remove**；**没有声明式包装**。
  ⇒ **替换实现 = 禁用旧 row + 插入新 row（+ 代码插件）**；要"包装"必须写 waterfall 监听。
  禁用示例：`- {id: hmr, disabled: true}`。

**loop 可整体替换**（一等公民）：

- `dsh-agent` 刻意与驱动解耦：官方 README 原话 —— "Consumers therefore depend on `dsh-agent` and never on
  `dsh-agent-loop`, keeping the driver **swappable**" ⇒ 业务可 `ctx.agents.setFactory(...)` 换掉整个 loop。
- 也可以用 `ctx.agents.create({setup})` / `agent.ctx` 做 **per-agent 作用域**定制（随 dispose 回收）。
- 阶段拦截（waterfall）：`agent/pre-step`（`{kind:'reject'}` 或替换 messages）·
  `agent/request`（返回 `LlmCallConfig` ⇒ 可改 **provider/model/tools**）·
  `agent/request-error`（`{kind:'retry'}`）· `agent/turn-stopping`。
- ⚠️ **请求对象 deep-frozen** ⇒ 只能**整体替换**，不能原地改。

**工具策略管道**（顺序固定）：
`tools/pre-execute`（返回 `allow/deny/cancel/ask`）→ **单调 `guards`** → `tools/execute` → `tools/post-execute`（可替换内容/阻断）→ `tools/result`（只读）。
- **`guards` 是单调同步守卫**：返回 reason 即拒，**后注册者无法翻案**（比"最后写入者赢"更安全）。
- `restrictions` = `tools.restrict(filter)` 的 allow/deny 掩码（作用于 agent 继承面，dispose 解除）。
- `mode` = `native/ptc/both` 是**呈现模式**，不是策略。

**外部 CLI 钩子桥**：`dsh-hook-protocol` + `dsh-hooks-claude-code` / `dsh-hooks-codex` 直接复用
Claude Code / Codex 的 `hooks.json`（点：`UserPromptSubmit/PreToolUse/PostToolUse/Stop/SessionStart`；
**exit 2 = 阻断且 stderr 即原因**；合并规则 **deny > ask > allow**；⚠️ **钩子失败一律不阻断**）。

**人审链路**：`approval/request` 是 waterfall（answerers）；策略 `ask|never`；
**没有 terminal answerer 就 `unavailable` 失败关闭**（✓ fail-closed）；`tool-ask-user` 走 `ctx.userQuestions`
（子 agent 不可调用）；`authorization.registerFlow` 管**凭证登录**（不是审批）；`permission-presets`
把 sandbox + approval 捆成单一用户旋钮。

**多智能体**（四档，全是原生）：

| 档 | 提供者 | 要点 |
|---|---|---|
| 一次性子 agent | `dsh-subagent` + `-spawn-in-process` + `tool-subagent` | 返回最终答案；`maxDepth=1` |
| **可续**子 agent | `dsh-subagent-fork-in-process`（`backgroundMode: continuable`） | 持久化 session；`sendMessage/interrupt/listChildren`；仅紧邻父子；`maxActiveSubagents=8` |
| 同级团队 | `dsh-experimental-agent-team` | Lead + teammates，持久化 mailbox + 共享 task board（CAS），9 个工具；单进程同工作区 |
| 远程驱动 | `dsh-acp` / `dsh-sdk-jsonrpc-server` / `dsh-api-gateway` + `api-remotes` | 外部系统当上层驱动 |
| 编排层 | `dsh-workflow` / `-ptc` / `tool-workflow` | 脚本化 fan-out |

**部署形态**：`<profile>` / `headless`（一次性）/ **`web`（HTTP+WS GUI，多会话并发）** /
`sdk`（JSON-RPC stdio）/ `acp`（stdio，有 `session/new|list|resume|close`）/ `plugin` 子命令 / `desktop`。
会话持久化 `session-persistence-jsonl`；`dsh-session` 提供 create/resume/fork/flush；
业务驱动入口：ACP stdio · SDK JSON-RPC · 受鉴权 HTTP `/api` Remote · `webhookRuntime` · `schedule` · profile patch 层。

**值得基座照搬的五件套**（dsh 独有的组合）：
服务注册 seam · waterfall 拦截 · **单调守卫** · patch/组合树 · preset 作用域。
**硬边界**：patch row 只能覆盖 `config`/`disabled`，**改不了 `name`、删不掉 row** ⇒
"替换实现"永远要"禁用 + 插入 + 代码插件"，这意味着**上层镜像必然要写代码**（不可能纯配置）。

## 5. 业务定制维度 → 落地手段（★ = 只能写代码/服务）

| 维度 | 业务问题 | 手段 | 基座今天 |
|---|---|---|---|
| 策略与权限 | 谁能碰什么；越权要 fail-closed | 配置 allow/deny/ask + 沙箱 + 钩子判定 | ⚠️ 只有 `tools.deny` 黑名单，且交付入口不生效 |
| 工具与外部系统 | 私有系统变成可调用工具 | MCP（dsh 原生 / pi 无）+ 插件工具 + ★私有鉴权网关 | ✅ L1 已通（MCP 两侧都验过） |
| 上下文与知识 | 领域规范稳定进上下文、长会话不爆窗 | 提示词/技能/压缩配置 + ★检索与记忆 | ✅ 技能与压缩；❌ 检索/记忆 |
| 模型路由 | 成本/延迟/合规三约束、额度耗尽降级 | 多 provider 声明（两侧都吃数据）+ ★成本路由与网关 | ⚠️ 只有名单，无价格/配额/降级 |
| 钩子与生命周期 | 会话前后建环境、模型/工具前后脱敏审计 | 钩子（L2） | ⚠️ 传输通、**契约与验收缺** |
| 编排与多智能体 | 长任务拆解、并行、隔离、续跑 | dsh `subagent`/`goal`；pi 需自建（示例 spawn） | ❌ 未进契约 |
| 传输与部署 | 同一能力进 TUI/CI/IDE/后端；多用户并发 | pi RPC/SDK；dsh web/ACP/SDK | ❌ 基座只有"跑一个进程" |
| 观测与审计 | 回放"为什么这么干"、成本归因、合规 | 轨迹（基座）+ dsh otel/token-meter | ⚠️ 有轨迹，无成本/留存/脱敏策略面 |

**服务面不可省的四件事**（配置永远覆盖不了）：
长驻会话（进程停即上下文散）、多用户并发（一进程=一身份一套凭据）、
审批卡点（钩子只能"问"，没人监听/无超时/无留痕）、成本熔断（只能设默认模型）。
—— 这四件属于**上层镜像/外部服务**，基座要做的是**给出接口与判据**，不是自己实现业务逻辑。

---

### 5.1 结构性风险：扩展与 Agent **同进程同权限**

pi 与 dsh 都一样：扩展/插件跑在 Agent 进程内、用同一套 OS 权限
（pi `extensions.md` 明说 "Extensions execute inside that process"）。
⇒ 一个业务插件崩溃/越权，影响的是**整个会话**。两条产品级含义：

1. **隔离必须靠外层**：每租户/每任务一个容器或进程，而不是指望插件自律。
2. **钩子链要有故障隔离口径**：哪些钩子失败应阻断（如策略拒绝），哪些失败只记日志
   （dsh 的 CLI 钩子桥选择"失败不阻断"，pi 的 `tool_call` 选择"失败即阻断工具" —— **两者语义相反**，
   基座若声称"钩子等价"就是错的）。

### 5.2 配置 / 服务的分界线（要对外明说）

| 能靠**配置**解决 | 只能靠**代码/服务**解决 |
|---|---|
| 启停与参数（patch、`config`、`disabled`） | 审批通道（人/超时/代理/留痕） |
| 工具 allow/deny/ask、沙箱模式、权限预设 | LLM/工具**网关**（配额、鉴权、计费、降级） |
| 模型与 provider 名单、思考等级、压缩阈值 | 集中审计与成本遥测 |
| 技能/提示词/连接器 | 检索与跨会话记忆 · 多租户隔离与并发上限 |

> 别让使用者以为"改 JSON 就能上生产"。上表右列是**服务的活**，不是基座字段的活。

## 6. 基座现状 vs 目标

| 层 | 现状 | 判定 |
|---|---|---|
| L0 声明式 | 中性定义 + 渲染 + 参数四种给法 + 容器 LLM 配置（已实测） | ✅ 闭环 |
| L1 薄接入 | 工具注册两侧实测（pi 3→4、dsh 19→20）；共享业务代码 + `enhance/shared-agnostic` | ✅ 闭环 |
| L2 钩子 | 传输通（`harness/<h>/extensions/*` 被拷进产物，种子 `trace` 就是 hook）、闸门 2 只验"进产物" | ⚠️ **半成品**（见 §7） |
| L3 loop | 无声明面、无验收 | ❌ 空白 |
| L4 服务形态 | 验证路径显式关会话来跑一次性任务（pi `--no-session`） | ❌ 空白 |
| 上层镜像 | 产物可烤进镜像（`AGENT_ARTIFACT_DIR` 默认路径）；但镜像里**没有闸门工具、没有渲染器** ⇒ 上层既不能自证也不能自己加钩子 | ❌ 关键缺口 |

---

## 7. 7 处实证缺陷（"文档说有、实现没有"）

> 全部由本仓库代码与文档对读得出，带文件行号；**未修**，登记在路线图 §23（编号 D1–D7）。

| # | 缺陷 | 证据 | 影响 |
|---|---|---|---|
| 1 | **`enhancements.yaml` 没有 schema**：`kind`/`event`/`entry` 的要求只写在 `core/catalog/capabilities.yaml`（文档生成器的目录），闸门 1 只查顶层 key | `tools/validate.mjs`（B6 段）；无 `core/spec/enhancements.schema.json` | 写错事件名、漏 `event`、未知 `kind` 都能过闸门 1；"钩子声明"形同注释 |
| 2 | **pi 侧"硬断言 3"不是集合相等**：观测值 = "声明 id ∩ entry 文件存在"，再比数量；而渲染器把 `extensions/` 下**每个文件**登记为扩展 | `adapters/pi/doctor.mjs`（enhancement-packaged 段）；`adapters/pi/render.mjs`（settings.extensions 组装） | **往 `extensions/` 丢一个未声明的扩展会被真的加载却查不出来**；与 `docs/09` 的"多一个也不行"矛盾 |
| 3 | **`compare` 不比增强**：只比 skills / connectors / routes | `tools/compare.mjs` | 深度定制落在四道闸门与等价性之外，既不禁止也不验证 |
| 4 | **dsh 渲染静默跳过非 `package` 声明**；profile `dependencies: {}` 写死、无安装步骤 | `adapters/dsh/render.mjs`（buildPatch 的增强循环、profile package.json） | 写错就**静默不生效**；npm 包形态从未被证实（只验过相对路径插件） |
| 5 | **参数层纪律被适配器自己绕过**：直接读 `AGENT_PERMISSION_MODE` / `AGENT_WORKSPACE_ROOT`，两者不在 `params.yaml` allowed 清单 | `adapters/dsh/render.mjs`；`core/catalog/params.yaml` | 与 `adapters/dsh/adapter.yaml` 自述的"只允许读清单里的名字"矛盾；参数层不再可信 |
| 6 | **`tools.deny` 在交付入口不生效**：只有本地运行器传 `--exclude-tools`；容器入口只透传 `AGENT_HARNESS_ARGS` | `adapters/pi/run.mjs`；`core/image/entrypoint.sh` | **我们宣传的工具边界在交付镜像里不成立**（且 pi 侧本就 fail-open，见 §4.1） |
| 7 | **`CURRENT-STATE.md` 已过期**：仍称 C3 按 pi 形状写死、dsh run 待做 | `docs/status/CURRENT-STATE.md` vs `conformance/cases/index.mjs`、`adapters/dsh/run.mjs` | 恢复现场的人会被误导 |

缺陷 1–4 是**同一条根因**：增强层只有"约定"没有"契约"——没有 schema、没有真观测、没有等价性口径、静默跳过。
这也是为什么 §3 把 L2 判为半成品。

---

## 7.1 待你拍板：业务层的主运行时选哪个

调研给出的一致倾向是 **dsh 更省力**（业务面能力更全）：它有原生 MCP、沙箱三模式、
`tools/pre-execute` 策略管道 + 单调 guards、`approval/request` 审批链路、可续子 agent 与团队、
`web`/ACP/SDK 三种服务形态、OTel 遥测、`plugin-manager` 热改。pi 侧这些**多数要自己写扩展**
（且无 MCP、无子代理、无沙箱）。

但代价同样明确：选 dsh = 绑定它的组合树与 seam 语义；pi 的优势是**简单、稳定、装配轻**
（L0/L1 已经两侧都验过）。

| 选项 | 适合 | 代价 |
|---|---|---|
| 业务层以 **dsh** 为主运行时 | 需要审批、沙箱、多智能体、服务形态的业务 | 绑定 dsh 语义；跨运行时"等价"承诺对深度定制不再成立 |
| 业务层以 **pi** 为主运行时 | 只要 L0/L1/L2 的轻量定制，追求装配简单 | 审批/沙箱/子代理要自建；无 MCP（基座已用种子扩展补上，但要自己维护） |
| 两侧都做 | 需要横向比较 | 深度定制的维护成本 ×2（且行为注定不同） |

**这条不实现、也先不选**，但需要你给方向 —— 它决定第 8 节里 7–9 项的落点。

## 8. 演进建议（按改动面从小到大，**未实现**）

| # | 动作 | 判据 | 风险 |
|---|---|---|---|
| 1 | 立 `enhancements.schema.json` 并接进闸门 1（`kind` 枚举、`hook` 必填 `event`、`entry`/`package` 按运行时互斥） | `make validate` + 两个负例 fixture（未知 kind、漏 event）变红 | 低 |
| 2 | 修 dsh 静默跳过（既非合法 `package` 也非合法文件 ⇒ 失败） | 闸门 1/2 + 负例注入 | 低（可能弄红现有写法） |
| 3 | 让"未声明的扩展文件"判失败（pi 侧先把假阴性堵上：`extensions/` 里每个文件都必须被声明）；真正的"已加载"观测另立一项 | 闸门 2 + 负例 | 中 |
| 4 | `tools.deny` 走契约：渲染期写进 `runtimePlan.prependArgs`，由 `startup.mjs` 拼装（不在入口脚本里写 case）；并加网关侧二次加固 | 容器入口实测"被禁工具真的调不到" | 中 |
| 5 | 参数层纪律修复：`AGENT_PERMISSION_MODE`/`AGENT_WORKSPACE_ROOT` 要么进 `params.yaml`，要么改走 `runtimeParams` | 闸门 1 的参数层检查不再有例外 | 低 |
| 6 | **钩子声明契约**：`adapter.yaml` 声明每运行时**可订阅事件集合**（版本 pin），`enhancements.yaml` 的 `event` 必须属于它；新增一道"**钩子确实触发**"的闸门（假网关触发 `tool_call`，断言钩子留痕） | 新闸门绿 + 负例（错事件名）红 | 中 |
| 7 | **上层镜像接入缝**：产物可烤进镜像（已通）；镜像内提供**自证能力**（携带闸门工具或 slim 验证器）；允许上层在**镜像内**加钩子（渲染期产物 + 运行时覆盖目录两种方式，后者要声明并验证） | 上层镜像里能跑通"四闸门 + 钩子触发"证据链 | 中高 |
| 8 | **服务形态契约**（L4）：会话生命周期/并发上限/状态外置/审批通道的声明面与对应闸门；主运行时选定后先做一条（如 dsh web / pi RPC） | 多会话并发与审批留痕各有一条实测证据 | 高 |
| 9 | **loop 策略声明**（L3）：最大轮次 / 时长预算 / 终止条件 / 委派（子 agent 引用与深度上限）；落到 dsh 原生与 pi 组合方式 | 越界可断言、续跑可留痕 | 高（最贴近"基座不含业务"的边界） |

**顺序理由**：1–5 是把"看起来有"变成"真的成立"（都是现有承诺的兑现，不是新增能力）；
6 让 L2 从半成品变闭环；7 是两层模型的**最低门槛**（否则上层镜像既不能自证也不能定制）；8–9 才是新增的大能力。

---

## 9. 底线（不可因"深度定制"而退化）

1. **四道闸门 + conformance 不许降级成软告警**；新能力要**新判据**，不是放宽旧判据。
2. **声明即契约**：能声明的东西必须能验证；验不了的，就诚实标注"未验证"，不许写成"已支持"。
3. **不静默失败**：不认识的 `kind`、写错的 `event`、没加载的扩展 —— 一律响亮失败。
4. **产物只读 + 可复算 digest**；运行期状态（会话/记忆/审批）**必须在产物之外**显式声明位置。
5. **制品/参数分层与参数下放**：`core/` 不提运行时名；运行期只注入参数不注入行为代码（行为进镜像层）。
6. **豁免必须显式**：跨运行时的差异（pi 有钩子语义 A、dsh 有 B）写进 exemptions，不假装等价。

## 10. 相关登记

- 决策：`docs/status/DECISIONS.md` **D-0012**（多语言共享）、**D-0013**（接入件固定）、**D-0014**（两层产品模型与定制层次）
- 待办：`docs/plans/IMPLEMENTATION-ROADMAP.md` **§23**（本文 §7 缺陷 + §8 演进项，含判据）
- 既有缺口登记：`adapters/pi/failures.md` F6（"已加载"口径）、F7（交付入口 deny）
