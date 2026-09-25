# 实施路线图（agent-base 规范工作清单）

> **性质**：本文件是 `agent-base` 的**唯一权威工作清单（canonical worklist）**。包选择、依赖顺序、闭包与后继切换以本文件为准。
> **来源**：逐条派生自 [`docs/design/2026-09-25-unified-agent-base-design.md`](../design/2026-09-25-unified-agent-base-design.md) **附录 B（实施顺序）**，不引入设计之外的新工作。
> **状态层**：事实与恢复记录在 `docs/status/`（`CURRENT-STATE.md` / `JOURNAL.md` / `RESUME-NEXT-SESSION.md`）。本文件只回答「做什么、什么顺序、什么算做完」。

---

## 0. 阅读约定

| 记号 | 含义 |
|---|---|
| 包 ID | 沿用设计的 `S0`–`S7`，便于与附录 B 逐行对照 |
| 轨道 | **A 横向（契约先行）** / **B 纵向（pi，关键路径）** / **C 纵向（dsh，比较轨）** |
| 状态 | `pending` / `active` / `blocked` / `done` |
| 包级验收 | 该包自身可判定的完成条件（不依赖后续包） |
| 阶段闸门 | 设计附录 B 原文：**`make validate && make conformance` 全绿，且 `core/` 无 harness 名** |

**关键路径 = B 轨（pi）。** 依据 §1.6 的主力定位：pi 稳定、纯新增、无历史包袱，S2–S5 以 **pi 先全绿**为准；C 轨（dsh）产出用于 §1.4 的选型比较，不压关键路径。

> ⚠️ 附录 B 的阶段闸门写作 `make validate && make conformance`，但 `conformance`（C1–C10）本身是 S2 的 A 轨交付物。因此**在 S0/S1 阶段，包级验收取该包自己的可判定条件**；`make conformance` 从 S2 起才成为各阶段的通用闸门。这是本文件对附录 B 的唯一处显式细化，理由已在包定义中逐条写明。

---

## 1. 包总览

| 包 | 轨道 | 目标 | 依赖 | 状态 |
|---|---|---|---|---|
| **S0** | A | 中性定义契约：schema + 能力目录 + 参数层清单 | — | **done** |
| **S1** | A | 四闸门框架 + 假网关 + 统一轨迹 schema | S0 | **done** |
| **S2** | A + B + C | `render` + `doctor`（pi 与 dsh）+ `conformance` C1–C10 | S1 | **pi 侧完成**（10/10）；**dsh 侧 7/10**（余 C3/C6/C7，见 §13） |
| **S3** | A + B + C | 探针 + smoke + `template/` + `new-agent` + 基座镜像 + 本地开发环境 | S2 | **闭环**（全部交付；Makefile 30 个目标、0 个未实现） |
| **S4** | A + B + C | `examples/idea-to-proof` 全绿（含 C5/C8） | S3 | **闭环**（`make examples-check` 全绿：四道闸门 → 可用） |
| **S5** | A + B + C | `examples/contract-review`（带 MCP，双 harness 等价性） | S4 | pending |
| **S6** | A | `docs/` 全 12 篇 | S4 | pending |
| **S7** | A | `CHANGELOG` + 版本策略 | S6 | pending |
| **S8** | A | **气隙构建**（内网：基础镜像 / npm 源 / 搬运包） | S3 | pending —— **I2 答复后新增** |

**最小可评审单元 = S0 + S1**（设计附录 B 原文）。它们是「适配契约」（§5）的具体化；S0–S1 交付后即可用真实适配器（先 pi）检验契约是否够用。

**P4 已定不额外造桩**：`conformance` 的 C1–C10 本身就是契约的可执行形态，不预先写「假 harness」。

---

## 2. 包定义

### S0 — 中性定义契约

| 项 | 内容 |
|---|---|
| **目标（outcome）** | 中性定义（`agent.yaml` / `connectors.yaml`）有机器可读的唯一真源；「字段属于制品层还是参数层」有可执行清单，而不是文档里的一句话 |
| **范围** | `core/spec/agent.schema.json`、`core/spec/connectors.schema.json`、`core/catalog/capabilities.yaml`、`core/catalog/params.yaml`、`core/README.md`（含 §12.1 层纪律原话） |
| **明确不含** | 渲染器、`doctor`、闸门 2–4、`conformance`、任何 harness 名字（`core/` 纪律） |
| **依赖** | 无 |
| **包级验收** | ① 两个 schema 是合法 JSON Schema 且能拒绝 §4.2/§4.3 之外的多余字段；② `capabilities.yaml` 覆盖 schema 的全部业务字段，每个字段记录类型/默认值/取值范围/**所属层**/支持该字段的 harness 及降级行为；③ `params.yaml` 与 `capabilities.yaml` 的「所属层」标注**双向一致**；④ `core/` 内无 harness 名；⑤ 存在一个可执行的校验入口并通过（见下） |
| **设计依据** | §4.2、§4.3、§4.6、§2.3、§12.1、§4.7（`apiVersion`）、N18、N26 |
| **风险** | 中性格式是「两个 harness 的最小公倍数」，可能损失表达力（§14 风险 3）——表达力由 §4.5 业务级增强承接，故 schema 应**刻意保持小**，不要为未来预留字段 |

> **对附录 B 的细化（需评审）**：附录 B 把 `core/gates` 框架整体归入 S1，但 S0 的完成判据要求「可执行校验」。本包因此包含**闸门 1 所需的最小校准入口**（`tools/validate.mjs` + `Makefile` 的 `validate` 目标），S1 再在其上补齐闸门 2–4 的框架、假网关与轨迹 schema。理由：schema 若无校验器即等于「空骨架」，无法满足「每个包交付物可被他人直接使用」。

### S1 — 验证框架基线

