# Current State

## Project Snapshot

- Project: `agent-base` —— 企业智能体基座 + 两个 harness 运行时（**主运行时定 `pi`**，另一侧并列可用）
- Current branch: `main`
- Theme-level focus: **L1–L5 全部闭合 + 「运行/开发」边界已定**。最近一段收口：L4 能力包（包定义 → 激活真的生效 → 期望集合 → 证据 → 发现面 → 内容 → 默认 → 插件）· Q4 本地预装镜像有锁 · 三轮真实走查（基础用法 / 写业务代码 / 只看文档）· 另一侧两条能力包豁免**实测推翻**后落地 · 候选运行时在**加固容器内起不来**的根因修复（两侧现在都能容器内自证）
- Project route: managed
- Canonical worklist: `docs/plans/IMPLEMENTATION-ROADMAP.md`（**看 §1.1 工作线总览**：L1 钩子与定制 · L2 发现面 · L3 环境与验证 · L4 能力包 · L5 基座自陈 · L6 可移植业务代码）
- Active work package: **无进行中的包**。仍开着的 4 条（E10 另一侧事件集合穷举 · C8 另一侧 coding 包插件内容 · O5 深定制样例契约 · Q5 容器内交互可选）见文末 Open Problems；边界决策见 `DECISIONS.md` 2026-09-28（运行环境与开发环境是两套）

## Current Architecture

### 产品形态：两层（D-0014）

- **基座层**（本仓库）：不变量（轨迹 schema、参数分层、产物只读、不静默失败）+ 契约（定义/渲染/启动）+ 闸门 + 基座镜像
- **业务层**（`FROM agent-base`，派生镜像）：业务代码、钩子、loop 定制、服务形态；**深度定制发生在这里**

### 定制分层（基座对每层的承诺与判据）

| 层 | 内容 | 现状 |
|---|---|---|
| L0 | 声明式配置（定义/provider/连接器/技能） | ✅ 闭环（两侧） |
| L1 | 薄接入（工具/命令注册） | ✅ 闭环（业务代码共享，接入各写各的） |
| L2 | 钩子（生命周期介入） | ✅ 闭环（事件名校验 + **逐条自证**，哑掉的钩子被点名）；另一侧事件集合未穷举 ⇒ **E10** |
| L3 | loop 定制（轮次/终止/编排） | ⚠️ 部分：**预算与续跑**已做并进闸门 4；终止条件/委派深度等剩余项 ⇒ **E6** |
| L4 | 服务形态（长驻/多会话/审批） | ⚠️ 部分：**审批通道**已做（两侧审批门 + `approval.decision` 留痕）；会话生命周期/并发/状态外置 ⇒ **E5 · E7** |

### 规范措辞原则：保证 / 允许 / 不管（D-0015、D-0016）

- **保证并验证**：进 schema/契约，有判据，改动走闸门与 conformance
- **允许但不保证**：开放命名空间（自定义字段/`kind`）原样透传进产物与清单，报告里标"未验证"
- **不管**：业务逻辑、策略内容、审批/网关/审计实现 —— 给缝，不给判据
- **唯一硬边界：不静默**（不认识的**声明**要保留并标注；不认识的**内容**不许静默行为）
- 对外契约：`docs/13-developer-contract.md`（起点与保证）；`docs/14-how-to-verify.md`（能做什么/怎么做/怎么确认）

### 五层模型（统一设计 §2.1）

- **应用层** `my-agent/`：`agent.yaml` + `connectors.yaml` + `skills/`（+ 可选 `harness/<h>/`）；业务团队只碰这里
- **制品层**：基座镜像 + 渲染产物（运行时原生形态），行为在此冻结
- **基座层** `core/`：不变量；**适配层** `adapters/<h>` + `conformance/`（新 harness 准入门槛 C1–C10）
- **参数层**：部署期只注入端点/凭据/模型名/权限模式/工作区根，不注入行为
- 三条贯穿原则：P-a 能力/选择分离 · P-b 文件系统隔离 · P-c 后验统一
- 核心判据：**行为烤进制品，参数下放运行期**

### 能力包（L4，已落地）

