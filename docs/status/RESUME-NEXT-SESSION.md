# Live Session Checkpoint

> Updated: 2026-09-25 15:35. **Session remains active — not a final handoff.**

## TL;DR

1. 状态层 + 权威工作清单就位（`docs/status/`、`docs/plans/IMPLEMENTATION-ROADMAP.md`，路由 = **managed**）。
2. **S0 与 S1 均已交付并验证**：中性定义契约 + 闸门 1 → 四闸门框架 + 统一轨迹 schema + 零凭据假网关。
3. 下一个包 = **S2**（`adapters/{pi,dsh}/` 的 `render` + `doctor`，以及 `conformance` C1–C10），**尚未开工**。

## Where things stand

- 分支 `main`，工作树干净。提交序列：`1fcda95`（状态层+路线图）→ `81499bb`（S0）→ `6a31899`（闭包 S0）→ `b38b397`（设计回写）→ `87ba18a`（S1）。
- 五个自检目标全绿，全部退出码 0：

  | 目标 | 覆盖 |
  |---|---|
  | `make validate` | 闸门 1 基座自洽（7 项） |
  | `make validate-selftest` | 闸门 1：16 项检查 + 9 个注入式样本 |
  | `make gates-selftest` | 框架 27 项：断言语言 / 短路 / 退出码 / `usable` / 摘要确定性 |
  | `make trace-selftest` | 轨迹 schema 19 项：七类事件 + 12 个必拒写法 |
  | `make gateway-selftest` | 假网关 31 项：零凭据 / 流式 / tools 计数 / 轨迹合规 / 关停 |

- **`usable` 目前恒为 false，这是正确的**：只有闸门 1 实现了，§6.8 要求四道全过才算「可用」。报告里的 `ok` 与 `usable` 分工是刻意的。
- 报告与退出码已统一到 §6.7：`0` 通过 / `2` 用法错误 / `10` 闸门 1 / `20` 闸门 2 / `30` 闸门 3 / `40` 闸门 4 / `50` 崩溃。
  **stdout 只放 JSON，人读日志走 stderr**（§8.2）——所以 `make validate` 的输出在 stderr 上。

## Next steps (immediate, action-level)

1. 读设计 §10.2 / §11.2（两份渲染映射表）与 §5.2（`adapter.yaml` 能力声明全字段）——这是 S2 的输入。
2. 先做 **B 轨 pi**（关键路径，纯新增无历史包袱）：`adapters/pi/adapter.yaml` + `render.mjs`（确定性、产出 digest）+ `doctor.mjs`（§6.3 七个字段）。
3. `doctor` 必须直接实现三条硬断言（技能集合 / 连接器集合 / 已加载扩展 id 集合 == 声明集合），用 `core/gates/assertions.mjs` 的 `set-equals`——**不要自己再写一套比较逻辑**。
4. C 轨 dsh 紧随其后（比较轨，不压关键路径）。
5. `conformance/` C1–C10 用例：用 `core/gates` 的断言语言写，声明式（每个用例 = 输入 + 期望断言）。
6. 别忘 `adapters/<h>/failures.md`（§5.5：每条静默失败配一个可执行检测用例）。

## Open decisions (无阻塞项，留待实现时撞上再定)

- pi 的 `model.reasoningEffort` 映射在 §10 里没有记录（`capabilities.yaml` 已标 `verified: false`）——S2 实测后回填支持度。
- 假网关响应体带非标准字段（`created: 0`、`fake_gateway`）。若接真实 harness 时某 SDK 严格拒绝未知字段，以 `x-fake-gateway-*` 响应头为准（三处独立暴露就是为此）。
- 企业 LLM 网关协议（I1）未定；假网关目前只有 OpenAI 兼容适配。第二适配层的插入边界已在 `tools/fake-gateway/README.md` 写明：新增 `protocols/anthropic.mjs`（三个同构导出）+ server 按路径分派，**`core.mjs` 一行不改**——若必须改，说明中性形状被污染了。

## Don't go down these paths again (ruled out)

- **一镜像多智能体 + 运行期 `--patch`**：违反 N19，且 `--patch` 失败静默、绕过制品签名（§15.3）。
- **瘦镜像 + 配置由卷下发**：同一镜像不同行为，把可执行内容的管控从镜像签名挪到平台 RBAC（§15.3）。
- **先造「假 harness」桩验证契约**：多一份无业务价值产物；`conformance` C1–C10 本身就是契约的可执行形态（P4）。
- **`conformance` 部分项仅告警**：会被软化的正是 C5/C8（最危险的两类退化）（P3）。
- **把端点/凭据写进 `agent.yaml` / `connectors.yaml`**：违反 R1/N21；定义里只写引用名。
- **未实现目标静默成功**：Makefile 里未实现的命令必须非零退出并说明归属包。
- **在 `core/gates` 之外另写一套报告/退出码语义**：§6.7 要求验证工具与运行时共用同一套语义；`validate.mjs` 已重构为复用 `core/gates`。
- **`usable` 只要跑过的闸门全绿就置 true**：那是「能启动」式的乐观，§6.8 要求四道全过。

## Ready-to-paste commands

```bash
make help                     # 命令面 + 参数
make validate                 # 闸门 1（输出在 stderr）
make validate AGENT_DIR=core/spec/fixtures/valid
make validate-selftest && make gates-selftest && make trace-selftest && make gateway-selftest
node tools/validate.mjs --json core/spec/fixtures/valid   # §6.7 形状的机器可读报告

# 假网关（闸门 3 的零凭据目标）
node tools/fake-gateway/server.mjs --port 0
# 门 3 编程接口：const gw = await startFakeGateway({ port: 0 }); gw.url / gw.traceLines / gw.close()

# 若 npm 报 EPERM 且提到 ~/.npm：依赖安装要换 cache 目录
npm install --cache /tmp/agent-base-npm-cache --no-audit --no-fund

# 设计正文按需取段（勿全文加载）
sed -n '570,709p'    docs/design/2026-09-25-unified-agent-base-design.md   # §5 适配契约 + conformance
sed -n '709,857p'    docs/design/2026-09-25-unified-agent-base-design.md   # §6 四闸门 + 输出契约 + 退出码
sed -n '1083,1210p'  docs/design/2026-09-25-unified-agent-base-design.md   # §10/§11 两份渲染映射表
```
