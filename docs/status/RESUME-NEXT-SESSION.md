# Live Session Checkpoint

> Updated: 2026-09-25 16:00. **Session remains active — not a final handoff.**

## TL;DR

1. S0 与 S1 均已交付并验证（契约基线 + 四闸门框架 + 轨迹 schema + 零凭据假网关）。
2. **S2 预检已完成，撞到一个契约级阻塞**：实测 **pi 0.87.1 没有 MCP**，而 dsh 原生有 —— `connectors`（N2 四大业务概念之一）在 pi 侧无落点。适配器**尚未开写**，等用户裁决。
3. 其余预检结论都是好消息：pi 与 dsh 的自证（`doctor`）都有**零凭据原语**可依，闸门 2 完全可实现。

## Where things stand

- 分支 `main`，工作树干净。提交：`1fcda95` → `81499bb` → `6a31899` → `b38b397` → `87ba18a` → `3c4fadf`。
- 五个自检目标全绿（`validate` / `validate-selftest` / `gates-selftest` / `trace-selftest` / `gateway-selftest`）。
- **没有**任何 S2 代码 —— 只有预检结论。不要以为 `adapters/` 存在。

## 🔴 阻塞：connectors 在 pi 侧没有落点

**实测事实**（本机 pi `0.87.1` / dsh `0.1.7-rc.1`）：

| 证据 | 结果 |
|---|---|
| pi `docs/`（39 篇）+ `README.md` + `CHANGELOG.md` 中 "mcp" 出现次数 | **0 / 0 / 0** |
| pi 包内 `mcp.json` / `allowInstall` / `hostConfigDiscovery` | **均 0 次**（bundle 里的 `mcpServers` 全是 Gemini SDK 的内部字段） |
| pi 包内任何 mcp 命名的包 | 无 |
| dsh 侧 | `@deepseek-ai/dsh-mcp-client`、`@deepseek-ai/dsh-mcp-resources` **存在** |

**为什么这是阻塞而不是 bug**：`connectors`（「它能连哪些系统」）是 §4.6/N2 的四个业务概念之一，属**可移植核心**。J1 承诺「同一份中性定义，两个 harness 都能渲染并跑通」，且基座对可移植核心的跨 harness 等价性负责。pi 侧无原生实现，意味着**这个承诺对带 MCP 的智能体不成立**。直接受影响的还有：

- **§10.2** 的映射表行 `connectors.yaml → agent-dir/mcp.json`（`mcpServers` + `allowInstall:false` + `hostConfigDiscovery:"off"`）在 0.87.1 上**不存在**。
- **P2 决策**：第二个参考示例 `contract-review` 的定位是「带 MCP，演示双 harness」——按现状无法按该定位演示。
- **§6.3 硬断言 2**（连接器集合相等）：pi 侧无物可断言。

**四个选项**（已呈用户裁决）：

| 选项 | 做法 | 代价 |
|---|---|---|
| **A** | 基座提供 pi 的「MCP 客户端扩展」作为**基座不变量增强**（烤进 `adapters/pi/seed/extensions/`），`connectors.yaml` 渲染成它的配置；`doctor.connectors[]` 由该扩展自证 | MCP 连接变成 harness 专有实现，我们自研并长期维护（协议演进 / 鉴权 / 工具 schema）。正是 P-c 的适用场景 |
| **B** | 承认 connectors 不属可移植核心，写进 `adapters/pi/exemptions.yaml` + 收窄 §1.4 边界 | 诚实、零新增维护面；但「业务真的需要 MCP」这件事没解决，`contract-review` 失去双 harness 演示意义 |
| **C** | 用第三方 pi MCP 扩展/包 | 需先做生态调研 + pin + 评审；依赖不可控 |
| **D** | 重估 §1.6 主力定位：MCP 类场景默认走 dsh | 与「pi 稳定所以压关键路径」冲突；但 §1.6 本就允许依数据翻转 |

