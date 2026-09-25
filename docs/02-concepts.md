# 02 · 概念：四个业务概念与两个运行时的对应

你只写四件事：**它是谁、用哪个模型、它会什么、它能连什么**。这一篇讲这四件事在中性定义里长什么样，
以及它们**在两个运行时里分别变成了什么**。

## 一、四个概念

| 概念 | 中性定义字段 | 含义 |
|---|---|---|
| **它是谁** | `agent.yaml` → `persona.instructions` | 人设与边界。写得越具体，行为越可预测 |
| **用哪个模型** | `agent.yaml` → `model.{route,name,reasoningEffort}` | `route` = **基座声明的路由名**（不是 URL、不是 provider）；`name` = 模型名 |
| **它会什么** | `skills/<名字>/SKILL.md`（+ 可选 `scripts/`） | 技能；技能可以带业务代码，只进智能体镜像 |
| **它能连什么** | `connectors.yaml` → `mcpServers[]` | MCP 连接器。推荐按名引用基座预装条目 |

外加两个可选项：

- **边界**：`agent.yaml` → `tools.deny: [bash, write]`
- **业务标签**：`trace-labels.yaml` —— 业务给机械轨迹起的说法（基座**不解释**这些词，只机械查找后呈现）

## 二、同一份定义，两个运行时（这是本项目的核心表）

| 概念 | 中性定义 | **pi** 里变成什么 | **dsh** 里变成什么 |
|---|---|---|---|
| 人设 | `persona.instructions` | `agent-dir/AGENTS.md` | `workspace/AGENTS.md` —— 该运行时的 `agent-instructions` 是"**工作区指令文件发现器**"，会去读工作区的 `AGENTS.md`/`CLAUDE.md`，所以人设必须落在**工作区**，不是某个配置字符串 |
| 模型选择 | `model.route` / `model.name` | `models.json.tmpl`（启动期渲染）+ `settings.json` 的 `defaultProvider`/`defaultModel` | patch 里的 `agent-default-model` + **provider 路由声明**（`llm-pi-ai` 的 `providers` 字典：`api`/`baseURL`/`apiKeyEnv`/`models`） |
| 技能 | `skills/<名字>/` | `agent-dir/skills/` + 运行参数 `--skill <目录>` | `skill-filesystem.customSkillDirs`（指向**镜像内固定路径**）+ 启用 `tool-skill` |
| 连接器 | `connectors.yaml` | ⚠️ **原生不支持 MCP** —— 声明了连接器时**渲染直接失败**（不产出"没有连接器的智能体"），等选定第三方 MCP 客户端扩展 | 每服务器 `insert` 一条 `@deepseek-ai/dsh-mcp-client` row（`serverName`/`transport`/`command` 或 `url`） |
| 工具边界 | `tools.deny` | 运行参数 `--exclude-tools`（**手工直接启动会绕过**，闸门 4 会抓） | 禁用对应的 tool row。⚠️ **粒度更粗**：`read`/`write`/`edit` 是**同一个** `tool-fs` row，禁一个等于禁三个 |
| 端点/凭据 | 只写引用名 | `${PREFIX}_BASE_URL` / `${PREFIX}_API_KEY`，在**启动期**渲染进 `models.json` | `!!js process.env.<引用名>`（在 profile 里就是表达式） |
| 轨迹 | —（自动） | **回调式**（订阅 loop 回调，能拿到实际发出的请求体）+ 事后映射兜底 | **`--json` 的 run events**（带 `callId`，可直接配对） |
| 业务级增强 | `harness/<运行时>/` | TypeScript 扩展文件 + 登记到 `settings.extensions` | cordis 插件 npm 包 + `insert` row |
| 隔离手段 | —（自动） | 临时 `HOME` + 中立 cwd + `--no-skills` | 临时 `DSH_HOME` + 中立 cwd |

**为什么两边不一样**：这是**必然**的 —— 两个运行时的原生机制根本不同（一个是扩展文件，一个是
插件包）。项目的承诺不是"机制一样"，而是**「同一份定义两边都能渲染并跑通」**，且**做不到等价的地方
必须显式写出来**（`adapters/<h>/exemptions.yaml`），不允许沉默地不一样。

## 三、行为烤、参数下放

判据一句话：

> 这个字段改了，同一个输入会不会得到不同行为？
> **会** → 烤进制品（构建期渲染）；**不会** → 参数层（运行期注入）。

| 烤进制品 | 参数层 |
|---|---|
| 人设、技能、连接器、工具边界、模型**选择**（哪个 route、哪个模型） | **端点**（`<PREFIX>_BASE_URL`）、**凭据**（`<PREFIX>_API_KEY`） |

所以你的 `agent.yaml` 里**永远不写 URL 和密钥**，只写引用名：

```yaml
model:
  route: corp-gateway        # 基座声明的路由名（core/catalog/routes.yaml）
  name: corp-think
```

引用名的约定（两个运行时共用，`make validate` 会校验）：

```
<路由名转大写、非字母数字换下划线>_BASE_URL    端点
<路由名转大写、非字母数字换下划线>_API_KEY     凭据
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
- 工具入参/结果默认**只留摘要**（`contentMode: digest`），要看明文切 `full` —— 两种轨迹性质不同，
  必须显式标注
- **业务不必懂基座的字段名**：基座只提供**附加协议**（`trace-labels.yaml`：定位符 → 业务说法）
  与查看器；查看器做的是**机械键查找**，它不知道"工单系统"是什么，只知道业务给某个连接器起了这个名字

```bash
node tools/trace-view/labels.mjs <AGENT_DIR> --timeline <轨迹文件>
```
