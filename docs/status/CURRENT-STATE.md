# Current State

## Project Snapshot

- Project: `agent-base` —— 一套企业智能体基座 + 多个 harness 运行时（pi 与 dsh 并列可选，两侧均可用）
- Current branch: `main`
- Theme-level focus: **harness 业务定制**（钩子、接入缝、派生镜像）—— 起点门槛已打通，剩余在深度定制与服务形态
- Project route: managed
- Canonical worklist: `docs/plans/IMPLEMENTATION-ROADMAP.md`（包 S0–S8；**当前活跃待办在 §23/§24/§25**）
- Active work package: **无在飞包**（上一包"派生镜像与接入缝 P1–P4"已闭合）；候选下一包 = 钩子声明契约（§23 E1/E2b）

## Current Architecture

### 产品形态：两层（D-0014）

- **基座层**（本仓库）：不变量（轨迹 schema、参数分层、产物只读、不静默失败）+ 契约（定义/渲染/启动）+ 闸门 + 基座镜像
- **业务层**（`FROM agent-base`，派生镜像）：业务代码、钩子、loop 定制、服务形态；**深度定制发生在这里**

### 定制分层（基座对每层的承诺与判据）

| 层 | 内容 | 现状 |
|---|---|---|
| L0 | 声明式配置（定义/provider/连接器/技能） | ✅ 闭环（两侧） |
| L1 | 薄接入（工具/命令注册） | ✅ 闭环（业务代码共享，接入各写各的） |
| L2 | 钩子（生命周期介入） | ⚠️ 传输 + **发射路径可验**；事件名校验与逐条自证未做 |
| L3 | loop 定制（轮次/终止/编排） | ❌ 空白（某运行时原生支持整体替换，基座无声明面） |
| L4 | 服务形态（长驻/多会话/审批） | ❌ 空白 |

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
| 1 静态校验 | `tools/validate.mjs`（基座自洽 29 项；带定义 43–44 项） | 10 |
| 2 解析自证 | `adapters/<h>/doctor.mjs`（零凭据真跑 harness） | 20 |
| 3 集成探针 | `tools/probe.mjs`（默认零凭据假网关） | 30 |
| 4 端到端冒烟 | `tools/smoke.mjs` | 40 |

`tools/verify.mjs` 只做编排与汇总，不重新实现检查。**声明即契约**：落不了判据的能力一律标"未验证"。

### 轨迹：双来源、同一 schema

- 统一轨迹 `core/trace/schema.json`：**9 类事件**，每条带 `emitter: hook | post-hoc`
- **回调式（主路径）**：扩展订阅 loop 回调，能拿到实际请求体（tools 数组、stream 标志）⇒ `emitter=hook`
- **事后映射（兜底）**：解析原生事件流/会话文件 ⇒ `emitter=post-hoc`（离线可复盘，拿不到请求体）
- 闸门 3 的 `probe/hook-fired`：声明了 `kind: hook` ⇒ 必须有钩子当场发出的事件；
  事后映射的运行时**如实报"不适用"**（不算通过）
- 业务可介入：`biz` 附加位 / `biz.event` / `trace-labels.yaml`；基座不懂业务语言

### 仓库拓扑

`core/`（91 文件）· `adapters/{pi,dsh}/`（24）· `tools/`（23）· `conformance/`（9）· `template/`（6）·
`docs/`（16 篇 + `design/`、`plans/`、`status/`）；`dist/` 是构建产物（已 gitignore）。
**Makefile 39 个目标全部已实现**（无 `NOT_YET` 桩）。

### 契约与检查（近期收紧，均带负例）