| 项 | 内容 |
|---|---|
| **目标** | 「可用 = 四闸门全过」有可执行的框架承载；模型探针可以在**零凭据**下跑 |
| **范围** | `core/gates/`（编排、断言语言、报告格式）、`tools/fake-gateway/`（协议无关核心 + 协议适配）、`core/trace/schema.json`（统一轨迹事件 schema） |
| **依赖** | S0 |
| **包级验收** | ① 闸门框架能加载并执行断言集，输出 §6 规定的报告格式；② 假网关在无任何凭据下响应模型探针；③ 轨迹 schema 就绪：七类事件 + `native.raw` 兜底（未映射事件必须带 `reason`，不许丢弃）；**两个 harness 各自的 `trace.mjs` 原生事件映射属于 S2**（§5.3/§5.7 把 `trace` 列为适配器 SPI，按 §2.4 拓扑落在 `adapters/<h>/`） |
| **设计依据** | §6、§8.3、§2.6 P1、N14 |

### S2 — 适配器与准入门槛

| 项 | 内容 |
|---|---|
| **目标** | 两个 harness 都能渲染并自证；新 harness 的准入门槛以可执行用例存在 |
| **A 轨** | `conformance/` 用例 **C1–C10** + `run.mjs`；**全为阻断性门槛**（P3 决策） |
| **B 轨（关键路径）** | `adapters/pi/`：`render.mjs` + `doctor.mjs`（§10.2） |
| **C 轨（比较轨）** | `adapters/dsh/`：`render.mjs` + `doctor.mjs`（§11.2） |
| **依赖** | S1 |
| **包级验收** | ① `make conformance` 全绿，**含 C5（静默失败检测力）与 C8（参数层隔离）**；② `doctor` 输出 §6.3 的**七个字段**（含 `enhancements[]`、`effectiveConfigDigest`）并满足三条硬断言（技能集合、连接器集合、已加载扩展 id 集合 == 声明集合）；③ 渲染确定性：同输入两次渲染 digest 相同（C2）；④ `core/` 无 harness 名 |
| **验收项拆分（实现期发现，2026-09-25）** | `conformance` 的 **C6（零凭据闸门 3/4）依赖 probe / smoke**，**C9（安全下限声明一致）依赖容器内加固参数** —— 两者按附录 B 都属 **S3**。因此 S2 能绿的只有 C1–C5、C7、C8、C10；**C6/C9 未实现时 runner 记 pending 并非零退出**（不做"跳过即通过"这种事）。这两项在 S3 补齐。 |
| **设计依据** | §5.6、§6.3、§10.2、§11.2、N11、N13 |

### S3 — 业务面命令与模板

| 项 | 内容 |
|---|---|
| **目标** | 业务开发者从模板到四闸门全绿**不需要理解任何 harness 概念** |
| **A 轨** | `template/`（开箱可跑、无 TODO）+ `tools/new-agent.mjs` |
| **B/C 轨** | 探针（闸门 3）+ smoke（闸门 4） |
| **依赖** | S2 |
| **包级验收** | ① `make new-agent NAME=x` 后立刻 `make validate && make render HARNESS=pi && make doctor HARNESS=pi` 全绿；② `grep -rn TODO my-agent/` 为空；③ `my-agent/` 内无 `package.json`、无绝对路径（schema 拒绝绝对路径，§9.2）；④ 业务向文件中不出现 harness 专有术语（§13 纪律） |
| **设计依据** | §12.2、§12.3、§6.4、§6.5、N4 |

### S4 — 首个示例走通（关键路径达成）

| 项 | 内容 |
|---|---|
| **目标** | **基座的核心目标在此包被证明**：一个业务智能体的想法被「验证走通」（E2E = 四闸门全绿） |
| **A 轨** | `examples/idea-to-proof`（纯技能型） |
| **B 轨** | pi 四闸门全绿（含 C5/C8）；走通 §12.4 流程甲 |
| **C 轨** | dsh 四闸门全绿（含 C5/C8） |
| **依赖** | S3 |
| **包级验收** | ① `make verify HARNESS=pi` 四闸门全绿，给出「可用/不可用」+ JSON 报告；② 流程甲（`dev-env → new-agent → 写业务 → validate → run-local → verify → image`）可被第三方按文档复现；③ `examples/` 整删后基座仍能 `validate` + `conformance`（N5） |
| **设计依据** | §1.1、§12.4、§6.8、N5、N22 |

### S5 — 双 harness 与等价性

| 项 | 内容 |
|---|---|
| **目标** | 「同一份定义，两个 harness」这句话被证明；等价性差异**全部显式**（豁免或失败），不允许沉默不等价 |
| **A 轨** | `examples/contract-review`（带 MCP，正好演示双 harness） |
| **B/C 轨** | 等价性比对通过（§6.6 断言集比对） |
| **依赖** | S4 |
| **包级验收** | ① `make verify HARNESS=pi,dsh` 通过；② 每一处不等价都落在 `adapters/<h>/exemptions.yaml` 里，且豁免带复核期限；③ §4.5 业务级增强的最小示例可跑，且闸门 2 的扩展 id 集合断言在**故意漏声明**时变红 |
| **设计依据** | §1.4、§6.6、§4.5、§5.5、N19 |

### S6 — 文档体系

| 项 | 内容 |
|---|---|
| **目标** | 平台与业务都能自助接手；**失败模式清单不缺位** |
| **范围** | §13 的 12 篇文档；`docs/03-capability-catalog.md` 由 `core/catalog/capabilities.yaml` **生成**（保证文档与实现不漂移） |
| **依赖** | S4（文档描述的行为必须已存在） |
| **包级验收** | ① 12 篇齐全，`07-troubleshooting.md` 含两个 harness 的静默失败表；② 业务向文档（01–05、07）无 harness 专有术语（唯一例外 `11-harness-enhancements.md`）；③ `03` 由工具生成而非手写 |
| **设计依据** | §13、N27、N6 |

