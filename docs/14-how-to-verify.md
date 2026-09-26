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
| **轨迹** | 统一轨迹：9 类事件、可回放、业务可扩展 | `make trace-view TRACE=…` |
| **容器** | 基座镜像：产物挂载或**烤进镜像**都能跑；缺配置 fail-fast | `docker run … config-check` |
| **自证** | **镜像内**跑闸门（离线、零凭据） | `docker run <镜像> verify` |
| **接入缝** | 上层镜像在**运行期**加业务代码与钩子（不动产物） | `make image-derived … OVERLAY_DIR=…` |
| **派生镜像** | `FROM agent-base` + 业务层，一条命令构建并自证 | `make image-derived AGENT_DIR=…` |
| **钩子可验** | 声明了钩子 ⇒ 断言"钩子发射路径真的在工作" | `make verify` 里的 `probe/hook-fired` |

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
    event: tool_call
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
| 定义合法、引用存在、分层合规 | `make validate AGENT_DIR=…` | 闸门 1 全绿（带定义 39–42 项） |
| 非法定义会被拦 | `make validate-selftest` | 13 个负例样本，每个**只因目标原因**变红 |
| 渲染确定、跨运行时差异有声明 | `make compare AGENT_DIR=…` | 「集合两侧一致（差异均有声明）」 |
| 工具边界**真的**生效 | `make verify AGENT_DIR=examples/idea-to-proof` | `probe/model.tools` 显示 `tools=1`（deny 了 bash/write/edit 只剩 read）⚠️ 这条以前是坏的：旧写法下是 4 |
| 端点真的收到带工具的流式请求 | 同上 | `probe/model.reachable` + `model.tools` + `model.stream` |
| **钩子确实在工作** | 同上 | `probe/hook-fired`：「钩子发射路径确实在工作：轨迹里有 N 条钩子当场发出的事件」⚠️ 证明的是发射路径；业务钩子要自证需自己留痕 |
| 另一个运行时的钩子 | `make verify … HARNESS=dsh` | 如实报「事后映射 ⇒ 该断言在此运行时不适用」（**不算通过**） |
| 被禁的工具真的调不到 | `make smoke AGENT_DIR=…` | `smoke/no-denied-tools` |
| 轨迹合法可回放 | `make trace-selftest` + `make trace-view TRACE=…` | 9 类事件全过 schema；视图能按 run 回放 |
| 镜像与源码同源 | `make conformance HARNESS=pi`（C9） | 四个镜像 + 归档的 LABEL 等于源码指纹 |
| 容器安全下限 | 同上 | C9 十六项（非 root、只读根、能力全丢、断网可用…） |
| **镜像内**能自证 | `docker run <镜像> verify` | 闸门 2/3/4（有定义连闸门 1）—— 离线、零凭据 |
| 接入缝不改产物 | `make startup-selftest` | 7 项接入缝断言（含「产物未被改动」） |
| 声明了但没写对 ⇒ 响亮失败 | 见 §4 | 全部非 0 退出，且报错点明原因 |

**一条命令跑全部**：`make verify-all`（每个示例 × 两个运行时）· `make conformance`（C1–C10）。

---

## 4. 负例：怎么确认"错的东西会红"（这些才是可信度的来源）

| 故意做错 | 期望 |
|---|---|
| 增强声明 `kind: 乱写` | 闸门 1 `enhance/schema` 红（负例 `11-enhance-bad-kind`） |
| `kind: hook` 但漏 `event` | 闸门 1 `enhance/schema` 红（负例 `12-enhance-hook-no-event`） |
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
3. **`probe/hook-fired` 的强度有限**（读准再用）：
   · 它证明的是「**钩子发射路径在工作**」（基座轨迹自己就是一个钩子，实测 5 条事件）；
   · 断言用的是**烤进产物的**声明（`hookEnhancements`）；**接入缝（overlay）新加的钩子**由闸门 2 验"已进产物且集合相等"，
     但"我这条是否触发"要**它自己留痕**（用 `core/trace/emit.mjs` 写事件即会被计入）；
   · 想逐条证明"每个声明都跑了"，需要钩子自证 + 更细的断言 —— 见路线图 §23 的 E1（事件名集合校验尚未实现）。
4. **深度定制不跨运行时等价**：钩子的失败语义在两侧甚至相反（一处阻断、一处不阻断）——
   差异写进 `exemptions.yaml`，不假装等价。
5. **dsh 侧的接入缝还是"未实现"**（overlay 只支持扩展目录 + settings 的装载形态）；
   声明了会**响亮失败**，不会静默跳过。
6. **容器安全下限（C9）只能在构建侧验**，镜像内 `verify` 不覆盖它。
