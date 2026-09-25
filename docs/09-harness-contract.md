# 09 · 适配契约：怎么接一个新运行时

面向平台开发者。目标：让"再接一个运行时"变成**填空**，而不是重新设计。

## 一、一个适配器要提供什么

```
adapters/<运行时>/
  adapter.yaml          能力声明 + 版本 pin + 形态声明（唯一真源，见下）
  render.mjs            中性定义 → 该运行时的原生配置（产物）
  doctor.mjs            [闸门 2] 让运行时**自证**它实际加载了什么
  trace.mjs             原生事件 → 统一轨迹（导出 mapEventStream）
  run.mjs               运行器（probe / smoke / run-local 共用）
  seed/                 基座种子：该运行时的不变量（设置、基座扩展、声明清单）
  failures.md           已知静默失败表（§5.5 要求逐条写）
  failure-cases.yaml    每条静默失败配一个**可执行**注入用例
  exemptions.yaml       做不到等价的地方（**必须显式**，不许沉默不等价）
  trace-mapping.md      原生事件 → 统一事件的映射说明 + 实现踩坑
```

另需一份原生事件样本：`conformance/fixtures/<运行时>-native-events.jsonl`。

**命令面约定**（两个渲染器与自证都遵守，工具据此跨运行时调用）：

```bash
node adapters/<h>/render.mjs <AGENT_DIR> [--out DIR] [--json]
node adapters/<h>/doctor.mjs <RENDER_DIR> [--json]
node adapters/<h>/run-local.mjs …   # 由 tools/run-local.mjs 按 --harness 分派
```

## 二、`adapter.yaml` 是关键：它是运行时知识的**唯一真源**

| 字段 | 作用 |
|---|---|
| `harness` / `version` / `adapterVersion` | 版本 pin（镜像构建与 `make dev-env` 从这读） |
| `package` / `bin` | npm 安装坐标与可执行名 |
| `renders` | 产物形态 + 是否确定性 |
| `capabilities` | 11 项能力声明（见下） |
| `enhancementShape` | 业务级增强的**声明形态**：`file`（产物里的文件）或 `package`（npm 包） |
| `failures` / `failureCases` / `exemptions` | 三个配套文件的路径 |

**为什么强调"唯一真源"**：这些知识一旦在两个地方各写一份，就会漂移，而且漂移时两边都不报错。
镜像构建、`dev-env`、conformance、用例助手**全部**从这一份读。

## 三、能力声明的 11 项与取值

取值只能用这四个：`supported` · `partial` · `unsupported` · `extension`。
`partial` **必须**在 note 里写清限制，并且该限制要进 `failures.md` 的检测清单。

`nativeParamInterpolation` · `runtimeWritableConfig` · `implicitSkillSources` · `configInclude` ·
`hmr` · `childAgents` · `osSandbox` · `permissionModel` · `traceEmit` · `mcpClient` · `runModes`

**每条 note 都要标依据**：【实测】= 本机跑出来的；【文档】= 上游文档；【待实测】= 尚未证实。
**不许夸大** —— conformance **C9** 会拿声明去对容器内实测。

## 四、准入门槛：`conformance` 的 C1–C10

**十项全是阻断性的。** 没实现不算通过（runner 记 `pending` 并非零退出），
"部分项仅告警"被明确否决 —— 会被软化的正是 C5/C8 这两类最危险的退化。

| 用例 | 验什么 |
|---|---|
| **C1** 声明完整性 | `adapter.yaml` 含全部必填能力项，且无未知项 |
| **C2** 渲染确定性 | 同定义渲染两次，产物与 digest 完全一致 |
| **C3** 渲染完整性 | 定义里每个非空字段在产物中有对应表达（**按适配器的 `expresses` 声明验证**） |
| **C4** 解析自证不变量 | `doctor` 输出七个字段，且三条集合断言成立 |
| **C5** 静默失败检测力 | 每条已知静默失败注入后**必须报错**（**灵魂项**；用例在 `failure-cases.yaml` 里声明） |
| **C6** 零凭据闸门 3/4 | 假网关下探针与冒烟通过 |
| **C7** 轨迹合规 | 原生事件映射后符合统一 schema，且**不丢事件** |
| **C8** 参数层隔离 | 把禁止项当参数注入 → **不得静默生效**（**灵魂项**） |
| **C9** 安全下限声明一致 | 声明的安全能力与容器内实测一致 |
| **C10** 退出码契约 | §6.7 的退出码语义逐条成立 |

跑：`node conformance/run.mjs --harness <h>`（`--only C5,C7` 可只跑几项）。

## 五、`doctor` 的七个字段（闸门 2 的输出契约）

`harness` · `version` · `definitionPath` · `skills` · `connectors` · `enhancements` ·
`modelRoutes` · `effectiveConfigDigest`