**可行性已确认，且有了更省的答案**：pi 扩展能 `pi.registerTool()`（TypeBox 参数 schema + `execute()`）、可行子进程 → 选项 A 技术上可做。**但** npm 上已有成熟的第三方 pi MCP 扩展生态（`pi-mcp-adapter` 2.37.0、`pi-mcp-extension` 1.5.0、`@clawos-dev/pi-mcp-bridge` 读 `.mcp.json` —— 正是 §10.2 预测的形态）→ **自研大概率是不必要的重复劳动**。建议**用 `conformance` C1–C10 选型**（重点 C7 轨迹合规 / C9 安全声明一致），而不是凭版本号挑。详见 `docs/research/2026-09-25-mcp-ecosystem-survey.md`。

## 🟠 第二项待确认：`connectors.yaml` 支持按名引用（公开契约变更）

已交付 `core/image/preinstall.yaml` —— **独立可升级的预装清单**，目的是让**开发智能体**便捷（用户明确的方向，判据 = 心智负担低 / 约定明确 / 改动局部化 / 非专家可上手）。含 15 条预装条目（含 3 条 planned 技能）+ **11 个开发者面向引用名** + 6 条排除项理由；`make validate` 的 `preinstall/*` 组（10 项）守它不烂。

要让它真正省事，需要一处公开契约变更（**未确认不实现**）：

```yaml
mcpServers:
  - ref: filesystem     # 开发者只写一个名字；渲染器按 preinstall.yaml 解析出 transport/command/args/版本
    enabled: true
```

现状 §4.3 要求开发者写全 `transport` + `command/args` 或 `urlRef` + 包名与版本 —— 与「心智负担低、非专家可上手」相悖。影响面：`core/spec/connectors.schema.json` + 两个 catalog + 渲染器（S2）+ 设计 §4.3/§4.6。**与既有决策不冲突**，反而更贴 P-a（能力=基座持有的包与版本，选择=智能体写不写这个 ref）与「升级局部化」。

> 另记一处设计语言待对齐：§8.1 说镜像语义是「验证快照」，§8.5 说的是「生产基座镜像」。本清单只服务前者；到真做生产镜像时再回看分层（§7.2/§8.5）。

## 已实测：好消息（闸门 2 可实现，且都零凭据）

| 机制 | 实测结果 |
|---|---|
| **pi 自证原语** | `pi --mode rpc` + `{"type":"get_commands"}` 零凭据返回**实际加载**的技能（`source:"skill"` + `sourceInfo.path`）→ §6.3 技能硬断言可实现 |
| **pi 配置目录** | `PI_CODING_AGENT_DIR` 可直接指向渲染产物，**不必伪造 `$HOME/.pi/agent`**；实测 `get_state` 读到了渲染的 `models.json`/`settings.json`（报 `provider=corp-gateway model=corp-think`） |
| **pi 隐式源（复现）** | `$HOME/.agents/skills` 里的技能**真的**混进加载集合（`skill:leaked`）→ §10.1 约束 3 复现 |
| **pi 隐式源（新发现）** | 还有第二个：**`.agents/skills` 沿 cwd 祖先发现、止于仓库根** —— 设计未记录，所以 cwd 也必须中立化 |
| **收干净的两条路** | `--no-skills --skill <dir>` → 只剩声明集合；或隔离 `HOME` → 同样干净。两者都用（P-b 首选文件系统） |
| **pi 写配置目录（复现）** | 连 `--list-models` 都会写 `<agent-dir>/{models-store.json,auth.json}` → §10.1 约束 2 复现，需要可写暂存 |
| **pi 端点不插值（复现）** | 上游文档确认：`models.json` 只插值 `apiKey`/headers，**`baseUrl` 不插值** → §10.2 的 `.tmpl` + 启动期渲染是必需的 |
| **dsh 自证原语** | `dsh <name> --from-default-profile <tpl> --dump-config` **零凭据**输出组合后的完整 profile 树 → dsh 的 doctor 有干净原语 |
| **dsh shipped 模板** | `acp` / `headless` / `sdk` / `sdk-minimal` / `web`（`tui` 不是 shipped 模板，本机 `~/.dsh/profiles` 里是自定义的 `dsh-tui`） |
| **假网关可接 pi** | pi 的 `models.json` 支持 `api:"openai-completions"` + 假 API key → 闸门 3 模型探针可指向我们的零凭据假网关（N14 闭环） |