### S7 — 版本与变更策略

| 项 | 内容 |
|---|---|
| **目标** | 中性定义的契约变更可追溯；升级有回归网 |
| **范围** | `CHANGELOG.md`、版本策略（中性定义 schema 变更走 CHANGELOG，N28）、`conformance` 作为升级回归网 |
| **依赖** | S6 |
| **包级验收** | ① `CHANGELOG.md` 记录 S0–S6 的契约变更；② 版本策略明确「哪些变更升 `apiVersion`、哪些只升基座版本」；③ `render` 遇到不支持的 `apiVersion` **显式失败**（不是警告） |
| **设计依据** | §4.7、N28、§14 风险 1 |

---

## 3. 跨包纪律（每个包都必须满足）

1. **`core/` 零 harness 依赖**：`core/` 内不得出现任何 harness 名字（新增 harness 不改 `core/`）。这是每阶段的通用闸门。
2. **层纪律写入文件头注释**（§12.1 原话），`core/`、`adapters/<h>/`、`template/`、`examples/` 各自的 README 必须包含本层「放什么 / 不放什么」。
3. **行为烤、参数下放**（J2）：任何新字段都要先回答「改了它，同一输入会不会得到不同行为？」会 → 制品层；不会 → 参数层。
4. **静默失败必须变红**：任何「配置写错但不报错」的路径，都要在闸门 1 注入用例或闸门 2 集合断言里被抓到，**不允许只打警告**。
5. **可复现**：构建期产物是确定性的，同 digest = 同行为（N19）。
6. **不预留桩**：不为第三个 harness 写占位代码；`conformance` 即契约。

---

## 4. 待外部输入（不阻塞实现，§15.2）

| # | 输入 | 阻塞什么 | 未到位时的处理 |
|---|---|---|---|
| **I1** | 企业 LLM 网关地址与协议，以及**是否保真转发 `tools` 与流式** | 闸门 3 接真实网关 | 用假网关跑（N14）；接真网关前先跑假网关以区分网络层与配置层问题。**这是最可能推翻本方案的一条** |
| **I2** | 内网能否直连 npm / 拉公共基础镜像 | 基座镜像构建（§8.1） | 先本地构建；若需私仓，改动局限在 `core/image/Dockerfile.base` 的镜像来源与 npm 配置，不影响适配契约 |
| **I3** | 第一批业务智能体场景 | 校验 §4.2/§4.3 字段是否够用 | 不阻塞：示例已定（`idea-to-proof` + `contract-review`），且 `examples/` 可整体替换 |

---

## 5. 维护规则

- 包状态变化、依赖调整、闭包与后继切换 → **改本文件**（`project-state update` 同步 `CURRENT-STATE.md` 的 `Active work package`）。
- 包的事实性进展（提交、验证结果、被否决的路径）→ **记 `docs/status/JOURNAL.md`**，不写进本文件。
- 会话交接 → **`docs/status/RESUME-NEXT-SESSION.md`**。
- 设计变更（架构、公开契约、安全）→ 先改 `docs/design/` 正文，再回来改本文件的包定义，**不允许只改路线图**。

---

## 6. 附加工作流：预装清单（独立产物）

**为什么单列**：预装内容的升级节奏与核心契约完全不同 —— 核心契约动一次要全企业重建，预装清单只是换几个 pin。因此它是一种**独立可升级产物**，不绑在任何一个包的交付节奏上。

| 项 | 内容 |
|---|---|
| 产物 | `core/image/preinstall.yaml` —— 验证基座镜像预装什么，以及**开发者面向的引用名**（`namedReferences`） |
| 目的 | **让开发智能体这件事便捷**（判据 = 用户对「快」的定义：心智负担低、约定明确、改动局部化、非专家可上手）。不是生产化的能力裁剪 |
| 校验 | `make validate` 的 `preinstall/*` 组（10 项）：必填字段、精确 pin、分类、id 唯一、技能 planned/shipped 自洽、排除项理由、**每条 devUse**、**引用名契约双向一致**、凭据引用名合法 |
| 消费方 | 基座镜像构建（**S3**）按清单生成；模板（S3）默认启用一个开发常用子集，保证 `new-agent` 后立刻能 `verify`（N4） |

**待确认的公开契约变更（不确认不实现）**：清单目前提供 11 个开发者可见引用名，但要让它真正省事，`connectors.yaml` 需要支持**按名引用基座预装条目**：

```yaml
mcpServers:
  - ref: filesystem          # 开发者只写这一个名字
    enabled: true
  # 渲染器按 preinstall.yaml 解析成 transport / command / args / 版本
```

- 现状：§4.3 要求每条连接器都写全 `transport` + `command/args` 或 `urlRef` + 包名版本 —— 开发者必须知道实现细节，与「心智负担低、非专家可上手」相悖。
- 影响面：`core/spec/connectors.schema.json`（新增 `ref` 形态，与原形态二选一）+ `core/catalog/{capabilities,params}.yaml` + 渲染器（S2）+ 设计 §4.3/§4.6。
- 与既有决策的关系：**不冲突**，反而更贴 P-a（能力=基座持有的包与版本；选择=智能体写不写这个 ref）与「升级局部化」（换 pin 只改一处，所有智能体受益）。

---

## 7. S2 未完成项：dsh 适配器（预检已做，实现未做）

**当前仓库状态（诚实标注）**：`adapters/dsh/` 已有 `adapter.yaml`（能力声明，全部来自实测/上位文档）、`failures.md`、`failure-cases.yaml`、`exemptions.yaml`；
**`render.mjs` / `doctor.mjs` / `trace.mjs` 尚未实现**。因此 `make conformance` 对 dsh 会报 C2/C3/C4/C5/C7/C8 未通过 ——
这是 runner 的预期行为（未实现不算通过），不是回归。

