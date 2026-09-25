# 文档索引

这套文档面向三类人：**业务开发者**（写智能体）、**平台/运维**（部署与凭据）、
**平台开发者**（接新运行时）。

> 先看 **[00-overview](00-overview.md)** 建立全局印象，再按你的角色挑一篇。
> **出问题时直接看 [07-troubleshooting](07-troubleshooting.md)** ——
> 这个项目里失败大多是**静默**的，那篇讲的就是"怎么看出来"。

## 全套文档（按设计 §13 的 12 篇 + 1 条说明）

| # | 文档 | 面向 | 状态 |
|---|---|---|---|
| 00 | [overview](00-overview.md) —— 这是什么、边界在哪、目录速览 | 全部 | ✅ |
| 01 | [quickstart](01-quickstart.md) —— 四步跑通第一个智能体 | 业务开发者 | ✅ |
| 02 | [concepts](02-concepts.md) —— 四个业务概念 ↔ 两个运行时的对应表 | 业务开发者 | ✅ |
| 03 | [capability-catalog](03-capability-catalog.md) —— 有哪些能力可配（**由真源生成**，`make gen-docs` 刷新） | 业务开发者 | ✅ |
| 04 | `04-skills.md` —— 技能怎么写 | 业务开发者 | ⏳ |
| 05 | `05-connectors.md` —— 连接器怎么配 | 业务开发者 | ⏳ |
| 06 | `06-deploy.md` —— 镜像、环境变量、凭据、退出码、stdout/stderr 契约 | 平台/运维 | ⏳ |
| 07 | [troubleshooting](07-troubleshooting.md) —— **失败模式清单** | 全部 | ✅ |
| 08 | `08-conventions.md` —— 分层纪律：哪层能放什么 | 平台/业务负责人 | ⏳ |
| 09 | `09-harness-contract.md` —— 适配契约、新运行时怎么接 | 平台开发者 | ⏳ |
| 10 | `10-harness-selection.md` —— 两个运行时的差异与选型 | 架构/平台 | ⏳ |
| 11 | `11-harness-enhancements.md` —— 业务级增强怎么写 | 业务开发者（要写增强时） | ⏳ |
| — | 第 13 条说明 | —— | 上游运行时包内**没有 `docs/` 目录**，只有包级 README；两份上位设计文档里的实测结论已沉淀为 `docs/design/2026-09-25-{pi,dsh}-harness-design.md` |

**状态说明**：`⏳` = 尚未撰写（会按 03–05 → 06 → 08–11 的顺序补齐）。
未列出的内容不会以"空骨架"形式出现 —— 宁可不建文件，也不留 TODO。

## 其它必读

| 文档 | 用途 |
|---|---|
| [设计正文](design/2026-09-25-unified-agent-base-design.md) | 为什么这样设计（含四类标记：不变量 / 适配契约 / 运行时专有 / 本项目决策） |
| [上位依据 · pi](design/2026-09-25-pi-harness-design.md) | pi 专有实测约束的唯一事实来源 |
| [上位依据 · dsh](design/2026-09-25-dsh-harness-design.md) | dsh 同上 |
| [实施路线图](plans/IMPLEMENTATION-ROADMAP.md) | 唯一权威工作清单（包 S0–S8 + 各包进展） |
| [MCP 生态调研](research/2026-09-25-mcp-ecosystem-survey.md) | 企业常用 MCP 服务器、npm 实测存活表、预装建议 |
| [状态与交接](status/INDEX.md) | `docs/status/` 的发现入口（结构快照 / 事件日志 / 交接接力棒） |

## 命令面在哪

`make help` 是唯一的命令入口（每个目标都带一句说明）。实现细节在：

- `tools/` —— 命令面实现（validate / probe / smoke / verify / new-agent / run-local / dev-env …）
- `core/` —— 基座不变量（定义 schema、能力/参数/路由目录、四闸门框架、统一轨迹、镜像）
- `adapters/<运行时>/` —— 运行时专有实现（渲染器、自证、轨迹映射、失败表、豁免）
- `conformance/` —— 新运行时的准入门槛（C1–C10，10 项阻断性检查）
