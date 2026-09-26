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
| `harness/shared/risk-score.mjs` | **业务代码（可共享）**：评分规则、工具描述与参数、拒答条件。零依赖、确定性 |
| `harness/pi/enhancements.yaml` · `harness/pi/extensions/risk-score.ts` | **pi 的接入方式**：`pi.registerTool()` 把共享业务包成工具 |
| `harness/dsh/enhancements.yaml` · `harness/dsh/risk-score.js` | **dsh 的接入方式**：cordis 插件 + `ctx.tools.register()`（零依赖接入） |
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

**业务工具真的发给了模型 —— 两个运行时都是**（端点侧观测到的工具数）：

| 运行时 | 去掉 `harness/` 增强 | 带 `corp_risk_score` 增强 |
|---|---|---|
| pi | **3** | **4** |
| dsh | **19** | **20** |

复现方法（两步对照，两个运行时各一遍）：

```bash
B=$(mktemp -d); cp -r examples/change-risk-review/* $B/; rm -rf $B/harness
node tools/verify.mjs $B --harness pi     # → tools=3      node tools/verify.mjs $B --harness dsh    # → tools=19
node tools/verify.mjs examples/change-risk-review --harness pi   # → tools=4
node tools/verify.mjs examples/change-risk-review --harness dsh  # → tools=20
```

**业务代码是同一份**：两侧的接入件都 import 产物里的 business/risk-score.mjs
（渲染器把 `harness/shared/` 拷进产物：pi 落在 agent-dir/business/，dsh 落在 产物/harness/business/，
所以两端接入件用的是**同一个相对路径** ../business/risk-score.mjs）。

**接入件只做三件事**：把业务参数形状翻译成该运行时的参数 DSL、注册工具、转发结果。
**一行业务规则都不该出现在接入件里** —— 这条由闸门 1 的 `enhance/shared-agnostic` 兜住：
`harness/shared/` 里的代码一旦 import 运行时包或调用运行时 API，当场变红。

**增强真的被加载**：闸门 2 的硬断言「已加载扩展 id 集合 == 声明集合」给出 `集合相等（2 项）`
（`trace` 基座不变量 + `corp-risk-score` 业务增强）。

## 改它（加一个业务增强要动什么）

```
harness/shared/<业务>.mjs          ← ① 业务代码：规则/参数/拒答条件。零依赖，不碰任何运行时
harness/<运行时>/enhancements.yaml ← ② 声明：id / kind / entry 或 package / description
harness/<运行时>/extensions|插件…  ← ③ 接入件：只做「翻译形状 + 注册 + 转发」
```

### ① 业务代码（`harness/shared/`）

纯 ESM、**零依赖**，只用语言本身。导出三样东西就够了：工具描述与参数（`TOOL`）、
纯函数规则（`score`）、统一执行语义（`run` → `{ text, details }`）。
约束：**不许出现任何运行时的名字/API**（闸门 1 会扫代码，注释里提到不算）。

### ② 声明

| 运行时 | 关键字段 | 说明 |
|---|---|---|
| pi | `entry: extensions/<文件>.ts` | 相对产物 agent 目录 |
| dsh | `package: ../../../harness/dsh/<文件>.js` | 相对**profile 配置目录**（三层 `..` 才回到产物根） |

### ③ 接入件（两边的差异只在这里）

| | pi | dsh |
|---|---|---|
| 模块契约 | `export default function (pi) { … }` | `export { apply, inject, name }`，`inject = ["tools"]` |
| 注册 | `pi.registerTool({ name, label, description, parameters, execute })` | `ctx.tools.register({ name, description, parameters, output, execute })` |
| 参数 | **普通 JSON Schema 对象**即可 | 该运行时的参数 DSL（`{ key: { type, required } }`）+ `output.schema` / `output.render` |
| 结果 | `{ content: [{ type: "text", text }], details }` | 返回值即结果；`output.render` 返回 `[{ type: "text", text }]` |
| 加载方式 | TypeScript，运行时用 jiti 直接加载，**无编译步骤** | JS 模块，按相对路径 import |

## 两个踩过的坑（写接入件时会遇到）

1. **接入件里不要 import 运行时的 SDK**。dsh 侧最初写 `import { defineTool } from "@deepseek-ai/dsh-tools"`，
   运行期直接 `failed to import`：接入件位于**产物**里，不在该运行时的 `node_modules` 之下，裸导入解析不到。
   两条路——把 SDK 接进产物（产物就不自足了）、或按注册接口要求的最少形状自己写（本示例选的）。
2. **产物要声明把接入件拷进运行目录**。dsh 的 `runtimePlan.copy` 原先只有 `dsh-home/workspace/skills`，
   插件没被拷过去 ⇒ 同样是 `failed to import`（报错只给文件名，很容易误判成代码写错）。

## 已知边界

- `dsh` 侧没有等价实现（见上表）：跨运行时**不是处处等价**，本示例不假装它等价。
- 闸门 2 的"已加载"目前能证明的是"声明的 entry 文件进了产物并被登记"，
  **不等于**运行时内部真的执行了它（这一点基座自己的文档里也如实标着待补，见 failures 的 F6）。
  本示例的加强证据是**闸门 3 的工具数**：4 > 3，说明工具确实发给了模型。
- 评分规则是示例用的**简化规则**（权重表 + 规则版本），不是任何企业的真实风控规则。
- 闸门 3/4 默认走零凭据假网关；要"真的能用"的证据加 `LIVE=1`。