### 7.1 预检实测结论（可直接作为实现依据）

| 项 | 实测结果 |
|---|---|
| 版本 | `0.1.7-rc.1`（RC，接口可能变；升级时只复核 `adapters/dsh/`） |
| **零凭据自证原语** | `dsh <name> --from-default-profile <tpl> --dump-config` 打印组合后的完整 profile 树后退出，不 mount、不连网 |
| shipped 模板 | `acp` / `headless` / `sdk` / `sdk-minimal` / `web`（**`tui` 不是 shipped 模板**） |
| profile 目录 | `$DSH_HOME/profiles/<name>/{cordis.patch.yml, package.json, cordis.yml, pnpm-workspace.yaml}` |
| patch 形状 | 顶层 **YAML 数组**；元素为 `{id, name, config, disabled}`（覆盖既有 row）或 `{insert: [<row>…]}`（新增 row）；`!!js` 表达式可用 |
| profile 元数据 | `package.json` 里 `dsh.profile.bundles: [@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app]` |
| 关键 row 及其 config | `agent-instructions` → `{maxBytes}`（**它是工作区 AGENTS.md/CLAUDE.md 的发现器，persona 不由 config 注入**）；`agent-default-model` → `{provider, model}`；`skill-filesystem` → `{customSkillDirs: [...]}`；`tool-skill` 负责暴露技能工具；MCP 每服务器一条 `@deepseek-ai/dsh-mcp-client` row |
| 原生轨迹 | `$DSH_HOME/sessions/--<cwd>--/<id>/session.v4.jsonl`，**zstd 压缩的 JSONL**；记录骨架 `{type, seq, time, data}`，type 用 `/` 命名空间 |
| 轨迹类型（实测） | `session`(头) · `request/context`{contextWindow, model, provider} · `request/header` · `assistant/message`{message, usage} · `assistant/chunk` · `text-chunks` · `reasoning-chunks` · `tool-call-chunks` · `tool/call`{arguments, callId, name} · **`tool/result`{error, message, step, turn}（无 callId，需按 step 内顺序配对）** · `step/start`/`step/end` · `turn/start`/`turn/end` · `permission/preset` · `sandbox/mode` · `approval/policy` · `agent/inbox/spliced` · `session/title` |
| 比另一个 harness 强的地方 | **原生的审批与沙箱事件** → 它能回答「谁放行了这次调用」（缺口 G3 在两边不对称） |

### 7.2 实现前必须先定的三个问题（不要猜）

| # | 问题 | 候选 | 影响 |
|---|---|---|---|
| **Q1** | persona 怎么进产物 | ① 渲染 `workspace/AGENTS.md`，运行期把该目录挂成 cwd（`agent-instructions` 按工作区根发现它，`.git` 为根标记）；② 找别的注入路径 | 决定渲染产物的顶层布局（是否要第二个输出根 `workspace/`） |
| **Q2** | `customSkillDirs` 写什么路径 | ① 固定镜像内路径（如 `/opt/agent/skills`），manifest 记录映射，本地/暂存运行期用挂载或软链对齐；② 写渲染时绝对路径 | 决定「同一产物在本地与容器是否都能跑」。①更贴 §11.2「相对引用解析成镜像内固定路径」 |
| **Q3** | `dsh.profile.bundles` 取哪套 | ① 照抄 shipped `web`（base + web-app，已验证能组合）；② 只 base（headless 取向，未验证） | 决定 profile 能否在 headless 下独立启动 |

### 7.3 实现顺序建议

1. 先定 Q1–Q3（它们决定产物布局，改起来会牵动 doctor 与 conformance）
2. `render.mjs`（完整 config、不做增量假设 —— 直接对治 D6「重述腐化」）
3. `doctor.mjs`（靠 `--dump-config` 组合树；**必须补上 patch target id 校验**，那是 D1 唯一的防线）
4. `trace.mjs` + `conformance/fixtures/dsh-native-events.jsonl`（按 7.1 的轨迹类型表；`tool/result` 的 callId 配对要写进 trace-mapping.md）
5. 跑 `make conformance` 直到 dsh 的 C2–C5/C7/C8 转绿；C6/C9 仍待 S3

---

## 8. S3 进展（2026-09-25）

**已交付**：`tools/probe.mjs`（闸门 3）、`tools/smoke.mjs`（闸门 4）、`tools/verify.mjs`（四道闸门编排 → §6.7 报告 + `usable`）、`adapters/pi/run.mjs`（运行器，三个消费者共用）。

**里程碑**：**四道闸门首次全过，`usable: true`** —— 基座「帮助业务智能体把想法验证走通」这句话第一次成为可执行的事实，而不再只是设计承诺。
实测路径：`make verify AGENT_DIR=<agent>` → 闸门 1 静态 → 渲染 → 闸门 2 自证 → 闸门 3 探针 → 闸门 4 冒烟全绿；冒烟里 `tools.deny: [bash]` 也被验证生效（只用了 `read`）。

**conformance 状态**：pi 侧 **C1–C8、C10 全绿**（含 C6 零凭据闸门 3/4），仅 **C9**（容器内安全实测）待 S3 的镜像与加固参数。

**S3 余项**：`template/` + `new-agent`（开箱可跑）、`core/image/`（基座镜像 + debug 变体）、`make dev-env` / `run-local`、`image` / `debug`。C9 依赖其中的容器内加固。

**由此暴露的一类 bug 已治本**：`--out`/`--endpoint` 缺失时把第一个位置参数误当旗标值吞掉 —— 同一行写法出现了**两次**（`render` 与 `probe`）。已抽出 `core/gates/cli.mjs` 统一解析，并加了 5 条自检，防止第三次。

---

## 9. S3 续：`template/` + `new-agent`（2026-09-25）

