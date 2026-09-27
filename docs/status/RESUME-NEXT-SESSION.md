# Live Session Checkpoint

> Updated: 2026-09-27 05:1x. **Session remains active — not a final handoff.**
> 工作线总览在路线图 **§1.1**（六条线 + 三阶段顺序 + 决策门）。

## TL;DR

1. **L3 整条线已闭合**：阶段一 = A1+V2（`make verify-plan` / `make project-info` / `/project plan`）· E1b（接入缝事件名）· Q1+Q2（`make env-check`）；阶段二 = A2 受控容器入口 · A3 出处与覆盖 · A4 失败归因（五类）· A5 无人值守端到端判据（含结果缓存）· **A6/A6b 两侧的审批门**（主运行时扩展 `verify-container.ts` + 另一侧 cordis 插件，都记 `approval.decision`、都 fail-closed）
2. **下一个具体动作**：**P5**（`docs/13` §2 契约表逐行补"最后一次实测"的日期/命令 —— 只写我真跑过的，没跑过的标"未实测"）+ O4/O5；O1/O2/O3 与 `CLAUDE.md` 已完成
3. 阶段三（择机，用户已定）：bundle 线 **B1 → C4 → B2 → C3 → C5**

## Where things stand

- **全绿**：**22 项回归自检**（21 个 `*-selftest` + `validate`，含 `validate-selftest` 的新正例机制）· 两侧 conformance **10/10** · `make examples-check` · `make walkthrough`（20/1/0）
- Makefile **51 个目标**（无 `NOT_YET` 桩）；L3 期间新增 `project-info` / `verify-plan` / `env-check` / `verify-container` / `unattended-selftest` / `dsh-approval-probe` / `dsh-verify-container-selftest` 等及各自自检
- 本轮提交（都在本地，无远端）：`ef9c92d`（A1+V2）· `487ea2f`（E1b）· `4c0540a`（A4）· `870e92f`（A5）· `1b6f1f2`（A6）· `e5bd6a6`（A6b-1）· `48371d0`（A6b-2）· `fa32e58`（E2b + D13）· 本轮 O1/O2/O3 + `CLAUDE.md`
- 记忆层可用（`mnemon` 0.2.9 + Memory Space `default` 已激活，满时自动归档）

## What this session delivered（本轮，按 §1.1 阶段一）

**A1 + V2：验证计划与非交互出口**（`ef9c92d`）

- 自省逻辑从 pi seed 搬到 **`core/introspect/project-info.mjs`**（中性、无运行时常量名）⇒ 会话内入口、CLI 出口、将来的容器路径**共用一份**；渲染器照 `_trace-emit.mjs` 的先例把它拷进产物 `extensions/_project-info.mjs`
- `make verify-plan [JSON=1]` + 会话内 `/project plan`：身份四摘要 · `local[]`（四道闸门的命令与期望）· `container[]`（四条，每条带 `why`）· `notCovered[]
` · `make project-info [CATEGORY=…] [JSON=1]`
- "只能在容器里成立"的断言做成**声明式**（`core/introspect/_container-only.mjs`），自检**双向**比对声明与 C9 实现（声明里的必须存在；实现里字面量的必须已归类）

**E1b：接入缝事件名**（`487ea2f`）—— 启动期用产物清单的 `hookEvents` 校验 overlay 声明；写错**响亮失败并点名**；`enumerated:false` 不假校验但提示；两条新负例（startup-selftest 37 项）

**Q1 + Q2：环境一致性与本地预检** —— `core/env/parity.mjs`（声明 + `classify`）· `core/catalog/adapter-pins.mjs`（pin 的**唯一**读取处，`dev-env` 与 `env-check` 共用）· `tools/env-check.mjs`（文本/JSON；未声明差异 ⇒ 退出码 10）；`verify --json` 新增 `environment{where,ok,declared,undeclared,notCoveredHere,unprecheckable}`；预装清单新增 `localCommands`（apt 包名 ≠ 命令名）

## Next steps (immediate, action-level)

