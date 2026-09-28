# 03 · 能力目录：有哪些东西可配

> **本文件由脚本生成，不要手改。** 真源是 `core/catalog/{capabilities,params,providers}.yaml`；
> 改了真源就跑 `make gen-docs`。`make validate` 会检查二者同步 —— 不同步即失败。
> 之所以这样安排：手写文档不会报错地过期，然后开始骗人。

中性定义的完整字段目录，含类型、默认值、取值范围、所属层、各 harness 支持度与降级行为。

## 所属层是什么意思

- **artifact** —— 取值写在中性定义里；运行期不可覆盖（改了要重建智能体镜像薄层，§2.2 副作用三）。
- **parameter** —— 只在部署期注入；出现在中性定义里即纪律违规。
- **valueRefParameter** —— 定义里只写引用名，取值来自 catalog/params.yaml 的允许清单。

判据一句话：**这个字段改了，同一个输入会不会得到不同行为？** 会 → 制品层（烤进产物）；不会 → 参数层。

## structural

| 字段 | 类型 | 所属层 | 必填 | 取值 | dsh | pi | 说明 |
|---|---|---|---|---|---|---|---|
| `apiVersion` | string | artifact | 是 | `agent-base/v1` | ✅ 支持 | ✅ 支持 | 定义格式版本。破坏性变更时升 v2，基座同时支持 v1/v2 渲染并给出迁移提示。 |
| `customizations` | object | artifact | 否 | — | ✅ 支持 | ✅ 支持 | **开放命名空间**：基座不解释、原样透传的自定义容器。配套规则同一条： `x-` 前缀的键（任意层级）与 `kind: x-*` 自定义增强种类同样被允许； 它们在闸门 1 报告与渲染清单里被列为**未验证声明**（不在基座保证范围内）。 拼错的**已知**字段仍会硬错误（`additionalProperties: false` 不动）—— 这正是"允许扩展"与"拼错要响"之间的分界。 |
| `name` | string | artifact | 是 | `^[a-z][a-z0-9-]{1,30}$` | ✅ 支持 | ✅ 支持 | 智能体名。同时约束镜像名与 dsh profile 名。 |
| `description` | string | artifact | 是 | — | ✅ 支持 | ✅ 支持 | 一句话说明。进能力目录与系统提示词。 |
| `connectorsFile` | relativePath | artifact | 否 | — | ✅ 支持 | ✅ 支持 | 连接器定义文件路径。默认同目录 connectors.yaml。 |
| `skillsDir` | relativePath | artifact | 否 | — | ✅ 支持 | ✅ 支持 | 技能目录。中性定义只声明本目录下的技能；隐式加载源必须由适配器用文件系统隔离（§4.4）。 |

<sub>来源：agent.yaml / connectors.yaml / harness/<h>/enhancements.yaml</sub>

## identity

| 字段 | 类型 | 所属层 | 必填 | 取值 | dsh | pi | 说明 |
|---|---|---|---|---|---|---|---|
| `persona.instructions` | string | artifact | 是 | — | ✅ 支持 | ✅ 支持 | 常驻人设文本。与 persona.instructionsFile 互斥，validate 拒绝同时出现。 |
| `persona.instructionsFile` | relativePath | artifact | 是 | — | ✅ 支持 | ✅ 支持 | 长文本人设的文件路径（推荐用于长文本）。绝对路径被 schema 拒绝（§9.2）。 |
| `tools.deny` | string[] | artifact | 否 | — | ✅ 支持 | ✅ 支持 | 工具黑名单（边界）。v1 不表达白名单——两份上位文档的实测只覆盖 deny。 |

<sub>来源：agent.yaml</sub>

## model

| 字段 | 类型 | 所属层 | 必填 | 取值 | dsh | pi | 说明 |
|---|---|---|---|---|---|---|---|
| `model.provider` | string | artifact | 是 | （参数层） | ✅ 支持 | ✅ 支持 | 模型供应商名。基座**内置**了常用供应商（deepseek / openai / corp-gateway …）， 智能体只写名字；端点、凭据引用名、模型名单都来自那份内置目录， 要改就用 `providers.yaml`（放智能体旁边或用 AGENT_PROVIDERS_FILE）覆盖同名条目。 |
| `model.name` | string | valueRefParameter | 是 | （参数层） | ✅ 支持 | ✅ 支持 | **默认**模型名。属环境属性 —— 同一份制品在不同环境常要指向不同模型名（端点不同、模型目录不同）。 运行期可用 `<供应商前缀>_MODEL` 覆盖；覆盖值须在该 provider 声明的模型名单内，并会记进轨迹。 可配置 ≠ 随便配 ≠ 配了没人知道。 |
| `model.reasoningEffort` | enum | artifact | 否 | `low` / `medium` / `high` | ✅ 支持（未实测） | unknown（未实测） | 推理强度。harness 不支持时按 exemptions.yaml 处理（§5.4），三种合法处置：等效替代 / 豁免 / 拒绝；禁止静默降级。 |

