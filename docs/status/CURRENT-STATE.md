# Current State

## Project Snapshot

- Project: `agent-base` —— 一套企业智能体基座 + 多个 harness 运行时（pi 与 dsh 并列可选，当前主力 pi）
- Current branch: `main`
- Theme-level focus: **首个示例走通（S4 `examples/idea-to-proof` 四道闸门 → 可用）**；下一步是双 harness 示例与 dsh 比较轨
- Project route: managed
- Canonical worklist: `docs/plans/IMPLEMENTATION-ROADMAP.md`（包 S0–S7，派生自统一设计附录 B；关键路径 = B 轨 pi。§7 记 dsh 实现待定项，§8 记 S3 进展）
- Active work package: `S4` **已闭环**（`examples/idea-to-proof` 可用）；下一包：`S5 examples/contract-review`（双 harness）或 dsh 比较轨

## Current Architecture

**五层模型**（统一设计 §2.1），自上而下：

- **应用层** `my-agent/`：中性定义 `agent.yaml` + `connectors.yaml` + `skills/`（+ 可选 `harness/<h>/` 业务级增强）；业务团队只碰这里
- **制品层** `my-agent:<ver>`：`base:<ver>` + 构建期渲染出的 harness 原生定义（行为在此冻结）
- **基座层** `base:<ver>`：`core`（不变量）+ `adapters/<h>`（harness 专有）
- **适配层** `adapters/pi` / `adapters/dsh` + `conformance/`（新 harness 准入门槛 C1–C10）
- **参数层**：部署期只注入不改变行为的东西（端点、凭据、探针参数）

**三条贯穿原则**：P-a 能力/选择分离 · P-b 文件系统隔离（隔离靠 FS 不靠配置）· P-c 后验统一（不做先验抽象）。

**核心判据（行为烤、参数下放）**：「这个字段改了，同一个输入会不会得到不同行为？会 → 烤进制品；不会 → 参数层」。

### 验证体系（四道闸门已全部可执行）

四道闸门从「只有闸门 1」变为**全部可执行**，`usable` 由此成为可达且已实测通过的判定：

| 闸门 | 实现 | 退出码 |
|---|---|---|
| 1 静态校验 | `tools/validate.mjs` | 10 |
| 2 解析自证 | `adapters/<h>/doctor.mjs`（零凭据真跑 harness） | 20 |
| 3 集成探针 | `tools/probe.mjs`（默认零凭据假网关） | 30 |
| 4 端到端冒烟 | `tools/smoke.mjs` | 40 |

`tools/verify.mjs` 只做**编排与汇总**、不重新实现任何检查 —— 保证「verify 说通过」与「单跑某道闸门说通过」永远一致。

### 轨迹：双来源、同一 schema

统一轨迹（`core/trace/schema.json`，8 类事件）有两条产出路径，都给同一份形状：

- **回调式（主路径）**：`adapters/<h>/seed/extensions/` 里的基座扩展订阅 harness loop 回调，能拿到**实际发出去的请求体**（真实 tools 数组与 stream 标志）与原生调用 id
- **事后映射（兜底）**：`adapters/<h>/trace.mjs` 解析原生事件流/会话文件；离线可复盘，拿不到请求体与判定

业务可介入轨迹（`biz` 附加位 / `biz.event` 业务日志 / `trace-labels.yaml` 标签表）；**基座不懂业务语言**，只提供协议与查看器（`tools/trace-view/`）。

### 仓库拓扑（现状）

`core/`（73 文件）· `adapters/{pi,dsh}/`（20）· `tools/`（13）· `conformance/`（6）· `template/`（6，派生源）· `docs/{design,plans,research,status}/`；`dist/` 是构建产物（已 gitignore）。

Makefile 共 31 个目标，**全部已实现**（不再有 `NOT_YET` 桩）。

**开箱可跑已成立**：`make new-agent NAME=x` 派生的智能体（落在基座之外的同级目录）立刻 `make verify` 即给出「可用」——判据由 `make new-agent-selftest` 逐条实测（跑的是**生成出来的 Makefile**，而非直接调基座工具）。

## Open Problems (theme-level)