- `core/spec/enhancements.schema.json`：`kind` 枚举、`kind=hook` 必填 `events`（**数组**：基座轨迹扩展自己就订阅 6 个）、`entry`/`package` 至少一个
- 钩子事件名的**契约面**：`adapters/<h>/adapter.yaml` 的 `hookEvents`（pi 39 个已穷举 + 复算命令；dsh 未穷举 ⇒ 如实标 `enumerated: false`）；闸门 1 `enhance/events` 逐个对名字，`hook/events-decl` 盯声明自洽（count 见证值），`catalog/enum-sync` 盯能力目录与 schema 的枚举一致；`hookEvents` 已**带进渲染清单**（产物自描述，E1b 的数据路径）
- 闸门 1 现在**也校验基座自己的** `adapters/<h>/seed/enhancements.yaml`（此前它是唯一没人查的增强声明 —— 基座不给自己开后门）
- 增强的**下划线约定**：`extensions/_*.mjs` = 被 import 的助手，不登记为扩展；声明指向 `_` 开头的文件在渲染期报错（声明了却永远不会被加载）
- 会话内自省命令 `/project`（基座不变量，`adapters/pi/seed/extensions/project-info.ts`）：报告全部从产物现算，钩子事件名与运行时集合逐个核对，可移植性结论与闸门 1 **同源**；自检 `pi-project-info-selftest`
- 渲染期：未声明的接入件、非法的 dsh 增强声明 ⇒ **响亮失败**（不静默跳过/静默加载）
- 参数层：`AGENT_PERMISSION_MODE` / `AGENT_WORKSPACE_ROOT` 已登记（适配器不许读未登记的名字）
- 工具边界：**清单声明**（`runtimePlan.prependArgs`），本地与容器**两条启动路径都执行**（实测 `tools=1`）
- 运行期复用产物前比**渲染输入摘要**（定义 + 基座 seed + 渲染器 + catalog，见 `adapters/<h>/render-inputs.mjs`）：**基座变了也要重渲**（只比定义摘要 ⇒ 新增基座扩展后旧产物被复用、新命令在会话里不存在，本轮实测踩中；判据与渲染器共用一份实现）
- `examples-check`：README 参数名必须落在产物契约或基座平台变量里；示例 Makefile 引用的脚本必须存在

## Open Problems (theme-level)

- **钩子只能证明"发射路径在工作"**：逐条自证（每个声明的钩子都留痕）未做
- **接入缝（overlay）里的钩子事件名未进判据**：事件名校验只覆盖定义层与基座 seed；把集合写进产物清单后由启动期/闸门 2 同判（路线图 §23 E1b）
- **dsh 侧事件集合未穷举**：`hookEvents.enumerated: false` ⇒ 那边写钩子只能标「未验证」，没有名字层面的判据
- **L3 loop 定制与 L4 服务形态无声明面与判据**：长驻会话、多会话并发、审批通道、成本/网关
- **dsh 侧接入缝未实现**：overlay 只支持"扩展目录 + settings 登记"这一种装载形态，其余响亮失败
- **多语言共享业务代码未实现**（D-0012/D-0013 已登记）：语言中立的描述符 + 进程边界执行 + 通用桥
- **pi 的"已加载"口径仍不到"已加载"**：已堵住"未声明的接入件被加载"，但"声明了却没加载"仍观测不到
- **`tool.call.decision` 恒为 `unobserved`**：轨迹观测不到别的 handler 是否阻断（诚实近似，非等价）
- **每用户鉴权与参数层模型不匹配**：连接器只有单一服务凭据 `credentialRef`，per-user OAuth 无表达
- **镜像未推任何 registry**：多架构归档可落盘；推送路径仍待确认（I2 已答"仅运行期无外网"）
- **预装清单未定稿**：`core/image/preinstall.yaml` 有候选与 npm 存活表，"预装哪些进镜像"待定
- **上游版本漂移**：dsh `0.1.7-rc.1` 为预发布、pi 迭代快；pin 之外的回归网已建立（两侧 conformance 均生效）
- **`CLAUDE.md` 尚未创建**：技术不变量/结构事实尚无按会话自动加载的落地处

## Key Files

### Loaded every Claude session

- `CLAUDE.md` —— **尚未创建**（落地后承载"技术不变量 / 结构事实"）
- 运行时记忆（mnemon 托管，会话自动注入）—— 本仓库**无** `MEMORY.md` 文件

### State / handoff

- `docs/status/RESUME-NEXT-SESSION.md` —— 当前会话交接
- `docs/status/CURRENT-STATE.md` —— 本文件
- `docs/status/INDEX.md` —— `docs/status/` 发现入口（含外部锚点表）
- `docs/status/JOURNAL.md` —— 只追加事件日志
- `docs/status/DECISIONS.md` —— D-0001–D-0017（D-0012/13 登记未实现；D-0014 两层模型；D-0015 保证/允许/不管；D-0016 开发者契约；D-0017 harness 层契约随基座版本演进）

### Design truth source

