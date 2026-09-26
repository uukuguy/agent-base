# Live Session Checkpoint

> Updated: 2026-09-26 22:30. **Session remains active — not a final handoff.**

## TL;DR

1. **D8 修复（用户报的真 bug）**：`run-local` 进交互后**没有 `/project`** —— 根因是**产物复用判据只看定义摘要**，基座变了（新增 seed 扩展）而定义没变 ⇒ 旧产物被复用且**无任何报错**。现在渲染输入自己有摘要（定义 + seed + 渲染器 + adapter.yaml + catalog + emit.mjs），旧产物无此字段 ⇒ 一律重渲（自愈）。自检已固化 [181d2ac]
2. **§26 V1 完成**：会话内自省命令 `/project`（基座不变量）；**E1 完成**（钩子事件名成为可校验契约）[4ed2916 · 686c6d4]
3. **下一个具体动作**：§26 **V2**（同一份逻辑再开 CLI 出口）或 **E2b**（钩子逐条自证）；**E1b**（接入缝事件名）数据路径已就位

## Where things stand

- **全绿**：16 个自检 · 两侧 conformance **10/10** · `make examples-check` · `make walkthrough`（20/1/0）· 两侧渲染清单都记 `renderInputsDigest`
- ✅ **记忆层已配好（本轮）**：`mnemon` CLI 装好（官方 macOS 推荐 `brew install --cask mnemon-dev/tap/mnemon`，实测 0.2.9；写 `/opt/homebrew` 会被沙箱拒 ⇒ 需提权）+ Memory Space「agent-base 项目记忆」(id `default`) 已建并**激活**。归档真的跑起来了：热记忆 15 条/10220 字节 → **11 条/7721 字节**（`~/.mnemon/data/default/mnemon.db`，15 insights / 41 edges）。排错：`mnemon --version` 探活（**别用 `mnemon status`**，有副作用）；宿主找不到二进制时设 `MNEMON_CLI_PATH`
- 工作树干净；5 个提交都在本地（无远端）
- `examples/idea-to-proof/.render/pi` 已重渲（含 `/project`）；其它示例的旧缓存会在下次 `make local`/`run-local` 时**自动重渲**

## What this session delivered

**D8：产物复用判据（本轮，`181d2ac`）**

- `core/gates/digest.mjs` 新增 `digestInputs(entries)`（带角色的输入集合摘要；`optional` 显式记 `absent`，区分"没有"与"没算"）
- `adapters/{pi,dsh}/render-inputs.mjs`：声明各自决定产物的输入（定义 / seed / 渲染器 / adapter.yaml / catalog / emit.mjs），并导出与 harness 无关的 `renderInputsDigest`
- 两侧渲染器把 `renderInputsDigest` 写进清单；`tools/run-local.mjs` 用它判新鲜度（缺失字段 ⇒ 视为旧产物）
- `local-selftest` 新增两条：**"基座变了、定义没变 ⇒ 也重新渲染"** 与 **"不许误报成定义已变"**

**§26 V1：`/project`**（`4ed2916`）—— 八个分类，全部从产物现算；补全即"项目应该有哪些信息"的目录；钩子事件名与运行时 39 个集合逐个核对；可移植性与闸门 1 同源；自检 21 项（含真起 pi 的 `get_commands` 取证）

**E1：钩子事件名契约**（`686c6d4`）—— `event` → `events[]`；`adapter.yaml` 的 `hookEvents`（pi 39 个 + 复算命令，dsh 如实标未穷举）；闸门 1 `enhance/events` / `hook/events-decl` / `catalog/enum-sync`；基座自己的 seed 声明也进校验；D-0017 裁定 harness 层契约随基座版本演进

**记账对齐**（`7afeaeb`）—— roadmap/docs13 与实现一致

## Next steps (immediate, action-level)

1. **§26 V2**：同一份 `_project-info.mjs` 再开一个 CLI 出口（CI/容器可用）—— **不要写第二份文案**
2. **E2b 钩子逐条自证**（路线图顺序的下一项）
3. **E1b 接入缝的事件名**：`manifest.hookEvents` 已就位，启动期 `applyOverlay` / 闸门 2 用它校验
4. **§26 V3**：dsh 侧等价入口（做不到就写进 `exemptions.yaml`）
5. 次要：dsh 接入缝装载形态只有一种 · 多语言业务代码（E9）· `image-push` 未对真实 registry 验证 · `CLAUDE.md` 仍未创建
6. **已设计但「择机实现」（用户 2026-09-26 决定，不占当前队列）**：能力包（bundles）——`coding` / `verify-baseline` 两类包 + 动态使能。设计稿 `docs/design/2026-09-26-capability-bundles.md`，路线图 §27（B1 机制本体 → C4 技能落盘 → B2 `/project bundles` → C3 默认组合，兑现缺陷 D9）。**不要当成下一步开工**，除非用户点名。

## Don't go down these paths again (ruled out)

- **只比定义摘要就复用产物** ⇒ 基座变了却不重渲，**且不报错**（D8，本轮实测：新命令在会话里根本不存在）
- **两条启动路径各拼一份 env** ⇒ 同一能力「容器里能用、本地不能用」，且报错不指向环境变量（D10：本地少了 `AGENT_ARTIFACT_DIR`）。平台变量**单一定义**在 `core/image/platform-env.mjs`；`startup.prepare` 的运行期布局契约必须由 `stageRenderDir` **原样带出**，本地不许手搓
- **去猜 `dirname(配置目录)` 找渲染清单** ⇒ **清单在产物根，暂存的运行目录里没有**；任何"读清单"的能力都得用 `AGENT_ARTIFACT_DIR`
- **复用判据各写一份路径列表** ⇒ 两份迟早不一致，失败方式是"某次改动不触发重渲"且无声；判据必须与渲染器共用一份实现
- **在双引号字符串里再嵌双引号** —— 本轮踩了**第四次**（`capabilities.yaml`、`_project-info.mjs`、两个自检）；中文全角括号无害，嵌套的 `"` 才致命，一律用「」
- **y 靠 grep 人读输出取闸门结论** —— 人读报告走 **stderr**，stdout 只放 `--json`
- **把 piRpc 的 responses 键当成请求 id** —— 键是**命令名**（`responses.get("get_commands")`）
- **`/project` 自己算一套可移植性** ⇒ 立刻与闸门 1 打架（第一版就犯）
- **给 dsh 编一份假的事件清单** ⇒ 穷举不出来就如实标"未验证"
- **以为沙箱内装不了 CLI** —— 会被拒的是"写 `/opt/homebrew`"，走**一次提权**（`sandbox_permissions`）就能装成；真正的坑是**建了 Memory Space 却没激活**（报 `catalog=1 / writable=0`），以及用 `mnemon status` 当探活（有副作用）

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

# 用户报的那条路径（现在应该有 /project）
cd examples/idea-to-proof && make local
> /project            # 整份；/project hooks 只看钩子；/project <Tab> 补全即目录

# 产物新鲜度自愈（基座变了也会重渲）
make pi-project-info-selftest && make local-selftest
```