1. **A2** 受控容器验证入口（封闭命令 + 绑定面 allowlist + realpath + 三条负例；复用镜像 agent-only `verify`）
2. **A3** 结论带 `image` 摘要与 `covered` 显式清单；`docs/13`/`docs/14` 写明**交付结论以容器内自证为准**
3. **A4** 失败归因三分类（`local-reproducible` / `declared-env-difference` / `unknown`，`unknown` 必须响亮上报）
4. **A5** 无人值守端到端判据（一条脚本化演示：改定义 → 本地闸门 → 容器验证 → 归因）
5. 可随手插入：`P5 + O2 + O3`（契约表与口径纪律）· `E2b`（钩子逐条自证）· `CLAUDE.md`

## Don't go down these paths again (ruled out)

- **在 `core/` 里写运行时常量的名字**（如把 `"pi"` 当默认参数）⇒ 被 `core/harness-name` 当场抓住。core 的中立性靠它守着（本轮真踩中，一次改掉 5 处红）
- **假设 apt 包名 == 命令名** ⇒ `ripgrep` 的命令是 `rg`、`ca-certificates` 根本不是命令。本地预检要么声明命令（`localCommands`），要么明确标"不可预检"
- **同一条事实写两份** ⇒ 本轮差一点又犯：pin 的读取抽成 `core/catalog/adapter-pins.mjs` 给 `dev-env` 与 `env-check` 共用；容器断言清单只保留 `_container-only.mjs` 一处，`env/parity.mjs` 直接引用它
- **把"没跑到"当成"通过"** ⇒ 宿主的 `verify` 首败即停，归因不能拿"不在失败清单里"当"本地通过"（本轮实测踩中，见 `core/verify/attribution.mjs`）
- **让"属性断言"退化成恒真** ⇒ `check(name, true, …)` 等于"因错误原因通过"；写成真断言后它当场抓出一个一直存在的契约违规（D12：镜像内自证失败退出码是 1）
- **在 python 里用 ASCII 双引号包中文** ⇒ 与本条同源，本轮第六次；一律改用「」
- **在 python 字符串里嵌 ASCII 双引号（第十一次）** ⇒ 脚本直接不执行，白跑一轮；中文引号/「」才安全，或直接改用 `edit` 工具
- **在双引号字符串里再嵌双引号** —— 已踩**第五次**（`parity.mjs` 刚犯）；中文全角括号无害，嵌套的 `"` 才致命，一律用「」
- **多个 `printf` 只把重定向挂在最后一条上** ⇒ 前几条掉到 stdout、日志丢失；追加多行要用 `{ …; } >> file`
- **只比定义摘要就复用产物**（D8）· **两条启动路径各拼一份 env**（D10）· **去猜 `dirname(配置目录)` 找清单** ⇒ 都用 `AGENT_ARTIFACT_DIR` / `platform-env.mjs`

## Ready-to-paste commands

```bash
cd ~/sandbox/agentic-2026/agent-base

# 回归（全部应为全绿）
for t in validate validate-selftest gates-selftest trace-selftest emit-selftest trace-view-selftest \
         gateway-selftest providers-selftest startup-selftest pi-selftest pi-trace-selftest \
         pi-trace-ext-selftest pi-project-info-selftest project-info-selftest env-check-selftest \
         new-agent-selftest local-selftest; do
  printf "%-32s" $t; make -s $t >/dev/null 2>&1 && echo OK || echo FAIL; done
node conformance/run.mjs --harness pi && node conformance/run.mjs --harness dsh
make examples-check && make walkthrough

# 本轮新增的两个出口
make verify-plan AGENT_DIR=examples/idea-to-proof          # 要验什么、哪些只能容器验、为什么
make verify-plan AGENT_DIR=examples/idea-to-proof JSON=1   # 给 AI 读
make project-info AGENT_DIR=examples/idea-to-proof CATEGORY=hooks
make env-check                                             # 本地 vs 容器：差异与缺项
make env-check JSON=1
```
