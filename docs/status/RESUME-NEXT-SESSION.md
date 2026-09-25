# Live Session Checkpoint

> Updated: 2026-09-25 23:05. **Session remains active — not a final handoff.**

## TL;DR

1. **里程碑已达成**：四道闸门全部落地，`make verify` 实测跑出 **`usable: true`** —— 「可用 = 四道闸门全过」从设计承诺变成可执行判定（全程零凭据）。
2. **pi 侧 conformance 9/10 全绿**（C1–C8、C10）；仅 C9（容器内安全实测）待基座镜像。
3. 剩下两条线：**S3 余项**（`template/` + `new-agent` → 基座镜像）与 **dsh 适配器**（只交了声明，`render/doctor/trace` 未实现）。

## Where things stand

- 分支 `main`，工作树干净。最近的提交见 `git log --oneline -8`（关键节点：`f547284` 轨迹扩展、`8973702` 闸门 3/4 + verify）。
- **十个自检目标全绿**：`validate` / `validate-selftest` / `gates-selftest` / `trace-selftest` / `emit-selftest` / `trace-view-selftest` / `gateway-selftest` / `pi-selftest` / `pi-trace-selftest` / `pi-trace-ext-selftest`。
- `make conformance --harness pi` → 9/10；不带 `--harness` 时 dsh 会拉低（预期，见下）。
- 一条命令看到全貌：`make -s help`（22 个目标，实现 17 / 未实现 5）。

## 走通一次（这是本轮最重要的能力）

```bash
make verify AGENT_DIR=<智能体目录> OUT=<渲染输出目录>
# → 闸门 1 静态 → 渲染 → 闸门 2 自证 → 闸门 3 探针 → 闸门 4 冒烟
# → 可用：四道闸门全过（§6.8）
```

实测细节：默认把模型端点指向**零凭据假网关**，所以不依赖任何外部系统；冒烟里 `tools.deny: [bash]` 也被验证生效（实跑只用了 `read`）。

## Next steps (immediate, action-level)

1. **`template/` + `tools/new-agent.mjs`** —— 关键路径。判据（§12.2）：派生后立刻 `make validate && make render && make doctor` 全绿；`grep -rn TODO my-agent/` 为空；无绝对路径、无 `package.json`。这是「非专家可上手」那句承诺的兑现点。
2. **`core/image/`**（基座镜像 + debug 变体）—— 它同时解锁 **conformance C9**（容器内只读根 / 非 root / cap-drop / 默认离线）。
3. `dev-env` / `run-local` / `image` / `debug` 四个 Makefile 目标（目前显式失败）。
4. **dsh 适配器**：`render` / `doctor`（必须补 patch target id 校验，那是 D1 唯一防线）/ `trace` + `conformance/fixtures/dsh-native-events.jsonl`。实现前先看路线图 §7（预检结论 + 我定的 Q1–Q3）。
5. 最后再谈 `examples/`（S4/S5）与 pi 侧 MCP 客户端选型（用 conformance C1–C10 实测选，不凭版本号挑）。

## Don't go down these paths again (ruled out)

- **一镜像多智能体 + 运行期 `--patch`**：同一镜像不同行为，违反 N19；`--patch` 失败静默且绕过制品签名（§15.3）。
- **瘦镜像 + 配置由卷下发**：同一镜像不同行为，把可执行内容的管控从镜像签名挪到平台 RBAC。
- **先造「假 harness」桩验证契约**：多一份无业务价值产物；`conformance` C1–C10 本身就是契约的可执行形态（P4）。
- **`conformance` 部分项仅告警**：会被软化的正是 C5/C8。
- **把端点/凭据写进中性定义**：违反 R1/N21；定义里只写引用名。
- **未实现的 Makefile 目标静默成功**：必须非零退出并指出所属包。
- **在 `core/gates` 之外另写报告/退出码语义**：`verify` 只做编排，不重新实现检查。
- **`usable` 只要跑过的闸门全绿就置 true**：§6.8 要求四道全过。
- **把生产化的顾虑当预装清单的门禁**：清单服务「快速验证」；生产分层（只读根/默认离线/调试工具）留待生产阶段回看。
- **让基座去理解业务语言**：基座只提供协议（附加位 / logger / 标签表）与查看器，翻译由查看器做机械查找。
- **自研 pi 的 MCP 客户端**：npm 上已有成熟第三方扩展（`pi-mcp-adapter` 等），自研大概率是重复劳动。
- **指望回调阻断来终止会话**：实测无效（阻断只变成错误结果，智能体照旧重试）；终止必须由假网关负责（已实现：收到工具结果后改回文本）。
- **照抄网络「MCP 排行」**：实测多数指向废弃包（github/slack/postgres 已 deprecated，git/fetch 不在 npm）。

## 三个实测踩坑（下次别重新踩）

1. **Node `spawn` 起的 harness 必须关 stdin**（`child.stdin.end()`），否则它等输入 → 零输出零事件，看起来像扩展没加载。**这个假故障我排查过一轮。**
2. **同进程内起假网关是可以的** —— 早前「必须独立进程」的结论是误判，真因就是上一条。
3. **参数解析别手写索引过滤**：`--out` 缺失时 `indexOf()+1 === 0` 会吞掉第一个位置参数（同类 bug 出现过两次）。已统一到 `core/gates/cli.mjs` 并加自检。

## Ready-to-paste commands

```bash
make -s help                                                    # 命令面全貌
make verify AGENT_DIR=<agent> OUT=<out>                          # 四道闸门 → usable
make conformance --harness pi                                    # 只看 pi（应 9/10）
make render AGENT_DIR=<agent> OUT=<out> && make doctor RENDER_DIR=<out>
make -s validate && make -s gates-selftest && make -s pi-trace-ext-selftest

# 依赖安装要先换 cache（沙箱不写 ~/.npm）
npm install --cache /tmp/agent-base-npm-cache --no-audit --no-fund

# 设计正文按需取段（勿全文加载）
sed -n '177,332p'   docs/design/2026-09-25-unified-agent-base-design.md   # §2 架构
sed -n '570,712p'   docs/design/2026-09-25-unified-agent-base-design.md   # §5 适配契约
sed -n '709,900p'   docs/design/2026-09-25-unified-agent-base-design.md   # §6 四闸门（含实现期修正）
sed -n '1236,1330p' docs/design/2026-09-25-unified-agent-base-design.md   # §12 落地设计
```