<sub>来源：agent.yaml</sub>

## skills

| 字段 | 类型 | 所属层 | 必填 | 取值 | dsh | pi | 说明 |
|---|---|---|---|---|---|---|---|
| `skills[].name` | string | artifact | 是 | — | ✅ 支持 | ✅ 支持 | 技能名。目录 bundle 形式对齐两个 harness 的交集。 |
| `skills[].description` | string | artifact | 是 | — | ✅ 支持 | ✅ 支持 | 技能的一句话说明，供模型判断何时使用。 |
| `skills[].whenToUse` | string | artifact | 否 | — | ✅ 支持 | ✅ 支持 | 何时使用该技能（触发条件描述）。 |

<sub>来源：skills/<name>/SKILL.md（frontmatter）</sub>

## loop

| 字段 | 类型 | 所属层 | 必填 | 取值 | dsh | pi | 说明 |
|---|---|---|---|---|---|---|---|
| `loop.maxModelCalls` | integer | verification | 否 | — | 🧩 靠扩展（未实测） | 🧩 靠扩展 | 一次运行最多几次模型调用（一次调用 = 一轮）。这是**可断言的声明**，不是运行时开关：基座跑完数轨迹，超了判红并给出数字。 |
| `loop.maxToolCalls` | integer | verification | 否 | — | 🧩 靠扩展（未实测） | 🧩 靠扩展 | 一次运行最多几次工具调用。防「工具风暴」把一次运行跑成几百步。 |
| `loop.maxWallClockSeconds` | integer | verification | 否 | — | 🧩 靠扩展（未实测） | 🧩 靠扩展 | 一次运行的挂钟上限（秒）。与其他两条不同：这条**强制执行**（超时即中止并按失败处理）。 |

<sub>来源：agent.yaml</sub>

## hooks

| 字段 | 类型 | 所属层 | 必填 | 取值 | dsh | pi | 说明 |
|---|---|---|---|---|---|---|---|
| `hooks.onFailure` | enum | verification | 否 | `record` / `block` | 🧩 靠扩展 | 🧩 靠扩展 | record（默认）= 业务钩子抛异常时记录 hook.error 后继续；block = 记录后抛出、让本次运行失败。两条路都先留痕 —— 静默失败是不允许的。 |

<sub>来源：agent.yaml</sub>

## connectors

| 字段 | 类型 | 所属层 | 必填 | 取值 | dsh | pi | 说明 |
|---|---|---|---|---|---|---|---|
| `mcpServers[].ref` | string | artifact | 是 | `^[a-z][a-z0-9-]{1,30}$` | ✅ 支持 | ⚠️ 有限制（未实测） | 按名引用基座预装条目（§4.3 设计点 4）。解析来源 core/image/preinstall.yaml 的 namedReferences。 这是「开发智能体便捷」的关键形态：开发者只写一个名字，不需要知道包名、版本、启动参数。 |
| `mcpServers[].name` | string | artifact | 是 | `^[A-Za-z0-9_-]{1,32}$` | ✅ 支持 | ✅ 支持 | 连接器名。对齐 dsh serverName 的命名空间约束。 |
| `mcpServers[].transport` | enum | artifact | 是 | `stdio` / `streamable-http` | ✅ 支持 | ✅ 支持 | 传输方式。决定 urlRef / command 哪个是必填（schema 用 oneOf 分型强制）。 |
| `mcpServers[].urlRef` | refName | artifact | 是 | （参数层） | ✅ 支持 | ⚠️ 有限制 | 端点引用名。取值来自 params.yaml 的 connector-endpoint。 |
| `mcpServers[].credentialRef` | refName | artifact | 否 | （参数层） | ⚠️ 有限制 | ⚠️ 有限制 | 凭据引用名。取值来自 params.yaml 的 connector-credential。 |
| `mcpServers[].command` | string | artifact | 是 | — | ✅ 支持 | ✅ 支持 | 可执行名或镜像内固定路径。属制品层——它决定「能连什么」，且是可执行内容。 |
| `mcpServers[].args` | string[] | artifact | 否 | — | ✅ 支持 | ✅ 支持 | stdio 参数列表。引用自研连接器时用相对路径（mcp-servers/<name>/…），渲染器解析成镜像内固定路径（§4.3 设计点 3）。 |
| `mcpServers[].enabled` | boolean | artifact | 否 | — | ✅ 支持 | ✅ 支持 | 是否启用该连接器。「有哪些连接器」改变行为 → 属制品层。 |
| `mcpServers[].description` | string | artifact | 否 | — | ✅ 支持 | ✅ 支持 | 连接器说明。进能力目录与系统提示词。 |

