# 变更记录

本文件同时承载 **版本策略** 与 **变更条目**（发布条目形如 `## <版本>`）。
条目按"使用者能看到什么变化"写，不按提交逐条复制 —— 逐条复制会变成噪声，让人不再读它。

---

## 版本策略

### 1.1 这里有**三个**独立的版本号，别混

| 版本 | 在哪 | 谁负责升 | 含义 |
|---|---|---|---|
| **基座版本** | `package.json` 的 `version` | 基座维护者 | 整个基座的发布版本。镜像 tag 用它（`agent-base:<版本>-<架构>`） |
| **定义契约版本** | 智能体定义里的 `apiVersion: agent-base/v1` | 基座维护者（破坏性变更时） | **中性定义这份契约**的版本。它比基座版本变得**慢得多** |
| **运行时 pin** | `adapters/<h>/adapter.yaml` 的 `version`（+ `adapterVersion`） | 适配器维护者 | 锁定的上游运行时版本，以及适配器自身的实现版本 |

**为什么分开**：基座可能因为加了一个检查、修了一个报错就从 0.1.0 升到 0.2.0，
但**中性定义一个字都不用改** —— 那是契约没变。反过来，契约一旦破坏性变更，
所有智能体都要动，那必须是 `apiVersion` 升版、并且**给出迁移提示**。

### 1.2 什么算"破坏性变更"

**定义契约（`apiVersion`）升版** —— 满足任一条即算：

- schema 里删字段、改字段名、收窄取值范围（枚举去掉取值、pattern 收紧、必填化）
- 改变某个字段的**所属层**（制品层 ↔ 参数层）—— 这会让已有定义直接违规
- 改变 `usable` 的判据（例如新增一道阻断性闸门）
- 改变跨运行时等价性的承诺范围（新增/收窄可移植核心）

**只升基座版本**：

- 修 bug、改报错文案、加检查（**新增检查也算**：它可能让原本"绿"的智能体变红，
  但这属于"发现真实问题"，不是契约变更 —— 会在条目里写清楚）
- 加字段（向后兼容：老定义照旧合法）
- 升级运行时 pin（**前提**：`conformance` 十项仍全绿；否则不能升）

### 1.3 兼容承诺

- **`apiVersion` 相同 ⇒ 老定义照旧能渲染、能跑**。基座若要支持两个 `apiVersion`，
  必须同时支持并给出迁移提示（`core/catalog/capabilities.yaml` 里 `apiVersion` 的说明就是这条）
- **不承诺**跨"验证快照"的兼容：验证快照（`my-agent:<版本>@sha256`）的语义是
  **"这次验证是在什么环境里跑出来的"**，不是可长期依赖的发布物。它要能**复现**，不要能**演进**
- **运行时 pin 会随上游变**，但每次升级都必须重跑 `make conformance`（两边都 10/10 才算过）

### 1.4 摘要的语义

| 摘要 | 覆盖什么 | 怎么用 |
|---|---|---|
| `definitionDigest` | **中性定义**目录 | 业务标签按它 join —— 改一句描述不会改写历史轨迹 |
| `artifactsDigest` | **渲染产物**（不含清单自身） | 同一定义渲染到不同目录必须得到同一摘要 |
| `effectiveConfigDigest` | 运行时版本 + 适配器版本 + 产物摘要 + **参数名集合**（只放名字不放值） | 每条轨迹事件都带它 —— 一份轨迹能追溯到它对应的那份配置 |
| 镜像摘要 | 多架构 manifest（或分架构记录） | 验证快照的可复现标识 |

**注意**：`effectiveConfigDigest` 只含**参数名**，不含参数值 —— 换环境（换端点/凭据）会得到
同一个摘要，这是**故意**的：摘要标识的是"哪份配置"，不是"哪套注入值"。

---

## 0.1.0（未发布）

首个完整形态。仓库存量即为此版本，尚无对外发布（`git remote` 为空）。

### 基座不变量