- **三层**：能力**实体**（任意语言；`kind: process` 走 stdin/stdout 一行 JSON）· **包定义** `core/catalog/bundles.yaml`（`verify-baseline` 默认开 · `coding` 默认关 · `browser` planned）· **激活**是运行期选择（`AGENT_BUNDLES`；写错包名**启动即响亮失败**并列出允许集合）
- 合法取值集合**烤在产物清单**（`bundles.{available,defaults,members,baseSkills,pluginPackages}`）；激活集合进轨迹 `run.meta.bundles` 与**生效配置摘要**（同一产物不同组合 ⇒ 不同摘要）
- **激活真的生效**：启动期按激活集合从暂存产物里摘除未激活包的**连接器 / 技能 / 插件**；摘法由清单声明**落点与格式**（`connectorSurface` / `skillSurface` / `pluginSurface`，core 不认运行时）。JSON 落点直接改写；YAML 的 insert row 用 Document API 加 `lineWidth: 0` **逐字保留**其余内容（含 `!!js`）并带**保真校验**（语义不符就拒绝写）
- **期望集合 = 声明 ∩ 当前启用**：`expectedConnectorNames()` / `expectedSkillNames()` 一份实现，startup 与两侧闸门 2 **共用**
- **发现面**：会话内 `/project bundles`（可用包 / 当前激活 / 默认组合 / 包里有什么 / 怎么开 + 「切换需重载」）；技能页显示**本组合实际加载**的那套
- **内容与默认**：3 个编码技能（`core/skills/`）由 `coding` 包携带；模板默认组合 = `coding` ⇒ 新智能体开箱就能编码（端点侧工具名实测变化）

### 接入缝与镜像内自证（P1–P3）

- `AGENT_OVERLAY_DIR`（默认 `/opt/agent-base/overlay`）：启动期把上层镜像带的 `extensions/`、`business/`
  与 `enhancements` 声明并进**暂存副本**（产物一字节不动），扩展路径登记进 `settings.json`
- 装载形态由该运行时的产物布局决定：**只实现了"扩展目录 + settings 登记"这一种**，其余形态**响亮失败**
- 镜像携带闸门源码与依赖（`/opt/agent-base/gates`）：`docker run <镜像> verify` 跑闸门 2/3/4（有定义连闸门 1），
  离线零凭据；`validate --agent-only` 用于镜像内（镜像里没有基座 docs/布局）
- 派生骨架 `core/image/derived/Dockerfile` + `tools/derived-image.mjs`（`make image-derived`）：渲染 → 组上下文 → 构建 → 镜像内自证

### 验证体系（四道闸门）

| 闸门 | 实现 | 退出码 |
|---|---|---|
| 1 静态校验 | `tools/validate.mjs`（基座自洽 **34 项**；带定义 **51 项**） | 10 |
| 2 解析自证 | `adapters/<h>/doctor.mjs`（零凭据真跑 harness；含 **`resolution/connectors-start`**：逐个真启动 stdio 连接器并要一次握手，起不来就红并给 stderr 尾巴） | 20 |
| 3 集成探针 | `tools/probe.mjs`（默认零凭据假网关） | 30 |
| 4 端到端冒烟 | `tools/smoke.mjs` | 40 |

`tools/verify.mjs` 只做编排与汇总，不重新实现检查。**声明即契约**：落不了判据的能力一律标"未验证"。

### 轨迹：双来源、同一 schema

- 统一轨迹 `core/trace/schema.json`：**12 类事件**（含 `approval.decision` 与 `hook.error`），每条带 `emitter: hook | post-hoc`；枚举**从 schema 现算**（不许在别处手写一份）
- **回调式（主路径）**：扩展订阅 loop 回调，能拿到实际请求体（tools 数组、stream 标志）⇒ `emitter=hook`
- **事后映射（兜底）**：解析原生事件流/会话文件 ⇒ `emitter=post-hoc`（离线可复盘，拿不到请求体）
- 闸门 3 的 `probe/hooks-evidenced`：**每条**声明的 `kind: hook` 都要留下带自己 id 的痕迹（事件字段 `enhancement`）⇒ 声明 N 个就有 N 条可指认证据；哑掉的钩子会被点名（纯函数 `core/gates/hooks.mjs`，自检 `probe-selftest` 含真跑负例）；
  事后映射的运行时**如实报"不适用"**（不算通过）
- 业务可介入：`biz` 附加位 / `biz.event` / `trace-labels.yaml`；基座不懂业务语言

### 仓库拓扑