**已交付**：`template/`（`agent.yaml` · `connectors.yaml` · `skills/example/SKILL.md` · `Makefile` 薄转发层 · `README.md` · `.gitignore`）与 `tools/new-agent.mjs`，以及 `tools/new-agent-selftest.mjs`。

**判据（§12.2）逐条实测通过**（`make new-agent-selftest` 全绿）：

| 判据 | 结果 |
|---|---|
| 生成后立刻 `make validate && make render && make doctor` 全绿 | ✅ 且**跑的是生成出来的 Makefile**，证明转发层本身可用 |
| `grep -rn TODO` 为空 | ✅ |
| 无 `package.json` | ✅ 业务方不需要管依赖 |
| 无绝对路径 | ✅ 基座引用是**相对路径**（`AGENT_BASE_DIR ?= ../..`），便于整体搬迁 |
| 端到端 | ✅ 派生后 `make verify` 直接给出**「可用：四道闸门全过」** |

**派生位置**：默认落在基座仓库的**同级目录**（应用在基座之外，§1.2），可用 `--out` 覆盖。

**顺带修掉的两个真 bug**：

1. **构建产物必须排除出定义摘要**：模板把渲染输出放在 `.render/`，而 `digest.mjs` 没排除它 → 渲染一次摘要就变，「同输入同 digest」当场不成立。已把 `.render`/`dist`/`.agent-base-build` 加入 `DEFAULT_EXCLUDES`。
2. **符号链接导致相对路径错位**：macOS 上 `/tmp`→`/private/tmp`、`/var`→`/private/var`。用未解析的路径算相对路径会得到"算式正确、实际指错"的结果（实测算成了 `/private/Users/...`）——因为 `make` 会规范化 CWD。已改为双方都 `realpath` 后再算；生成的 Makefile 也加了 `check-base`，路径不对时给人话而不是 `MODULE_NOT_FOUND`。

**S3 余项**：`core/image/`（基座镜像 + debug 变体）、`make dev-env` / `run-local` / `image` / `debug`；C9 依赖容器内加固。之后才是 `examples/`（S4/S5）。

---

## 10. S3 续：基座镜像（2026-09-25）

**已交付**：`core/image/` 的 `Dockerfile` · `Dockerfile.debug` · `entrypoint.sh` · `gen-preinstall-lock.mjs` · `build.mjs`；`make image` / `image-all` / `image-manifest` / `image-debug` / `debug` / `image-lock`。

### 10.1 为什么**按架构分开构建**，而不是一次 `--platform a,b`

用户明确要求同时支持 **arm64 与 amd64**（开发机是 M3 Max/arm64）。做法：

- **主路径**：`--arch <a>` 单架构构建 + `--load` —— 本机架构原生（arm64 实测 ~90 秒），另一架构走 QEMU 模拟（隔离，且一架构失败不会毁掉整个构建，排查时能分清"代码问题"还是"模拟问题"）
- **打包路径**：`--manifest` 用 `docker-container` 驱动的 builder 产出**真正的多架构 manifest list**（OCI 归档落盘）
- 日常开发不为模拟付代价，消费者最终仍拿到"一个 tag 两个架构"

### 10.2 本机的容器环境（OrbStack）

本机 Docker **一直由 OrbStack 管理**（不是 Docker Desktop）。对镜像工作有三点直接后果：

| 事实 | 后果 |
|---|---|
| context 只有 `docker` 驱动（`default` 与 `orbstack` 两个 builder 都是） | **该驱动连多平台构建都不支持**。实测两条报错：<br>· `docker buildx build --platform linux/amd64,linux/arm64` ⇒ `Multi-platform build is not supported for the docker driver`<br>· 加 `--load` ⇒ `docker exporter does not currently support exporting manifest lists`<br>**同一条命令加 `--builder ab-multi`（docker-container 驱动）即退出码 0。** 所以多架构**只能**用自建的 container builder —— 这不是多此一举，是本环境下的唯一路径（另一条路是打开 containerd 镜像存储，但 OrbStack 未暴露该开关：`orb config get` 查无此键） |
| **手敲的朴素命令能不能用，取决于"当前 builder"** | `docker buildx build` 不指定 builder 时用当前选中的那个。本机默认是 OrbStack 的 docker 驱动 ⇒ 多平台直接失败。`make image-builder` 会把 container builder 建好**并设为当前**，之后最朴素的这条即可工作：<br>`docker buildx build -f Dockerfile --platform linux/arm64,linux/amd64 -t my-image .`（实测 EXIT=0）<br>**但它会给出 WARNING：不加 `--load`/`--push`/`--output` 时结果只留在 build cache，`docker images` 里看不到** —— "构建成功"与"拿到镜像"是两件事 |
| 三个终点各有前提 | `--load` 单架构可用 / `--push` 需配好的 registry（本地 HTTP registry 还要 insecure 配置）/ `--output type=oci` 无需 registry。**"构建成功"与"落到哪里"是两件事**，别混 |
| x86_64 走 Rosetta 模拟（比 QEMU 快） | amd64 镜像构建/实测代价可接受（实测 base+debug 约 2.5 分钟） |
| builder 是容器形态，OrbStack 重启后可能未就绪 | `--manifest` 复用 builder 前先 `inspect --bootstrap` 确保就绪，否则会拿到含糊的 "no builder" 失败 |

### 10.3 实测踩到的四个坑（都已固化进代码或检查里）