- **中性定义契约**（`apiVersion: agent-base/v1`）：`agent.yaml` + `connectors.yaml` + `skills/` + 可选 `trace-labels.yaml`
- **三个能力目录**：字段/所属层（`capabilities.yaml`）、参数层允许/禁止（`params.yaml`）、**模型路由目录**（`routes.yaml`）
- **四道闸门**：静态校验 → 解析自证 → 集成探针 → 端到端冒烟；`usable` = 四道全过（不是"能启动"）
- **统一轨迹**：8 类事件 + `native.raw` 兜底（**不许丢弃**）+ `biz` 附加位 + `biz.event` 业务日志
- **业务可读时间轴**：`trace-labels.yaml`（定位符 → 业务说法），基座**不解释**业务语义
- **零凭据假网关**：闸门 3/4 不需要任何密钥即可跑；能终止会话（收到工具结果后改回文本）
- **MCP 客户端（pi）**：pi 原生没有；经基座种子扩展 `pi-mcp-adapter@2.37.0`（精确 pin，构建期装好）补上，连接器渲染成 `agent-dir/mcp.json`

### 两个运行时

| 运行时 | pin | 准入 |
|---|---|---|
| pi | `0.87.1` | **C1–C10 全绿** |
| dsh | `0.1.7-rc.1` | **C1–C10 全绿** |

- 「同一份中性定义，两个运行时都能渲染并跑通」**首次有双边证据**
- 做不到等价的地方逐条写进各适配器的 `exemptions.yaml`，并在文档里标注

### 上手路径

```bash
make new-agent NAME=my-agent     # 派生到基座之外，开箱可用
make dev-env                     # 按 pin 校验/安装运行时
make verify                      # 四道闸门 → 可用 / 不可用
make run-local                   # 本地跑一次（临时 HOME，文件系统隔离）
```

### 镜像里怎么配 LLM（容器内的运行期配置）

- **端点 / 凭据 / 模型名**三者都是运行期注入：`<路由前缀>_BASE_URL` · `<路由前缀>_API_KEY` · `<路由前缀>_MODEL`
  - 四种给法，**不假定任何编排层**：① 环境变量 ② `NAME_FILE=/path` ③ **`AGENT_SECRETS_DIR=/dir`**（读 `/dir/NAME`）④ 定义里的默认值；
    优先级固定 ① > ② > ③ > ④
  - 手工运行有便利开关：`make run-local --endpoint/--api-key/--model/--secrets-dir/--param`
  - 镜像里**只有一个运行时**时容器不必传 `HARNESS`（会明确提示按哪个起）；多个候选时仍必须显式指定
  - 模型名会按**路由声明的模型名单**校验；不覆盖时用定义里的默认值
- **启动期四步**：解析参数 → 校验模型名 → **暂存可写副本**（产物只读，永不改写）→ **原子渲染**（仅对不支持环境插值的运行时）
- **失败即失败**：缺端点/凭据、模型名不在名单 → 退出码 2，信息点名缺哪个引用名与两种给法；**不静默降级**
- **凭据永不打印**（日志与 JSON 里只显示 `***` 与来源）
- **`config-check` 子命令**：只校验配置与产物、不跑模型（生产里当就绪探针）
- 挂载约定：**渲染输出整体**挂到 `/opt/agent-base/artifact`（可用 `AGENT_ARTIFACT_DIR` 改）
- **实测**：容器内 `--network none` + 产物只读挂载下，pi 与 dsh 都能用注入的配置跑通，端点侧收到 `tools>0 / stream=true`

> **判据修正**：`model.name` 此前被当作"行为选择"放进禁止清单，导致它在容器里无法按环境切换。
> 已改为按「值是否随部署环境而变」判定 —— 模型名是环境属性，进参数层；`model.route` 仍是制品层
> （它决定后面三个引用名）。

### 缺陷收口（D1–D6）与「钩子确实触发」的证据（P4）

- **D6 工具边界**（影响交付正确性）：`tools.deny` 改为**清单声明**（`runtimePlan.prependArgs`），
  本地与容器**两条启动路径都按同一份执行**。实测 `probe/model.tools`：**4 → 1**
  —— 也就是说**旧写法根本没生效**（本地与容器都没有），只是没人断言过