<sub>来源：connectors.yaml</sub>

## enhancements

| 字段 | 类型 | 所属层 | 必填 | 取值 | dsh | pi | 说明 |
|---|---|---|---|---|---|---|---|
| `harness/<h>/enhancements.yaml#enhancements[].id` | string | artifact | 是 | — | ⚠️ 有限制（未实测） | ⚠️ 有限制（未实测） | 增强的唯一 id。声明即契约。 |
| `harness/<h>/enhancements.yaml#enhancements[].kind` | enum | artifact | 是 | `tool` / `hook` / `command` / `middleware` / `subagent` / `provider` / `other` | ⚠️ 有限制（未实测） | ⚠️ 有限制（未实测） | 增强类型。取值与 enhancements.schema.json 的枚举**必须一致**（闸门 1 的 catalog/enum-sync 盯着）。 |
| `harness/<h>/enhancements.yaml#enhancements[].entry` | relativePath | artifact | 是 | — | ⚠️ 有限制（未实测） | ⚠️ 有限制（未实测） | 增强入口文件（相对路径，文件形态的运行时用）。随制品烤进智能体镜像薄层，参与 digest。 |
| `harness/<h>/enhancements.yaml#enhancements[].package` | string | artifact | 是 | — | ⚠️ 有限制（未实测） | ⚠️ 有限制（未实测） | 插件包名或相对路径（包形态的运行时用）。与 entry 二选一。 |
| `harness/<h>/enhancements.yaml#enhancements[].events` | string[] | artifact | 是 | — | ⚠️ 有限制（未实测） | ⚠️ 有限制（未实测） | 钩子订阅哪些生命周期事件（**数组**，基座自己的轨迹扩展就订阅 6 个）。名字必须属于 adapters/<h>/adapter.yaml 声明的可订阅集合。 |
| `harness/<h>/enhancements.yaml#enhancements[].config` | object | artifact | 否 | — | ⚠️ 有限制（未实测） | ⚠️ 有限制（未实测） | 传给该增强的配置（原样透传进产物；基座不解释业务键 —— 保证/允许/不管的"允许"段）。 |
| `harness/<h>/enhancements.yaml#enhancements[].description` | string | artifact | 否 | — | ⚠️ 有限制（未实测） | ⚠️ 有限制（未实测） | 这个增强是干什么的（给人看的；不进判据）。 |

<sub>来源：harness/<h>/enhancements.yaml</sub>

## 参数层：哪些可以运行期注入，哪些禁止

参数层允许/禁止清单。机器可读真源，validate 与 conformance/C8 共同消费。

**名字怎么来的**（两个运行时共用，`make validate` 会校验）：

```
大写 + 非字母数字字符替换为下划线
```

- 0 → `[object Object]`
- 1 → `[object Object]`

### 允许（allowed）

