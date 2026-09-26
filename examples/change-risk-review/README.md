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

**在这个目录里开发** —— 每个示例自带 Makefile，不用回仓库根：

```bash
cd examples/change-risk-review
```

### 开发循环：改 → 查 → 跑 → 验

```bash
# ① 改完立刻查：秒级，不用网络、不用密钥（定义/引用/分层/增强声明都查）
make validate
#   期望：闸门 1：全绿，末尾没有 ❌（写错的地方会点名字段；**不写死项数**，免得数字一漂就过期）

# ② 真跑一次
make run-local ENDPOINT=<端点> API_KEY=<密钥> PROMPT="复核这次变更的风险，给出可复算的评分"
#   期望：一份可复算、可审计的风险分数（业务工具给出的确定值，不是模型编的）；退出码 0

# ③ 四道闸门 → 给一个「可用 / 不可用」的结论
make verify
#   期望：✅ 可用：四道闸门全过（§6.8）
#   闸门 3/4 默认走基座自带的**零凭据假网关**，不需要任何密钥
```

### 端点与密钥怎么给（三选一）

```bash
# ① 命令行（临时用）
make run-local ENDPOINT=<端点> API_KEY=<密钥> PROMPT="…"

# ② 放这个目录下的 .env（之后不用再敲；**真实环境变量优先于它**）
printf 'CORP_GATEWAY_BASE_URL=<端点>\nCORP_GATEWAY_API_KEY=<密钥>\n' > .env
make run-local PROMPT="…"

# ③ 凭据目录（CI / 生产）：AGENT_SECRETS_DIR=/dir，读 /dir/<参数名>
```

本示例的参数名：`ENDPOINT` → `CORP_GATEWAY_BASE_URL`；密钥 → `CORP_GATEWAY_API_KEY`

### 不知道有哪些模型可用

```bash
make providers-init ENDPOINT=<端点> API_KEY=<密钥> 
#   期望：打印该端点的模型名单，并写成 ./providers.yaml
#   这个文件会被自动采用；`agent.yaml` 里的 model.name 写错了，闸门 1 当场拦住
```

### 换一个运行时再验一次 / 看等价性

```bash
make verify HARNESS=dsh     # 期望：同样「可用：四道闸门全过」
make compare                # 期望：等价性通过（差异必须有声明，不许沉默）
```

### 零凭据地只看链路与边界

```bash
make probe    # 闸门 3：模型可达、工具字段没被吞、流式没被降级
make smoke    # 闸门 4：真的干活、且没越界用工具
```

### 四道闸门分别在证明什么

| 闸门 | 证明什么 | 本示例的看点 |
|---|---|---|
| 1 静态 | 定义合法、引用与分层合规 | 技能名与目录一致、模型名在该供应商名单内、增强声明合法 |
| 2 解析自证 | 运行时**实际加载**到的东西与声明一致 | 技能/增强真的进了产物（不是写在定义里就算） |
| 3 集成探针 | 模型可达、工具字段在、流式没降级 | 闸门 2 的硬断言：`resolution/enhancements-set 集合相等（2 项）`；`make smoke` 的看点是业务工具**真的被调用** |
| 4 端到端冒烟 | 它真的能干活、且没越界用工具 | 被禁的工具不会出现在冒烟轨迹里（边界是**实测**的，不是约定的） |

它有**业务级增强**（`harness/`）：一个真的会调用的风险评分工具 + 两侧各自的接入件


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
