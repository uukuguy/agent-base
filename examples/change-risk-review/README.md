# change-risk-review · 变更风险复核（**业务级增强**示例）

这个示例回答一个问题：**中性定义管不到的业务能力，怎么加、怎么证明它真的加上了？**

| 其它示例的形态 | 本示例的形态 |
|---|---|
| 能力全部来自中性定义（技能 / 连接器） | 中性定义只说"用风险评分工具"，**工具由 harness 层增强提供** |

## 它解决什么问题

复核一次变更（发布、配置调整、数据迁移、依赖升级）的风险。风险分数必须来自**企业规则评分工具**
`corp_risk_score` —— 确定性、可复算、可审计。智能体**不许自己心算分数**，关键事实不全时**不许**算分。

## 结构

| 文件 | 干什么 |
|---|---|
| `agent.yaml` | 中性定义：人设、模型、只读边界（`tools.deny: [bash, write, edit]`） |
| `connectors.yaml` | 空 —— 业务能力**不来自** MCP 连接器，而来自 harness 层增强 |
| `harness/pi/enhancements.yaml` | **业务级增强声明**：声明"本运行时提供 `corp_risk_score` 工具" |
| `harness/pi/extensions/risk-score.ts` | **增强的实现**：`pi.registerTool()` 注册的业务工具（零依赖、确定性规则） |
| `skills/risk-factor-checklist/SKILL.md` | 算分之前必须问清的五类事实；缺事实时怎么答 |
| `skills/score-interpretation/SKILL.md` | 分数怎么读、因素必须原样引用、三句不许说的话 |
| `trace-labels.yaml` | 业务给轨迹起的说法（含业务工具 `tool:corp_risk_score`） |
| `Makefile` | 薄转发层 |

`harness/<运行时>/` 的存在意味着**可移植性降到"核心 + 某运行时增强"** —— 闸门 1 会把这一点显式打出来，
不假装它和纯中性定义一样可移植。

## 构建与验证过程

在**仓库根**执行：

```bash
# ① 静态校验：定义、技能、**增强声明**（单一真源、不许重复表达中性定义字段）
node tools/validate.mjs examples/change-risk-review
#   期望：闸门 1：全绿（39 项检查）
#   其中两条专盯本示例：
#     ✅ enhance/single-source  业务级增强没有重复表达中性定义字段
#     ✅ portability/report     本智能体可移植性：核心 + pi 增强（不可移植）

# ② 渲染：确认扩展**进了产物**并被登记
node adapters/pi/render.mjs examples/change-risk-review --out /tmp/crr
node -e 'const s=require("/tmp/crr/agent-dir/settings.json");console.log(s.extensions)'
#   期望：["extensions/risk-score.ts","extensions/trace.ts"]
#   注意：extensions/ 目录里的**每个文件**都会被登记为扩展（只有基座发射器 _trace-emit.mjs 被排除）
#   —— 别把帮助函数丢进这个目录

# ③ 四道闸门（闸门 2 会**实测**扩展真的被加载）
node tools/verify.mjs examples/change-risk-review --harness pi
#   期望：✅ 可用：四道闸门全过
#   其中闸门 2 的硬断言：✅ resolution/enhancements-set  集合相等（2 项）

# ④ 另一侧：dsh 上仍然可用（本示例没有给 dsh 写增强，它照常跑）
node tools/verify.mjs examples/change-risk-review --harness dsh
#   期望：✅ 可用：四道闸门全过

# ⑤ 等价性：中性定义层两侧一致，差异必须有声明
node tools/compare.mjs examples/change-risk-review
#   期望：✅ 等价性通过

# ⑥ 全部示例一起跑（结构 + README + 两个运行时 + 等价性 + 技能脚本）
make examples-check
```

## 实测证据（这个示例的意义就在这里）

**业务工具真的发给了模型** —— 端点侧观测到的工具数：

| 场景 | 端点收到的工具数 |
|---|---|
| 同一份定义，**去掉** `harness/` 增强 | **3** |
| 带 `corp_risk_score` 业务增强 | **4** |

复现方法（两步对照）：

```bash
B=$(mktemp -d); cp -r examples/change-risk-review/* $B/; rm -rf $B/harness
node tools/verify.mjs $B --harness pi                          # → tools=3
node tools/verify.mjs examples/change-risk-review --harness pi  # → tools=4
```

**增强真的被加载**：闸门 2 的硬断言「已加载扩展 id 集合 == 声明集合」给出 `集合相等（2 项）`
（`trace` 基座不变量 + `corp-risk-score` 业务增强）。

## 改它（加一个业务增强要动什么）

```
1. harness/<运行时>/extensions/<你的工具>.ts   ← 实现：export default function (pi) { pi.registerTool({...}) }
2. harness/<运行时>/enhancements.yaml          ← 声明：id / kind / entry / description（**不许**重复中性定义字段）
3. 跑 make validate + node tools/verify.mjs <目录> --harness <运行时>
```

工具实现的契约（照 `risk-score.ts` 抄）：

- `export default function (pi) { … }`，用 `pi.registerTool({ name, label, description, parameters, execute })` 注册
- `parameters` 用**普通 JSON Schema 对象**即可（运行时只要求它是个对象）——**零依赖**，不需要 TypeScript 类型导入
- `execute` 返回 `{ content: [{ type: "text", text }], details }`
- 扩展是 TypeScript，但由运行时用 jiti 直接加载，**没有编译步骤**

## 别的运行时的增强长什么样（本示例没做，但形态要知道）

| 运行时 | 增强形态 | 本示例的做法 |
|---|---|---|
| pi | TypeScript 扩展（`pi.registerTool()` / `pi.on()`） | 本示例实现了 |
| dsh | **cordis 插件 npm 包** + patch 里的 insert row（`{ id, package, config }`） | 未实现：需要一个真实可用的 npm 包，示例不编造不存在的东西 |

所以本示例在 dsh 上"没有业务工具"是**如实的结果**，不是静默忽略：`compare` 与可移植性报告都把它显式说出来。

## 已知边界

- `dsh` 侧没有等价实现（见上表）：跨运行时**不是处处等价**，本示例不假装它等价。
- 闸门 2 的"已加载"目前能证明的是"声明的 entry 文件进了产物并被登记"，
  **不等于**运行时内部真的执行了它（这一点基座自己的文档里也如实标着待补，见 failures 的 F6）。
  本示例的加强证据是**闸门 3 的工具数**：4 > 3，说明工具确实发给了模型。
- 评分规则是示例用的**简化规则**（权重表 + 规则版本），不是任何企业的真实风控规则。
- 闸门 3/4 默认走零凭据假网关；要"真的能用"的证据加 `LIVE=1`。
