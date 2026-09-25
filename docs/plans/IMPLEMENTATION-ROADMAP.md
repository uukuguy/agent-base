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
| **S1** | A | 四闸门框架 + 假网关 + 统一轨迹 schema | S0 | **active** |
| **S2** | A + B + C | `render` + `doctor`（pi 与 dsh）+ `conformance` C1–C10 | S1 | pending |
| **S3** | A + B + C | 探针 + smoke + `template/` + `new-agent` | S2 | pending |
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
| **包级验收** | ① `make conformance HARNESS=pi` 全绿，**含 C5（静默失败检测力）与 C8（参数层隔离）**；② `doctor` 输出 §6.3 的**七个字段**（含 `enhancements[]`、`effectiveConfigDigest`）并满足三条硬断言（技能集合、连接器集合、已加载扩展 id 集合 == 声明集合）；③ 渲染确定性：同输入两次渲染 digest 相同（C2）；④ `core/` 无 harness 名 |
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