- `docs/README.md` —— 文档索引（16 篇，标了每篇面向谁）
- `docs/design/2026-09-25-unified-agent-base-design.md` —— **最终稿 v2.4**；含 5 处"实现期实测修正/增补"小节（视同正文）
- `docs/design/2026-09-25-{pi,dsh}-harness-design.md` —— 各自 harness 专有实测约束的唯一事实来源
- `docs/design/2026-09-26-harness-customization.md` —— **可定制点实测调研**（两侧钩子/loop/服务形态、层次模型 L0–L4、7 处实证缺陷）
- `docs/design/2026-09-26-base-value-and-openness.md` —— 基座价值定义（保证/允许/不管三段式、全生命周期表）
- `docs/design/2026-09-26-capability-bundles.md` —— **能力包设计稿（未实现）**：包的概念与动态使能、能力实体/包定义/包激活的归属、与闸门/轨迹/`/project` 的接线、未决项
- `docs/13-developer-contract.md` —— 开发者契约（起点与保证、跨版本稳定性承诺、不约束清单）
- `docs/14-how-to-verify.md` —— 能做什么 / 怎么做 / 怎么确认（每条的期望与边界、负例表）
- `docs/06-deploy.md` —— 部署与派生镜像（接入缝、镜像内自证、权限坑）
- `docs/plans/IMPLEMENTATION-ROADMAP.md` —— 唯一权威工作清单（§23 缺陷/演进、§24 开放性、§25 起点缺口）
- `docs/research/2026-09-25-mcp-ecosystem-survey.md` —— MCP 生态调研（企业常用、npm 存活表、pi 客户端生态）
- `README.md` —— 对外定位、基座/应用边界、四类标记的阅读方式

### Implementation entry points

- `Makefile` —— 全部命令的唯一边界（38 个目标，全部已实现）
- `tools/{validate,probe,smoke,verify}.mjs` —— 闸门 1/3/4 与四道闸门编排
- `tools/{dev-env,run-local}.mjs` —— 本地开发环境（按 pin 对齐版本；临时 HOME 跑制品；复用前校验定义摘要）
- `tools/derived-image.mjs` —— 派生镜像构建 + 镜像内自证（`make image-derived`）
- `tools/examples-check.mjs` —— 示例校验（结构 + README 完整性/参数名 + 四道闸门 + 技能脚本自检 + N5）
- `tools/new-agent.mjs` + `template/` —— 派生入口与派生源（`new-agent-selftest` 验证"开箱可跑"）
- `examples/` —— 6 个示例项目（**不是基座的一部分，可整体删除**），两侧"可用"，各自 README 载同一条开发循环
- `adapters/pi/{adapter.yaml,render.mjs,doctor.mjs,trace.mjs,run.mjs}` —— 适配器 SPI（`run.mjs` 是 probe/smoke/自检共用运行器）
- `adapters/{pi,dsh}/seed/` 与 `enhancements.yaml` —— 基座不变量：安全姿态 + 两条增强（轨迹扩展 `trace.ts`、会话内自省命令 `project-info.ts`）
- `core/gates/` —— 四闸门框架：编排 / 断言语言 / §6.7 报告与 `ok`≠`usable` / 退出码唯一处 / 确定性摘要 / CLI 解析
- `core/trace/` —— 统一轨迹：`schema.json`（真源，9 类事件 + `emitter`）· `emit.mjs` · 业务级 logger · 自检
- `core/spec/` —— 中性定义 schema（**public contract**）+ **增强 schema** + fixtures（1 合法 + **12** 注入式非法）
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
5. 自检全貌：`make -s help`；十四个自检目标 + `make conformance`（两侧都预期全绿）。
6. 需要实现细节时按需读统一设计正文（勿全文加载）：§0.2 决策、§2 架构、§4 定义单元、§5 适配契约、§6 四闸门、§8 交付契约与轨迹、§12 落地。

## 镜像与同源校验（不记逐次构建的 ID）

交付四份变体（arm64/amd64 × 普通/调试）+ 一份多架构 OCI 归档。

- **同源指纹**：`core/image/inputs-digest.mjs` 对构建输入算 sha256，构建期烤进 LABEL `agent-base.inputs-digest`；
  C9 用同一份实现重算比对 —— **改了输入不重建镜像 ⇒ C9 直接红**
- 查当前值：`node -e "import('./core/image/inputs-digest.mjs').then(m=>console.log(m.imageInputsDigest('dist/image/context')))"`
  与 `docker image inspect <镜像> --format '{{index .Config.Labels "agent-base.inputs-digest"}}'`
- 不在此处记录逐次构建的镜像 ID：它每次重建都变，记在这里只会变成过期数字
