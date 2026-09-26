# Live Session Checkpoint

> Updated: 2026-09-26 21:20. **Session remains active — not a final handoff.**

## TL;DR

1. **E1 完成**（钩子声明契约）：`kind: hook` 的 `event`（单串）→ **`events`（数组）**，名字逐个对 `adapter.yaml` 声明的可订阅集合（pi **39 个**，附复算命令）；负例 `13-enhance-hook-bad-event` 只因该原因红 [686c6d4]
2. **顺手堵了个后门**：闸门 1 此前不校验**基座自己的** `adapters/<h>/seed/enhancements.yaml` —— 那份 `kind: hook` 连事件名都没写却一直"全绿"
3. **下一个具体动作**：用户新提的 **§26 V1 `make guide AGENT_DIR=…`**（列出该项目要验什么：闸门逐条期望 + 技能/连接器/增强/钩子事件名 + 可粘贴命令）—— 依赖已就绪；路线图顺序上的下一项是 **E2b（钩子逐条自证）**

## Where things stand

- **全绿（实测）**：14 个自检 · 两侧 conformance **10/10** · `make examples-check` · `make walkthrough`（20 通过 / 1 跳过 / 0 失败）
- **闸门 1 数字变了**（本轮实测）：基座自洽 **29** 项（原 27）· 带定义 **43–44** 项（原 39–42）· 负例 **13** 个（原 12）+ 1 个合法样本
- 本轮两个提交都在本地：`7afeaeb`（记账与实现对齐）、`686c6d4`（E1）。工作树干净；仍**无远端**
- 状态层已刷新：CURRENT-STATE 的开放问题与"契约与检查"段；roadmap §23 勾 E1、新增 E1b，新增 §26；DECISIONS **D-0017**
- ⚠️ **运行时记忆写不进去**：`MEMORY.md` 顶到容量（10220/10240）、Memory Space 数为 0（无处归档）⇒ mnemon 明确拒绝写入。用户反馈因此只落在仓库里（roadmap §26 + JOURNAL）

## What this session delivered

**记账漂移修复**（`/project-state check` 抓到，用户同意后执行）[7afeaeb]

- roadmap §25 `P4` 已实现却标 `pending`、§23 `E3/E4` 即 §25 `P3/P2` 却各自 pending、"E2 标 done 却依赖 pending 的 E1"是**假依赖** → 全部对角
- `docs/13` §2 的 D2 行 `⚠️`→`✅`、带定义项数 38–40→**39–42**（六示例实测区间）、负例 10→**12**；INDEX 补 4 条外部锚点
- 教训已记 JOURNAL：**同一能力被两张表各记一遍就一定会不一致**（§23 加交叉引用）

**E1 钩子声明契约**（路线图 §23）[686c6d4]

- `adapters/pi/adapter.yaml`：新增 `hookEvents`（`enumerated: true`、**count 39** 作手抄见证值、`source`、**`reproduce` 复算命令**、39 个事件名按 `types.d.ts:979-1017` 声明顺序）
- `adapters/dsh/adapter.yaml`：`enumerated: false`（无统一钩子总线，seam 名字未穷举）⇒ 名字不假校验，声明如实标「未验证」
- `core/spec/enhancements.schema.json`：`event: string` → **`events: string[]`**（`minItems: 1`，`kind=hook` 必填）
- 基座 seed 的 trace 声明补上它真正订阅的 **6 个**事件（与 `extensions/trace.ts` 的 `pi.on(...)` 逐条对应）
- 闸门 1 新增：`enhance/events`（逐个对名字，坏名字列出来并指向复算命令）· `hook/events-decl`（声明自洽：count/重复/必须给 source；`enumerated: false` 必须给 note 且不许给名字）· `catalog/enum-sync`（能力目录与 schema 的枚举必须一致）
- 闸门 1 **现在也校验 `adapters/<h>/seed/enhancements.yaml`**（schema + 单一真源 + 事件名，与智能体声明同一套）
- 负例 `13-enhance-hook-bad-event`（`events: [tool_calls]`）→ 只因 `enhance/events` 红
- 能力目录 `enhancements` 组补齐：`package`/`events`/`config`/`description` 四个字段，`kind` 枚举 `plugin` → 与 schema 对齐（`docs/03` 已 `make gen-docs` 刷新）

**契约记账**（用户会关心的一条）

