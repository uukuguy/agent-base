# 08 · 分层纪律：哪层能放什么

这篇是**规则**，不是建议。每条都有机器执法项，违规会让 `make validate` 或 `make conformance` 失败。

## 一、三层边界

| 层 | 目录 | 谁改 | 能放什么 |
|---|---|---|---|
| **基座层** | `core/` · `adapters/<运行时>/` · `tools/` · `conformance/` | 平台开发者 | 不变量与适配实现。**基座不含任何业务智能体** |
| **应用层** | `my-agent/`（**基座之外**） | 业务开发者 | 定义、技能、连接器、业务级增强 |
| **平台层** | 镜像仓库、凭据、网络策略 | 平台/运维 | 基座不碰 |

**最硬的一条**：应用派生**到基座之外**，且**不回头改基座**。
如果你发现"必须改基座才能做这个智能体"，那说明基座**缺能力** —— 那是另一件事，
应当按 `09-harness-contract` 走能力补充流程，而不是顺手在基座里加一行特例。

## 二、三类层语义（决定一个字段该放哪）

| 层 | 含义 |
|---|---|
| `artifact` | 取值写在中性定义里，**运行期不可覆盖**。改了要重建智能体制品 |
| `parameter` | **只在部署期注入**；出现在中性定义里即违规 |
| `valueRefParameter` | 定义里**只写引用名**，真值来自参数层允许清单 |

**判据一句话**：

> 这个字段改了，**同一个输入会不会得到不同行为**？
> **会** → 制品层（烤进产物）；**不会** → 参数层。

## 三、禁止清单（出现在定义里就是错的）

| 禁止内容 | 禁止出现在 | 为什么 |
|---|---|---|
| 人设正文 | `persona.instructions`（**作为参数**） | 人设是行为内容，必须烤进制品 |
| 技能清单/正文 | `skillsDir`（**作为参数**） | 同上 |
| 连接器启用声明 | `mcpServers[].enabled` / `.name` / `.transport` | 这是能力声明，属于制品 |
| 模型选择 | `model.route` / `model.name` | 行为选择，属于制品（**参数层只能给端点与凭据**） |
| 工具边界 | `tools.deny` | 行为内容 |
| 业务级增强内容 | `harness/<h>/**` | 同上是行为内容 |

每条都由 **闸门 1** 与 **conformance C8** 双重执法（C8 会真的把禁止项当参数注入，
确认它**不会**静默生效）。

## 四、生成物不是源码

| 生成物 | 位置 | 为什么要分开 |
|---|---|---|
| 镜像构建上下文 | `dist/image/context/` | 它含 harness 名（在包名里），放 `core/` 会踩"core 不得出现 harness 名"这条；**生成的构建输入不是源码** |
| 渲染产物 | `.render/`（派生出来的智能体里）或 `dist/` | 构建产物必须**排除出定义摘要**，否则渲染一次摘要就变（自漂移） |
| 能力目录文档 | `docs/03-capability-catalog.md` | 由真源生成；有**同步检查**，改了真源没刷新即失败 |

原则：**凡是由真源生成的东西，都要有一个"同步检查"**。手写文档不会报错地过期，然后开始骗人。

## 五、单一真源地图

| 内容 | 真源 | 谁消费 |
|---|---|---|
| 中性定义契约 | `core/spec/{agent,connectors}.schema.json` | 闸门 1、两个渲染器 |
| 能力目录（字段/层/支持度） | `core/catalog/capabilities.yaml` | 闸门 1、文档 03 |
| 参数层允许/禁止 | `core/catalog/params.yaml` | 闸门 1、conformance C8 |
| **供应商（provider）内置** | `core/catalog/providers.yaml` | 闸门 1、两个渲染器 |
| **供应商覆盖**（部署层/智能体） | `AGENT_PROVIDERS_FILE=<你的 providers.yaml>` · `AGENT_CATALOG_DIR=<目录>` · **`<智能体目录>/providers.yaml`** | 同上（优先级：环境变量文件 > 环境变量目录 > 智能体自带 > 基座内置；同名 id 按字段合并） |
| 预装清单 | `core/image/preinstall.yaml` | 镜像构建（经 `preinstall.lock.txt`）、连接器 `ref` |
| 运行时版本 pin | `adapters/<h>/adapter.yaml` | 镜像构建、`make dev-env` |
| 运行时能力声明 | 同上 `capabilities:` 段 | conformance C1、文档 10 |
| 轨迹事件契约 | `core/trace/schema.json` | 两个映射器、查看器、conformance C7 |

