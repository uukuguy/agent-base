# Live Session Checkpoint

> Updated: 2026-09-25. **项目已达到设计目标（M1–M4 全部达成）—— 这是一份可交接的终态记录。**

## TL;DR

**基座已完整交付，且每一个承诺都有可执行的验证。**

| 里程碑 | 状态 | 证据 |
|---|---|---|
| **M1** 运行时接入 | ✅ | `conformance` C1–C10 对 **pi 与 dsh 都 10/10 全绿** |
| **M2** 文档 | ✅ | `docs/00`–`docs/11` 共 12 篇 + 索引（其中 03 由真源生成并有同步检查） |
| **M3** 版本策略 | ✅ | `CHANGELOG.md`（三个版本号分工 / 破坏性变更定义 / 兼容承诺）+ 闸门 1 的版本纪律检查 |
| **M4** 双运行时示例 | ✅ | `examples/contract-review`（带 MCP 连接器）两侧四道闸门均「可用」+ `make compare` 等价性通过 |

一句判据：`make verify AGENT_DIR=<智能体>` 给出 **可用 = 四道闸门全过**（不是"能启动"）。

## Where things stand

- 分支 `main`，工作树干净。最近提交：`git log --oneline -12`。
- **十一个自检目标全绿**：`validate-selftest` / `gates-selftest` / `trace-selftest` / `emit-selftest` /
  `trace-view-selftest` / `gateway-selftest` / `pi-selftest` / `pi-trace-selftest` / `pi-trace-ext-selftest` /
  `new-agent-selftest` / `local-selftest`。
- `make validate` → 全绿（基座自洽 + 每个智能体定义）。**Makefile 里没有被 stub 掉的目标**（也不再有 `NOT_YET` 之类的占位宏）。
- `make examples-check` → 全绿（**每个示例在每个运行时上都「可用」**，并跑跨运行时等价性比对）。
- 双架构基座镜像（生产 + 调试变体）已交付；多架构 manifest 以 OCI 归档落盘。

## 走通一次（三条路径，都已实测）

```bash
# ① 派生一个新智能体（落在基座之外，开箱可用）
make new-agent NAME=my-agent DESCRIPTION="一句话说明"
cd ../my-agent && make verify          # → 可用：四道闸门全过

# ② 示例（含带 MCP 连接器的双运行时示例）
make verify  AGENT_DIR=examples/contract-review
make verify  AGENT_DIR=examples/contract-review HARNESS=dsh
make compare AGENT_DIR=examples/contract-review      # 跨运行时等价性

# ③ 容器
make image-all && make debug RENDER_DIR=.render/pi
```

判据都是**实测**的，不是声明：闸门 3 从**端点侧**取证（假网关记录它收到了几个工具 ——
带连接器时实测 4 → 7/36），闸门 4 真跑一次任务并检查退出码、输出、轨迹合规与工具越界。

## 若要继续推进（可选，非必需）

设计目标已达成。以下是有价值但**不属于**已完成范围的事，按价值排序：

| 项 | 为什么值得做 | 起点 |
|---|---|---|
| 第三个运行时接入 | 验证"准入成本 = conformance 十项"这句承诺 | `docs/09-harness-contract.md` 的九步 |
| dsh 的 `model.reasoningEffort` 映射 | 目前是**已声明豁免**（provider 条目的取值形状未实测） | `adapters/dsh/exemptions.yaml` 的 `reasoning-effort-not-mapped` |
| pi 增强"已加载"的观测 | 目前口径是「已进入产物」，离「已被运行时成功加载」差一步 | `adapters/pi/failures.md` F6 |
| 镜像推送链路 | 多架构 manifest 已能产出；推送需要可用的内部 registry | `make image-push` |
| 生产化能力 | 鉴权、审批流、多租户、SBOM 签名 —— **明确不在基座范围** | 见 `CHANGELOG.md` 的"本期不包含" |

## 接手前请先读

1. `docs/07-troubleshooting.md` —— **失败模式清单**（失败大多是静默的，这篇讲怎么看出来）
2. `docs/08-conventions.md` —— 分层纪律（哪层能放什么，每条都标了执法项）
3. `docs/status/DECISIONS.md` —— 关键决策与理由
4. `docs/design/2026-09-25-unified-agent-base-design.md` —— 为什么这样设计

## 一条纪律（贯穿整个项目）

**做不到就说清楚做不到。** 两个运行时做不到等价的地方，逐条写在各自的 `exemptions.yaml` 里；
未映射的字段声明为豁免并写明理由，而不是静默丢弃；检查发现的问题修在**检查侧**，
而不是把产物改到能通过；能力变了就同步更新**用例的预期**（能力变了，静默失败面就变了）。
`make compare` 会把所有已声明差异列出来 —— 可以不一样，但不许悄悄不一样。