| 坑 | 现象 | 处置 |
|---|---|---|
| 默认 `docker` 驱动不支持 OCI 导出 | `--manifest` 报 "OCI exporter is not supported for the docker driver" | 自动创建 `docker-container` 驱动的 builder（官方建议路径） |
| 调试变体的基础镜像 tag 猜错 | `tag.replace(/-debug$/,"")` 不匹配 `...-debug-arm64` ⇒ 指回自己 ⇒ 拉取失败 | 显式传基础镜像 tag，不做字符串猜 |
| 「预热 npx 缓存」是伪需求 | `npm cache add` 后仍 ENOTCACHED；真正生效的是**按精确 pin 全局安装**（npx 直接用它，不碰 `_npx`） | 删掉预热步骤，只做全局安装 |
| **检查写错方向** | C9 一度测 `npx --offline`（系统从不使用的命令）⇒ 必然 ENOTCACHED ⇒ 报出**假缺陷** | 改为测**连接器真正跑的命令** `npx -y <pkg>@<ver>`，断网下逐条验 |

> 第 4 条值得单独记住：**检查写错方向比漏检更糟** —— 它会让人去修一个本来正确的东西。

### 10.4 一次自纠：Dockerfile 不该要求构建参数

最初 Dockerfile 硬性要求 `HARNESS_SPECS` 构建参数，于是**最普通的一条 buildx 命令跑不起来**（少一个 `--build-arg` 就报错）。这是纯粹的摩擦：坐标表本来就已经生成进构建上下文（`harnesses.lock.json`），Dockerfile 直接读它即可。已去掉该参数。顺带修掉一个自己写出的 shell bug —— **`while read` 循环里跑 `npm`，npm 会吃掉 stdin**，读循环被 `set -e` 打断；改回 `for` 形式。

### 10.5 分层纪律的一次自纠

坐标表最初用 harness 名做键，被 `core/harness-name` 判红；去掉名字改用包坐标后**仍**判红 —— 因为**包名本身就含 harness 名**（scope 与包名里都有）。最终处置不是放宽规则，而是纠正分层：**生成的构建输入不是源码**，落到 `dist/image/context/`（已 gitignore），`core/` 只留人工维护的源文件；harness 的可执行名归 `adapters/<h>/adapter.yaml` 的 `bin:`。

**S3 余项**：`make dev-env`（按 pin 装/校验两个 harness）、`make run-local`（临时 HOME 挂渲染产物）、`examples/`（S4/S5）、dsh 适配器。

---

## 11. S3 收口：本地开发环境（2026-09-25）

**已交付**：`tools/dev-env.mjs`（`make dev-env`）· `tools/run-local.mjs`（`make run-local`）· `tools/local-selftest.mjs`（`make local-selftest`）。

至此**上手路径三段全通**，且每一段都有可重复的判据：

| 段 | 命令 | 判据 |
|---|---|---|
| 派生 | `make new-agent NAME=x` | `new-agent-selftest`：§12.2 四条全过，派生即 `usable` |
| 本地开发 | `make dev-env` + `make run-local` | `local-selftest`：版本与 pin 一致 + 临时 HOME 隔离生效 + 真跑到模型 + 未污染本机 `~/.pi` |
| 边界（容器） | `make image` + `make debug` | `conformance C9`：容器下限十项实测 |

**设计要点**：`run-local` 跑的是**渲染产物**而不是源码目录，并且沿用**临时 HOME + 中立 cwd**（P-b：隔离靠文件系统）——因为该 harness 有两个隐式技能源（其中一个沿 cwd 祖先发现），不隔离干净就会"技能多出来一个"，而那种失败在本地与容器里表现不一致，正是最难查的一类。

**纪律**：未实现的 harness 必须**响亮失败**（`adapters/<h>/run.mjs` 不存在即拒绝），不许静默改用另一个 harness —— 那会让跨 harness 的结论失真。

**Makefile 状态**：30 个目标，**0 个未实现**（不再有 `NOT_YET` 桩）。

**S3 之后**：`examples/`（S4/S5，首批走通示例）· dsh 适配器（比较轨）· 镜像推送路径（待 I2）。

---

## 12. S4：首个示例走通（`examples/idea-to-proof`）

**判据（设计原文）**：示例四道闸门全绿（含 C5/C8）。**实测达成** —— `make examples-check` 全绿，
其中「四道闸门 → 可用（退出码 0）」。

### 12.1 交付内容

| 文件 | 说明 |
|---|---|
| `agent.yaml` | 人设（三条不可松的纪律）+ 模型 + 边界 `tools.deny: [bash, write, edit]` |
| `connectors.yaml` | 空 —— 纯技能型 |
| `trace-labels.yaml` | 业务给轨迹起的说法（基座不解释，只机械查找后呈现） |
| `skills/{claim-extraction,falsifier-design,evidence-grading}/SKILL.md` | 三个真正干活用的技能，串成完整工作流 |
| `skills/evidence-grading/scripts/check-table.mjs` | 技能脚本（带 `--selftest`）：校验产出表格的结构，专治"看起来完整、实则漏项" |
| `examples/README.md` + 示例内 `README.md` | 怎么跑、怎么改、四道闸门各证明什么 |
| `tools/examples-check.mjs`（`make examples-check`） | 结构 + 四道闸门 + 技能脚本自检 + **不变量 N5** |

### 12.2 这个示例刻意不做的事

**没有 `harness/<runtime>/` 目录。** 它的价值正是证明「纯中性定义 + 技能」已经够用 ——
等真需要自定义工具/钩子时再加业务级增强。把增强塞进第一个示例会掩盖"什么情况下才需要它"。

### 12.3 顺带钉死的一个 bug 类别

`examples-check` 一开始就撞上参数解析问题 —— 而这**已经是同一类 bug 的第三次**（`render` / `probe` / `labels`）：

```js
const pos = args.find((a, i) => !a.startsWith("--") && i !== args.indexOf("--out") + 1);
```

旗标缺席时 `indexOf` 返回 -1，`-1 + 1 === 0` 会把**第一个位置参数**吞掉，命令直接报用法错误。

