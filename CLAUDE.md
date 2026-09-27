# CLAUDE.md —— 进入这个仓库先读这一页

> 这份文件是**新会话的入口**（§25 L5）。它只做三件事：这个项目是什么、怎么验、有什么纪律。
> 细节不在这里堆：每一项都指向真源文件。

## 1. 这是什么

**agent-base**：企业智能体**基座** + 两个运行时（主运行时 `pi`，候选 `dsh`）。

- **基座 ≠ 应用**：基座不含任何业务智能体；业务智能体派生到 `examples/` 或基座之外，**不回头改基座**。
- 核心目标不是"上生产"，而是**帮一个业务智能体把想法验证走通**；生产化（鉴权/多租户/签名/编排）不在范围。
- harness 差异**只允许**出现在 `adapters/` 与业务级增强里；`core/` 必须中立。

## 2. 判据：「可用」是跑出来的，不是声称的

**四道闸门全绿才算「可用」**（`ok` ≠ `usable`）：

| 闸门 | 命令 | 回答什么 |
|---|---|---|
| 1 静态 | `make validate AGENT_DIR=…` | 定义合法吗、引用存在吗、层纪律对不对 |
| 2 解析自证 | `make doctor RENDER_DIR=…` | 运行时**实际加载**的集合 == 声明的集合吗 |
| 3 集成探针 | `make probe RENDER_DIR=…` | 端点/技能/连接器可达吗、钩子是否**逐条留痕** |
| 4 端到端冒烟 | `make smoke RENDER_DIR=…` | 真跑一次：退出码/输出/轨迹/有没有越界用工具 |

一次跑完：`make verify AGENT_DIR=…`。退出码语义只有一处定义（`core/gates/exit-codes.mjs`）：
`0 通过 · 2 用法 · 10/20/30/40 闸门 1–4 · 50 崩溃`。

**本地不等于交付结论**：`make verify-container AGENT_DIR=…` 才是容器内自证（绑定面=当前项目只读、
网络 none、根只读、能力全丢；镜像与源码不同源会**拒绝执行**）。宿主结论**不含**安全下限/双架构/同源。

## 3. 最常用的几条

```bash
make help                                  # 全部目标（每条都有一行说明）
make local AGENT_DIR=examples/idea-to-proof   # 进交互会话调试（最常用的开发入口）
#   会话内：/project（项目真相）· /project plan（验证计划）· /verify-container（需审批的容器验证）
make verify-plan AGENT_DIR=… [JSON=1]      # 要验什么、哪些只能容器验、为什么
make env-check [JSON=1]                    # 本地 vs 容器：差异与缺项（未声明的差异会红）
make verify-container AGENT_DIR=… [DRY=1]  # 受控容器验证（失败会自动归因）
make unattended-selftest                   # 无人值守链路演示（改定义→闸门→容器→归因）
```

## 4. 纪律（这些是硬约束，不是偏好）

1. **证据先于断言**：结论要跑出来。`make debug` 曾被怀疑坏了，实测退出码 0 —— 类此先跑再说。
2. **不静默降级 / 不静默跳过**：做不到就**响亮失败**并说清缺什么；跳过要**如实标"没验"**，不许算通过。
3. **单一真源**：同一事实不许写两份（pin、预装清单、事件集合、路径列表…）。检查脚本与实现**共用**一份实现。
4. **`core/` 不许出现运行时名**（连默认参数值都不行）——`core/harness-name` 会当场判红。
5. **产物清单只增不改语义**；新增事件类型/字段是加法，改语义要动 `$id` 版本。
6. **助手文件**（会被拷进产物、被 import 的那种）在 `core/` 与产物里都用 `_` 前缀，否则会被当成未声明扩展。
7. **声明与行为必须一致**：`exemptions.yaml` 里的不对称一旦被实测推翻，就改声明（不是留着好看）。
8. **可以不一样，但不许悄悄不一样**：差异要么进 `exemptions.yaml`，要么进 `env-exemptions`（`core/env/parity.mjs`）。

## 5. 改完代码怎么验（收尾必跑）

```bash
make regression        # 一条命令：镜像过期就先重建 → 22 项自检 → 两侧 conformance → examples-check → selfcheck
make regression FAST=1 # 快检：跳过要真跑容器的几项（**跳过不算通过**）
```

`make regression` 会**先查镜像指纹**：闸门源码（`core/` · `adapters/` · `tools/{validate,probe,smoke,verify}.mjs`）
变了而镜像没重建 ⇒ 它先重建再往下跑（D13 的教训：不重建就谈不上"验过"）。
**改开发工具**（`tools/gen-*.mjs` · `selfcheck.mjs` · `regression.mjs` 等）**不会**让镜像过期 ——
指纹只覆盖"能改变镜像内判据"的代码。

## 6. 状态在哪看

| 想知道 | 看 |
|---|---|
| 现在在做什么、下一步是什么 | `docs/status/RESUME-NEXT-SESSION.md`（会话检查点） |
| 项目结构与不变量 | `docs/status/CURRENT-STATE.md` |
| 待办与路线（六条工作线、阶段、决策门） | `docs/plans/IMPLEMENTATION-ROADMAP.md`（**先看 §1.1**） |
| 为什么这么设计 | `docs/design/`（统一设计 + 两个 harness 设计 + 能力包 + 开放性与验证） |
| 能做什么/怎么验/边界 | `docs/14-how-to-verify.md`（含负例表与强度说明） |
| 已定的取舍 | `docs/status/DECISIONS.md` |
| 逐条流水 | `docs/status/JOURNAL.md` |

## 7. 已知的坑（别重复踩）

- 别在字符串里嵌 ASCII 双引号（用「」或改用 `edit` 工具）；别拿"看起来对"当验证。
- 产物复用判据必须覆盖**全部**输入（D8）；镜像同源判据必须覆盖**被烤进去的代码**（D13）。
- 退避：`docker` 由 OrbStack 管，多架构要自建 `docker-container` builder（`build.mjs` 会自动确保 `ab-multi` 存在）。
- 完整清单见 `RESUME-NEXT-SESSION.md` 的「Don't go down these paths again」。
