# 能力描述契约（提案 · 未实现）

> 状态：**提案**（2026-09-27 起草）。它**改动公开契约**（描述文件形状、接入方式），
> 所以先评审再动手 —— 与路线图 §22 的"先把契约定清楚，比先写桥再改契约便宜"一致。
> 本文只描述契约与判据，**不含实现**；落地项是路线图 §22 的三条（D-0012 / D-0013）。
>
> 关联：`docs/status/DECISIONS.md` 的 **D-0012**（多语言共享）与 **D-0013**（接入件上收为通用桥）。

---

## 1. 现在是什么样（证据）

以 `examples/change-risk-review` 为例，一个业务能力（企业风险评分）今天要写 **5 个文件**：

| 文件 | 角色 | 问题 |
|---|---|---|
| `harness/shared/risk-score.mjs` | 业务规则 + **工具描述**（`TOOL` 导出：name/label/description/parameters…） | **描述嵌在 JS 里** ⇒ 业务语言被绑死在 JS |
| `harness/pi/extensions/risk-score.ts` | pi 接入件：`pi.registerTool({...})` | 每个能力一份，形如胶水 |
| `harness/dsh/risk-score.js` | dsh 接入件：cordis 插件 + `ctx.tools.register()` + 参数 DSL 转换 | 同上，**且要自己写 JSON Schema→DSL 的转换** |
| `harness/pi/enhancements.yaml` | pi 侧声明（`kind: tool` + `entry`） | 声明面，保留 |
| `harness/dsh/enhancements.yaml` | dsh 侧声明（`kind: tool` + `package`） | 声明面，保留 |

**已经做对的部分**（这条契约要保住）：业务规则与接入分离 —— 两个接入件 import **同一份**
`business/risk-score.mjs`（渲染器拷进产物），接入件里没有任何业务规则。

**真正的问题**有两条，正好对应 D-0012 与 D-0013：

1. **共享只在 JavaScript 世界里成立**：`harness/shared/*.mjs` 由接入件以 ESM `import` ——
   业务团队若用 Python/Go/Java 写规则，这条"可共享"立刻不成立。
2. **每个新增能力都要写两份接入件**：pi 的注册形状与 dsh 的注册形状**不同**（后者还要做参数 DSL 转换），
   接入件里没有任何业务知识，纯粹是"把同一份描述翻译成两个运行时的形状"。

---

## 2. 契约：三件套

| # | 产物 | 形态 | 谁拥有 |
|---|---|---|---|
| ① | **能力描述** | 语言无关的声明文件（一份） | 业务团队 |
| ② | **可执行体** | **任意语言**：一个可执行入口（脚本/二进制），按**进程边界协议**调用 | 业务团队 |
| ③ | **桥** | 每个运行时一个，**基座不变量**（进 `adapters/<h>/seed/`，受闸门 2 的集合断言约束） | 基座 |

桥的职责只有一件：**读描述 → 按本运行时的形状注册工具 → 调用时把入参交给可执行体、把结果翻译回来**。
桥里**不许**出现任何具体能力的名字（否则它就不是通用桥）。

于是新增一个业务能力的成本（D-0013 的判据）变成：**加一份描述 + 加一份实现，不加接入件**。

---

## 3. 描述契约

位置：`harness/shared/capabilities/<name>.yaml`（与实现同目录，便于一起被拷进产物）。