- CHANGELOG 0.1.0 下立「**破坏性：`event` → `events`**」+ 迁移写法（`event: X` → `events: [X]`）
- **D-0017**：`enhancements.schema.json` 是 **harness 层**契约，随**基座版本**演进，**不进 `apiVersion`**；`apiVersion` 语义窄化为"只承诺中性定义"。被否方案=升 `apiVersion: agent-base/v2`（6 示例 + 模板 + fixtures 全动，为一个未发布且不可移植的字段，不成比例）
- `docs/13` §3 稳定性表加一行明确这条边界；`docs/11` 示例改为 `events:` 并新增"四条硬约束"（含事件名）；`docs/14` 补判据与负例行

**用户新提需求（已登记）**

- 用户实测 `examples/idea-to-proof`：`make local` 进交互 pi **调试很方便**；要求新增一条命令列出"该项目要验证的目标 / skills 等"以指导验证 → roadmap **§26 V1/V2**，硬要求：**从产物与 adapter.yaml 真源现算**，不许第二份手写文案、不许与 `docs/14` 打架

## Next steps (immediate, action-level)

1. **§26 V1 `make guide AGENT_DIR=<示例>`**（用户提出，起点依赖已就绪）：列出四道闸门逐条期望 + 技能/连接器/增强 + 钩子订阅事件名 + 可移植性等级，每条附可粘贴命令；定义里加一个技能/钩子 ⇒ 输出必须跟着变
2. **E2b 钩子逐条自证**（路线图顺序的下一项）：声明 N 个钩子 ⇒ N 个都能指到自己的痕迹（现在只证明"发射路径在工作"）
3. **E1b 接入缝的事件名**：把 `hookEvents` 写进 render manifest，启动期 `applyOverlay` / 闸门 2 用它校验 overlay 声明的事件名（overlay 是业务定制主路径，现在事件名无人对）
4. 次要：dsh 侧接入缝（E3 已在旧口径下"done"，但**装载形态只有扩展目录+settings 一种**）· 多语言业务代码（E9）· `image-push` 未对真实 registry 验证 · `CLAUDE.md` 仍未创建

## Don't go down these paths again (ruled out)

- **为 harness 层字段改名去升 `apiVersion`** ⇒ 会把中性定义与不可移植的 harness 层绑成同一个节奏（D-0017 已否，附代价）
- **给 dsh 编一份假的事件清单** ⇒ 穷举不出来就**如实标"未验证"**，不做假校验（与"跳过即通过"同类）
- **保留 `event` 单串并加 `events` 双写法** ⇒ 同一事实两种写法，正是本轮刚抓到的"两处真源"病
- **把事件名校验只放在渲染器里** ⇒ 渲染器只覆盖"渲染过的东西"；闸门 1 才覆盖定义层 + 基座 seed
- **只校验智能体的声明、放过基座自己的** ⇒ 本轮实测：seed 的 `kind: hook` 没有事件名，一直没红
- **手抄事件名不留见证值/复算命令** ⇒ 39 这个数字两份二手报告给过 24/32，都对不上；`count` + `reproduce` 就是为这个

## Ready-to-paste commands

```bash
cd ~/sandbox/agentic-2026/agent-base

# 回归（全部应为全绿）
for t in validate validate-selftest gates-selftest trace-selftest emit-selftest trace-view-selftest \
         gateway-selftest providers-selftest startup-selftest pi-selftest pi-trace-selftest \
         pi-trace-ext-selftest new-agent-selftest local-selftest; do printf "%-24s" $t; make -s $t >/dev/null 2>&1 && echo OK || echo FAIL; done
node conformance/run.mjs --harness pi && node conformance/run.mjs --harness dsh
make examples-check && make walkthrough

# 看钩子事件契约（39 个 + 复算命令）
grep -A50 '^hookEvents:' adapters/pi/adapter.yaml
node tools/validate.mjs examples/idea-to-proof | grep -E 'enhance/events|hook/events-decl'

# 负例只该因目标原因红
make validate-selftest          # 期望：13-enhance-hook-bad-event 实际=["enhance/events"]

# 改过 catalog 就刷新生成文档
make gen-docs
```

## 用户实测过的本地调试入口（本轮反馈）

```bash
cd examples/idea-to-proof && make local     # 进交互 pi —— 用户实测"调试很方便"
```