处置不是"再修一次"，而是治本三连：
1. 统一到 `core/gates/cli.mjs` 的 `parseArgs`（按"旗标吃掉它的值"推进，不会误吞）；
2. `render.mjs` 里那个打过补丁的老写法也一并改掉 —— 留着等于第二种写法；
3. **闸门 1 增加静态检查 `cli/no-naive-flag-skip`**，扫到这种写法即失败（含自检：它确实抓到了 `render.mjs`）。

### 12.4 不变量 N5 的验证方式

`examples-check` 静态确认 `core/` `tools/` `adapters/` 中**没有任何对 `examples/` 的引用**，
并单独跑一次基座自洽（不带任何智能体定义）—— 于是"整个 `examples/` 可删"不是一句口号。

---

## 13. dsh 适配器：渲染器 + doctor 已交付（2026-09-25）

**已交付并验证**：`adapters/dsh/render.mjs` + `adapters/dsh/doctor.mjs`（闸门 2，单跑九项全绿）。验证方式是**让真实 harness 组合我们的 profile**：
`DSH_HOME=<产物>/dsh-home dsh <name> --dump-config` → 退出码 0，且组合树逐项对上了
（模型覆盖、人设发现启用、技能目录指向镜像内固定路径、安全姿态以 `!!js` 表达式保留、工具边界禁用生效）。

**conformance 现状**：dsh **7/10 通过**（C1 声明完整性 · C2 渲染确定性 · C4 解析自证 · C5 静默失败检测力 · C8 参数层隔离 · C9 安全下限 · C10 退出码契约）；未过 **C3 / C6 / C7**。pi 侧仍 10/10（无回归）。

### 13.1 两处实测推翻/修正

| 项 | 预检结论 | 实测结论 |
|---|---|---|
| bundles（原 Q3） | 照抄 shipped `web` | **改用 `base + dsh-headless`** —— `web` 把 `agent-instructions`/`skill-filesystem`/`tool-skill`/`tool-fs` **全部禁用**（它由 Web UI 驱动），`headless` 才启用 |
| 连接器配置形状 | 未知（曾计划"未验证就响亮失败"） | 从插件 README 拿到**权威形状**：`serverName`/`transport`/`command`/`args`/`url`/`headers`，且官方就用 `!!js process.env.X` 做参数注入 → 与本基座的"参数下放"一致，可以正常渲染 |

### 13.2 自己写 YAML 输出（两个实测教训）

`!!js` 是这个 harness 的惯用表达方式，必须原样输出成表达式：

1. **不能用库的自定义标签**：实测出来是 `!!js [object Object]`（库没走 `stringify`），
   dsh 不会求值 ⇒ 配置静默变错。改为自写这套简单结构的 YAML 输出（可控、确定）。
2. **表达式含 `: ` 必须加引号**：`… ? 'never' : 'ask'` 里的"冒号+空格"是 YAML plain scalar 的
   禁区，会被当成嵌套映射 ⇒ 配置静默变成 `{'[object Object]': ask}`。
   处置：`plainSafe()` 判定，必要时输出 `!!js "表达式"`（**标签在引号外面**）。

> 两条都属于同一类：**格式层的细节错误不会报错，只会让配置静默变成别的意思**。所以 doctor 必须
> 对着组合树断言姿态，而不是相信渲染器写对了。

### 13.3 doctor 交付内容（闸门 2 · 零凭据）

靠 `--dump-config`（组合后打印完整 profile 树后退出，不挂载不连网）。九项检查全绿，其中：

| 检查 | 作用 |
|---|---|
| `resolution/patch-targets` | **D1 的唯一防线**：patch 的每个 target id 必须出现在组合树里。该 harness 对"目标不存在"**只打警告、退出码 0**，所以这条是基座在替上游报它不报的错 |
| `resolution/model-routes` | 实际生效的模型来自本次渲染产物，不是宿主配置 |
| `resolution/skills-set` | 硬断言 1（口径：已配置且就位 —— 见下"不对称"） |
| `resolution/connectors-set` | 硬断言 2（只认 `dsh-mcp-client` 行；`mcp-resources` 是 base 自带的，不是业务连接器） |
| `resolution/enhancements-set` | 硬断言 3（**这边是真观测**：组合树列出全部 row） |
| `resolution/posture` | 我们显式声明的安全姿态与工具边界，在组合树里真的生效 |

解析组合树踩到的坑（都已修）：**不能用正则抓 config 块** —— 被两种形态坑过：数组值（`customSkillDirs:` 后跟 `- 值`）与折行值（`policy: !!js >-` 后跟续行）。改为**按行 + 缩进的状态机**。另外：组合树里**没有 `disabled` 行 = 默认启用**，不是"不在树里"。

### 13.4 三项"检查按第一个 harness 的形状写死"——已修两项

**已修（都在检查侧治本，没有去改适配器迁就检查）：**

| 用例 | 原来的问题 | 处置 |
|---|---|---|
| **C5** | 注入器把 pi 的产物路径（`agent-dir/...`）硬编码在检查代码里，不认识 dsh 的 `patch-target-missing` | 改为**声明式注入**：适配器在 `failure-cases.yaml` 里给出 `inject: {file: glob, append: 文本}`，检查侧只负责执行。于是加第二个 harness 不必改检查代码。**实测证据：`D1→20`** —— 刚写的 D1 防线被机器抓到了 |
| **C4** | 用例助手声明的业务级增强是 pi 形态（`entry: extensions/x.ts`），dsh 的增强是 cordis 插件 npm 包 ⇒ 声明的增强进不了组合树 | 增强**声明形态由适配器决定**：`adapter.yaml` 新增 `enhancementShape: file \| package`，助手据此写声明。这也是"契约归适配器、不归检查" |

> 顺带抓到一个**会掩盖真因**的写法：`adapterField()` 的 try/catch 把"忘了 import YAML"也吞了，
> 于是形态判断静默回退成默认值，表现为"dsh 又拿到错声明"。已补 import，并让 catch 出声。