- **D1 增强 schema**：`core/spec/enhancements.schema.json` 接进闸门 1（`kind` 枚举、`kind=hook` 必填 `event`、
  `entry`/`package` 至少一个）；负例 `11-enhance-bad-kind` / `12-enhance-hook-no-event` 各自只因目标原因红
- **D2 未声明接入件**：本运行时会加载 `extensions/` 下的每个文件 ⇒ 渲染期要求每个文件都被某条声明认领
  （负例：丢一个未声明文件 ⇒ 渲染失败）
- **D3 增强进比对**：`compare` 现在把两边的增强集合摆出来，差异必须被豁免解释；基座轨迹在一侧是扩展形态
  这件事因此第一次**显式**写进 `adapters/pi/exemptions.yaml`
- **D4 dsh 静默跳过**：非法增强声明（缺 `package`/`id`）改为渲染期响亮失败
- **D5 参数层**：`AGENT_PERMISSION_MODE` / `AGENT_WORKSPACE_ROOT` 登记进 `params.yaml`（基础设施类）
- **P4 钩子可验**：轨迹事件带 `emitter: hook|post-hoc`；闸门 3 新增 `probe/hook-fired`
  —— 声明了钩子就必须有"钩子当场发出"的事件（实测 5 条）；另一运行时是事后映射 ⇒ **如实报"不适用"**，不算通过

### 派生镜像：起点门槛打通（P1–P3）

- **接入缝**（P3）：`/opt/agent-base/overlay/`（`AGENT_OVERLAY_DIR`）——上层镜像把业务代码与钩子放这里，
  启动期**只改暂存副本**：拷 `extensions/`、`business/`，把 `enhancements` 并进副本清单，
  并把扩展登记进 `settings.json`。产物一个字节不动，**闸门 2 的"声明 == 进产物"因此覆盖它**（实测集合相等）
- **镜像内自证**（P2）：镜像携带闸门源码与依赖（`/opt/agent-base/gates`），
  `docker run <镜像> verify` 跑**闸门 2/3/4**（给了定义连**闸门 1**）—— 离线、零凭据，可放进 CI；
  为它新增 `validate --agent-only`（镜像里没有基座 docs/布局，跑基座自洽只会假红）
- **派生镜像骨架**（P1）：`template/derived/Dockerfile` + `make image-derived AGENT_DIR=… [OVERLAY_DIR=…]`
  —— 渲染 → 组上下文 → 构建 → **镜像内自证**，一条命令给证据（实测：构建成功 + 自证通过）
- 修两个真实缺陷：① **`COPY` 保留权限位**导致容器内读不到（仓库里多个 0600 文件 + 派生骨架缺 `chmod`，
  两者都修）② `core/image/startup.mjs` 注释里出现运行时名（`core/harness-name` 闸门抓到，已改中性）

### 业务增强：**业务代码共享，接入方式各写各的**

- `harness/shared/**` 是**可共享的业务代码**（零依赖、纯逻辑），渲染器把它拷进两个产物
  （pi → `agent-dir/business/`，dsh → `<产物>/harness/business/`），两侧接入件用**同一个相对路径**引用它
- 闸门 1 新增 `enhance/shared-agnostic`：扫描共享代码的**代码**（剥掉注释再扫），
  出现运行时 SDK 导入或运行时 API 调用就变红 —— "可共享"变成可执行判据
- `examples/change-risk-review/` 改成共享形态：一份业务模块 + 两个薄接入件。
  **两侧实测都生效**：pi 工具数 3→4、dsh 工具数 19→20，dsh 冒烟里 `corp_risk_score` 真的被调用
- 踩坑与修法写进示例 README：接入件不 import 运行时 SDK（产物里裸导入解析不到）、
  产物必须把 `harness/` 写进 `runtimePlan.copy`（**且只在目录存在时声明**，否则所有不带增强的示例在 dsh 上全红）

### 统一轨迹：新增技能级事件 `skill.use`

- 原生轨迹没有"技能"概念，基座从"某次工具调用读了 `skills/<名>/SKILL.md`"**推导**，
  并按纪律标注 `derivation: "path-pattern"`（推导出来的必须说出来，不许冒充原生观测）
