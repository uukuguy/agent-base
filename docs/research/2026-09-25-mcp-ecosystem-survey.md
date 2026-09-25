# MCP 生态调研（2026-09-25）

> **用途**：回答两个问题 —— ① 企业场景最常用的 MCP 是哪些（决定基座预装什么）；② pi 侧的 MCP **客户端**从哪来（S2 预检发现的阻塞）。
> **方法**：官方 registry/文档 + 企业选型文章 + **本机 `npm view` 实测存活**。外部来源在本文件末尾标注；**只有 npm 实测过的才进推荐清单**。
> **结论摘要**：网上多数「MCP 排行」指向**已废弃**的包；推荐清单必须只收实测活着的。客户端问题比预想便宜得多（已有成熟第三方 pi 扩展）。

---

## 1. 传输与安装形态（决定 `connectors.yaml` 够不够用）

官方 registry 文档规定：

| 形态 | 说明 |
|---|---|
| `streamable-http` | 远程服务器**应当**用它；**SSE 已废弃**（仅为兼容旧客户端而保留） |
| `stdio` | 本地进程，registry 里用 `packages` 描述（`registryType: npm`、`identifier`、`version`、`transport.type: stdio`） |
| 远程多租户 | URL 支持 `{变量}` 模板 + `headers`（可标 `isSecret`） |

**对基座的结论**：`core/spec/connectors.schema.json` 的 `stdio | streamable-http` 二值枚举**与官方规范一致**，无需增加 `sse`（已废弃）。三种安装形态都能用现有 schema 表达：

- npm-stdio → `command: npx`, `args: ["-y", "<pkg>@<ver>"]`
- python-stdio → `command: uvx`, `args: ["mcp-server-git"]`
- remote → `transport: streamable-http` + `urlRef`

---

## 2. 官方参考实现（7 个）

Everything / Fetch / Filesystem / Git / Memory / Sequential Thinking / Time。零凭据、本地、无外部系统依赖 —— 是**验证走通**场景最合适的默认集。

---

## 3. 企业场景高频系统（按「能解锁多少人」排序）

工程 → GitHub / Linear 或 Jira / Sentry；销售 → Salesforce 或 HubSpot / Slack；支持 → Zendesk 或 Intercom / Notion 或 Confluence；财务运营 → Google Workspace / 数据仓库（Snowflake、BigQuery、Postgres）；全员 → Slack + Google Workspace。

企业级的真正判据不是工具数量，而是三条：**每用户鉴权**、**可分级权限**、**每次调用有记录**（含实参、结果、执行身份）。

---

## 4. 🔴 npm 实测存活表（本机 `npm view`，2026-09-25）

**A. 活着且近期有发布 —— 可进预装清单**

| 包 | 版本 | 形态 |
|---|---|---|
| `@modelcontextprotocol/server-filesystem` | 2026.8.31 | stdio / npm |
| `@modelcontextprotocol/server-memory` | 2026.8.31 | stdio / npm |
| `@modelcontextprotocol/server-sequential-thinking` | 2026.8.31 | stdio / npm（注意名字**带连字符**） |
| `@modelcontextprotocol/server-everything` | 2026.8.31 | stdio / npm（参考/测试服务器） |
| `@notionhq/notion-mcp-server` | 2.5.2 | stdio / npm |
| `@sentry/mcp-server` | 0.40.0 | stdio / npm |
| `@supabase/mcp-server-supabase` | 0.13.0 | stdio / npm |
| `@playwright/mcp` | 0.0.82 | stdio / npm |
| `@upstash/context7-mcp` | 4.1.1 | stdio / npm |

**B. 已废弃（`deprecated` 标记为 "Package no longer supported"）—— 禁止进清单**

| 包 | 最后版本 | 备注 |
|---|---|---|
| `@modelcontextprotocol/server-github` | 2025.4.8 | 已被官方 GitHub MCP 取代 |
| `@modelcontextprotocol/server-slack` | 2025.4.25 | 已被官方 Slack MCP 取代 |
| `@modelcontextprotocol/server-postgres` | 0.6.2 | 已废弃 |

**C. 不在 npm —— 需别的安装形态**

| 目标 | 实测 | 正确形态 |
|---|---|---|
| Git 服务器 | `@modelcontextprotocol/server-git` **E404**；`mcp-server-git` 是 `0.0.1-security` 占位 | Python：`uvx mcp-server-git` |
| Fetch 服务器 | `@modelcontextprotocol/server-fetch` **E404** | Python：`uvx mcp-server-fetch` |
| GitHub 官方 MCP | `@github/github-mcp-server` **E404** | 交付形态非 npm（二进制/远程） |
| Linear / Atlassian | `@linear/mcp-server`、`@atlassian/mcp-server` **E404** | 远程 `streamable-http` |

> **教训（要写进文档）**：网络上的「MCP 排行」普遍未校验包生命周期。基座的预装清单**只能来自实测**，并且必须有升级/退役机制（与 §14 风险 1 的上游漂移同类）。

---

## 5. 🟢 pi 侧的 MCP 客户端：生态已有成熟解

