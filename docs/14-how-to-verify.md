# 14 · 怎么验：能做什么、怎么做、怎么确认

| | |
|---|---|
| 状态 | 验证指南（面向"要亲手确认的人"） |
| 日期 | 2026-09-26 |
| 相关 | [`13-developer-contract.md`](13-developer-contract.md)（保证什么）· [`06-deploy.md`](06-deploy.md)（部署细节）· 路线图 §23/§24/§25（未完成项） |

**读法**：每条都给「命令 + 期望输出 + 它证明了什么」。命令都在仓库根目录跑。
凡标 ⚠️ 的是**边界**：这条只证明到这个程度，别当成更强的结论。

---

## 0. 一次性准备

```bash
cd <repo>
make image-all DEBUG=1        # 四个镜像变体（arm64/amd64 × 普通/调试）
make verify-all               # 全部示例 × 两个运行时，四道闸门
```

---

## 1. 能做什么（能力清单，按层）

| 层 | 能做什么 | 怎么验 |
|---|---|---|
| **定义** | 一份中性定义（人设/模型/技能/连接器/工具边界），跨运行时成立 | `make validate AGENT_DIR=…`（闸门 1） |
| **渲染** | 确定性产物：同一定义渲两次结果相同，产可复算摘要 | `make compare AGENT_DIR=…` |
| **本地跑** | 零凭据假网关 / 真实端点 / 本地模型，三种跑法 | `make run-local …`、`LIVE=1` |
| **闸门** | 四道闸门回答"可用/不可用"，且带证据（端点侧取证） | `make verify AGENT_DIR=…` |
| **轨迹** | 统一轨迹：10 类事件、可回放、业务可扩展 | `make trace-view TRACE=…` |
| **容器** | 基座镜像：产物挂载或**烤进镜像**都能跑；缺配置 fail-fast | `docker run … config-check` |
| **自证** | **镜像内**跑闸门（离线、零凭据） | `docker run <镜像> verify` |
| **接入缝** | 上层镜像在**运行期**加业务代码与钩子（不动产物） | `make image-derived … OVERLAY_DIR=…` |
| **派生镜像** | `FROM agent-base` + 业务层，一条命令构建并自证 | `make image-derived AGENT_DIR=…` |
| **钩子逐条可验** | 声明了钩子 ⇒ 断言"**每条**钩子各自留下带自己 id 的痕迹" | `make verify` 里的 `probe/hooks-evidenced`（哑掉的钩子会点名） |

**现在还不能做**（诚实清单，见路线图）：
loop 定制（L3）· 服务形态与多会话（L4）· 审批通道 · 成本/网关 · 多语言业务代码（D-0012）·
业务钩子"我这条也跑了"的逐条证明（需要钩子自己留痕）。

---

## 2. 怎么做：四条主路径

### 路径 A：从零做一个智能体

```bash
make new-agent NAME=demo DESCRIPTION="演示用"
make verify AGENT_DIR=demo            # 四道闸门
make run-local AGENT_DIR=demo --prompt "你好"
```
期望：`new-agent` 打印骨架清单；`verify` 末行「可用」；`run-local` 末尾给出退出码 0 与轨迹路径。

### 路径 B：把定义跑成容器智能体

```bash
make render AGENT_DIR=examples/idea-to-proof OUT=/tmp/art
docker run --rm -v /tmp/art:/opt/agent-base/artifact:ro \
  -e HARNESS=pi -e CORP_GATEWAY_BASE_URL=… -e CORP_GATEWAY_API_KEY=… \
  agent-base:0.1.0-arm64 agent "说句你好"
```

### 路径 C：做**派生镜像**（业务层，推荐给真实项目）

```bash
make image-derived AGENT_DIR=examples/idea-to-proof \
     OVERLAY_DIR=./my-overlay IMAGE_REF=agent:mine
```
`my-overlay/` 的最小形态：

```yaml
# my-overlay/overlay.yaml
apiVersion: agent-base/v1
harness: pi
enhancements:
  - kind: hook
    id: corp-audit
    entry: extensions/corp-audit.ts
    events: [tool_call]
```
```
my-overlay/extensions/corp-audit.ts   # 业务钩子（工具调用前审计/脱敏/策略）
my-overlay/business/rules.mjs         # 可共享的业务代码
```
期望输出（实测）：
```
✅ 已构建 agent:mine
✅ 配置齐备（config-check，无挂载）（退出码 0）
✅ 缺凭据 fail-fast（不静默跑）（退出码 2）
✅ 可用：派生镜像构建成功，并在镜像内自证通过（产物与定义已烤入，运行时无需挂载）
```