- 查看器据此让业务标签 `skill:<名>` 真的出现在时间轴上（此前该定位符永不渲染）
- 自检里用**真实工具调用**验证：假网关新增测试用入参覆盖 `toolArgs`
  （让一次真实调用去读 SKILL.md），事件计数 `{… "skill.use":1 …}` 且全部过统一轨迹 schema

### 新增示例：harness 层「业务级增强」（`examples/change-risk-review/`）

- 中性定义只承诺"用风险评分工具"，工具**由 harness 层增强提供**：`harness/pi/enhancements.yaml` 声明 +
  `harness/pi/extensions/risk-score.ts` 实现（`pi.registerTool()`、零依赖、确定性规则、可审计）
- 证据链：闸门 1 报告可移植性降级（核心 + 某运行时增强）→ 渲染把扩展登记进 `settings.extensions` →
  **闸门 2 硬断言「声明集合 == 进入产物集合」** → **闸门 3 工具数 3→4**（业务工具真的发给了模型）
- README 写清"加一个业务增强要动什么"（实现契约、参数用普通 JSON Schema、jiti 免编译，
  以及"`extensions/` 里每个文件都会被登记成扩展"这个坑），并说明 dsh 侧的增强形态是 cordis 插件包
  （本示例不编造不存在的 npm 包，因此 dsh 侧如实"没有"）

写这个示例时又抓到一个**判据错误**（不是示例的问题）：闸门 2 判断"声明的增强是否进入产物"用的是
`文件名.includes(增强 id)` 子串匹配 —— íd `corp-risk-score` + 文件 `risk-score.ts` 完全合法却被判"没进产物"
（假阴），而 id `trace` 会被 `extensions/my-trace-helper.ts` 满足（假阳）。已改成**按声明的 entry 精确匹配**。



- `examples/` 扩到 5 个**完整项目**（定义 + 技能 + 轨迹标签 + Makefile + README），覆盖主要场景：
  纯技能 · MCP 连接器 · **本地模型（无凭据）** · **同一制品多环境** · **只读 + 多技能 + 观测**
- 每个 README 必含「它解决什么问题 / 结构 / **构建与验证过程** / 改它 / 已知边界」，
  且构建过程必须写清"做什么 → 跑哪条命令 → 看什么 → 期望结果"；`make examples-check` 把它变成验收项
  （缺节、过程太空、提到不存在的文件、某个运行时不可用 → 直接红）
- 清掉误提交的渲染产物（`.render/` 进 `.gitignore`）

写这几个示例时暴露并修掉三个**真问题**（都是"文档写的"与"工具做的"不一致）：

- **`run-local` 不消费产物里的端点默认值**：`provider: ollama` 的产物已声明默认端点，
  但 `make run-local PROMPT=…` 仍报"未提供模型端点"，与 quickstart 的写法自相矛盾。
  现在端点来源依次为 `--endpoint` > 环境变量 > **产物默认值**
- **无凭据的本地供应商（`auth: none`）此前渲染出的配置让运行时判它不可用**
  （模型解析成 unknown / No API key）：现在凭据参数带**占位默认值**、用户不必提供任何密钥，
  两个运行时都实测四道闸门全过
- **模板 Makefile 的 `providers-init` 判断旗标写错**（判 `ROUTE` 却传 `PROVIDER`，
  且默认输出还是旧名 `routes.yaml`）→ 已修
- `examples-check` 在示例缺 README 时会抛未捕获 ENOENT → 已修（先判存在再解析）



- `examples/` 的定位说清：**真实开发是在一个项目里持续做**，现场验证的载体是示例项目，
  不是一条命令的演练脚本（`docs/12-dev-walkthrough.md` 讲清两者分工）
- 每个示例补齐：完整定义 + 技能（有实质内容）+ 轨迹标签 + Makefile + **README（含构建与验证过程）**；
  覆盖场景扩到 5 个：纯技能 · MCP 连接器 · 本地模型（无凭据）· 同一制品多环境 · 只读 + 多技能 + 观测