`core/`（125 文件）· `adapters/{pi,dsh}/`（46）· `tools/`（36）· `conformance/` · `template/` ·
`docs/`（16 篇编号文档 + `design/`、`plans/`、`status/`）；`dist/` 是构建产物（已 gitignore）。
**Makefile 66 个目标全部已实现**（28 个 `*-selftest`；`make regression` 共 37 项）。
（数字按 2026-09-28 实测；这类数字会腐烂 —— 引用时以现场命令为准。）

### 契约与检查（近期收紧，均带负例）

- `core/spec/enhancements.schema.json`：`kind` 枚举、`kind=hook` 必填 `events`（**数组**：基座轨迹扩展自己就订阅 6 个）、`entry`/`package` 至少一个
- 钩子事件名的**契约面**：`adapters/<h>/adapter.yaml` 的 `hookEvents`（pi 39 个已穷举 + 复算命令；dsh 未穷举 ⇒ 如实标 `enumerated: false`）；闸门 1 `enhance/events` 逐个对名字，`hook/events-decl` 盯声明自洽（count 见证值），`catalog/enum-sync` 盯能力目录与 schema 的枚举一致；`hookEvents` 已**带进渲染清单**（产物自描述，E1b 的数据路径）
- 闸门 1 现在**也校验基座自己的** `adapters/<h>/seed/enhancements.yaml`（此前它是唯一没人查的增强声明 —— 基座不给自己开后门）
- 增强的**下划线约定**：`extensions/_*.mjs` = 被 import 的助手，不登记为扩展；声明指向 `_` 开头的文件在渲染期报错（声明了却永远不会被加载）
- 项目自省：会话内 `/project`（基座不变量，`adapters/pi/seed/extensions/project-info.ts` 薄壳）与命令行 `make project-info` / `make verify-plan` **共用同一份逻辑**（`core/introspect/project-info.mjs`，渲染器把它拷进产物供扩展 import）；报告全部从产物现算，钩子事件名与运行时集合逐个核对，可移植性结论与闸门 1 **同源**；自检 `pi-project-info-selftest` + `project-info-selftest`
- **验证计划**（`make verify-plan`，`JSON=1` 给 AI）：四个身份摘要 + 本地四道闸门的命令与期望 + "只能在容器里成立"的四条（每条带 `why`）+ 本次未覆盖清单；`core/introspect/_container-only.mjs` 是那份**声明**，自检盯着它与 C9 实现一致（防"加了断言没归类"）
- 渲染期：未声明的接入件、非法的 dsh 增强声明 ⇒ **响亮失败**（不静默跳过/静默加载）
- 参数层：`AGENT_PERMISSION_MODE` / `AGENT_WORKSPACE_ROOT` 已登记（适配器不许读未登记的名字）
- 工具边界：**清单声明**（`runtimePlan.prependArgs`），本地与容器**两条启动路径都执行**（实测 `tools=1`）
- 运行期复用产物前比**渲染输入摘要**（定义 + 基座 seed + 渲染器 + catalog，见 `adapters/<h>/render-inputs.mjs`）：**基座变了也要重渲**（只比定义摘要 ⇒ 新增基座扩展后旧产物被复用、新命令在会话里不存在，本轮实测踩中；判据与渲染器共用一份实现）
- **平台级运行期变量单一定义**（`core/image/platform-env.mjs`）：容器入口与 `run-local` 必须给同一套；`startup.prepare` 的运行期布局 `env` 契约由 `stageRenderDir` 原样带出，本地**不再手搓**（手搓 ⇒ 漏 `AGENT_ARTIFACT_DIR` ⇒ 会话内 `/project` 容器能用、本地不能用，本轮实测踩中 D10）；`local-selftest` 静态比对两个入口的变量集合
- `examples-check`：README 参数名必须落在产物契约或基座平台变量里；示例 Makefile 引用的脚本必须存在

## Open Problems (theme-level)

**仍开着的（都有正式待办号，判据写在路线图）**