### 13.5 仍未过的一项检查 + 两个适配器缺口

| 项 | 状态 | 下一步 |
|---|---|---|
| **C3** 渲染完整性 | 未过。检查按 pi 的产物形状写死（找 `AGENTS.md`、`settings.json`、`extensions`） | 改成**以 manifest 为映射**的中性契约：渲染器在 manifest 里声明「定义字段 → 产物位置」（`expresses` 映射），检查只验证声明的位置存在且内容对。认死文件名等于把第一个 harness 的形状当契约 |
| **C6** 零凭据闸门 3/4 | 未过。`tools/probe.mjs` / `smoke.mjs` 目前只走 pi（`adapters/pi/run.mjs`） | 需要 `adapters/dsh/run.mjs`（运行器），让 probe/smoke 对 dsh 也能跑 |
| **C7** 轨迹合规 | 未过，`trace.mjs` 未实现 | 会话是 zstd 压缩 JSONL v4；`tool/result` **没有 callId**，需按 step 内顺序配对 |

| 用例 | 失败原因 | 该改什么 |
|---|---|---|
| **C3** 渲染完整性 | 检查按 pi 的产物形状写死：找 `AGENTS.md`、`settings.json`、`settings.extensions`。dsh 的产物是 profile patch + `workspace/AGENTS.md`，形状根本不同 ⇒ 误判 | 改成**以 manifest 为映射**的中性判定：渲染器**声明**每个定义字段落在产物的哪个位置，检查只验证"声明的位置存在且内容对"。认死文件名等于把第一个 harness 的形状当成契约 |
| **C4** 解析自证 | 用例助手 `makeFullAgent` 声明的业务级增强是 pi 形态（`entry: extensions/risk-score.ts`）；dsh 的增强是 **cordis 插件 npm 包**，渲染器按 `package` 字段处理 ⇒ 声明的增强进不了组合树 | 让用例助手按被测 harness 写**该 harness 形态**的增强声明（pi: 文件；dsh: 包） |
| **C5** 静默失败检测力 | 注入器不认识 dsh 的 `kind: patch-target-missing`（我已在 `failure-cases.yaml` 声明 D1 用例，但 runner 没有对应注入实现） | 加该注入：往 patch 里塞一个不存在的 target id，doctor **必须**报错（这条正是我新写的 D1 防线，值得机器验证） |

> **注意**：这三项都不是"适配器还不行"，而是"**检查把第一个 harness 的形状当成了契约**"。
> 因为踩过"检查写错方向比漏检更糟"，这里不打算改适配器去迁就检查。

### 13.6 dsh 轨余项（按依赖排序）

1. `adapters/dsh/run.mjs`（运行器）→ 解锁 **C6**（probe/smoke 对 dsh 也能跑）与 `run-local --harness dsh`
2. `adapters/dsh/trace.mjs` + `conformance/fixtures/dsh-native-events.jsonl` → **C7**
3. **C3 的中性化**（manifest `expresses` 映射）—— 这是唯一还"按 pi 形状写死"的检查

---

## 14. S8 · 气隙构建（I2 答复后新增，2026-09-25）

**为什么新增**：用户明确「运行环境**肯定不能出内网**」。这不是"以后再说"的偏好，而是硬约束 ——
它决定基座镜像能不能在目标环境里**被构建出来**、交付物能不能**搬进去**。

### 14.1 三个必须可替换的入口

| 入口 | 现状 | 要补的 |
|---|---|---|
| **基础镜像来源** | `Dockerfile` 已有 `ARG NODE_IMAGE=node:24-bookworm-slim`，可整体替换 | 文档化 + 构建脚本暴露该参数（内网仓库地址） |
| **npm 源** | 直接走公网 registry | `ARG NPM_REGISTRY`（或 `.npmrc`）+ 构建期校验"确实走的是内网源"，不靠默认值 |
| **依赖搬运** | 无 | `make image-vendor`：把 pi / dsh / 预装清单里全部 npm 包**打成 tarball 目录**，连同基础镜像 OCI 与构建上下文打成一个可搬运的包；内网侧用 `--offline` 安装 |

### 14.2 两条纪律

1. **"离线可用"必须实测，不能假设**。已有的实测证据：按精确 pin **全局安装**后，连接器
   `npx -y <pkg>@<ver>` 在 `--network none` 下可直接解析（`conformance/C9` 的 `offline-mcp-resolvable`
   会逐条验）。反过来，"只 `npm cache add` 不算数"也已实测证伪过。
2. **不许静默降级到公网**。构建时若配置了内网源却仍有包从公网拉取，应**失败**而不是"能拉就拉" ——
   否则内网构建会在某次升级后突然拉不通，而那次失败没有任何线索。

### 14.3 与其它包的关系

- **不阻塞** dsh 轨（M1）与文档（M3）：前者是适配契约，后者是描述。
- **阻塞的是"真的搬进内网"**：即 M4 的交付形态（验证证据包 + 镜像快照）在目标环境里能否复现。
- `core/image/preinstall.lock.txt` 已经是构建输入，S8 直接复用它做 vendor 清单 —— 不需要新的真源。

### 14.4 三个外部输入的答复（2026-09-25，已回填设计 §15.2）

| # | 答复 | 后果 |
|---|---|---|
| **I1** 企业 LLM 网关 | **没有网关**，验证性 E2E 应用直接调 API；保真转发记为将来风险 | G1 后半「网关吞 tools」**降级为已记录风险**，不建检测、不进准入门槛。门 3/4 仍用零凭据假网关（与有没有网关无关） |
| **I2** 内网 | **肯定不能出内网** | 本工作包（S8） |
| **I3** 业务场景 | **暂无成熟场景** | 示例保持参考实现定位；能力覆盖面以契约完整性为准，不按某个场景裁剪 |