| id | 种类 | 名字模式 | 含密钥 | 支撑哪些字段 | 说明 |
|---|---|---|---|---|---|
| `connector-endpoint` | connector-endpoint | `^AGENT_[A-Z0-9_]+_ENDPOINT_[A-Z0-9_]+$` | 否 | `mcpServers[].urlRef` | 连接器端点覆盖。同名系统的不同环境实例；换环境不该重建智能体。 |
| `connector-credential` | connector-credential | `^[A-Z][A-Z0-9_]*_(TOKEN\|SECRET\|KEY\|PASSWORD)$` | 是 | `mcpServers[].credentialRef` | 连接器凭据。§2.3 的表格未逐项列出连接器凭据，这里按 §4.3 的示例名（JIRA_TOKEN / GITLAB_TOKEN） 归纳出 v1 命名约定，使 validate 能判定 credentialRef 是否落在允许清单内。 **这是本清单里唯一由示例归纳、而非表格原文列出的条目**——若约定不合适，改这里即可。 |
| `provider-credential` | model-provider-credential | `^[A-Z][A-Z0-9_]*_API_KEY$` | 是 | `model.provider` | 供应商凭据。内置 provider 目录里给出了每家的**通行名字** （DeepSeek → DEEPSEEK_API_KEY、OpenAI → OPENAI_API_KEY）， 所以用户不需要"照着 provider 名推一个变量名"。 |
| `provider-endpoint` | model-provider-endpoint | `^[A-Z][A-Z0-9_]*_BASE_URL$` | 否 | `model.provider` | 端点覆盖。内置 provider 多数已带公开端点（此时不必给）；内部网关那种每环境不同的， 在 provider 条目里写 baseUrlParam 表示"由部署给"。 |
| `model-name` | model-provider-model | `^[A-Z][A-Z0-9_]*_MODEL$` | 否 | `model.name` | 模型名的运行期覆盖。中性定义里的 `model.name` 是**默认值**，不是最终值。 同一份制品在不同环境常常要指向不同模型名（端点不同、模型目录不同）。 覆盖必须可校验、可追溯：启动期按 provider 声明的模型名单校验，并把它记进轨迹 —— 「可配置」不等于「随便配」，也不等于「配了没人知道」。 |
| `probe-param` | probe-parameter | `^AGENT_PROBE_[A-Z0-9_]+$` | 否 |  | 探针参数（超时、目标）。只影响「怎么探测」，不影响智能体行为。 |
| `log-level` | observability | `^AGENT_LOG_LEVEL$` | 否 |  | — |
| `trace-dest` | observability | `^AGENT_TRACE_DEST$` | 否 |  | 轨迹输出位置。轨迹格式本身由 core/trace/schema.json 强制，不因目的地而变。 |
| `run-mode` | runtime | `^AGENT_RUN_MODE$` | 否 |  | debug 只在 agent-base:<h>-debug 变体里有效；生产基座 entrypoint 遇到 AGENT_RUN_MODE=debug 即以退出码 2 退出（§8.5）。 |
| `permission-mode` | sandbox-mode | `^AGENT_PERMISSION_MODE$` | 否 |  | 权限模式。**它是部署输入**：同一个产物在开发机与生产上可以用不同的权限模型， 因此它必须是参数层里登记过的名字 —— 适配器不许读未登记的环境变量 （否则"参数层是唯一可注入面"这句话就不成立）。 |
| `workspace-root` | workspace-root | `^AGENT_WORKSPACE_ROOT$` | 否 |  | 工作区根。同样是部署输入（挂载点可能变），登记进来以免适配器绕过参数层。 |
| `secrets-dir` | runtime | `^AGENT_SECRETS_DIR$` | 否 |  | 凭据目录：读 `<目录>/<引用名>` 作为该参数的值。与"逐个设环境变量"并列的一种给法， 不绑定任何编排层（有人直接 docker run、有人包在编排里、有人在 CI 里跑）。 优先级：环境变量 > `…_FILE` > 本目录 > 定义里的默认值（唯一实现在 core/image/startup.mjs）。 注意 §7.2 的限制：凭据无法对 agent 工具进程做 OS 级隔离 —— 边界由**运行环境**（容器、沙箱、机器权限）提供， 基座不假定它是哪一种。 |

### 禁止（forbidden）

这些内容**出现在中性定义里就是错的**（`make validate` 直接拒绝）：

| id | 种类 | 禁止出现在 | 为什么 | 谁来拦 |
|---|---|---|---|---|---|
| `persona-text` | behavior-content | `persona.instructions` / `persona.instructionsFile` | 人设文本改变行为，必须可评审、可回滚、可签名。 | gates/1,conformance/C8 |
| `skills-manifest-or-content` | behavior-content | `skillsDir` | 技能是可执行内容（含 skills/<name>/scripts/ 下的业务代码），必须随制品烤入并参与 digest。 | gates/1,conformance/C8 |
| `connector-enablement` | capability-declaration | `mcpServers[].enabled` / `mcpServers[].name` / `mcpServers[].transport` | 「它能连哪些系统」是能力声明，不是环境差异。同名系统换环境只换端点（见 allowed.connector-endpoint）。 | gates/1,conformance/C8 |
| `model-provider-selection` | provider-choice | `model.provider` | **选哪家供应商**留在制品层：供应商名决定后面三个引用名（端点 / 凭据 / 模型名）， 是「这份制品连哪家」的身份，不是环境属性。 | gates/1,conformance/C8 |
| `tool-boundary` | behavior-content | `tools.deny` | 工具白/黑名单是边界，属制品层。 | gates/1,conformance/C8 |
| `harness-enhancement-content` | behavior-content | `harness/<h>/**` | 业务级增强是行为（§4.5），构建期烤进智能体镜像薄层，随 digest 可复现。 | gates/1,conformance/C8 |

