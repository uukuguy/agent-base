# Current State

## Project Snapshot

- Project: `agent-base` —— 一套企业智能体基座 + 多个 harness 运行时（pi 与 dsh 并列可选，当前主力 pi）
- Current branch: `main`
- Theme-level focus: 统一设计已定稿 v2.4，实现尚未开始 —— 把「适配契约」具体化为可执行形态（S0–S1）
- Project route: managed
- Canonical worklist: `docs/plans/IMPLEMENTATION-ROADMAP.md`（包 S0–S7，派生自统一设计附录 B；关键路径 = B 轨 pi）
- Active work package: `S0` 中性定义契约（schema + 能力目录 + 参数层清单）

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

- 适配契约（§5 六个面）目前只有文档形态，尚无 `core/gates`、`conformance/C1–C10`、假网关等可执行载体
- 上游版本漂移：dsh `0.1.7-rc.1` 是预发布，pi 迭代快 —— pin 之外的回归保障（conformance）未建立
- 业务级 harness 增强（§4.5：`harness/shared/` 纯算法 + `harness/<h>/` 薄外壳 + `enhancements.yaml`）尚无最小示例验证其可写性
- 两份 harness 的实测约束散落在两份上位文档 §10/§11，未沉淀为可执行的断言
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
- `docs/design/2026-09-25-unified-agent-base-design.md` —— **最终稿 v2.4**；§0.2 四个骨架级决策与 §15.1 取舍均已裁决，§15.2 仅剩 3 项待外部输入
- `docs/design/2026-09-25-pi-harness-design.md` —— pi 专有实测约束的唯一事实来源（上位依据）
- `docs/design/2026-09-25-dsh-harness-design.md` —— dsh 专有实测约束的唯一事实来源（上位依据）
- `README.md` —— 对外定位、基座/应用边界、四类标记的阅读方式

### Implementation entry points (待创建，见统一设计 §2.4 / §12.3)
- `Makefile` —— 全部命令的唯一边界（`validate` / `render` / `doctor` / `probe` / `smoke` / `verify` / `image` / `conformance`）
- `core/gates/` —— 四道闸门框架：编排、断言语言、报告格式
- `core/catalog/{capabilities,params}.yaml` —— 能力目录与参数层清单的机器可读真源
- `core/spec/{agent,connectors}.schema.json` —— 中性定义唯一真源
- `adapters/pi/`、`adapters/dsh/` —— adapter.yaml / render / doctor / probes / trace / exemptions / failures
- `conformance/` —— C1–C10 用例与 runner（**C5 静默失败检测力、C8 参数层隔离是灵魂**）
- `tools/fake-gateway/` —— 零凭据假网关（协议无关核心 + 协议适配）

## Resume Instructions

1. Read this file（结构 / 主题 / 开放问题）。
2. Read `RESUME-NEXT-SESSION.md`（在飞意图 + 下一个具体动作）。
3. `git status --short` 与 `git log --oneline -5`。
4. CLAUDE.md（若已创建）+ 运行时记忆自动加载。
5. 需要实现细节时按需读统一设计正文（1593 行，勿全文加载）：§0.2 决策、§2 架构、§4 定义单元、§5 适配契约、§6 四闸门、§12 落地、附录 B 实施顺序。