### 路径 D：只做接入缝（不改产物、不重建镜像）

把 overlay 目录挂进去即可：

```bash
docker run --rm --network none \
  -v /tmp/art:/opt/agent-base/artifact:ro \
  -v ./my-overlay:/opt/agent-base/overlay:ro \
  -e HARNESS=pi <镜像> verify
```
期望：闸门 2 的集合里出现你的增强 id（例如 `["corp-audit","trace"]`，集合相等 2 项）。

---

## 3. 怎么确认：逐条判据与期望

| 要证明的事 | 命令 | 期望 / 判据 |
|---|---|---|
| 定义合法、引用存在、分层合规 | `make validate AGENT_DIR=…` | 闸门 1 全绿（基座自洽 30 项；带定义 44 项） |
| 非法定义会被拦 | `make validate-selftest` | 13 个负例样本 + 1 个合法样本 + **1 个正例样本**，每个**只因目标原因**变红；正例用来断言「必须绿**且**某条检查里点到了名字」（如未验证声明） |
| 渲染确定、跨运行时差异有声明 | `make compare AGENT_DIR=…` | 「集合两侧一致（差异均有声明）」 |
| 工具边界**真的**生效 | `make verify AGENT_DIR=examples/idea-to-proof` | `probe/model.tools` 显示 `tools=1`（deny 了 bash/write/edit 只剩 read）⚠️ 这条以前是坏的：旧写法下是 4 |
| 端点真的收到带工具的流式请求 | 同上 | `probe/model.reachable` + `model.tools` + `model.stream` |
| **钩子确实在工作（逐条）** | 同上 | `probe/hooks-evidenced`：「N 个声明的钩子各自留痕：trace(5 条) · audit-hook(1 条)」；哑掉的会红并点名 |
| 另一个运行时的钩子 | `make verify … HARNESS=dsh` | 如实报「事后映射 ⇒ 该断言在此运行时不适用」（**不算通过**） |
| 钩子订阅的**事件名真的存在** | `make validate AGENT_DIR=…` | `enhance/events`：声明的每个事件名都在 `adapters/<h>/adapter.yaml` 的 `hookEvents` 里（pi 39 个，逐个对名字）⚠️ dsh 侧事件集合**未穷举** ⇒ 如实标「未验证」，不做假校验 |
| 被禁的工具真的调不到 | `make smoke AGENT_DIR=…` | `smoke/no-denied-tools` |
| 轨迹合法可回放 | `make trace-selftest` + `make trace-view TRACE=…` | 10 类事件全过 schema；视图能按 run 回放 |
| 镜像与源码同源 | `make conformance HARNESS=pi`（C9） | 四个镜像 + 归档的 LABEL 等于源码指纹 |
| 容器安全下限 | 同上 | C9 十六项（非 root、只读根、能力全丢、断网可用…） |
| **镜像内**能自证 | `docker run <镜像> verify` | 闸门 2/3/4（有定义连闸门 1）—— 离线、零凭据 |
| 接入缝不改产物 | `make startup-selftest` | 7 项接入缝断言（含「产物未被改动」） |
| **会话里能问到项目真相** | `make local` 然后 `/project`（或 `make pi-project-info-selftest`） | 命令真的注册（source=extension）· 输出每项指到产物来源 · 补全项随项目变 · 事件名写错标 ❌ |
| **要验什么、哪些只能容器验** | `make verify-plan AGENT_DIR=…`（`JSON=1` 给 AI）/ 会话内 `/project plan` | 四个身份摘要 + 本地四道闸门的命令与期望 + 容器断言逐条带 `why` + 本次未覆盖清单；`make project-info-selftest` 全绿 |
| **容器内验证（受控入口）** | `make verify-container AGENT_DIR=…`（`DRY=1` 只看参数、`JSON=1` 给 AI） | 绑定面**恰好两处只读**（项目 + 产物）· 网络 none · 根只读 · 能力全丢 · 容器内闸门 1(agent-only)/2/3/4 全过；**交付结论以它为准**（宿主结论不含安全下限/双架构/同源） |
| **镜像是过期的那份吗** | `make verify-container …`（前置自动比指纹） | 镜像 LABEL ≠ 当前源码指纹 ⇒ **拒绝执行**并给出重建命令（闸门判据是烤进镜像的，用旧镜像验新产物会得到「容器挂、本地过」的假差异）；确实要用旧镜像加 `--allow-stale-image` |
| **会话里请求容器验证（需审批）** | 会话内 `/verify-container`（`make local` 之后） | 先摊开将要执行的 docker 参数 → 你放行/拒绝 → 只有放行才跑；决定记进轨迹 `approval.decision`；无应答者时 **fail-closed 不执行**；自检 `make pi-verify-container-selftest` |
| **同上（另一侧）** | 该运行时会话内 `/verify-container`（同一套判据的另一个落地形态） | 走它的原生审批接缝（四种结果；无应答者/无审批服务 ⇒ **fail-closed 放弃**）；事件同样进轨迹；自检 `make dsh-verify-container-selftest` |
| **容器挂的时候是不是缺陷** | 同上（失败时自动归因） | 五类：本地可复现（真缺陷）/ 已声明差异（不是缺陷）/ 容器专有断言失败（真缺陷，改镜像）/ 本地没跑到（先修前面那条）/ **未声明的差异（响亮上报，不许猜）** |
| 声明了但没写对 ⇒ 响亮失败 | 见 §4 | 全部非 0 退出，且报错点明原因 |

