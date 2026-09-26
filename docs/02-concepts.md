# 02 · 概念：四个业务概念与两个运行时的对应

你只写四件事：**它是谁、用哪个模型、它会什么、它能连什么**。这一篇讲这四件事在中性定义里长什么样，
以及它们**在两个运行时里分别变成了什么**。

## 一、四个概念

| 概念 | 中性定义字段 | 含义 |
|---|---|---|
| **它是谁** | `agent.yaml` → `persona.instructions` | 人设与边界。写得越具体，行为越可预测 |
| **用哪个模型** | `agent.yaml` → `model.{provider,name,reasoningEffort}` | `provider` = **供应商名**（`deepseek` / `openai` / 内部网关 …，不是 URL；旧名 `route` 等价）；`name` = **默认模型名**（属环境属性，运行期可用 `<PROVIDER>_MODEL` 覆盖） |

**"有哪些模型可用"看 provider 目录** —— 基座**内置**常用供应商（`core/catalog/providers.yaml`：
`deepseek` / `openai` / `corp-gateway`），所以只写名字就能用；
要改端点/模型名单，写自己的 `providers.yaml`（放智能体旁边，或 `AGENT_PROVIDERS_FILE` 指过去），
同名条目**按字段合并**覆盖。
名单别靠记：`make providers-init ENDPOINT=<baseUrl>` 会问端点 `GET <baseUrl>/models`，把实测结果写成目录。
| **它会什么** | `skills/<名字>/SKILL.md`（+ 可选 `scripts/`） | 技能；技能可以带业务代码，只进智能体镜像 |
| **它能连什么** | `connectors.yaml` → `mcpServers[]` | MCP 连接器。推荐按名引用基座预装条目 |

外加两个可选项：

- **边界**：`agent.yaml` → `tools.deny: [bash, write]`
- **业务标签**：`trace-labels.yaml` —— 业务给机械轨迹起的说法（基座**不解释**这些词，只机械查找后呈现）

## 二、同一份定义，两个运行时（这是本项目的核心表）

| 概念 | 中性定义 | **pi** 里变成什么 | **dsh** 里变成什么 |
|---|---|---|---|
| 人设 | `persona.instructions` | `agent-dir/AGENTS.md` | `workspace/AGENTS.md` —— 该运行时的 `agent-instructions` 是"**工作区指令文件发现器**"，会去读工作区的 `AGENTS.md`/`CLAUDE.md`，所以人设必须落在**工作区**，不是某个配置字符串 |
| 模型选择 | `model.provider` / `model.name` | `models.json.tmpl`（启动期渲染）+ `settings.json` 的 `defaultProvider`/`defaultModel` | patch 里的 `agent-default-model` + **provider 声明**（`llm-pi-ai` 的 `providers` 字典：`api`/`baseURL`/`apiKeyEnv`/`models`） |
| 技能 | `skills/<名字>/` | `agent-dir/skills/` + 运行参数 `--skill <目录>` | `skill-filesystem.customSkillDirs`（指向**镜像内固定路径**）+ 启用 `tool-skill` |
| 连接器 | `connectors.yaml` | **原生没有，靠基座种子扩展补上**（`pi-mcp-adapter`，构建期装好）→ 渲染成 `agent-dir/mcp.json` + `settings.json` 的 `packages` 声明 | 原生支持：每服务器 `insert` 一条 `@deepseek-ai/dsh-mcp-client` row（`serverName`/`transport`/`command` 或 `url`） |
| 工具边界 | `tools.deny` | 运行参数 `--exclude-tools`（**手工直接启动会绕过**，闸门 4 会抓） | 禁用对应的 tool row。⚠️ **粒度更粗**：`read`/`write`/`edit` 是**同一个** `tool-fs` row，禁一个等于禁三个 |
| 端点/凭据 | 只写引用名 | `${PREFIX}_BASE_URL` / `${PREFIX}_API_KEY`，在**启动期**渲染进 `models.json` | `!!js process.env.<引用名>`（在 profile 里就是表达式） |
| 轨迹 | —（自动） | **回调式**（订阅 loop 回调，能拿到实际发出的请求体）+ 事后映射兜底 | **`--json` 的 run events**（带 `callId`，可直接配对） |
| 业务级增强 | `harness/<运行时>/` | TypeScript 扩展文件 + 登记到 `settings.extensions` | cordis 插件 npm 包 + `insert` row |
| 隔离手段 | —（自动） | 临时 `HOME` + 中立 cwd + `--no-skills` | 临时 `DSH_HOME` + 中立 cwd |

**为什么两边不一样**：这是**必然**的 —— 两个运行时的原生机制根本不同（一个是扩展文件，一个是
插件包）。项目的承诺不是"机制一样"，而是**「同一份定义两边都能渲染并跑通」**，且**做不到等价的地方
必须显式写出来**（`adapters/<h>/exemptions.yaml`），不允许沉默地不一样。