- **另一侧的事件集合未穷举**（`hookEvents.enumerated: false`）⇒ 那边写钩子只能标「未验证」，没有名字层面的判据 —— **E10**
- **另一侧 `coding` 包里的插件内容**：当前是计划模式类插件，无头模式下意义有限 —— **C8**
- **业务层深定制的样例契约**：钩子 / loop / 服务各一个最小样例，并入 E5–E8 一起做 —— **O5**
- **容器内交互**（可选）：`-debug` 变体只给诊断 shell，没在容器里跑真正的运行时会话 —— **Q5**
- **服务形态与 loop 的剩余判据**：会话生命周期 / 并发上限 / 状态外置 / 终止条件 / 委派深度 / 租户隔离 / 成本归因到人（预算与续跑已做）—— **E5–E8**
- **每用户鉴权与参数层不匹配**：连接器只有单一服务凭据（`credentialRef` → 一个环境变量），per-user OAuth 无表达 —— `preinstall.yaml` 的 `missing-capabilities`
- **pi 的「已加载」口径仍不到「已加载」**：堵住了"未声明的接入件被加载"，但"声明了却没加载"仍观测不到
- **`tool.call.decision` 恒为 `unobserved`**：轨迹观测不到别的 handler 是否阻断（诚实近似，非等价）
- **另一侧接入缝只支持一种装载形态**（扩展目录 + settings 登记），其余响亮失败
- **镜像未推任何 registry**：多架构归档可落盘，推送路径待定（I2 已答"仅运行期无外网"）
- **预装清单未定稿**：「预装哪些进镜像」仍可调；本地对应物 `.local-packages` 已**从同一份锁装入且有可复算指纹**（`.local-packages.lock.json`，含"锁变了而镜像没重刷"检测）
- **上游版本漂移**：另一侧 `0.1.7-rc.1` 是预发布、主运行时迭代快；pin 之外的回归网是两侧 conformance

**已闭合（保留结论，供下一次会话别重复推导）**

- **L3 环境与验证**：两侧受控容器验证入口 + 审批门；审批决定进 `approval.decision`；`unavailable` fail-closed
- **两侧都能在加固容器内自证**：候选运行时原先起不来是因为它的原生加载器把 `.node` 复制到 `$TMPDIR`（加固容器里是 tmpfs）再 `require` ⇒ `failed to map segment`；修法 = 该适配器设 `NARB_DISABLE_NATIVE_CACHE=1`（**就地加载**）。临时声明已从 `core/env/parity.mjs` 撤掉
- **钩子逐条自证**（E2b）：哑掉的钩子被点名，证据是事件字段 `enhancement`
- **多语言业务代码**（D-0012/D-0013/D-0018）：语言中立的描述符 + 进程边界执行 + 每运行时通用桥；**两侧实测**闸门 3 真调通一个 **Python** 能力（零胶水）
- **运行环境与开发环境是两套**（决策 2026-09-28）：不提供「会话内即时改代码」；运行跑制品，开发在正式研发环境做，改完**重启即生效**（实测：改定义后重跑 `run-local` 自动重渲染）；会话 cwd 保持中立临时目录。据此 **C7 关闭**、开发容器工作线（**W1–W4**）降级为「容器侧只做环境一致性与交付自证」
- **`CLAUDE.md` 已创建**：新会话入口（这是什么 / 怎么验 / 纪律 / 状态在哪 / 已知的坑）

## Key Files

### Loaded every Claude session

- 运行时记忆（mnemon 托管，会话自动注入）—— 本仓库**无** `MEMORY.md` 文件

### State / handoff

- `docs/status/RESUME-NEXT-SESSION.md` —— 当前会话交接
- `docs/status/CURRENT-STATE.md` —— 本文件
- `docs/status/INDEX.md` —— `docs/status/` 发现入口（含外部锚点表）
- `docs/status/JOURNAL.md` —— 只追加事件日志
- `docs/status/DECISIONS.md` —— D-0001–D-0018（D-0012/13/18 多语言能力契约；D-0014 两层模型；D-0015 保证/允许/不管；D-0016 开发者契约；D-0017 harness 层契约随基座版本演进；**2026-09-28 运行/开发两套环境**）

### Design truth source

