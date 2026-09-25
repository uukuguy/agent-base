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
| **S2** | A + B + C | `render` + `doctor`（pi 与 dsh）+ `conformance` C1–C10 | S1 | **active** |
| **S3** | A + B + C | 探针 + smoke + `template/` + `new-agent` | S2 | **active**（probe/smoke/verify + template/new-agent 已交付；余镜像与本地运行入口） |
| **S4** | A + B + C | `examples/idea-to-proof` 全绿（含 C5/C8） | S3 | pending |
| **S5** | A + B + C | `examples/contract-review`（带 MCP，双 harness 等价性） | S4 | pending |
| **S6** | A | `docs/` 全 12 篇 | S4 | pending |
| **S7** | A | `CHANGELOG` + 版本策略 | S6 | pending |

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