- **dsh 适配器：`render` + `doctor` 已交付并验证**（doctor 单跑九项全绿，含 D1 防线）；`trace` 未实现。dsh 的 C2/C8 已过，C3/C4/C5 未过 —— **但那三项问题在检查侧**（它们按第一个 harness 的产物形状写死），不在适配器
- **conformance C3/C4 是按 pi 产物形状写的**，对第二个 harness 会误判（认死了 `AGENTS.md`/`settings.json`/`extensions`）→ 需要泛化成「以 manifest 为映射」的中性判定，否则第二个 harness 永远过不了
- **G1 只剩一半**：回调能看到「harness 发了几个工具」，看不到「网关收到后有没有吞」。三条互补路径已定（链路观测 / 响应侧不一致检测 / 响应头回显对照，后者已实现但仅在网关回显时生效）
- **G3 的真值需要「做决策的扩展」自己上报**：轨迹扩展观测不到别的 handler 是否阻断，因此 `tool.call.decision` 目前恒为 `unobserved`（诚实近似，不是等价）
- **闸门 2 硬断言 3 的口径是「已进入产物」而非「已加载」**：纯钩子型扩展目前观测不到（`failures.md` F6 已记，补法是让增强自证 id）
- **首个业务示例已走通**：`examples/idea-to-proof` 四道闸门 → 可用；`examples/` 可整体删除而基座仍绿（N5 由 `examples-check` 静态验证）
- **业务开发者上手路径三段全通**：派生 → 本地开发 → 容器边界，各有可重复判据（`new-agent-selftest` / `local-selftest` / `conformance C9`）
- **上手路径仍只有 pi 一侧**：派生的智能体开箱 `usable`，`HARNESS=dsh` 仍会因 dsh 适配器未实现而失败
- **镜像只在本地产出、尚未推任何 registry**：多架构 manifest 已能落盘（OCI 归档），推送路径待 I2（内网能否直连镜像仓库）确认
- **企业级 MCP 的每用户鉴权**与参数层模型（单一服务凭据 `credentialRef`）不匹配 —— 设计缺口，排在首个走通之后
- **pi 侧 MCP 客户端需外部补齐**（pi 0.87.1 原生无 MCP；第三方扩展生态已成熟，见调研）→ 选定并 pin 一个扩展之前，声明了连接器的智能体在 pi 上渲染即失败（响亮，不静默）
- **预装清单的服务器选择**仍未定稿：`core/image/preinstall.yaml` 已列出候选与 npm 实测存活表，但「预装哪些进镜像」是待定项；企业 SaaS 集与 per-user OAuth 的冲突同上
- **上游版本漂移**：dsh `0.1.7-rc.1` 是预发布，pi 迭代快 —— pin 之外的回归保障（`conformance`）已建立但对 dsh 尚未生效
- **业务级 harness 增强尚无最小示例**：`capabilities.yaml` 里该组字段仍是 `verified: false`，等首个真实增强验证其可写性
- **等待外部输入（不阻塞）**：企业 LLM 网关地址协议与 tools/流式保真度（I1，最可能推翻方案）、内网能否直连 npm 与公共基础镜像（I2）、首批业务智能体场景（I3）
- **交付物标准（企业可接手）**：模板必须开箱可跑、无 TODO；`examples/` 可整删后基座仍须 `validate` + `conformance` 全绿

## Key Files

### Loaded every Claude session
- `CLAUDE.md` —— **尚未创建**（设计中；落地后承载「技术不变量 / 结构事实」）
- 运行时记忆（mnemon 托管，会话自动注入）—— 本仓库**无** `MEMORY.md` 文件，协作元信息由运行时记忆层承载

### State / handoff
- `docs/status/RESUME-NEXT-SESSION.md` —— 当前会话交接
- `docs/status/CURRENT-STATE.md` —— 本文件
- `docs/status/INDEX.md` —— `docs/status/` 发现入口（含外部锚点表）
- `docs/status/JOURNAL.md` —— 只追加事件日志

### Design truth source
- `docs/design/2026-09-25-unified-agent-base-design.md` —— **最终稿 v2.4**；含 5 处「实现期实测修正/增补」小节（§2.3 / §6.4 / §8.3 / §10.1–§10.2 / §12.1 / §14 / §15.1），**那些是实测修正，视同正文，不要当注释略过**
- `docs/design/2026-09-25-{pi,dsh}-harness-design.md` —— 各自 harness 专有实测约束的唯一事实来源（上位依据）
- `docs/plans/IMPLEMENTATION-ROADMAP.md` —— 唯一权威工作清单 + §7 dsh 待定项 + §8 S3 进展
- `docs/research/2026-09-25-mcp-ecosystem-survey.md` —— MCP 生态调研（企业常用、npm 实测存活表、pi 客户端生态）
- `README.md` —— 对外定位、基座/应用边界、四类标记的阅读方式

