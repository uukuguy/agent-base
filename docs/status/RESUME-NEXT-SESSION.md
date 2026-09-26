# Live Session Checkpoint

> Updated: 2026-09-26 21:45. **Session remains active — not a final handoff.**

## TL;DR

1. **§26 V1 完成**：会话内自省命令 **`/project`**（基座不变量，每个智能体自带）—— 在交互会话里随时查"这个项目现在是什么样"，内容**全部从产物现算**，补全列表本身就是"一个项目应该有哪些信息"的目录 [4ed2916]
2. 前一轮：**E1 完成**（钩子事件名成为可校验契约）[686c6d4]；记账漂移已对齐 [7afeaeb]
3. **下一个具体动作**：§26 **V2**（同一份逻辑再开一个 CLI 出口，CI/容器可用）或 **E2b**（钩子逐条自证）—— 两者都依赖已就绪

## Where things stand

- **全绿**：15 个自检 · 两侧 conformance **10/10** · `make examples-check` · `make walkthrough`（20 通过 / 1 跳过 / 0 失败）· `make verify AGENT_DIR=examples/idea-to-proof` = **可用**
- 闸门 1：基座 **29** 项 · 带定义 **43** 项 · 负例 **13** 个；Makefile **39** 个目标（selftest 13→14）
- 工作树干净；三个提交都在本地（无远端）
- ⚠️ **运行时记忆仍写不进去**：`MEMORY.md` 满（10220/10240）+ Memory Space 数为 0（无处归档）⇒ mnemon 拒绝写入、既有条目不变。本轮用户的两条反馈因此只落在仓库（roadmap §26 + JOURNAL）

## What this session delivered

**记账与契约**（前两轮）

- [7afeaeb] roadmap/`docs/13` 与实现对齐（P4/E3/E4 勾 done、假依赖改正、数字现场复核）
- [686c6d4] **E1**：`kind: hook` 的 `event` → **`events`（数组）**；`adapter.yaml` 声明 `hookEvents`（pi 39 个 + `reproduce` 复算命令；dsh `enumerated: false` 如实标未穷举）；闸门 1 `enhance/events` + `hook/events-decl` + `catalog/enum-sync`；闸门 1 现在也校验**基座自己的** seed 声明；负例 `13-enhance-hook-bad-event`。契约记账：CHANGELOG 破坏性条目 + **D-0017**（harness 层契约随基座版本演进，不进 `apiVersion`）

**§26 V1：`/project`**（本轮，`4ed2916`）

- `adapters/pi/seed/extensions/project-info.ts`（薄壳：`registerCommand` + `getArgumentCompletions` + `sendMessage`，不触发模型调用）
- `adapters/pi/seed/extensions/_project-info.mjs`（纯逻辑：不依赖任何运行时 API ⇒ 自检可直接 import，dsh 侧将来可复用）
- 八个分类：`overview` / `model`（只给引用名，不读 auth.json）/ `skills` / `connectors` / `enhancements` / `hooks`（与运行时 39 个可订阅事件逐个核对）/ `trace`（9 类事件从 schema 现算）/ `portability`（与闸门 1 同源）
- 渲染器配套：① **下划线约定**（`extensions/_*.mjs` = 助手，不登记为扩展；声明指向 `_` 开头 ⇒ 渲染期报错）② 清单新增 **`hookEvents`**（E1b 的数据路径：产物自描述）③ 清单新增 **`agentEnhancements`**（只含智能体自己的增强 ⇒ 可移植性与闸门 1 同判据）
- 新自检 `make pi-project-info-selftest`（21 项，含真起 pi 的 `get_commands` 取证）

**用户两条反馈（原话要点，已登记）**

- ① `make local` / `run-local` 进交互 pi **调试很方便**（已写进 RESUME 的常用命令）
- ② 要**会话内的斜杠命令**（不是 Makefile 目标）能随时查项目信息、且**靠补全反过来知道项目应该有哪些信息** → §26 V1/V2/V3

## Next steps (immediate, action-level)

1. **§26 V2**：把同一份 `_project-info.mjs` 再开一个 CLI 出口（`make project-info AGENT_DIR=…`，CI/容器里可用）—— 逻辑已共享，**不要写第二份文案**
2. **E2b 钩子逐条自证**：声明 N 个钩子 ⇒ N 个都能指到自己的痕迹（现在只证明"发射路径在工作"）
3. **E1b 接入缝的事件名**：`manifest.hookEvents` 已就位 ⇒ 启动期 `applyOverlay` / 闸门 2 用它校验 overlay 声明的事件名
4. **§26 V3**：dsh 侧的等价入口（做不到就显式写进 `exemptions.yaml`，不假装等价）
5. 次要：dsh 侧接入缝装载形态只有一种 · 多语言业务代码（E9）· `image-push` 未对真实 registry 验证 · `CLAUDE.md` 仍未创建

## Don't go down these paths again (ruled out)

- **在双引号字符串里再嵌双引号** —— 本轮踩了**第三次**（`capabilities.yaml`、`_project-info.mjs`、自检文件）；中文全角括号不是问题，**嵌套的 `"` 才是**，一律改用「」或单引号
- **靠 grep 人读输出取闸门结论** —— 人读报告走 **stderr**，stdout 只放 `--json`；自检里要按 JSON 取（`gates[].checks[]` 里找 id）
- **记 `piRpc` 的 responses 键为请求 id** —— 键是**命令名**（`responses.get("get_commands")`）
- **`/project` 自己算一套可移植性** ⇒ 立刻与闸门 1 打架（第一版就犯：把基座不变量算进了"不可移植"）。凡"同一结论两处算"都要像这次一样在自检里**断言两者一致**
- **助手文件混进扩展登记** ⇒ 一个不导出工厂函数的文件被登记会让运行时**整体加载失败**；写作 `_` 开头，并在渲染期拦住"声明指向 `_` 开头"的写法
- **给 dsh 编一份假的事件清单** ⇒ 穷举不出来就如实标"未验证"（既有教训，继续遵守）

## Ready-to-paste commands

```bash
cd ~/sandbox/agentic-2026/agent-base

# 回归（全部应为全绿）
for t in validate validate-selftest gates-selftest trace-selftest emit-selftest trace-view-selftest \
         gateway-selftest providers-selftest startup-selftest pi-selftest pi-trace-selftest \
         pi-trace-ext-selftest pi-project-info-selftest new-agent-selftest local-selftest; do
  printf "%-30s" $t; make -s $t >/dev/null 2>&1 && echo OK || echo FAIL; done
node conformance/run.mjs --harness pi && node conformance/run.mjs --harness dsh
make examples-check && make walkthrough

# 会话内自省命令（人肉看一眼）
cd examples/idea-to-proof && make local
> /project              # 整份
> /project hooks        # 只看钩子（含"订阅的事件在不在 39 个里"）
> /project <Tab>        # 补全即"项目应该有哪些信息"的目录

# 自省命令自检（含真起 pi 的 get_commands 取证）
make pi-project-info-selftest
```
