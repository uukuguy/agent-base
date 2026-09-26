# docs/status INDEX

Catalog of every file in `docs/status/`. Categorized so Claude knows which to read, which to skip, and which are decision history kept for traceability only.

**Status legend**:
- 🟢 **active** — read on resume; reflects current truth
- 🟡 **decision-history** — historical record of a decision/finding; don't act on the recommendations inside (they may be reversed by later sessions)
- 🔴 **superseded** — replaced by a newer file or by a memory entry; safe to ignore on resume
- ⚫ **scratch** — one-off experiment scratch / data dump; not meant to be read again

When adding a new file to `docs/status/`, **also add its row here** — otherwise it becomes orphan exhaust (HARD INVARIANT, see project-state skill top).

## Active (read these on every resume)

| File | Status | Purpose |
|---|---|---|
| `JOURNAL.md` | 🟢 active | Append-only event log. `/project-state journal "..."` 追加。 |
| `RESUME-NEXT-SESSION.md` | 🟢 active | Session handoff baton. |
| `CURRENT-STATE.md` | 🟢 active | Structural snapshot. |
| `INDEX.md` (this file) | 🟢 active | Discovery hub. |

## Decision history (kept for traceability — verdicts may be outdated)

| File | Status | What it recorded | Outcome / supersession |
|---|---|---|---|
| `DECISIONS.md` | 🟢 active | 架构决策与理由（镜像构建与分层、双架构、生成物不落 core/ 等） | 持续追加；每条都带代价与边界 |

## Archived

| Bucket | Files | Notes |
|---|---|---|
| (empty initially) | | |

> When adding new archive buckets, append a row here pointing to `_archive/<label>/`. Do not list individual files.

## External anchors (outside `docs/status/`)

| Path | Role |
|---|---|
| `docs/plans/IMPLEMENTATION-ROADMAP.md` | **唯一权威工作清单** —— 包 S0–S7、依赖顺序、包级验收、跨包纪律、待外部输入 |
| `docs/research/2026-09-25-mcp-ecosystem-survey.md` | MCP 生态调研：企业常用服务器 + **npm 实测存活表**（废弃包警示）+ pi 侧客户端生态 |
| `docs/design/2026-09-25-unified-agent-base-design.md` | 最终设计 v2.4 —— 架构 / 适配契约 / 四闸门 / 落地设计的唯一真源 |
| `docs/design/2026-09-25-pi-harness-design.md` | pi 专有实测约束上位依据 |
| `docs/design/2026-09-25-dsh-harness-design.md` | dsh 专有实测约束上位依据 |
| `README.md` | 对外定位与基座/应用边界 |
| `docs/13-developer-contract.md` | 开发者契约：起点（含还缺什么）、保证（逐条指向真实判据）、明确不约束清单 |
| `docs/14-how-to-verify.md` | 能做什么 / 怎么做 / 怎么确认（逐条给命令 + 期望 + 边界，含负例表） |
| `docs/design/2026-09-26-harness-customization.md` | 两侧可定制点实测调研（pi 39 个钩子事件 / dsh ~30 个 seam；L0–L4 分层；D1–D7 实证缺陷） |
| `docs/design/2026-09-26-base-value-and-openness.md` | 基座价值定义（"保证 / 允许 / 不管"三段式；能力有无判据的自检问题） |

## Don't add new files unless they fit one of the categories above

If you want to record a **finding/lesson** that's a long-lived project fact → write to `CLAUDE.md` (structural facts section). If it's a collaboration lesson → write to the runtime memory layer. If it's a complete audit / experiment report → write a `docs/status/<topic>.md` here AND add its INDEX row.