## 供应商（provider）目录

`model.provider` 写的必须是这里声明的供应商（基座**内置**常用供应商；业务只选、不定义）。

| 供应商 | 协议形状 | 端点 | 凭据引用名 | 模型 | 说明 |
|---|---|---|---|---|---|
| `corp-gateway` | `openai-completions` | 由 `CORP_GATEWAY_BASE_URL` 给 | `CORP_GATEWAY_API_KEY` | `corp-think` | 内网网关（自带假网关是它的零凭据等价物） |
| `ollama` | `openai-completions` | `http://localhost:11434/v1` | `—` |  | Ollama（本机） |
| `vllm` | `openai-completions` | `http://localhost:8000/v1` | `—` |  | vLLM（本机） |
| `local` | `openai-completions` | 由 `LOCAL_BASE_URL` 给 | `—` |  | 本地/自建 OpenAI 兼容服务（端点由部署给） |
| `deepseek` | `openai-completions` | `https://api.deepseek.com` | `—` | `deepseek-flash` `deepseek-v4-pro` | DeepSeek |
| `openai` | `openai-completions` | `https://api.openai.com/v1` | `—` | `gpt-5.5` `gpt-5.4` `gpt-4o` `gpt-4o-mini` | OpenAI |
| `openai-codex` | `openai-responses` | 由 `?` 给 | `—` | `gpt-5.5` | OpenAI Codex 订阅（登录一次即用，无需 API Key） |
| `anthropic` | `anthropic-messages` | `https://api.anthropic.com` | `—` | `claude-opus-5-5` `claude-sonnet-5` `claude-haiku-4-5-20251001` | Anthropic（Claude） |
| `minimax` | `openai-completions` | `https://api.minimax.io/v1` | `MINIMAX_API_KEY` | `MiniMax-M3` `MiniMax-M2.7` `MiniMax-M2.7-highspeed` `MiniMax-M2.5` `MiniMax-M2` | MiniMax（国际 api.minimax.io） |
| `minimax-cn` | `openai-completions` | `https://api.minimax.cn/v1` | `MINIMAX_CN_API_KEY` | `MiniMax-M3` `MiniMax-M2.7` `MiniMax-M2.7-highspeed` `MiniMax-M2.5` `MiniMax-M2` | MiniMax（国内 api.minimax.cn） |
| `glm` | `openai-completions` | `https://api.z.ai/api/paas/v4` | `ZAI_API_KEY` | `glm-5.3` `glm-5.3-flash` `glm-5.2` | GLM（国际 api.z.ai） |
| `glm-cn` | `openai-completions` | `https://open.bigmodel.cn/api/paas/v4` | `ZAI_API_KEY` | `glm-5.3` `glm-5.3-flash` `glm-5.2` | GLM（国内 open.bigmodel.cn） |
| `kimi` | `openai-completions` | `https://api.moonshot.ai/v1` | `MOONSHOT_API_KEY` | `kimi-k3` `kimi-k2.7-code` `kimi-k2.7-code-highspeed` `kimi-k2.6` | Kimi（国际 api.moonshot.ai） |
| `kimi-cn` | `openai-completions` | `https://api.moonshot.cn/v1` | `MOONSHOT_API_KEY` | `kimi-k3` `kimi-k2.7-code` `kimi-k2.7-code-highspeed` `kimi-k2.6` | Kimi（国内 api.moonshot.cn） |

换环境通常只改一个引用名、不改定义；写错供应商名 `make validate` 会当场拦下并列出可用取值。
要覆盖或新增供应商，写自己的 `providers.yaml`（放智能体旁边，或 `AGENT_PROVIDERS_FILE` 指过去）。

## 不变量

- {"id":"no-harness-name-in-core","requirement":"core/ 内不得出现任何 harness 名字（每个实施阶段的通用闸门，附录 B）。","enforcedBy":["gates/1"]}
- {"id":"no-absolute-path","requirement":"中性定义里禁止绝对路径（§9.2 差异表）。","enforcedBy":["spec/*.schema.json（relativePath 的 pattern）"]}
- {"id":"single-source-of-truth","requirement":"业务级增强不得与中性定义重复表达同一字段（§4.5）——两个真源会被 derive 出不一致的行为。","enforcedBy":["gates/1"]}
- {"id":"layer-consistency","requirement":"params.yaml 禁止清单里的 definitionPaths 必须被本目录标为 layer=artifact；且 valueRef=parameter 的字段必须与 params.yaml 的 backs 双向一致。","enforcedBy":["gates/1"]}