## 二之二、能用哪些模型（provider 与协议形状）

**"用哪家的模型"由 `model.provider` 决定**，基座内置了常用供应商（`core/catalog/providers.yaml`），
所以多数情况只写名字即可。要接别的家，就在自己的 `providers.yaml` 里加一条 —— 关键字段是 `api`
（**协议形状**，不是模型名）。

**两个运行时可用的协议形状**（各自包内实测得出，声明在 `adapters/<h>/adapter.yaml` 的 `capabilities.modelApis`）：

| 协议形状 `api:` | pi | dsh |
|---|---|---|
| `openai-completions`（绝大多数 OpenAI 兼容端点：DeepSeek、vLLM、内网网关…） | ✅ | ✅ |
| `openai-responses` | ✅ | ✅ |
| `anthropic-messages` | ✅ | ✅ |
| `azure-openai-responses` | ✅ | ✅ |
| `bedrock-converse-stream` | ✅ | ✅ |
| `google-generative-ai` | ✅ | ❌ |
| `google-vertex` | ✅ | ❌ |

> 最后两行是**真实差异**：pi 认 Google 的形状，dsh 的 pi-ai 适配器不认。
> 闸门 1 会拦住"只有某一个运行时支持的形状"（`providers/model-api`）——
> 因为中性定义承诺的是**两个运行时都能跑**；真要用 Google，就用 pi 跑并单独说明。

**内置了哪些**（`core/catalog/providers.yaml`，写名字即用）：

| provider | 说明 | 密钥 |
|---|---|---|
| `ollama` / `vllm` / `local` | 本地模型服务（无需密钥） | — |
| `deepseek` | DeepSeek 开放平台 | `DEEPSEEK_API_KEY` |
| `openai` | OpenAI | `OPENAI_API_KEY` |
| `openai-codex` | OpenAI 订阅（**只有 pi**，登录一次免密钥） | 走 pi 凭据库 |
| `anthropic` | Claude（原生 Messages 协议） | `ANTHROPIC_API_KEY` |
| `minimax` / `minimax-cn` | MiniMax（国际 / 国内） | `MINIMAX_API_KEY` / `MINIMAX_CN_API_KEY` |
| `glm` / `glm-cn` | GLM 智谱（国际 api.z.ai / 国内 open.bigmodel.cn） | `ZAI_API_KEY` |
| `kimi` / `kimi-cn` | Kimi（国际 / 国内） | `MOONSHOT_API_KEY` |
| `corp-gateway` | 内网网关（自带假网关是它的零凭据等价物） | `CORP_GATEWAY_API_KEY` |

**作用域**：`harnesses: [pi]` 表示只有该运行时能用 —— 各运行时原生认识的家数不同，**允许不同**。
选了当前运行时不支持的 provider，渲染期直接失败并说明原因。

**凭据三种模式**：`auth: env`（默认，从环境/变量文件读）· `auth: none`（本地服务，不产生凭据参数）
· `auth: native`（**基座不注入密钥**，用运行时自己的凭据库 —— 订阅登录就是这种）。

**加一家（例子）**：

```yaml
# 你的 providers.yaml（放智能体旁边，或 AGENT_PROVIDERS_FILE 指过去）
apiVersion: agent-base/v1
providers:
  - id: my-vendor                 # 智能体里写 model.provider: my-vendor
    api: anthropic-messages       # ← 协议形状，按上表填
    baseUrl: https://api.example.com
    credentialEnv: MY_VENDOR_API_KEY   # 凭据引用名；不写就按 MY_VENDOR_API_KEY 约定
    models: [some-model-a, some-model-b]
```

同名条目**按字段合并**覆盖内置（只想改端点就只写 `baseUrl`）。
`baseUrlParam` 而不是 `baseUrl` 表示"端点由部署期给"（内部网关那种）。

**dsh 侧额外说明**：dsh 自带两个 LLM 适配器 —— `dsh-llm-deepseek`（DeepSeek 原生）与
`dsh-llm-pi-ai`（pi-ai 后端，上表的形状来自它）。基座渲染的是后者，因此**供应商可换**；
DeepSeek 之外的模型走同一个 `providers` 字典。

## 二之三、业务增强：业务代码共享，接入方式按运行时

中性定义只承诺"用什么、边界在哪"；运行时特有的业务能力（自定义工具、钩子）放 **harness 层**：

```
harness/shared/<业务>.mjs           业务代码：零依赖、纯逻辑，**两个运行时共用这一份**
harness/<运行时>/enhancements.yaml  声明：本运行时提供什么（id / kind / entry 或 package）
harness/<运行时>/extensions|插件…   接入件：把业务包成该运行时的形状（翻译 + 注册 + 转发）
```