S2 预检确认 pi 0.87.1 **没有原生 MCP 客户端**（docs/README/CHANGELOG 零提及、无 `mcp.json`）。但 `npm search` 显示**第三方 pi MCP 扩展生态已经不小**：

| 包 | 版本 | 说明 |
|---|---|---|
| `pi-mcp-adapter` | 2.37.0 | MCP 适配扩展（版本号最活跃） |
| `pi-mcp-extension` | 1.5.0 | "MCP client extension for the Pi coding agent" |
| `@ian-pascoe/pi-mcp` | 0.5.3 | "A complete Model Context Protocol Host for Pi" |
| `@clawos-dev/pi-mcp-bridge` | 0.2.587 | **读 `.mcp.json` 里的 stdio / http server 并桥接** |
| `@spences10/pi-mcp` | 0.0.60 | 安全暴露已配置的 MCP 工具 |
| `@geohar/pi-mcp-combiner` | 0.14.3 | 经 sharedserver 跑 mcp-combiner 聚合器 |
| `@feniix/bridgekit` | 0.15.0 | TypeBox 工具一次定义、适配到 pi 与 MCP |

**这对原选项 A/B/C 的影响**：

- 「自研 pi MCP 客户端」（我原先倾向的 A）**不再是唯一出路**，很可能是不必要的重复劳动。
- `@clawos-dev/pi-mcp-bridge` 读的正是 `.mcp.json` + `mcpServers`（stdio/http）——**与设计 §10.2 预测的渲染形态一致**，说明我们的渲染契约方向是对的。
- 但企业级要求（**每次调用留痕** / 每用户鉴权 / 权限分级）**没有一个第三方扩展会天然满足我们的 §8.3 统一轨迹与 §7 安全基线**。所以「采用第三方」≠「免检」：必须用 `conformance` C1–C10 过一遍，尤其 **C7（轨迹合规）与 C9（安全声明一致）**。

> 这恰好是 P4 决策的价值兑现：**`conformance` 用例本身就是契约的可执行形态**——用它来选型，而不是用偏好。

---

## 6. 对基座的设计含义

1. **预装的是「能力」，不是「默认启用」**（P-a）。镜像里可用 = 能力；`connectors.yaml` 里 `enabled: true` = 选择。默认 `enabled: false`，闸门 2 的断言集只含 enabled 的（§6.3 断言 2 已如此设计）——这同时挡住「工具膨胀导致模型选不准」（工具描述每次请求都要读）。
2. **v1 预装只收「零凭据 + 无外部依赖 + npm 实测活着」的本地集**：`filesystem` / `memory` / `sequential-thinking` / `everything`。理由：体积小、不依赖 I2（内网 npm）、正好支撑 `idea-to-proof` 与闸门 3 的零凭据探针。
3. **企业 SaaS 集不进默认镜像，只在能力目录里声明**（`@notionhq/notion-mcp-server`、`@sentry/mcp-server`、`@supabase/mcp-server-supabase`、`@playwright/mcp`、`@context7`）。避免 §14 风险 8（基座层膨胀）。需要时按智能体进薄层。
4. **Python 形态要给 `uvx` 留位置**：`git`/`fetch` 只有 Python 实现 → 基座镜像要么带 `uv`，要么这两个不进 v1 预装。
5. **新缺口（记入设计待办，不阻塞首个走通）**：企业级 MCP 的关键是**每用户鉴权**，而我们的参数层模型是**单一服务凭据**（`credentialRef` → 环境变量）。Slack / Salesforce / Google Workspace 这类要求 per-user OAuth 的服务器与现有模型不匹配。

---

## 7. 建议的决策（待用户确认）

| 项 | 建议 |
|---|---|
| pi 的 MCP 客户端 | **不自研**；采用 + 精确 pin 一个第三方扩展（优先 `pi-mcp-adapter` / `pi-mcp-extension` / `@clawos-dev/pi-mcp-bridge`），**以 C1–C10 准入**（C7/C9 是重点）。它作为基座种子进 `adapters/pi/seed/` |
| 预装服务端 v1 | 只预装本地零凭据四件（filesystem / memory / sequential-thinking / everything），pin 到实测版本 |
| 企业 SaaS | 只进能力目录声明，默认 `enabled: false`，不进默认镜像 |
| `connectors` 与可移植性 | 客户端由基座按 harness 提供 → **J1 得以保持**（不再需要 B 方案收窄核心） |
| per-user OAuth | 记为设计缺口，排到首个走通之后 |

---

## 外部来源

- [The MCP Registry — Publishing Remote Servers](https://modelcontextprotocol.io/registry/remote-servers.md)（transport 规范、SSE 已废弃）
- [Example Servers（官方参考实现 7 个）](https://modelcontextprotocol.io/examples.md)
- [Best MCP Servers for Enterprise Teams (2026) — Metorial](https://metorial.com/answers/best-mcp-servers-enterprise)（企业选型排序 + 企业级三判据）
- [The MCP Registry](https://modelcontextprotocol.org/registry/about)
- npm 实测：`npm view <pkg> version deprecated`（2026-09-25，本机）

> 外部内容仅作证据；**推荐清单以第 4 节的 npm 实测为准**。