```yaml
# harness/shared/capabilities/corp-risk-score.yaml —— 提议形状（未实现）
apiVersion: agent-base/v1
name: corp_risk_score                 # 工具名（进模型可见的工具表；下划线风格）
label: 企业风险评分                     # 给人看的短名
description: >                        # 进模型提示；写清"何时用、何时别用"
  用企业风险规则给一次变更打分（确定性、可复算）。
  关键事实不全时会拒答并列出缺什么 —— 不要用你自己的判断补上再调用。
promptSnippet: corp_risk_score：按企业规则给变更打分（确定性、可审计）

parameters:                           # JSON Schema（语言无关的唯一描述）
  type: object
  additionalProperties: false
  properties:
    touchedSurfaces: { type: array, items: { type: string }, description: 这次变更影响的面 }
    environments: { type: array, items: { type: string }, description: 执行环境 }
    dataMigration: { type: boolean }
    rollback: { type: string, enum: [none, scripted, feature-flag] }
    window: { type: string, enum: [off-peak, peak] }
    owner: { type: string }
  required: [touchedSurfaces, environments]

result:                               # 结果契约（闸门 4 用它断言"返回形状没变"）
  type: object
  required: [score, level, factors, ruleVersion]

execution:                            # 可执行体：怎么跑
  kind: process                       # 本期只有 process（进程边界）
  runtime: node                       # node | python | shell …（决定镜像里要有什么）
  entry: risk-score.py                # 相对本目录
  timeoutMs: 5000                     # 超时即失败（不静默降级）

declaration:                          # 契约自陈（闸门 1 校验）
  deterministic: true                 # 同入参同结果：不随机、不读时钟、不访问网络
  sideEffects: none                   # none | reads-files | writes-files | network
  version: "2026-09-1"                # 规则版本；改权重/阈值就要改它
```

**校验规则**（进闸门 1 的 schema，与现有 `enhancements.schema.json` 同级）：
`name` 形状与唯一性（同名两份描述 ⇒ 红）、`parameters`/`result` 必须是合法 JSON Schema、
`execution.entry` 必须存在且可执行、`runtime` 必须在镜像预装清单里有对应物、
`deterministic: false` 时**必须**在描述里说明可复现手段（否则闸门 3 的复算断言不成立）。

---

## 4. 进程边界协议

```
<可执行体>  --params <临时文件路径>        # 或 stdin（二选一，本期只做 stdin 更简单）
```
- **入参**：stdin 一行 JSON（工具入参原样），UTF-8，无 BOM。
- **出参**：stdout 一行 JSON：`{ "text": "<给模型看的文本>", "details": { …结构化结果… } }`；
  `text` 必填，`details` 可选（闸门 4 按 `result` 契约校验 `details`）。
- **拒答**（业务主动拒绝）：`{ "refused": true, "text": "拒答：…", "details": { "missing": [...] } }`
  —— 与今天 `run()` 的语义一致。
- **退出码**：`0` 正常（哪怕 `refused: true`）· `2` 输入不合契约 · 其他非零 = 执行失败
  （桥把它变成工具错误，**不静默吞掉**）。
- **stderr**：只放诊断，桥原样透到轨迹的 `native.raw`（不解析）。
- **超时**：描述里的 `timeoutMs`，超时即失败并写一条 `tool.result ok:false`。

**为什么用进程边界**：语言自由 + 崩溃隔离（业务段错误不会带走智能体进程）+ 不需要为每种语言写桥。
代价是每次调用一个进程（见 §7 分叉 A）。

---

## 5. 落地形态

- 渲染器把 `harness/shared/` 整棵拷进产物（今天已经在拷 `shared/` → `business/`），并生成一份
  **能力清单**进 `render-manifest.json`：`capabilities: [{name, runtime, deterministic, descriptionPath}]`。
- 桥作为**基座不变量**进 `adapters/<h>/seed/`（pi：扩展；dsh：cordis 插件 + insert row），
  它在**加载期**读清单、逐个注册工具。因此闸门 2 的集合断言天然覆盖桥本身。
- 两个运行时的 `enhancements.yaml` 里**不再出现每个业务能力的条目**；
  业务能力的存在由**清单**表达（闸门 2 增加一条：清单里的能力数 == 桥注册出的工具数）。

---

## 6. 判据（什么算做完）

| 闸门 | 断言 |
|---|---|
| 1 | 描述文件过 schema；同名不重复；`execution.entry` 存在；`runtime` 在镜像预装清单里；`deterministic: false` 必须给可复现手段 |
| 2 | 桥已加载（基座不变量集合断言）+ **注册出的工具名集合 == 清单里的能力名集合** |
| 3 | 端点侧看到的工具数 = 基线 + 能力数；工具名与描述里的 `name` 一致 |
| 4 | 真调一次：`details` 过 `result` 契约；**同入参两次结果一致**（`deterministic: true` 时）；拒答路径返回 `refused: true` 且**不猜** |
| 自检 | ① 同一份描述在两个运行时上注册出的工具名/参数 schema **一致**（桥的正确性）② 描述与可执行体不一致（改了描述没改实现）能被发现 ③ 桥里不出现任何具体能力名（静态断言，防它退化成"每能力一份桥"） |