- `make examples-check` 新增 README 验收：必备小节齐备、构建与验证过程有可执行命令与期望结果、
  README 提到的文件必须存在、**每个运行时都要给出「可用」**
- 清掉误提交进仓库的渲染产物（`.render/` 已进 `.gitignore`）
- 顺带修掉一个真问题：**无凭据的本地供应商**（`auth: none`）此前渲染出的配置会让运行时判该 provider
  不可用（模型解析成 unknown / No API key）—— 现在凭据参数带占位默认值、用户不必提供任何密钥，
  两个运行时都实测四道闸门全过

### `make walkthrough`：一条命令走完真实开发循环

- 派生 → 改定义（技能目录发现 + 工具边界）→ **故意写错让闸门变红** → 改对 → 渲染（含确定性）→
  闸门 2/3/4 → 运行期参数四种给法 → 本地真跑并验证产物只读 → 跨运行时比对 → 容器 `config-check`
  →（可选）`LIVE=1` 打真实端点
- 输出是**功能 × 证据**清单；没验的项明确标成"跳过"（需要真实端点或已构建镜像），不伪装成通过
- 与 `examples/` 的分工写进 `docs/12-dev-walkthrough.md`：examples 是对照用的样子示例，
  验证"我的场景能不能用"要走派生的智能体

### `LIVE=1`：让四道闸门对着**真实端点**跑

- `make verify LIVE=1`（或 `--live` / `AGENT_VERIFY_LIVE=1`）：闸门 3/4 不再走零凭据假网关，
  而是用产物自己声明的端点与凭据真实调用模型 —— 即"真的能用"的最终证据。
  默认仍走假网关（快、封闭、不花额度），两条路互不影响
- 订阅型 provider 的登录态**自动带上**（取运行时自己的凭据目录，默认 `~/.pi/agent` 的 `auth.json`），
  容器里挂该目录即可；找不到会明确报错
- LIVE 模式下闸门 3/4 的判据相应调整：证据来自运行时轨迹里的真实模型请求，
  冒烟不再以假网关的应答标记判定，而以"真实调用发生 + 任务正常结束"判定
- 设计取舍：闸门规则服务**快速验证**，不做成本控制 —— 想验就一步到位

### provider：内置到 14 家，支持本地模型与订阅登录

- **本地模型（开发验证期最常用）**：内置 `ollama`（11434）、`vllm`（8000）、`local`（端点由
  `LOCAL_BASE_URL` 给，覆盖 LM Studio / llama.cpp / SGLang 等），都走 OpenAI 兼容、**都不需要密钥**
  （新增 `auth: none`：不产生凭据参数）
- **订阅登录免密钥**：新增 `auth: native` —— 基座**不注入任何密钥**，凭据由运行时自己的凭据库提供
  （如 pi 的订阅登录 `auth.json`）；内置 `openai-codex`（只有 pi）。新增
  `AGENT_HARNESS_HOME` / `--harness-home` 把登录态显式带进暂存副本（产物仍只读、不写凭据）
- **新增云供应商**（端点与模型名逐条按官方文档核实）：`anthropic`（原生 Messages）、
  `minimax` / `minimax-cn`、`glm` / `glm-cn`、`kimi` / `kimi-cn`
- **provider 作用域**：`harnesses: [pi]` —— 各运行时原生认识的家数不同，允许不同；
  用了当前运行时不支持的 provider，渲染期**明确失败**（不再要求两个运行时处处相同）
- **闸门 2 新增** `resolution/native-credential`：`auth: native` 的 provider 必须被底层真正认识
  （p,i 用 `pi auth check` 实证），订阅就绪时报告 oauth 状态
- **闸门 3/4 对订阅型显式「不适用」**：它们的验证手段是把端点重定向到零凭据假网关，
  而订阅型端点由运行时解析 —— 硬跑会真打订阅端点（不封闭、且花额度），因此如实声明不适用

### 破坏性：`model.route` 废除；轨迹字段 `route` 改名 `provider`

- **`model.route` 不再接受**（连旧名都不留）：定义里写 `route:` 会在闸门 1 失败，并给出
  `已废除 → 请改写 model.provider` 的提示。`AGENT_ROUTES_FILE` 同样移除，改用 `AGENT_PROVIDERS_FILE`
