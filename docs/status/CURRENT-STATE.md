# Current State

## Project Snapshot

- Project: `agent-base` —— 一套企业智能体基座 + 多个 harness 运行时（pi 与 dsh 并列可选，当前主力 pi）
- Current branch: `main`
- Theme-level focus: 契约基线与验证框架（S0–S1）已交付 —— 下一个包是把两份 adapter 与准入门槛 conformance 做出来（S2）
- Project route: managed
- Canonical worklist: `docs/plans/IMPLEMENTATION-ROADMAP.md`（包 S0–S7，派生自统一设计附录 B；关键路径 = B 轨 pi）
- Active work package: `S2` render + doctor（pi 与 dsh）+ `conformance` C1–C10（S0/S1 已交付，见 JOURNAL）

## Current Architecture

五层模型（统一设计 §2.1），自上而下：

- **应用层** `my-agent/`：中性定义 `agent.yaml` + `connectors.yaml` + `skills/`；业务团队只碰这里
- **制品层** `my-agent:<ver>`：`base:<ver>` + 构建期渲染出的 harness 原生定义（行为在此冻结）
- **基座层** `base:<ver>`：`core`（不变量）+ `adapters/<h>`（harness 专有）
- **适配层** `adapters/pi` / `adapters/dsh` + `conformance/`（新 harness 准入门槛 C1–C10）
- **参数层**：部署期只注入不改变行为的东西（端点、凭据、探针参数）

三条贯穿原则：**P-a 能力/选择分离**、**P-b 文件系统隔离**（隔离靠 FS 不靠配置）、**P-c 后验统一**（不做先验抽象）。

核心判据：**行为烤、参数下放** —— 「这个字段改了，同一个输入会不会得到不同行为？会 → 烤进制品；不会 → 参数层」。

单仓拓扑：`core/` + `adapters/{pi,dsh}/` + `conformance/` + `template/` + `examples/` + `tools/` + `docs/`。

## Open Problems (theme-level)

- 🟠 **pi 侧无 MCP 客户端**（实测）：pi 0.87.1 的 docs/README/CHANGELOG 零提及 MCP，无 `mcp.json`/`allowInstall`/`hostConfigDiscovery`；dsh 侧原生有 `@deepseek-ai/dsh-mcp-client`。**但第三方 pi MCP 扩展生态已成熟**（`pi-mcp-adapter` 2.37.0 等，见调研）→ 不必自研。待裁决：采用哪个扩展 + 预装哪些服务器
- 企业级 MCP 的**每用户鉴权**与我们的参数层模型（单一服务凭据 `credentialRef`）不匹配 —— 记为设计缺口，排到首个走通之后
- 网络「MCP 排行」普遍未校验包生命周期（实测：github/slack/postgres 已废弃，git/fetch 不在 npm）→ 预装清单只能来自实测，且需升级/退役机制
- `adapters/{pi,dsh}/` 尚不存在 —— 因此闸门 2–4 无实现可跑，`usable` 目前恒为 false（只有闸门 1 实现了）
- 闸门 2 的三个硬断言（技能集合 / 连接器集合 / 已加载扩展 id 集合）尚无真实 harness 可断言 —— 要等 S2 的 `doctor`
- `conformance/C1–C10`（新 harness 准入门槛）尚未落地；C5（静默失败检测力）与 C8（参数层隔离）是灵魂
- §6.3 硬断言 3 的集合口径需澄清：pi 常驻内置扩展（如 `llama`，source=extension），不能算「未声明的增强混入产物」——断言集应只含制品来源的增强
- 上游版本漂移：dsh `0.1.7-rc.1` 是预发布，pi 迭代快 —— pin 之外的回归保障（conformance）未建立
- 业务级 harness 增强（§4.5：`harness/shared/` 纯算法 + `harness/<h>/` 薄外壳 + `enhancements.yaml`）尚无最小示例验证其可写性；`capabilities.yaml` 里该组字段的 `verified: false` 即此缺口
- pi 的第二隐式技能源（`.agents/skills` 沿 cwd 祖先发现）设计未记录；实测 `--no-skills --skill <dir>` 与隔离 HOME 两条路都能收干净
- 假网关的响应体带非标准字段（`created: 0`、`fake_gateway`），若某 SDK 严格拒绝未知字段，以 `x-fake-gateway-*` 响应头为准 —— 接真实 harness 时需实测
- 等待外部输入（不阻塞实现）：企业 LLM 网关地址协议与 tools/流式保真度、内网能否直连 npm 与公共基础镜像、首批业务智能体场景
- 仓库交付物标准（企业可接手）：模板必须开箱可跑、无 TODO；`examples/` 可整删后基座仍须 `validate` + `conformance` 全绿

## Key Files