**设计修正待回写**（用户裁决后一并处理）：

- §14 风险 12「上游文档缺失：npm 包内无 docs 目录」→ **对 pi 0.87.1 已过时**（包内有 39 篇 docs）。
- §10.1 约束 3「配置无法排除隐式技能源」→ 准确说法是**配置键**无法排除，但 **CLI flag `--no-skills` 可以**；且还需补记第二隐式源（cwd 祖先的 `.agents/skills`）。
- §6.3 硬断言 3 的集合口径 → pi 常驻内置扩展（`llama`，`source=extension`）不该算「未声明的增强混入产物」；断言集应只含**制品来源**的增强。

## Next steps (immediate, action-level)

1. **等用户裁决 connectors 落点**（A/B/C/D）。这是唯一阻塞项。
2. 裁决后先回写设计（§10.1 / §10.2 / §14 / §6.3 + §15.1 记账），再动 `adapters/`。
3. 然后按 B 轨 pi 推进：`adapter.yaml` → `seed/` → `render.mjs` → `doctor.mjs`。`doctor` 直接用 `core/gates/assertions.mjs` 的 `set-equals`，不要另写比较逻辑。
4. pi 的运行期契约（实测得出，非推断）：`PI_CODING_AGENT_DIR=<渲染产物>` + 中立化 `HOME` 与 `cwd` + `--no-skills --skill <声明目录>` + `PI_OFFLINE=1`。

## Don't go down these paths again (ruled out)

- **一镜像多智能体 + 运行期 `--patch`**：违反 N19，且 `--patch` 失败静默、绕过制品签名（§15.3）。
- **瘦镜像 + 配置由卷下发**：同一镜像不同行为，把可执行内容的管控从镜像签名挪到平台 RBAC（§15.3）。
- **先造「假 harness」桩验证契约**：多一份无业务价值产物；`conformance` C1–C10 本身就是契约的可执行形态（P4）。
- **`conformance` 部分项仅告警**：会被软化的正是 C5/C8（P3）。
- **把端点/凭据写进 `agent.yaml` / `connectors.yaml`**：违反 R1/N21；定义里只写引用名。
- **未实现目标静默成功**：Makefile 里未实现的命令必须非零退出并说明归属包。
- **在 `core/gates` 之外另写报告/退出码语义**：`validate.mjs` 已重构为复用 `core/gates`。
- **`usable` 只要跑过的闸门全绿就置 true**：§6.8 要求四道全过。
- **照抄设计 §10.2 的 mcp.json 映射**：pi 0.87.1 没有这个文件——先落 connectors 决策，否则会写出一个永不生效的渲染分支（正是 §5.5 在治的静默失败）。

## Ready-to-paste commands

```bash
make help                     # 命令面 + 参数
make validate && make gates-selftest && make trace-selftest && make gateway-selftest && make validate-selftest
node tools/validate.mjs --json core/spec/fixtures/valid   # §6.7 形状报告

# pi 零凭据自证（实测过的形态）
H=$(mktemp -d); printf '{"type":"get_commands"}\n{"type":"get_state"}\n' | \
  HOME=$H PI_CODING_AGENT_DIR=<agent-dir> PI_OFFLINE=1 pi --mode rpc --no-session --no-skills --skill <agent-dir>/skills

# dsh 零凭据自证
H=$(mktemp -d); HOME=$H DSH_HOME=$H/dsh dsh <name> --from-default-profile web --dump-config

# 若 npm 报 EPERM 且提到 ~/.npm：依赖安装要换 cache 目录
npm install --cache /tmp/agent-base-npm-cache --no-audit --no-fund

# 设计正文按需取段（勿全文加载）
sed -n '570,712p'    docs/design/2026-09-25-unified-agent-base-design.md   # §5 适配契约 + conformance
sed -n '709,857p'    docs/design/2026-09-25-unified-agent-base-design.md   # §6 四闸门 + 输出契约 + 退出码
sed -n '1083,1210p'  docs/design/2026-09-25-unified-agent-base-design.md   # §10/§11 两份渲染映射表
```