- **共享部分的边界是可执行的**：闸门 1 的 `enhance/shared-agnostic` 会扫 `harness/shared/` 的**代码**
  （注释不算），出现运行时 SDK 导入或运行时 API 调用就变红 —— "可共享"不是口号。
- **接入方式本来就不同**：一个运行时用 `registerTool()` + JSON Schema 参数，
  另一个用 cordis 插件 + 自己的参数 DSL。差异只应出现在接入件里。
- **可移植性会显式降级**：用了 `harness/<运行时>/` 的智能体，闸门 1 会报
  "核心 + <哪些> 增强（不可移植）"，不假装它和纯中性定义一样。

## 三、行为烤、参数下放

判据一句话：

> 这个字段改了，同一个输入会不会得到不同行为？
> **会** → 烤进制品（构建期渲染）；**不会** → 参数层（运行期注入）。

| 烤进制品 | 参数层（运行期注入） |
|---|---|
| 人设、技能、连接器、工具边界、**选哪家供应商** | **端点**（`<PROVIDER>_BASE_URL`，provider 已给公开端点时不必给）、**凭据**（`<PROVIDER>_API_KEY`）、**模型名**（`<PROVIDER>_MODEL`，默认取定义里的值） |

> **一条判据修正（写下来免得后人再踩）**：早期这里的判据是"改了它会不会改变行为"，于是模型名被归进制品层。
> 那条判据对"环境属性"这一类不适用 —— **端点与模型名在实际部署里是绑在一起的**（内网网关只服务它有的那几个模型，dev/prod 的模型名往往不同），
> 端点既然运行期给，模型名就没有理由烤死。判据已改为：**这个值是不是随部署环境而变**。是 → 参数层；否 → 制品层。
> 「可配置」不等于「随便配」：模型名会按 provider 声明的名单校验，并记进轨迹。

所以你的 `agent.yaml` 里**永远不写 URL 和密钥**，只写引用名：

```yaml
model:
  provider: deepseek          # 供应商名（基座内置；也可用自己的 providers.yaml 覆盖/新增）
  name: corp-think
```

引用名的约定（两个运行时共用，`make validate` 会校验）：

```
<供应商名转大写、非字母数字换下划线>_BASE_URL    端点
<供应商名转大写、非字母数字换下划线>_API_KEY     凭据
```

连接器的凭据同理：`<名字>_(TOKEN|SECRET|KEY|PASSWORD)`。

**为什么这么切**：行为和产物绑在一起，才谈得上"同一份产物在两个环境行为一致"（可复现）；
而端点与密钥是环境属性，写进制品等于把环境焊死在产物里。

## 四、运行时"实际加载了什么"为什么要单独验（闸门 2）

因为**声明**和**生效**之间有一段黑箱，而且它的失效方式是**静默**的：

- pi：有两个**隐式技能源**（`$HOME/.agents/skills` 和沿 cwd 祖先发现的 `.agents/skills`），
  配置键关不掉 —— 不隔离干净就会"技能多出来一个"
- dsh：patch 指向不存在的 row 时**只打警告、退出码 0 继续跑** —— 配置写了没生效，一点提示都没有

所以闸门 2 不问"我们声明了什么"，而是问运行时**自己报告它加载了什么**，然后把两边做集合断言：

| 硬断言 | 内容 |
|---|---|
| 1 | 实际加载的**技能**集合 == 声明集合（多一个也不行） |
| 2 | 实际启用的**连接器**集合 == 声明的启用集合 |
| 3 | 已加载**扩展** id 集合 == `enhancements.yaml` 声明集合 |

## 五、轨迹里有什么

轨迹是一份 **JSONL**，8 类事件，每条都带 `effectiveConfigDigest`（这样一份轨迹能追溯到
它对应的那份配置）。要点：

- **未映射的原生事件进 `native.raw`，并必须带自足的理由** —— **不许丢弃**（这条是硬决策）
- **技能级事件 `skill.use`**：原生轨迹里没有"技能"这个概念，基座从"某次工具调用读了
  `skills/<名>/SKILL.md`"**推导**出技能使用，并按纪律标注 `derivation: "path-pattern"` ——
  看轨迹的人有权知道这条是观测还是推导。于是业务标签里的 `skill:<名>` 能真的出现在时间轴上。
- 工具入参/结果默认**只留摘要**（`contentMode: digest`），要看明文切 `full` —— 两种轨迹性质不同，
  必须显式标注
- **业务不必懂基座的字段名**：基座只提供**附加协议**（`trace-labels.yaml`：定位符 → 业务说法）
  与查看器；查看器做的是**机械键查找**，它不知道"工单系统"是什么，只知道业务给某个连接器起了这个名字

```bash
node tools/trace-view/labels.mjs <AGENT_DIR> --timeline <轨迹文件>
```