### Implementation entry points
- `Makefile` —— 全部命令的唯一边界（22 个目标，实现 17 / 未实现 5）
- `tools/{validate,probe,smoke,verify}.mjs` —— 闸门 1/3/4 与四道闸门编排
- `tools/{dev-env,run-local}.mjs` —— 本地开发环境（按 pin 对齐版本；临时 HOME 跑制品）
- `examples/` —— 示例智能体（**不是基座的一部分，可整体删除**）：`idea-to-proof` 已走通；`contract-review` 待做
- `tools/examples-check.mjs` —— 示例校验（结构 + 四道闸门 + 技能脚本自检 + 不变量 N5）
- `tools/new-agent.mjs` + `template/` —— 派生入口与派生源（`new-agent-selftest` 验证「开箱可跑」）
- `adapters/pi/{adapter.yaml,render.mjs,doctor.mjs,trace.mjs,run.mjs}` —— 适配器 SPI（`run.mjs` 是 probe/smoke/自检共用的运行器）
- `adapters/pi/seed/` —— 基座不变量：`settings.json` 安全姿态 + `enhancements.yaml` 声明 + `extensions/trace.ts` 轨迹扩展
- `adapters/dsh/` —— 声明已交付；`render`/`doctor`/`trace` 待做（预检结论与待定项见路线图 §7）
- `core/gates/` —— 四闸门框架：编排 / 断言语言（12 种）/ §6.7 报告与 `ok`≠`usable` / 退出码唯一处 / 确定性摘要 / 统一 CLI 解析
- `core/trace/` —— 统一轨迹：`schema.json`（真源）· `emit.mjs`（会被拷进产物，故自包含）· 业务级 logger · 两份自检 · `README.md` 分层与协议
- `core/spec/` —— 中性定义 schema（**public contract**，`additionalProperties: false`）+ fixtures（1 合法 + 10 注入式非法）
- `core/catalog/{capabilities,params}.yaml` —— 两个执法点：字段所属层 + 参数层允许/禁止清单
- `core/image/preinstall.yaml` —— 独立可升级的预装清单（开发者面向引用名 + 精确 pin + 存活实测 + 排除项理由）
- `conformance/` —— **pi 侧 C1–C10 全绿（10/10）**；准入门槛全阻断，未实现记 pending 并非零退出；`--harness` 可单独断言某适配器
- 本机容器环境：**OrbStack 2.2.3** 管理 Docker（context `orbstack`，只有 `docker` 驱动 ⇒ 多架构打包需自建 `docker-container` builder `ab-multi`；x86_64 走 Rosetta）。详见路线图 §10.2
- `core/image/` —— 基座镜像与调试变体：`Dockerfile`/`Dockerfile.debug`/`entrypoint.sh`/`gen-preinstall-lock.mjs`/`build.mjs`；按架构分开构建 + 一步合并多架构 manifest；`conformance/image-checks.mjs` 做容器内实测
- `tools/fake-gateway/` —— 零凭据假网关（协议无关核心 + 协议适配；已含会话终止语义）
- `tools/trace-view/` —— 轨迹查看器参考实现（业务附加协议 + 机械回退；源码不含业务词汇）
- `package.json` / `package-lock.json` —— 基座工具链依赖（`ajv`、`yaml`，精确 pin；`node_modules/` 已 gitignore）

## Resume Instructions

1. Read this file（结构 / 主题 / 开放问题）。
2. Read `RESUME-NEXT-SESSION.md`（在飞意图 + 下一个具体动作）。
3. `git status --short` 与 `git log --oneline -5`。
4. CLAUDE.md（若已创建）+ 运行时记忆自动加载。
5. 自检全貌：`make -s help`；十个自检目标 + `make conformance`（后者对 dsh 预期非零）。
6. 需要实现细节时按需读统一设计正文（1600+ 行，**勿全文加载**）：§0.2 决策、§2 架构、§4 定义单元、§5 适配契约、§6 四闸门、§8 交付契约与轨迹、§12 落地、附录 B 实施顺序。