- `docs/README.md` —— 文档索引（16 篇，标了每篇面向谁）
- `docs/design/2026-09-25-unified-agent-base-design.md` —— **最终稿 v2.4**；含 5 处"实现期实测修正/增补"小节（视同正文）
- `docs/design/2026-09-25-{pi,dsh}-harness-design.md` —— 各自 harness 专有实测约束的唯一事实来源
- `docs/design/2026-09-26-harness-customization.md` —— **可定制点实测调研**（两侧钩子/loop/服务形态、层次模型 L0–L4、7 处实证缺陷）
- `docs/design/2026-09-26-base-value-and-openness.md` —— 基座价值定义（保证/允许/不管三段式、全生命周期表）
- `docs/design/2026-09-26-capability-bundles.md` —— **能力包设计稿（已实现，L4）**：包的概念与动态使能、能力实体/包定义/包激活的归属、与闸门/轨迹/`/project` 的接线
- `core/catalog/bundles.yaml` + `core/bundles/{index,filter,selftest}.mjs` —— **能力包真源与机制**：包定义 · 选择解析 · 物化 · 期望集合（与闸门共用）· 按落点/格式摘除未激活内容（含 YAML 保真校验）
- `docs/13-developer-contract.md` —— 开发者契约（起点与保证、跨版本稳定性承诺、不约束清单）
- `docs/14-how-to-verify.md` —— 能做什么 / 怎么做 / 怎么确认（每条的期望与边界、负例表）
- `docs/06-deploy.md` —— 部署与派生镜像（接入缝、镜像内自证、权限坑）
- `docs/plans/IMPLEMENTATION-ROADMAP.md` —— 唯一权威工作清单（§23 缺陷/演进、§24 开放性、§25 起点缺口）
- `docs/research/2026-09-25-mcp-ecosystem-survey.md` —— MCP 生态调研（企业常用、npm 存活表、pi 客户端生态）
- `README.md` —— 对外定位、基座/应用边界、四类标记的阅读方式

### Implementation entry points

- `Makefile` —— 全部命令的唯一边界（66 个目标，全部已实现）
- `tools/{validate,probe,smoke,verify}.mjs` —— 闸门 1/3/4 与四道闸门编排
- `core/verify/attribution.mjs` —— **失败归因**（容器挂≠缺陷：本地可复现 / 已声明差异 / 容器专有 / **本地没跑到** / 未声明差异）
- `adapters/dsh/approval-probe.mjs` —— 探针：另一侧原生流/会话文件里有没有审批记录、相对路径插件 row 能不能加载（`make dsh-approval-probe`）
- `adapters/dsh/seed/` —— **基座不变量插件**（声明 + `plugins/verify-container/`）：渲染器拷进 profile、row 指向入口文件、注入事件写入器
- `tools/verify-container.mjs` —— **受控容器验证入口**（docker 参数全由基座生成、调用方不能追加：绑定面=当前项目只读、网络 none、根只读、能力全丢；`DRY=1` 可审阅；**镜像与源码不同源 ⇒ 先拒绝并要求重建**，D13）
- `adapters/<h>/project-layout.mjs` —— 各运行时的**产物读法**（`configDir()` + `read()`）：core 的自省逻辑运行时无关，形状差异都在这里
- `tools/trace-view/labels.mjs` + `make trace-view [AGENT_DIR=… TRACE=…]` —— 轨迹查看器入口（业务可读时间轴 + 业务说法覆盖率）
- `tools/project-info.mjs` —— **项目自省的命令行出口**（与会话内 `/project` 共用 `core/introspect/` 的同一份逻辑）；`--plan` 给验证计划
- `core/introspect/{project-info,_container-only}.mjs` —— 自省与"只能在容器验"的**声明**（后者被自检盯着与 C9 实现一致）
- `tools/{dev-env,run-local}.mjs` —— 本地开发环境（按 pin 对齐版本；临时 HOME 跑制品；复用前校验定义摘要）
- `tools/derived-image.mjs` —— 派生镜像构建 + 镜像内自证（`make image-derived`）
- `tools/examples-check.mjs` —— 示例校验（结构 + README 完整性/参数名 + 四道闸门 + 技能脚本自检 + N5）
- `tools/new-agent.mjs` + `template/` —— 派生入口与派生源（`new-agent-selftest` 验证"开箱可跑"）
- `examples/` —— 6 个示例项目（**不是基座的一部分，可整体删除**），两侧"可用"，各自 README 载同一条开发循环
- `adapters/pi/{adapter.yaml,render.mjs,doctor.mjs,trace.mjs,run.mjs}` —— 适配器 SPI（`run.mjs` 是 probe/smoke/自检共用运行器）
- `tools/gen-selection-facts.mjs` + `docs/design/2026-09-27-runtime-selection-facts.md` —— **选型决策的事实材料**（生成物 + 闸门 1 守同步）
- `tools/local-packages.mjs` + `.local-packages.lock.json` —— 本地预装镜像**按锁装入 + 可复算指纹**（`make local-packages[-lock|-check]`；回归里有检查）
- `core/skills/{code-navigation,debugging,verification}/` + `core/skills/selftest.mjs` —— **基座编码技能**（由 `coding` 包携带；自检拒绝占位骨架）
- `docs/15-business-code-cookbook.md` —— **业务代码怎么写**（能力 / 自研连接器 / 怎么验 / 常见坑；每段都跑通过）
- `adapters/<h>/exemptions.yaml` + `core/env/parity.mjs` —— **两类「已声明差异」的唯一登记处**（当前豁免表只剩**当前**不对称；临时声明一旦被实测推翻就撤）
- `core/spec/capability-judgements.mjs` —— **能力 → 判据**的可执行清单（O4）：解析 `docs/13` §1/§2 每行的判据，落到真实的 `make` 目标 / 脚本 / 路径 / 检查 id；`make selfcheck` 与闸门 1 共用它
- `core/spec/open-namespace.mjs` —— **开放命名空间**的单一实现（`x-*` / `customizations:` / `kind: x-*`）：闸门 1 的 `open/unverified-declarations` 与两个渲染器的清单字段共用它
- `adapters/{pi,dsh}/seed/` 与 `enhancements.yaml` —— 基座不变量（**两种落地形态**：一侧是扩展 `extensions/*.ts`，另一侧是 cordis 插件 `plugins/*/index.js` + insert row，都由渲染器注入事件写入器）：安全姿态 + 轨迹 + 会话内自省命令 `project-info` + **受控容器验证入口 `verify-container`（需审批）**
- `core/gates/` —— 四闸门框架：编排 / 断言语言 / §6.7 报告与 `ok`≠`usable` / 退出码唯一处 / 确定性摘要 / CLI 解析
- `core/trace/` —— 统一轨迹：`schema.json`（真源，**12 类事件** + `emitter` + `enhancement`[哪个声明写的]）· `emit.mjs` · 业务级 logger · 自检
- `CLAUDE.md` —— **新会话入口**（这是什么/怎么验/纪律/状态在哪/已知的坑）
- `core/spec/` —— 中性定义 schema（**public contract**，含开放命名空间 `x-*`/`customizations`）+ **增强 schema**（`kind` 允许 `x-*`）+ fixtures（1 合法 + **13** 注入式非法 + **1 正例**）
- `core/catalog/{capabilities,params,providers}.yaml` —— 三个执法点：字段所属层 · 参数层清单 · provider 目录
- `core/image/` —— 基座镜像与调试变体 + `verify-in-image.mjs`（镜像内自证）+ `derived/Dockerfile`（派生骨架）
- `core/config/dotenv.mjs` —— 环境文件加载（真实环境变量优先；永不打印值）
- `tools/fake-gateway/` —— 零凭据假网关（协议无关核心 + 协议适配）
- `tools/trace-view/` —— 轨迹查看器参考实现（业务附加协议 + 机械回退；源码不含业务词汇）
- `conformance/` —— 准入门槛 C1–C10（**两侧全绿**），含容器安全下限与"参数名从产物契约读取"的容器能力检查
- `package.json` / `package-lock.json` —— 基座工具链依赖（`ajv`、`yaml`，精确 pin）