**一条命令跑全部**：`make verify-all`（每个示例 × 两个运行时）· `make conformance`（C1–C10）。

---

## 4. 负例：怎么确认"错的东西会红"（这些才是可信度的来源）

| 故意做错 | 期望 |
|---|---|
| 增强声明 `kind: 乱写` | 闸门 1 `enhance/schema` 红（负例 `11-enhance-bad-kind`） |
| `kind: hook` 但漏 `events` | 闸门 1 `enhance/schema` 红（负例 `12-enhance-hook-no-event`） |
| `kind: hook` 但事件名写错（如 `tool_calls`） | 闸门 1 `enhance/events` 红，并列出该名字不属于那 39 个（负例 `13-enhance-hook-bad-event`） |
| 往 `extensions/` 丢一个未声明的文件 | **渲染期**响亮失败（该运行时会加载它，等于"偷偷加载"） |
| 另一个运行时的增强不给 `package` | **渲染期**响亮失败（不静默跳过） |
| overlay 声明的 harness 与当前不符 | `prepare` 失败并点明不匹配（不猜） |
| overlay 目录在但缺 `overlay.yaml` | `prepare` 失败（不猜内容） |
| 不给凭据就跑 | `config-check` 退出码 2（fail-fast，不静默降级） |

---

## 5. 边界（读到这条请当真）

1. **闸门 3/4 默认走零凭据假网关**：它证明"链路通、工具到位、流式没降级"，
   **不证明**"真实模型答得好"。要后者：`LIVE=1`（会真的调用，花你自己的额度）。
2. **订阅型 provider（如 `openai-codex`）无 LIVE 时报"不适用"**，不假装通过。
3. **`probe/hooks-evidenced` 的强度**（读准再用）：
   · 它证明的是「**每条声明的钩子各自留痕**」：声明 N 条，就要有 N 条带 `enhancement=<声明 id>` 的钩子事件；
   · 业务钩子自证只有一行：写事件时用 `new TraceWriter({ enhancement: "<声明 id>" })`（基座把写入器放到扩展同目录）；
   · 哑掉的钩子**会被点名并红**（不再是"有钩子事件就算过"）；订阅的事件在本场景不发生，也应在加载期留一条；
   · 断言用的是**烤进产物的**声明（`hookEnhancements`）；**接入缝（overlay）新加的钩子**由闸门 2 验"已进产物且集合相等"，
     事件名由启动期校验（E1b 已落地）；"我这条是否触发"同样要它自己留痕；
   · 另一运行时（轨迹事后映射）如实报「不适用」，不假装通过。
4. **深度定制不跨运行时等价**：钩子的失败语义在两侧甚至相反（一处阻断、一处不阻断）——
   差异写进 `exemptions.yaml`，不假装等价。
5. **dsh 侧的接入缝还是"未实现"**（overlay 只支持扩展目录 + settings 的装载形态）；
   声明了会**响亮失败**，不会静默跳过。
6. **容器安全下限（C9）只能在构建侧验**，镜像内 `verify` 不覆盖它。
7. **`/project` 只读产物、只报事实**：它不评价业务逻辑对不对，也不读 `auth.json`
   （登录态不是项目信息）；`trace` 一行显示「未声明」说明这次不是在基座入口里跑的
   （落点与摘要由运行期注入）。