### Loaded every Claude session
- `CLAUDE.md` —— **尚未创建**（设计中；落地后承载「技术不变量 / 结构事实」）
- 运行时记忆（mnemon 托管，会话自动注入）—— 本仓库**无** `MEMORY.md` 文件，协作元信息由运行时记忆层承载

### State / handoff
- `docs/status/RESUME-NEXT-SESSION.md` —— 当前会话交接
- `docs/status/CURRENT-STATE.md` —— 本文件
- `docs/status/INDEX.md` —— `docs/status/` 目录发现入口
- `docs/status/JOURNAL.md` —— 只追加事件日志

### Design truth source
- `docs/research/2026-09-25-mcp-ecosystem-survey.md` —— MCP 生态调研（企业常用服务器、npm 实测存活表、pi 客户端生态、预装建议）
- `docs/design/2026-09-25-unified-agent-base-design.md` —— **最终稿 v2.4**；§0.2 四个骨架级决策与 §15.1 取舍均已裁决，§15.2 仅剩 3 项待外部输入
- `docs/design/2026-09-25-pi-harness-design.md` —— pi 专有实测约束的唯一事实来源（上位依据）
- `docs/design/2026-09-25-dsh-harness-design.md` —— dsh 专有实测约束的唯一事实来源（上位依据）
- `README.md` —— 对外定位、基座/应用边界、四类标记的阅读方式

### Implementation entry points
- `Makefile` —— 全部命令的唯一边界；已实现 `validate` / `validate-selftest` / `gates-selftest` / `trace-selftest` / `gateway-selftest`，其余目标**显式失败并指向所属包**（不静默通过）
- `core/image/preinstall.yaml` —— **独立可升级的预装清单**：验证基座镜像预装什么 + 开发者面向的引用名（`namedReferences`，11 个名字）。目的是让**开发智能体**便捷；`make validate` 的 `preinstall/*` 组（10 项）守它不烂
- `core/gates/` —— 四闸门框架：`orchestrator.mjs` 编排（首个失败即短路）、`assertions.mjs` 断言语言（12 种，含 `fails` = 静默通过即判失败）、`report.mjs` §6.7 报告与 `ok`/`usable` 之分、`exit-codes.mjs` 唯一定义处、`digest.mjs` 确定性摘要、`selftest.mjs` 框架自检
- `core/trace/schema.json` —— 统一轨迹事件 schema（JSONL，七类事件 + `native.raw` 兜底必带 reason）；`trace/selftest.mjs` 为自检
- `tools/fake-gateway/` —— 零凭据假网关：`core.mjs` 协议无关核心 + `protocols/openai.mjs` 适配 + `server.mjs`（导出 `startFakeGateway({port:0})` → `{url, port, traceLines, close()}`）；`tools` 计数与 `stream` 在三处独立暴露（响应体 / `x-fake-gateway-*` 头 / 轨迹）
- `tools/validate.mjs` —— 闸门 1 唯一入口：基座自洽（schema ↔ 能力目录 ↔ 参数层清单对账）+ 定义校验 + `--selftest` 注入式负向用例
- `core/spec/{agent,connectors}.schema.json` —— 中性定义唯一真源（**public contract**；`additionalProperties: false` 让未知字段成为硬错误）
- `core/catalog/params.yaml` —— 参数层允许/禁止清单（J2 第一个执法点）；`conformance/C8` 的输入
- `core/catalog/capabilities.yaml` —— 每个字段的类型/默认值/所属层/各 harness 支持度与降级行为（J2 第二个执法点）
- `core/spec/fixtures/` —— 1 个合法样本 + 8 个注入式非法样本（每个 `expect.yaml` 声明它必须撞上的失败项）
- `package.json` / `package-lock.json` —— 基座工具链依赖（`ajv`、`yaml`，精确 pin；`node_modules/` 已 gitignore）
- `adapters/pi/`、`adapters/dsh/` —— adapter.yaml / render / doctor / probes / trace / exemptions / failures（待 S2）
- `conformance/` —— C1–C10 用例与 runner（**C5 静默失败检测力、C8 参数层隔离是灵魂**）（待 S2）
- `core/image/` —— 基座镜像与 debug 变体（待 S3+）

## Resume Instructions

1. Read this file（结构 / 主题 / 开放问题）。
2. Read `RESUME-NEXT-SESSION.md`（在飞意图 + 下一个具体动作）。
3. `git status --short` 与 `git log --oneline -5`。
4. CLAUDE.md（若已创建）+ 运行时记忆自动加载。
5. 需要实现细节时按需读统一设计正文（1593 行，勿全文加载）：§0.2 决策、§2 架构、§4 定义单元、§5 适配契约、§6 四闸门、§12 落地、附录 B 实施顺序。