---

## 7. 两个必须先拍的分叉（公开契约 + 性能取舍）

### 分叉 A：JS 业务走进程内还是统一走进程边界？

| 选项 | 好处 | 代价 |
|---|---|---|
| **A1 统一进程边界**（所有能力都走 §4 协议） | 语义只有一条、实现只有一条、没有"两种行为" | 每次工具调用起一个进程：**本地迭代变慢**（今天 `make local` 的"快"是卖点之一） |
| **A2 双通道**（JS/TS 走进程内 `import`；其他语言走边界） | 保持本地迭代速度；JS 业务零额外机制 | **两套语义**（进程内异常 vs 边界退出码、异步 vs 同步）⇒ 必须有"进程内/外语义一致"的自检（D-0012 的判据本来就要求它） |
| **A3 先只做边界，JS 以后再说** | 契约最小、评审面最小 | 现有 `change-risk-review` 要迁移两次 |

> 我的倾向：**A2**（保住开发速度，用自检守语义一致）—— 但这条要你拍，因为它决定"业务代码的默认写法"。

### 分叉 B：非 JS 语言的运行时从哪来？

| 选项 | 好处 | 代价 |
|---|---|---|
| **B1 镜像预装 Node + Python** | 覆盖绝大多数"业务规则/评分/清洗"场景；契约立刻可用 | 镜像变大、构建变慢；要进 `preinstall.yaml` + 双架构可得 + 离线可用（**已有一条自检在管预装集**） |
| **B2 由能力包按需提供**（与 L4 联动） | 镜像默认保持精简；语言运行时是"包"的一种 | **依赖 L4**（你已把能力包定为"择机"）⇒ 会把这条线也拖住 |
| **B3 不做语言运行时**：只定义边界协议，可执行体由业务自备（宿主/容器内已有） | 零镜像成本 | "两边都能跑"退化成"看你怎么准备环境"；与"本地/容器结论一致"的纪律冲突 |

> 我的倾向：**B1**（先 Python 一门语言，验证契约；Go/Java 等出现真实需求再加），因为它**不依赖 L4**。

---

## 8. 迁移路径（路线图 §22 的三条）

1. **契约 + 桥**（D-0012/D-0013）：先按选定的 A/B 选项实现 **一门非 JS 语言**（Python）的
   "描述 + 实现 + 桥"，并写自检证明"零胶水注册"。
2. **迁移 `change-risk-review`**：改为"描述 + 实现"，删掉两份手写接入件；断言**工具数不变**、
   两侧仍可用、README 说明更新。
3. **回归口径**：`make regression` 全绿（含新增的能力契约自检）+ 两侧 conformance。

---

## 9. 明确不做（避免范围蔓延）

- **不做跨进程流式输出**（本期只要"一次调用一个结果"；流式是运行时的事，不是业务能力的事）。
- **不做能力市场的分发/签名**（那是 L4 与交付链路的事）。
- **不改中性定义**：能力仍然由 harness 层声明（`harness/<h>/` 或清单），中性定义只说"用哪些工具"。
- **不承诺语言运行时的版本矩阵**：本期只承诺"镜像里预装的那一个版本"，写在 `preinstall.lock.txt` 里。

---

## 10. 需要拍板的点（评审时逐个定）

1. **分叉 A**：A1 统一边界 / **A2 双通道**（倾向）/ A3 先边界后 JS。
2. **分叉 B**：**B1 镜像预装 Node+Python**（倾向）/ B2 靠 L4 能力包 / B3 不做。
3. **描述文件的位置与名字**：`harness/shared/capabilities/<name>.yaml` 是否合适；
   要不要允许把描述与实现放在 `skills/<name>/` 旁边（技能已经是天然的能力容器）。
4. **`result` 契约的严格度**：闸门 4 按 `result` 校验 `details` 到什么程度（只校验必填键，还是递归校验类型）。
5. **拒答的语义**：`refused: true` 是否也要在轨迹里成为一等信号（便于审计"业务主动拒答"而非模型放弃）。