- **轨迹事件字段 `route` → `provider`**（`model.request` / `model.error`），与配置层同一个词，
  全项目一种说法；统一轨迹 schema、假网关（含 `--provider` / `FAKE_GATEWAY_PROVIDER` 与
  `x-fake-gateway-provider` 头）、轨迹视图、产物清单字段（`modelRoutes`→`modelProviders` 等）同步改名

### 破坏性：增强声明的事件字段改为 `events`（数组）；钩子事件名**开始对名字**

- `enhancements.yaml` 里 `kind: hook` 现在要求 **`events: [...]`**，不再是 `event: <字符串>`。
  迁移：`event: tool_call` → `events: [tool_call]`。旧写法会在闸门 1 失败（`enhance/schema`），
  不会静默当成"没声明"
- **为什么现在改**：单个字符串**表达不了基座自己的轨迹扩展**（它订阅 6 个事件）；
  而旧写法"事件名写错也不报错"—— 又一处"看起来有、其实没有"。0.1.0 未发布，改动只影响仓内文件（已全部更新）
- **新增判据**：`enhance/events`（声明的每个事件名必须属于 `adapters/<h>/adapter.yaml` 的 `hookEvents`：
  pi **39 个**已穷举并附 `reproduce` 复算命令；dsh 未穷举 ⇒ 如实标 `enumerated: false`、声明按「未验证」处理）、
  `hook/events-decl`（集合声明自洽，`count` 是手抄见证值）、`catalog/enum-sync`（能力目录与 schema 的枚举必须一致）
- **顺手堵上一个后门**：闸门 1 此前**不校验基座自己的** `adapters/<h>/seed/enhancements.yaml` ——
  它那份 `kind: hook` 连事件名都没写却一直"全绿"。现在两个来源都走同一套 schema 与事件名核对
- **契约边界（D-0017）**：`enhancements.schema.json` 是 **harness 层**契约，随**基座版本**演进，
  不属于 `apiVersion` 所承诺的中性定义契约（中性定义仍是 `agent-base/v1`，一个字没改）

### 模型协议形状：声明 + 校验（`providers/model-api`）

- 两个适配器各自声明**支持的协议形状**（`adapters/<h>/adapter.yaml` 的 `capabilities.modelApis`，
  从包内实测得出）：pi 7 种、dsh 5 种（差异在 Google 的两种形状）
- 闸门 1 校验每个 provider 的 `api:` 都被**两个运行时**支持 —— 写错或用了单边形状当场失败，
  而不是渲染出一份适配器不认的配置（那会在运行时表现为看不懂的报错）
- 文档给出可用的形状表与"加一家供应商"的最小写法

### 模型配置：内置 provider，写名字就能用

- 新增**内置 provider 目录**（`core/catalog/providers.yaml`）：`deepseek` / `openai` / `corp-gateway`。
  智能体只写 `model.provider: deepseek` + `model.name: …`，**不必建任何文件**，
  也不必照着 provider 名去推 `XXX_BASE_URL` / `XXX_API_KEY` —— 内置条目直接给出通行名字
  （`DEEPSEEK_API_KEY` 等）与公开端点
- `model.provider` 是新写法，`model.route` 仍等价可用
- 要改端点/模型名单：写自己的 `providers.yaml`（智能体旁边 / `AGENT_PROVIDERS_FILE` / `AGENT_CATALOG_DIR`），
  同名 id **按字段合并**覆盖内置；`provider.baseUrl` 给了字面端点时，端点不再是必填参数
- **工具链会读变量文件**（`.env` 这类）：`AGENT_ENV_FILE` 显式指定，或放智能体目录/当前目录/仓库根；
  **真环境变量优先**
- 模型列表**完整**进入两个运行时的配置（不只是默认那一个），两边都能切换模型
- `examples/` 每个示例都带上了 Makefile：`cd examples/idea-to-proof && make verify` 直接能跑

### 模型路由目录可以被部署层覆盖（不再需要改基座）