## Resume Instructions

1. Read this file（结构 / 主题 / 开放问题）。
2. Read `RESUME-NEXT-SESSION.md`（在飞意图 + 下一个具体动作）。
3. `git status --short` 与 `git log --oneline -5`。
4. CLAUDE.md（若已创建）+ 运行时记忆自动加载。
5. 自检全貌：`make -s help`；28 个自检目标 + `make regression`（37 项，含两侧 conformance）。
6. 需要实现细节时按需读统一设计正文（勿全文加载）：§0.2 决策、§2 架构、§4 定义单元、§5 适配契约、§6 四闸门、§8 交付契约与轨迹、§12 落地。

## 镜像与同源校验（不记逐次构建的 ID）

交付四份变体（arm64/amd64 × 普通/调试）+ 一份多架构 OCI 归档。

- **同源指纹**：`core/image/inputs-digest.mjs` 对构建输入算 sha256，构建期烤进 LABEL `agent-base.inputs-digest`；
  C9 用同一份实现重算比对 —— **改了输入不重建镜像 ⇒ C9 直接红**
- 查当前值：`node -e "import('./core/image/inputs-digest.mjs').then(m=>console.log(m.imageInputsDigest('dist/image/context')))"`
  与 `docker image inspect <镜像> --format '{{index .Config.Labels "agent-base.inputs-digest"}}'`
- 不在此处记录逐次构建的镜像 ID：它每次重建都变，记在这里只会变成过期数字