**反例**：供应商目录在成型之前**没有真源** —— 两个渲染器各自硬编码协议形状，
智能体写错供应商名时渲染照样成功，直到运行时才炸。凡"两边各写一份"的东西，迟早漂移。

## 六、执法对照（哪条纪律由哪个检查拦）

| 纪律 | 执法项 |
|---|---|
| 定义合法（未知字段是硬错误） | `schema/agent`、`schema/connectors`、`ref/*` |
| 能力目录与 schema 不漂移 | `catalog/missing-field`、`catalog/stale-field` |
| 参数层双向一致 | `params/backs`、`params/forbidden-layer` |
| 供应商必须已声明 | `provider/declared`、`providers/present`、`providers/id`、`providers/param-convention`、`providers/param-allowed`、`providers/model-api`（协议形状必须被两个运行时支持） |
| 凭据引用必须在允许清单内 | `cred/not-in-params`、`preinstall/credential-ref` |
| `core/` 不得出现运行时名 | `core/harness-name` |
| 不得手写"跳过旗标值"的参数解析 | `cli/no-naive-flag-skip` |
| 生成文档必须同步 | `docs/catalog-sync` |
| 预装清单自洽（pin / 存活 / 排除理由 / 引用名） | `preinstall/*` 共 10 项 |
| 字段所在层不得被违反 | `layer/forbidden-field` + conformance **C8** |
| 运行时声明不得夸大 | conformance **C1**（声明完整性）+ **C9**（与容器内实测一致） |
| 声明的 ≠ 实际加载的 | conformance **C4**（三条集合断言） |
| 静默失败必须被检出 | conformance **C5**（每条失败模式配一个注入用例） |

## 六之二、供应商配置（providers.yaml）是**配置**，不是基座代码

`core/catalog/providers.yaml` 写的是"这次部署连哪个端点、端点服务哪些模型"—— 那是**环境属性**。
它在 `core/` 里只是**内置的常用供应商**（deepseek / openai / corp-gateway，开箱就能用）；
要新增一家或改端点/模型名单，写自己的那份，**不必动基座代码**：

```bash
# ① 直接指一个文件
AGENT_PROVIDERS_FILE=/path/to/your-providers.yaml make validate AGENT_DIR=<你的智能体>
# ② 或者一个目录（取其中的 routes.yaml）
AGENT_CATALOG_DIR=/etc/agent-base make verify AGENT_DIR=<你的智能体>
```

**派生出来的智能体**更省事：把 `providers.yaml` 放在定义旁边即可 —— Makefile 会认它，
基座工具自己也会认（`agent-local` 那一级）。两条路径都覆盖，是因为工具会切工作目录：
只靠 Makefile 的 `wildcard` 在"直接调工具"时就不生效了。

**模型名单别手填**，问端点：

```bash
make providers-init ENDPOINT=https://gw.internal/v1 API_KEY=…      # 会 GET <endpoint>/models
```

它把端点实际提供的模型名写成一份目录 —— 名单于是**是实测的，不是记来的**，
也就不会出现"闸门 1 说可用、运行时端点说不认识"。

**一条硬规矩**：设了 `AGENT_PROVIDERS_FILE` / `AGENT_CATALOG_DIR` 却读不到文件 ⇒ **直接失败**，
不静默回退到内置。否则"我明明配了"与"系统其实在用内置"会同时成立 —— 那是本项目一直在治的那类静默失败。

## 七、规则看着碍事时怎么办

先问一句：**是不是分层错了？**

真实案例：镜像构建要一份"装什么"的坐标表。第一版用运行时名做键，被判红；去掉名字改用包坐标后
**仍然**判红 —— 因为**包名本身就含运行时名**。

当时的两个选项是"放宽规则"和"改设计"。正确做法是**纠正分层**：生成的构建输入根本不是源码，
不该放在 `core/`，于是它落到 `dist/`；运行时的可执行名归 `adapters/<h>/adapter.yaml`。

**放宽规则几乎总是错的** —— 规则被判红往往是在提示你某样东西放错了层。