- 路由目录（连哪个端点、端点服务哪些模型）是**部署输入**：`AGENT_ROUTES_FILE` / `AGENT_CATALOG_DIR`
  优先于基座内置那份；设了却读不到 ⇒ **直接失败**，不静默回退
- 派生智能体把 `routes.yaml` 放定义旁边即**自动生效**：Makefile 认它，基座工具也认它
  （解析链多一级 `agent-local`；环境变量仍优先）。生成的 Makefile 新增 `run-local` / `routes-init` 目标
- `run-local` 的端点不再被默认值静默覆盖：没给端点会**明确报错**并列出三种给法（此前会默默指向死端口，
  表现为"我明明配了却连不上"）
- `make routes-init ENDPOINT=<baseUrl>`：问端点 `GET <baseUrl>/models`，把**实测**的模型名写成目录
  （名单不再靠手填，也就不会与实际端点漂移）
- 输出/报错会说明"这份目录是从哪来的"，写错模型名时列出该路由可用的取值

### 镜像

- 双架构（`arm64` + `amd64`）+ 调试变体（`-debug`，`FROM` 同一 digest 只加诊断工具）
- 容器上限**实测**：非 root（uid 10001）、只读根、能力全丢、断网下运行时与 11 个连接器均可用
- 生产镜像**拒绝**调试模式（退出码 2）
- 预装清单有**生成锁**与同步检查；运行时装什么、什么版本，一处可查

### 校验与准入门槛

- `make validate`：基座自洽 + 定义校验（含**路由必须已声明**、生成文档同步、`core/` 不得出现运行时名等）
- `make conformance --harness <h>`：C1–C10 十项阻断性门槛（**未实现记 pending 并非零退出**）
- **11 个 `*-selftest` 目标**，加上 `validate` 与 `examples-check` 共 13 个可执行校验入口；`examples-check` 含「示例可整体删除而基座仍绿」这条不变量的静态验证

### 示例

- `examples/idea-to-proof`：纯技能型，四道闸门 → 可用；技能里带一个可自检的脚本
- `examples/contract-review`：**带 MCP 连接器**（`ref: filesystem`，零凭据、可离线）；两个运行时四道闸门均 → 可用
- **每个示例都在每个运行时上验「可用」**（`make examples-check`）—— "可移植"这句承诺的可执行形态
- **跨运行时等价性比对**（`make compare`）：技能/连接器/模型路由三组集合两侧一致、路由协议形状一致，
  且**任何差异都必须有声明**（读各运行时的 `exemptions.yaml`）—— 可以不一样，但不许悄悄不一样

### 文档

- `docs/00`–`docs/11` 共 12 篇 + 索引；其中 `03-capability-catalog` **由真源生成**并有同步检查

### 本期不包含（说清楚，免得当成"应该有"）

| 项 | 说明 |
|---|---|
| 生产化能力 | 鉴权、审批流、多租户、高可用、SBOM 签名、常驻服务编排 —— **不在基座范围**。基座里的安全基线存在的理由是让验证环境足够接近生产，结论才可信 |
| ~~pi 侧的 MCP 客户端~~ | **已接入**：选定并 pin 第三方扩展 `pi-mcp-adapter@2.37.0` 作为基座种子依赖（构建期装进镜像、运行期不下载）；连接器渲染成 `agent-dir/mcp.json`，实测工具数 4 → 7 |
| 镜像推送链路 | 多架构 manifest 已能产出；推送到 registry 需要可用的内部仓库 |
| dsh 的 `model.reasoningEffort` 映射 | provider 条目的取值形状未实测 ⇒ 声明为豁免，不猜形状 |
| pi 侧增强"已加载"的观测 | 目前验到「已进入产物」，离「已被运行时成功加载」还差扩展自报一步（`adapters/pi/failures.md` F6） |

---

## 如何维护本文件

- **面向使用者写**：一条条目回答"我用它的时候会看到什么变化"，而不是"我改了哪个文件"
- **诚实**：修了假缺陷（检查写错方向）也要写 —— 否则别人会以为是产品变了
- **破坏性变更必须显式标注**，并写清迁移动作
- 与 `apiVersion` 的关系：契约升版时，在条目里点明"需要迁移"