外加**三条硬断言**（不是"报告一下"，是**必须成立**）：

1. 实际加载的**技能**集合 == 声明集合（多一个也不行）
2. 实际启用的**连接器**集合 == 声明的启用集合
3. 已加载**扩展** id 集合 == `enhancements.yaml` 声明集合

**关键在"实际"两个字**：要用运行时的**零凭据自证原语**去问它，而不是复述我们写了什么。
（pi 有 `get_commands`/`get_state`；dsh 有 `--dump-config`。两个都不需要网络与密钥。）

## 六、`run.mjs` 的对外形状（让上层工具跨运行时统一）

```js
export const HARNESS_ID = "…";
export function digestOfRender(renderDir) { /* 从渲染清单算 §6.7 摘要 */ }
export function stageRenderDir(renderDir) { /* 暂存可写副本；返回 {staging, …, placeholders} */ }
export function localInvocation({ … }) { /* 返回 {bin, args}：该运行时的启动参数形态 */ }
export async function runAgent({ renderDir, endpoint, prompt, timeoutMs }) {
  /* 返回 {exitCode, stdout, stderr, events(统一轨迹), native, staging, placeholders} */
}
```

有了这一层，`tools/probe.mjs` / `tools/smoke.mjs` / `tools/run-local.mjs` **不必认识任何运行时**，
`--harness` 一路分派下去即可。

**两条必须遵守的运行期契约**（都是实测踩出来的）：

1. **暂存可写副本 + 中立 HOME/cwd** —— 两个运行时都有隐式技能源，配置关不掉，只能靠隔离。
   产物里写的是**镜像内固定路径**，暂存时改写成暂存路径（**只改副本**）。
2. **关掉子进程 stdin** —— 不关的话运行时会**等输入**，表现为"零输出零事件"，
   看起来像扩展没加载，极难排查。另外：无人值守运行必须**显式给放行策略** ——
   审批在无应答者时是 fail closed（**等人**，不是报错）。

## 七、四个"别自己另发明一套"的契约

这几条都是踩过坑后定下的；新适配器照做即可：

| 契约 | 为什么 |
|---|---|
| 渲染器在清单里声明 **`expresses`**（定义字段 → 产物位置） | C3 只验声明。**认死文件名等于把第一个运行时的形状当成契约** |
| 增强的**声明形态由适配器给**（`enhancementShape`） | 用例助手据此写声明；否则第二个运行时永远过不了 C4 |
| 静默失败用例**声明式注入**（`inject: {file: glob, append: 文本}`） | 检查侧只执行，不把某个运行时的产物路径写死进检查代码 |
| 清单里声明 **`skillsInProduct`** | 上层工具不必知道目录形状（pi 在 `agent-dir/` 下，dsh 在根） |

一句话总结这四条：**位置与形态的知识归适配器，检查只做"按声明验证"。**

## 八、接一个新运行时的顺序

1. **预检**：搞清楚它的零凭据自证原语、产物形态、运行期契约、隐式副作用。**别猜** ——
   猜错的代价是后面全部返工（本项目在 dsh 上就撞过一次：模板选错，`web` 把工具/技能行全禁用了）
2. 写 `adapter.yaml`：先填能力声明，**每条 note 标依据**（实测/文档/待实测）
3. 写 `render.mjs`：产出完整 config（**不做增量假设** —— 有的运行时的 config 是整体替换不是深合并）
4. 写 `doctor.mjs`：用自证原语，配三条硬断言
5. 写 `trace.mjs` + 样本：**一对一是硬约束**（输入多少条就输出多少条，不许丢；
   没对应类型的进 `native.raw` 且 `reason` 必须自足）
6. 写 `run.mjs`：运行器
7. 写 `failures.md` + `failure-cases.yaml`：**每条静默失败配一个可执行用例**
8. 写 `exemptions.yaml`：**做不到等价的地方一条条写出来**
9. 跑到 `conformance` 十项全绿

## 九、诚实说明：本项目的两个运行时都还没做到的部分

| 项 | 状态 |
|---|---|
| pi 的 `enhancements[]` 口径 | 目前是「**已进入产物**」而非「**已加载**」—— 离真正的加载还差一步（pi 约束 7：扩展入参未校验）。缺口记在 `adapters/pi/failures.md` F6 |
| dsh 的 `model.reasoningEffort` | **尚未映射**（provider 条目的 `reasoningEfforts` 取值形状未实测）。渲染器声明为豁免并写明理由，不猜形状 |
| dsh 的技能集合口径 | 只能给「已在 `customSkillDirs` 配置且 `SKILL.md` 就位」，拿不到「已被发现」；口径弱于 pi，已在 `exemptions.yaml` 标注 |

**这三条的写法就是本项目的标准做法**：做不到就说清楚做不到，写成机器可读的豁免，
而不是把"我们声明了"当成"它生效了"。
