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
| **S2** | A + B + C | `render` + `doctor`（pi 与 dsh）+ `conformance` C1–C10 | S1 | **两侧全绿 10/10**（dsh 准入完成，见 §16） |
| **S3** | A + B + C | 探针 + smoke + `template/` + `new-agent` + 基座镜像 + 本地开发环境 | S2 | **闭环**（全部交付；Makefile 30 个目标、0 个未实现） |
| **S4** | A + B + C | `examples/idea-to-proof` 全绿（含 C5/C8） | S3 | **闭环**（`make examples-check` 全绿：四道闸门 → 可用） |
| **S5** | A + B + C | `examples/contract-review`（带 MCP，双 harness 等价性） | S4 | **闭环**（M4，见 §20） |
| **S6** | A | `docs/` 全 12 篇 | S4 | **闭环**（12 篇全部完成 + 索引；03 由真源生成并有同步检查） |
| **S7** | A | `CHANGELOG` + 版本策略 | S6 | **闭环**（`CHANGELOG.md` 含版本策略 + 闸门 1 有版本纪律检查） |
| **S8** | A | **运行期无外网**（构建期可联网）：构建期装齐 + 运行期断网验证 + 关掉静默联网 | S3 | **闭环**（见 §20.4；端到端证据由 M4 与 §21 的容器内验证给出） |

**最小可评审单元 = S0 + S1**（设计附录 B 原文）。它们是「适配契约」（§5）的具体化；S0–S1 交付后即可用真实适配器（先 pi）检验契约是否够用。

**P4 已定不额外造桩**：基座保证的是两个运行时的契约；第三个运行时不在保证范围内，`conformance` 的 C1–C10 就是契约的可执行形态（不为它预先写「假 harness」）。

---

## 1.1 当前活跃工作线（2026-09-26 登记）

> S0–S8 全部闭合后，工作分散在 §22–§30。用户要求"**几条大开发线路要记录并安排清楚**"，
> 于是这里给出**路线级的归类与顺序**（唯一权威清单仍是本文件；本节只是入口视图，不另立第二份计划）。

| 线 | 目标（一句话） | 包含项 | 状态 | 关键依赖 |
|---|---|---|---|---|
| **L1 钩子与定制契约** | 「配了要真的生效」——钩子/loop/服务都有声明面与判据 | E1b · E2b · E5–E8 · E9 | ✅ **本线闭合**（2026-09-28）：E1/E1b/E2/E2b（每条声明的钩子要么留痕、要么被点名）· **E5**（审批通道 + 生产向收口为上层义务）· **E6**（预算可断言 · 续跑可对上 · 结束可分辨 · 委派深度如实标不可断言）· **E7**（钩子失败语义 record/block，闸门执行 block）· **E8**（次数与时长归因；token 实测不可得，如实标注）· **E9**（多语言能力落地）。生产向部分依据 `docs/design/2026-09-28-service-form-conventions.md` 收口为**上层义务**（基座接缝已定并各自可验证） | — |
| **L2 会话内发现面** | 会话里随时能问清"这个项目是什么、要验什么" | V2 · V3 · **A1** | ✅ **本线闭合**：V1（主运行时侧命令）· V2（非交互出口）· V3（另一侧等价入口，含已声明的补全不对称）· A1（验证计划） | — |
| **L3 环境与验证权威性** | 本地迭代为主、容器取证交给 AI；**两处结论一致** | A2–A6 · Q1–Q5 · W1–W4 | ✅ **本线闭合**：阶段一（A1/V2/E1b/Q1/Q2）+ A2–A6 + A6b-1（量清）+ **A6b-2（另一侧的审批门）全部完成**；Q3 并入 A3，**Q5/§29 W\* 保持可选**（用户已同意降级） | — |
| **L4 能力包（bundles）** | 一组能力打成"包"、可动态使能；验证纯净、编程时打开 | B1 · B2 · C3–C7 | **设计完成，用户决定择机实现** | C4 需"基座技能进声明"机制；C7 依赖 B1 |
| **L5 基座自陈与口径** | 声称的能力都能指向判据；文档不许再悄悄过期 | P5 · O1–O5 · `CLAUDE.md` · O6 | ✅ **本线闭合**（2026-09-28）：O1（开放命名空间）· O2（口径三段式）· O3（未验证声明进报告）· **O4（能力→判据可执行清单，72 条）**· P5（契约表逐行实测）· `CLAUDE.md` · **O6（docs/14 判据纳入复核，73 条；过程中抓出「文档让人跑不存在的 make trace-view」并把它做出来）**；外加缺口清单防腐检查（`docs/gaps-not-done`）。O5 并入 E5–E8（已结清） | — |
| **L6 业务代码可移植** | 语言无关的能力描述 + 进程边界执行 + 通用桥 | E9（= D-0012/13 的落地） | ✅ **落地完成**（2026-09-28）：① 描述 schema + 装载/就位校验 + **双通道调用** + 闸门 1 的 `capabilities/descriptions`；② **两侧通用桥**（按清单遍历注册，桥里不出现任何能力名）；③ **示例已迁移**：`examples/change-risk-review` 改为「描述 + **Python** 实现」，**删掉三份手写接入件与两份逐能力声明** —— 四道闸门两侧仍「可用」、跨侧等价性通过；④ **闸门 3 逐条真调用**：按描述造入参、真调、按 `result` 断言形状、声明确定性则复算一致；⑤ **Python 进镜像预装**（B1）：容器内验证通过（此前容器挂在 `python3 ENOENT`，**归因工具判为「未声明的差异」**——没让它溜过去）。自检：`capabilities-selftest`（含探针负例）· `pi-/dsh-capabilities-selftest`（各六段） | 后续（不在本线）：Go/Java 运行时按需再加 |

### 建议顺序（三阶段 + 常设）

1. **第一阶段（今天就能开工，不需要任何新决策）**
   **A1**（`verify-plan`，**含 V2 的非交互出口** —— AI 驱动的前提是能拿到结构化输出，所以两者一起做）
   → **E1b**（接入缝的钩子事件名；`manifest.hookEvents` 数据路径已就位，小）
   → **Q1 + Q2**（把"本地 vs 容器"的差异**机器可读**；这是 A4 归因的前提）
2. **第二阶段（L3 关键路径）**
   ~~A1~~ → ~~A2~~ → ~~A3~~ → ~~A4~~ → ~~A5~~ → ~~A6~~ → ~~A6b-1~~ → ~~A6b-2~~ **本线已闭合**（两侧的审批门都落地，证据见各自自检）
   → 收束 §28：**Q3/Q4 必留**（结论出处、预装集有锁），**Q5/§29 的 W\*** 降级为可选
3. **第三阶段（择机，用户已说 deferred）**
   **B1**（包机制本体）→ **C4**（3 个编码技能落盘 + "基座技能进声明"）→ **B2**（`/project bundles`）→ **C3**（默认组合，兑现 D9）→ **C5**（插件类目）
4. **可随手插入的小线（不阻塞任何东西，且防止文档再次漂移）**
   **P5 + O2 + O3**（契约表随实现更新 · 口径统一为"保证/允许/不管" · 未验证声明进报告）· **E2b** · **L5 的 `CLAUDE.md`**（技术不变量的落地处，今天挂在 §CURRENT-STATE 的开放问题里）

### 决策门（需要用户拍，别人替不了）

> **一句话版（含我的建议与工作量）在 [`OPEN-DECISIONS.md`](OPEN-DECISIONS.md)** —— 拍板时看那一页就够，本节是它的展开依据。

| 门 | 影响 | 现在该不该定 |
|---|---|---|
| **主运行时选型**（pi / dsh / 最终收敛到一个） | 解 E5–E8 与默认 HARNESS | **事实材料已备**（2026-09-27）：`docs/design/2026-09-27-runtime-selection-facts.md` —— 机器生成 + 闸门 1 守同步（`docs/selection-facts-sync`），含声明面覆盖（dsh 23 supported/23 verified vs pi 20/22 + 1 unknown）、11 个能力维度的逐项对比、基座不变量的**落地形态**（`project-info` 只有 pi 有 ⇒ 选 dsh 要先补 V3）、以及机器能判的开放问题 |
| **bundle 线何时启动** | L4 全部 | 用户已说"择机" |
| **§29 dev 容器还要不要做**（W1） | 人是否需要"进容器做全套"这条可选路 | 不急；L3 做成后多数场景不需要它 |
| **能力描述契约**（§22 / D-0012+D-0013） | L6 全部；以及"业务代码默认怎么写" | **提案已备、待评审**：`docs/design/2026-09-27-capability-description-contract.md`。两个真分叉：**A** JS 业务走进程内（快，但两套语义）还是统一走进程边界（一致，但每次调用一个进程）；**B** 非 JS 语言运行时是**镜像预装 Node+Python**（倾向：不依赖别的线）还是靠能力包（依赖你已设为"择机"的 L4）。拍完即可开工，实现只有 3 步 |

**主运行时选型的取舍要点**（供拍板，**不是结论**；事实见上面那份生成物）：

- **选 `pi` 当主运行时**：基座不变量最全（`/project`、`/verify-container`、进程内轨迹都在）、版本稳定（`0.87.1`）；
  代价是 `hmr` 缺（改配置要重启）、`mcpClient`/`permissionModel` 靠**扩展**补、无 OS 沙箱。
- **选 `dsh` 当主运行时**：能力面更宽（原生 `hmr`、原生 MCP、原生权限预设 + 审批且 fail-closed）、声明面覆盖更高；
  代价是**预发布版本**（升级抖动要单独评估）、生命周期事件集合**未穷举**（该侧钩子只能标「未验证」）、要补 `project-info`（§26 V3）。
- **新增一条机器可判的依据（2026-09-27 实测）**：`capabilities.commandsHeadless` —— 会话内斜杠命令能否被**无头驱动**。
  选 `pi`：能（RPC 发 `/project skills` ⇒ 命令执行、报告进会话，已有端到端自检）⇒ **会话内能力进得了自动化验证网**；
  选 `dsh`：不能（无头模式把它当提示词送模型，实测无 command 事件）⇒ 这些能力只能靠人手工在 tui 里点，**回归网覆盖不到**。
  这条与 E5–E8（服务/loop 形态）直接相关：那些形态本身就要靠会话内操作验证。
- **暂不定**（第三条路）：两条线都保留、默认仍用 `pi`，等 `dsh` 出稳定版再比一轮 ——
  阶段二的实验已证明**两侧的受控容器验证与审批门都能跑通**，所以「不定」不阻塞别的工作。

> 无论选哪条：**两侧的 conformance 与那套豁免/差异声明都继续维护** —— 选型改变的是「哪一侧在关键路径上」，
> 不是「另一侧可以不管」（翻转只需改默认 HARNESS 与示例默认 runtime，设计不动）。

### 常设职责（不是项目，但要有人做）

- **上游 pin 漂移复核**：dsh `0.1.7-rc.1` 是预发布、pi 迭代快；升级必须重跑两侧 conformance（已自动化）
- **`image-push`**：推送链路未对真实 registry 验证 —— 属**外部条件**（要有内部仓库），不是开发项
- **验收口径**：任何阶段收尾都要重跑「16 个自检 + 两侧 conformance + `examples-check`」（本文件各节的判据都以此为底）

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
6. **不为第三个 harness 写占位代码**：基座保证两个运行时的契约，第三个通过 `conformance` 接入即可（无保证）。

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

**conformance 现状**：dsh **9/10 通过**（除 C3 外全过，含 C6 零凭据闸门 3/4 与 C7 轨迹合规）；只剩 **C3 渲染完整性**。pi 侧 10/10。

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
| `resolution/model-providers` | 实际生效的模型来自本次渲染产物，不是宿主配置 |
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

## 14. S8 · 运行期无外网（按用户澄清缩小规模，2026-09-25）

**澄清**：用户明确「**只有运行时段必须无外网**，构建不会那么严格」。我先前的读法（"构建也不能出网"
⇒ 需要气隙构建、内网镜像仓库、vendored tarball）**读过头了**，本包据此缩小。

### 14.1 正确的形态：构建期装齐、运行期断网

这恰好是本项目已经在做的架构，而不是要新增一套离线分发机制：

| 环节 | 做法 | 现状 |
|---|---|---|
| **构建期** | 走公网拉基础镜像与 npm；按精确 pin **全局安装** harness 与预装 MCP 服务器 | ✅ 已实现（`core/image/Dockerfile` + `preinstall.lock.txt`） |
| **运行期** | 连接器以 `npx -y <pkg>@<ver>` 启动，靠**已装的那个精确版本**解析，不临时拉取 | ✅ 已实测（`--network none` 下 11 个连接器 0 失败） |
| **运行期验证** | 以 `--network none` 跑，而不是靠"应该不用网" | ✅ `conformance/C9` 的 `offline-*` 两项在验 |

### 14.2 真正还需要补的（三件小事，不是一个大包）

1. **关掉静默联网**：harness 的遥测 / 自更新检查必须在运行期关闭 —— 否则"无外网"会表现为**启动变慢或报错**，而不是清晰失败。
   - pi：基座 seed 已关遥测 ✅
   - dsh：**待核**（要确认没有默认的外拨，例如更新检查）
2. **构建期必须装齐**：凡运行期要用的，构建期都得在镜像里 —— 已有 `preinstall.lock.txt` 作为构建输入，
   但缺一条**反向检查**：运行期会用到、却不在锁里的东西（例如某 connector 的间接依赖）目前没校验。
3. **运行期"无外网"要有一条真的端到端证据**：现有 `offline-*` 验的是"包能解析"，不是"整轮任务不碰网"。
   更强的检查是：断网 + 假网关下跑一次**真的用到连接器**的任务（例如 filesystem 连接器），断言任务成功完成。

### 14.3 明确不再需要的（先前被我过度设计出来的）

- ❌ 气隙构建 / vendored tarball 目录 / `make image-vendor`
- ❌ 内网镜像仓库与 npm 私有源的替换入口（构建期走公网即可）
- ❌ 把交付物做成"可离线搬运包"（构建与运行是两套环境，交付按构建期产物走即可）

> 保留一条通用能力即可：`Dockerfile` 的 `ARG NODE_IMAGE` 已经允许换基础镜像来源 —— 零成本，留着应对将来。

### 14.4 三个外部输入的答复（2026-09-25，已回填设计 §15.2）

| # | 答复 | 后果 |
|---|---|---|
| **I1** 企业 LLM 网关 | **没有网关**，验证性 E2E 应用直接调 API；保真转发记为将来风险 | G1 后半「网关吞 tools」**降级为已记录风险**，不建检测、不进准入门槛。门 3/4 仍用零凭据假网关 |
| **I2** 网络 | **仅运行期无外网**；构建期不严格 | 本包（S8），规模如上缩小 |
| **I3** 业务场景 | **暂无成熟场景** | 示例保持参考实现定位；能力覆盖面以契约完整性为准，不按某个场景裁剪 |

---

## 15. dsh 打通：从 7/10 到 9/10（2026-09-25）

### 15.1 新增的基座构件：模型路由目录

**发现**：`model.route` 的语义是「**基座声明**的路由名」（agent.schema.json），但仓库里**没有这份声明** ——
两个渲染器各自硬编码协议形状、参数引用名靠约定推算。后果：智能体写错路由名**渲染照样成功**，
等到运行时才炸，且报错看不懂。

**处置**：新增 `core/catalog/routes.yaml`（基座层能力目录，P-a 的"能力在基座"）+ 闸门 1 四项校验：

| 检查 | 作用 |
|---|---|
| `routes/present` | 路由目录必须存在且非空 |
| `routes/id` | 路由名合法 |
| `routes/param-convention` | 端点/凭据引用名符合 `<PREFIX>_BASE_URL` / `<PREFIX>_API_KEY` |
| `routes/param-allowed` | 引用名被参数层允许清单覆盖 |
| `route/declared` | **智能体写的 route 必须是已声明的**（负向用例已验：报错并列出可用取值） |

### 15.2 dsh 的运行路径打通（三件）

| 构件 | 说明 |
|---|---|
| **provider 路由渲染** | 只写 `agent-default-model.provider: <route>` 只是"选了哪个路由"；路由**存不存在**得由 provider 适配器决定。本 harness 走 `llm-pi-ai` 的 `providers` 字典（`api` / `baseURL` / `apiKeyEnv` / `models`）。不配这一步的失效方式很隐蔽：`--dump-config` 依然成功，直到真跑才报错 |
| **`adapters/dsh/run.mjs`** | 运行器：暂存副本 + **镜像内固定路径改写为暂存路径** + 端点靠环境变量注入 + 非交互显式放行策略（审批无应答者时是 **fail closed 等人**，不是报错 —— D4）。实测：退出码 0，12 条原生事件 → 12 条统一事件，`tool.call`/`tool.result` 按 `callId` 配对 |
| **`adapters/dsh/trace.mjs`** | 映射 **`--json` 的 run events**（而不是 zstd 会话文件）：这条通道**带 `callId`**、不需要 zstd 解码。C7 已绿（12 进 12 出、全过 schema、不丢事件） |

### 15.3 两处检查的泛化（都在检查侧，没去迁就）

| 用例 | 泛化 |
|---|---|
| **C6** | probe/smoke 改为按 harness 分派运行器；模型断言改成**端点侧取证** —— 断言"端点实际收到了几个工具/是否流式"（读假网关的记录），而不是"harness 说自己发了什么"。这比原判据更强，且天然跨 harness |
| **C3 的前置** | 渲染器在清单里声明 `skillsInProduct`（技能在产物内的相对位置）—— 上层工具不必知道某 harness 的目录形状。踩到的教训：probe 里我一开始猜 `renderDir/skills`，而 pi 的技能在 `agent-dir/skills` 下 |

### 15.4 剩余：C3（唯一还"按 pi 形状写死"的检查）

C3 认死 `AGENTS.md` / `settings.json` / `extensions` 这些**文件名**。修法已定：
渲染器在清单里声明 **`expresses` 映射**（定义字段路径 → 产物内位置），检查只验证"声明的位置存在且内容对"。
**认死文件名等于把第一个 harness 的形状当成契约。**

---

## 16. M1 达成：dsh 准入 10/10（2026-09-25）

**结论**：`conformance` 的十项阻断性门槛，**pi 与 dsh 都全绿**。J1「同一份中性定义，两个 harness
都能渲染并跑通」第一次有了**双边证据** —— 此前只有 pi 一边。

### 16.1 C3 的泛化：把"认死文件名"改成"按声明验证"

C3 原先是唯一还按第一个 harness 的产物形状写死的检查（认死 `AGENTS.md` / `settings.json` /
`extensions` 这些**文件名**），第二个 harness 必然误判。

**新契约**：渲染器在清单里声明 `expresses` —— 「定义字段 → 产物内位置」，形如

```json
"expresses": {
  "persona.instructions": { "at": "workspace/AGENTS.md", "contains": "你是「想法到证据」的分析助手" },
  "model.route":          { "at": "…/cordis.patch.yml", "contains": "provider: corp-gateway" },
  "tools.deny":           { "at": "…/cordis.patch.yml", "contains": ["- id: tool-bash", "- id: tool-fs"] },
  "skills":               { "at": "skills" },
  "model.reasoningEffort": { "exempt": "…非平凡理由…" }
}
```

C3 只做三件事：① 每个期望字段都有声明；② 声明的位置**存在**；③ `contains` 与**定义里的字面值**
都能在那里找到（独立复核，防"声明敷衍了事"）。豁免必须写非平凡理由。

**为什么这样更好**：位置知识归**渲染器**（它是唯一知道产物形状的一方），检查不必认识任何 harness。
认死文件名等于把第一个 harness 的形状当成契约。

### 16.2 过程中暴露的一个真实缺口（已记为豁免，未静默丢弃）

`model.reasoningEffort` 在 dsh 侧**尚未映射**：它的 provider 模型条目有 `reasoningEfforts` 字段，
但**取值形状未实测**。按纪律不猜形状 —— 渲染器在 `expresses` 里声明为豁免并写明理由，
同时进 `exemptions.yaml`（跨 harness 差异必须显式）。补法：实测形状后补映射并删掉豁免。

### 16.3 M1 之后的顺序

1. **M2 文档 12 篇（S6）** —— 「别人能直接接手」；其中 `07-troubleshooting`（失败模式清单）是灵魂
2. **M3 版本策略 + CHANGELOG（S7）** —— 交付形态收口
3. **S8 三件小事**（运行期无外网：关静默联网 / 装齐的反向检查 / 端到端断网证据）—— 并进 M2 前后
4. **M4 `examples/contract-review`**（可选，因 I3 后置）

---

## 17. M2 达成：文档 12 篇（2026-09-25）

| # | 文档 | 面向 | 要点 |
|---|---|---|---|
| 00 | overview | 全部 | 定位与边界、三层、可移植核心四要素、两个原则、目录速览 |
| 01 | quickstart | 业务开发者 | 四步跑通；含真实端点、换运行时、出镜像 |
| 02 | concepts | 业务开发者 | **四个业务概念 ↔ 两个运行时机制的对照表** |
| 03 | capability-catalog | 业务开发者 | **由 `core/catalog` 真源生成**；闸门 1 有同步检查 |
| 04 | skills | 业务开发者 | SKILL.md 格式 + 业务代码落点 + **隐式技能源这个坑** |
| 05 | connectors | 业务开发者 | 按名引用（11 个预装名字）+ 完整写法 + 凭据引用名 + 两运行时差异 |
| 06 | deploy | 平台/运维 | 镜像变体与固定路径、环境变量、入口与退出码、加固参数、运行期无外网 |
| 07 | troubleshooting | 全部 | **失败模式清单**（静默失败为主）+ 基座自身踩过的 8 个坑 + 证据在哪 + 还不知道的 |
| 08 | conventions | 平台/负责人 | 分层纪律 + 单一真源地图 + **执法对照表**（哪条纪律由哪个检查拦） |
| 09 | harness-contract | 平台开发者 | 适配器 SPI + 能力声明纪律 + C1–C10 + 四条"别另发明一套" + 接入九步 |
| 10 | harness-selection | 架构/平台 | 能力对比（有出处）+ 四条真正影响选择的差异 + 场景建议 + 不等价清单 |
| 11 | harness-enhancements | 业务开发者 | 三种东西的区分 + 三层结构 + 三条硬约束 + 现成参考实现 + 晋升通道 |

**质量做法**（不是写完就算）：
- 文中引用的 **make 目标、仓库路径、检查 id、适配器文件、连接器名字**全部与真源交叉校验
- 未写完时分批交付，**不留死链**（未写的篇目在索引里是纯文件名，不是假链接）
- 凡是"由真源生成"的文档（03）都配**同步检查**，改了真源没刷新即失败
- 已知能力边界**写进文档**（例如 pi 的增强口径只到"已进入产物"、dsh 的推理强度未映射），
  而不是只留在 issue 里

---

## 18. M3 达成：版本策略 + CHANGELOG（2026-09-25）

**交付**：根目录 `CHANGELOG.md`，同时承载版本策略与变更条目。

### 18.1 版本策略的核心：三个版本号分工

| 版本 | 在哪 | 含义 |
|---|---|---|
| **基座版本** | `package.json` | 整个基座的发布版本（镜像 tag 用它） |
| **定义契约版本** | 定义里的 `apiVersion: agent-base/v1` | **中性定义这份契约**的版本，变得**慢得多** |
| **运行时 pin** | `adapters/<h>/adapter.yaml` | 锁定的上游运行时版本 + 适配器实现版本 |

为什么分开：基座可能因为加一个检查就从 0.1.0 升到 0.2.0，而**中性定义一个字都不用改** —— 那是契约没变。
反过来，契约一旦破坏性变更，所有智能体都要动，那必须 `apiVersion` 升版并**给出迁移提示**。

文档里把"什么算破坏性变更"逐条列了（删字段/改层归属/改 `usable` 判据/改等价性范围），
并明确了**兼容承诺**：`apiVersion` 相同 ⇒ 老定义照旧能渲染能跑；**但不承诺**跨"验证快照"的兼容 ——
快照的语义是"这次验证跑在什么环境里"，要能**复现**，不必能**演进**。

### 18.2 版本纪律用机器守

新增闸门 1 检查 `docs/changelog-version`：**改了 `package.json` 的版本，就必须存在形如 `## <版本>` 的发布条目**。

> 第一版检查用 `includes` 子串匹配，结果被自己的"版本策略正文里举的例子"骗过（文中恰好有 `0.2.0`）。
> 收紧成"必须存在 `## <版本>` 形式的发布条目"，并按负向用例复验通过。
> 记这条是因为它又是一次"检查写得太松 = 等于没有"。

### 18.3 本期不包含（写进 CHANGELOG，免得被当成"应该有"）

生产化能力、pi 侧 MCP 客户端、`examples/contract-review`、镜像推送链路、
dsh 的 `model.reasoningEffort` 映射、pi 侧增强"已加载"的观测 —— 逐条写清并指向对应文档。

---

## 19. pi 的 MCP 通路打通（M4 地基，2026-09-25）

**背景**：M4（`examples/contract-review`，双运行时 + MCP 等价性）卡在一件事上 ——
pi **原生没有 MCP 客户端**，所以"双运行时 MCP 等价"当时做不到等价。

**决策**（沿用调研结论）：**不自研**，采用并精确 pin 第三方扩展 `pi-mcp-adapter@2.37.0`，
以**基座种子依赖**形式装进基座镜像。

### 19.1 实现

| 环节 | 做法 |
|---|---|
| 扩展从哪来 | 登记进 `core/image/preinstall.yaml`（kind: system）→ 进构建锁 → **构建期全局安装** ⇒ 运行期不需要网络。复用既有机制，**没有新造安装通道** |
| 渲染 | `connectors.yaml` → `agent-dir/mcp.json`（`{mcpServers, settings:{allowInstall:false, hostConfigDiscovery:"off"}}`）+ `settings.json` 的 `packages` 声明扩展的**本地路径** |
| 本地运行 | 暂存时把镜像内路径改写成本地路径（`AGENT_MCP_ADAPTER_PATH`）；**没给就响亮失败** —— 不许跑出一个没有 MCP 客户端的智能体而无人察觉 |

配置形状不是我猜的：读了扩展实现，它读的正是 **agent-dir 下的 `mcp.json`**，
条目结构 `{command,args,env}|{url,headers}` —— 与设计 §10.2 的预测一致。

### 19.2 实测证据（这是关键）

| 场景 | 模型端点收到的工具数 |
|---|---|
| 基线（不带连接器） | **4** |
| 带 `ref: filesystem` 连接器 | **7** |

即：该 MCP 服务器的 3 个工具**真的注册进了模型可见的工具列表**，退出码 0、无报错。
负向也验了：产物声明了扩展包而本地未提供路径 ⇒ 运行器**拒绝运行**并说明原因。

### 19.3 同步更新（改了行为就必须改说法）

`adapters/pi/adapter.yaml`（`mcpClient: unsupported → extension`，含实测证据）、
`exemptions.yaml`（豁免从"pi 不支持"改为"**机制不同**"）、`failures.md` F10、
文档 02/05/10、`CHANGELOG.md`；镜像重建并复跑 **C9 十项全绿**。

### 19.4 下一步

M4 的地基已就位：可以做 `examples/contract-review`（带连接器、两个运行时都跑），
并做**跨运行时等价性比对**（比较"启用了哪几台服务器/调到了什么工具"，而不是比较扩展内部的工具名）。

---

## 20. M4 达成：双运行时示例与等价性比对（2026-09-25）

### 20.1 交付物

| 件 | 说明 |
|---|---|
| `examples/contract-review/` | 合同条款审阅：**带 MCP 连接器**（`ref: filesystem`，零凭据、可离线）；3 个技能，其中一个带可执行的自检脚本 |
| `make compare` | **跨运行时等价性比对**（`tools/compare.mjs`） |
| `make examples-check` | 升级为**每个示例在每个运行时上都验「可用」**，并跑等价性比对 |

### 20.2 实测证据

| 项 | 结果 |
|---|---|
| 四道闸门 · pi | **可用** |
| 四道闸门 · dsh | **可用** |
| 技能集合 | 两侧一致（3 个） |
| 连接器集合 | 两侧一致（filesystem） |
| 模型路由 / 协议形状 | 两侧一致（corp-gateway / openai-completions） |
| 连接器真的生效（端点侧） | 不带：4 个工具；pi 带：**7**；dsh 带：**36** |
| 已声明差异 | 17 条（两侧合计），全部可被 `exemptions.yaml` 解释 |

### 20.3 等价性比对的判据（这是本条的实质）

比的是**中性定义层面应当一致**的三组集合（技能 / 连接器 / 模型路由）+ 路由协议形状。
**不**比运行时专有的东西（工具名、提示词拼装、token 计数、扩展形态）—— 那些本来就不同。

关键一条：**任何差异都必须能被某个运行时的 `exemptions.yaml` 解释，解释不了就失败。**
这条把设计 §4.6 的"可以不一样，但不许悄悄不一样"变成了可执行判据。

### 20.4 S8（运行期无外网）的实际收口

| 项 | 状态 |
|---|---|
| 运行期静默联网 | pi 侧 `PI_OFFLINE=1` + 不发现宿主机 MCP 配置；dsh 侧用隔离的 `DSH_HOME` 与中立 cwd；两者的连接器都靠**构建期装好的精确版本**启动 |
| "装齐了"的反向检查 | C9 的 `offline-harness-usable` + `offline-mcp-resolvable`：断网容器里逐条验运行时与预装包 |
| **真用到连接器的端到端证据** | **由 M4 给出**：带连接器的智能体在两个运行时上都跑到「可用」，且端点侧工具数显著变化 |

### 20.5 本轮暴露并修掉的三处真实缺陷

| 缺陷 | 性质 |
|---|---|
| `verify.mjs` 没把 `--harness` 往下传 | 于是 probe 用 **pi 的运行器**去跑 dsh 的产物 —— 报出的是"产物目录不存在"这种看不懂的错 |
| pi doctor 用 `c.name` 读清单里叫 `serverName` 的字段 | "声明集合"实际是 `[undefined]`，集合断言必错且错得看不懂 |
| `examples-check` 只验一个运行时 | "可移植"于是只是口号。改为每个示例在每个运行时上都验，并跑等价性比对 |

---

## 21. 容器里怎么配 LLM（2026-09-25）

**触发**：交接后用户问「现在运行镜像如何配置 LLM 呢？」—— 一查发现**容器里根本配不了**，
而宿主机侧的四道闸门全绿。缺口是真实且成体系的：

| 缺口 | 现象（实测） |
|---|---|
| 产物只有 `.tmpl`，没人渲染 | 容器里跑起来模型报"没有 API key" |
| 产物只读，运行时却要写 | `--read-only` 挂载下 pi 建会话目录直接 ENOENT |
| 挂载点语义含糊 | 入口脚本把 `PI_CODING_AGENT_DIR` 同时当"产物根"和"配置目录" |
| 模型名不可配 | 判据用粗了：**端点与模型名在部署里是绑在一起的**（见 §21.2） |

### 21.1 设计：运行时中性的启动期准备

新增 `core/image/startup.mjs`（子命令 `prepare` / `run` / `config-check`），**不认识任何具体运行时**：
拷什么、设哪个环境变量、cwd 放哪、要不要渲染、argv 前缀是什么，全部来自产物清单里的
`runtimePlan`（各渲染器产出）。于是加第三个运行时不必改这里。

启动四步：**解析参数 → 校验模型名 → 暂存可写副本 → 原子渲染**（仅当该运行时需要）。
任何一步不满足 → **退出码 2**，点名缺哪个引用名与两种给法；**不静默降级**。

| 能力 | 做法 |
|---|---|
| 运行期注入 | `<路由前缀>_BASE_URL` / `_API_KEY` / `_MODEL`；凭据支持 **`…_FILE`**（K8s/Docker secret 的标准接法） |
| 产物不可变 | 只读产物**永不改写**：暂存到 `/run/agent-base`，写入都发生在副本里（自检断言摘要未变） |
| 原子渲染 | 临时文件 + rename；替换后仍有 `${…}` 占位即失败（不留半个配置） |
| 凭据不泄漏 | 日志与 `--json` 里只显示 `***` 与来源；`--json` 里密钥**没有 value 字段** |
| 就绪探针 | `config-check`：只校验、不落盘、stdout 是纯 JSON |

### 21.2 判据修正：模型名是环境属性

原判据「改了它会不会改变行为」把 `model.name` 归入制品层并写进禁止清单。那条判据对"环境属性"
这一类不适用 —— 端点与模型名绑在一起（内网网关只服务它有的那几个模型），端点既然运行期给，
模型名就没有理由烤死。判据改为**「这个值是不是随部署环境而变」**；`model.name` 进参数层
（定义里的值退化为默认值），`model.route` 仍是制品层（它决定三个引用名）。
详见 `docs/status/DECISIONS.md`。

**防"可配置=随便配"**：路由目录声明它服务哪些模型；闸门 1（`model/declared-in-route`）与启动期
都按名单校验；模型名进轨迹。

### 21.3 实测证据

| 项 | 结果 |
|---|---|
| 容器内 `--network none` + 产物只读挂载 + 参数注入 | **pi 与 dsh 都退出码 0**，端点侧收到 `tools>0 / stream=true`，`model` == 注入值 |
| 容器内轨迹 | 轨迹扩展**真的产出了事件**（摘要与清单一致）—— 之前容器内跑是没有轨迹的 |
| 负向：不给凭据 | 退出码 2，信息点名 `CORP_GATEWAY_API_KEY` 与两种给法 |
| 启动期自检 | `make startup-selftest`：**逐个适配器各跑一遍**（dsh 21 项 / pi 25 项，两条能力路径分别覆盖） |
| 准入门槛 | C9 新增 5 项（容器内跑通、端点到证、模型名来自运行期、产物未被改写、缺凭据 fail-fast） |

### 21.4 过程中撞到的四件事（都写下来）

1. **spawn 的 args 不含程序名**：我多塞了一次 `exe`，对 shebang 脚本参数里就多一个自身路径 ——
   有的运行时容忍（看不出问题），有的把它当第一个位置参数（报"profile 名是 /usr/local/bin/…"）。
2. **`core/` 不得出现运行时名**的纪律把我新写的启动脚本与自检各拦了一次 ——
   拦得对：那份脚本本来就该运行时中性（改成按目录发现适配器 + 按能力分层断言）。
3. **自检一开始"一律要求值出现在产物里"**，把原生插值的运行时误判为失败 ——
   改成按 `rendersParams` 能力分层断言（一律成立的部分 + 仅渲染型运行时成立的部分）。
4. **COPY 会保留源文件权限**：开发机上的 0600 让容器里的非 root 用户读不到启动脚本 →
   Dockerfile 显式 `chmod`（"文件在但读不到"是极难查的一类问题）。

### 21.5 下一步（本包之外的可见缺口）

- 编排层如何把"产物 + 参数"组合成一次运行（K8s Job / 常驻服务）不在基座范围，但基座已给出契约
- `AGENT_HARNESS_ARGS` 仍是"参数串"：多运行时下更稳的形态是清单声明 argv（`argvPrefix` 已经开了头）

### 21.6 落地过程中被门槛抓出来的六件事（都记下来，都是真问题）

**主因是一条**：为了让宿主侧与容器内走同一条路径，我把暂存/渲染统一到 `core/image/startup.mjs`
（由 `stageRenderDir` 调用）。一改，**四处重复实现**立刻现形 —— 门槛与自检同时变红：

| # | 重复实现 | 症状 | 处置 |
|---|---|---|---|
| 1 | `run.mjs` 内联渲染 | 模型名这个新参数没跟上 → 端点侧记录到的是**凭据占位串**当模型名 | 删除，委托启动脚本 |
| 2 | `doctor.mjs` 的 `renderModelsTemplate` | 在已渲染的产物上**再渲染一遍**，把模型名换回占位串 → 自证报"实际生效模型与产物不一致" | 删除，只报告暂存结果 |
| 3 | `trace-ext-selftest.mjs` 自建暂存 | 非端点参数一律换成字面量 `placeholder` → "带上了 model 与 route"断言变红 | 删除，共用暂存 |
| 4 | `dsh/run.mjs` 自建暂存 + `dsh/doctor.mjs` 再抄一份 | 统一暂存后路径改写生效，doctor 却还在拿镜像内路径比对 → 假失败 | 两处都改为委托；断言改为与**暂存后**路径比 |

**另外三件**：

| # | 事 | 说明 |
|---|---|---|
| 5 | **第三方扩展自带技能** | pin 的 MCP 客户端扩展在 `resources_discover` 里把自己那个 `mcp-scripting` 塞进技能集合 → "实际加载的技能集合"多一项，硬断言与跨运行时等价性双双告警。它在自己配置里受 `scriptMode !== false` 控制，而那份配置正是我们写的 `mcp.json` ⇒ 置 `scriptMode: false`。**顺带关掉一个我们从未声明的能力**（"跑可信 JavaScript、一次发多个 MCP 调用"） |
| 6 | **零凭据模式必须显式** | 新的暂存要求必填凭据 ⇒ 探针/冒烟/自证/本地自检原本"不用给密钥"就都不成立了。改为：`zeroCredential` 默认 **false**，由各调用点**显式**打开；开发者用 `run-local --zero-credential`。真实运行不许静默用占位凭据 |

**还有一条纪律的副作用**：`core/` 不得引用示例目录（N5 是静态扫描）—— 启动自检原本拿示例当输入，
且我在注释里写了那个字面量，两次触线。现在自检**自带最小定义**，对示例零依赖。

### 21.7 收口状态

| 项 | 结果 |
|---|---|
| 自检 | **13 个全绿**（含新增的 `startup-selftest`：逐适配器各跑一遍，dsh 21 项 / pi 25 项） |
| 准入门槛 | **两侧 10/10**（C9 含 5 项容器内 LLM 配置检查） |
| 示例 | **全绿**（每个示例在每个运行时上都"可用" + 跨运行时等价性通过） |

---

## 22. 后续设计项（2026-09-26 登记，**未实现**）

> 来源：`change-risk-review` 示例落地后评审提出的两条。**已记录、未实现** —— 不要把它们当成已完成能力。
> 决策原文见 [`docs/status/DECISIONS.md`](../status/DECISIONS.md) 的 **D-0012 / D-0013**。

| # | 项 | 判据（什么算做完） | 依赖 | 状态 |
|---|---|---|---|---|
| 1 | **共享业务逻辑支持多语言**（D-0012） ✅ | 已做：Python 实现的业务能力**零胶水**两侧注册（示例 `corp_risk_score`），闸门 3 按描述**真调用**并校验结果形状；描述文件是接入件唯一输入；进程内/外语义一致有**对跑自检 + 反向断言** | 能力描述契约 → 已实现（`core/capabilities/`） | `done` |
| 2 | **接入件上收为每个运行时一个通用桥**（D-0013） ✅ | 已做：两侧各一个桥，按清单遍历注册；桥以基座不变量身份进闸门 2 的集合断言；**桥里不出现任何能力名**由自检逐条比对 | 项 1（已实现） | `done` |
| 3 | 上面的迁移 ✅ | 已做：删掉三份手写接入件（业务实现 + 两侧接入件）与两份逐能力声明；**四道闸门两侧仍「可用」、跨侧等价性通过**；README 与验证表逐句更新，并记下"迁移前后语义逐字一致"的实测（6 组入参） | 项 1、2（已实现） | `done` |

**为什么先登记不急着做**：两条都会**改动公开契约**（能力描述的形状、接入方式），
而当前示例刚好是验证它们的最小载体。先把契约定清楚再动手，比先写桥再改契约便宜。

---

## 23. harness 业务定制：实证缺陷与演进项（2026-09-26 登记；**D1–D7 与 E1/E2 已实现**）

> 来源：`docs/design/2026-09-26-harness-customization.md`（四路实测调研）。
> 缺陷编号 D1–D7 与设计文档 §7 一一对应；演进项 E1–E9 对应 §8。
> **进度（2026-09-26 收尾核对实现）**：D1–D7 + E1/E2 已实现，**E2b 是下一步**；
> E3/E4 已由 §25 的 P3/P2 交付（**勿重复做**）；E5–E9 待做。

### 23.1 缺陷（"文档说有、实现没有"，全部带证据）

| # | 缺陷 | 证据 | 修好的判据 | 风险 | 状态 |
|---|---|---|---|---|---|
| D1 | `enhancements.yaml` 没有 schema ✅ | 立了 `core/spec/enhancements.schema.json` 并接进闸门 1；负例 11/12 各自只因目标原因红 | 闸门 1 `enhance/schema` | 低 | `done` |
| D2 | pi 侧未声明接入件会被静默加载 ✅ | **渲染期**拦住：`extensions/` 里每个文件都必须被某条声明认领（负例：丢一个 `sneaky.ext` ⇒ 渲染失败） | 渲染期断言 | 中 | `done` |
| D3 | `compare` 不比增强 ✅ | 增强已进比对；结构性差异（基座轨迹在一侧是扩展形态）写进 `adapters/pi/exemptions.yaml` | 差异必须被豁免解释 | 低 | `done` |
| D4 | dsh 渲染静默跳过非法声明 ✅ | 改为响亮失败并点明原因（负例：缺 `package` ⇒ 渲染抛错）；npm 包形态仍标"未验证" | 渲染期抛错 | 低 | `done` |
| D5 | 参数层被绕过 ✅ | 两个变量已登记进 `core/catalog/params.yaml`（基础设施类，`backs: []`） | 闸门 1 `params/backs-orphan` | 低 | `done` |
| D6 | `tools.deny` 交付入口不生效 ✅ | 改为**清单声明**（`runtimePlan.prependArgs`）**两条启动路径都执行**；实测本地与容器内 `tools=1`（旧写法下是 4，即根本没生效） | `probe/model.tools` 计数 | 中 | `done` |
| D7 | `CURRENT-STATE.md` **已过期**（称 C3 按 pi 形状写死、dsh run 待做） | `docs/status/CURRENT-STATE.md` vs conformance 与 dsh run | 文档与实现一致（本轮已修） | 低 | `done` |
| D8 | **产物复用判据只看定义摘要** ⇒ 基座变了（seed 扩展/渲染器/目录表）而定义没变时，旧产物被复用，**改了却没生效且无任何报错** | 实测踩中：新增基座扩展（会话内自省命令 `/project`）后，`examples/idea-to-proof/.render/pi` 照旧被复用 ⇒ `run-local` 的交互会话里根本没有该命令。修法：渲染器记录**渲染输入摘要**（定义 + seed + 渲染器 + adapter.yaml + catalog + emit.mjs，见 `adapters/<h>/render-inputs.mjs`），`run-local` 比它而不是只比定义摘要；旧产物无此字段 ⇒ 一律重渲 | 复用的产物必须与当前输入一致 | 中 | `done`（自检固化：`local-selftest` 里"基座变了也重渲"且不许误报成"定义已变"） |
| D10 | **两条启动路径的平台变量不一致** ⇒ 同一能力**容器里能用、本地不能用** | 实测踩中（用户报）：`/project` 在容器里正常，`make local` 里报「读不到渲染清单」——容器入口会给 `AGENT_ARTIFACT_DIR`，而 `tools/run-local.mjs` 自己手搓一份 env、**漏了它**（渲染清单在**产物根**，暂存副本里没有）。根因更一般：`startup.prepare` 返回的运行期布局 `env` 契约被 `stageRenderDir` 丢掉了（只取了 `Object.values(...)[0]`），于是本地只能手搓、必然漂移。修法：① 新增 `core/image/platform-env.mjs` 作为平台变量的**单一定义**（含"镜像专有"豁免清单）② `stageRenderDir` 原样带出布局契约（两个适配器）③ `run-local` 改为消费这两份，不再手搓 ④ 报错信息点名 `AGENT_ARTIFACT_DIR` | 同一能力在容器与本地都必须可用 | 中 | `done`（自检固化：`local-selftest` 静态比对"entrypoint 提到、本地没给"的变量；`pi-project-info-selftest` 用本地入口的同一套 env 重建并断言能读到清单） |
| D12 | **镜像内自证失败时退出码是 1**，不在契约的语义表（0/2/10/20/30/40/50）里；而且它**不首败即停** —— 与 `docs/07` 写的"闸门 1 失败时后续闸门不会跑"不符 | 实测（A5 的属性断言抓到）：坏项目在容器里 `verify` 退出 **1**，调用方无法按语义归因。修法：`core/image/verify-in-image.mjs` 改为**首个失败闸门即停**，退出码取该闸门的语义码（从闸门仓库根动态导入 `core/gates/exit-codes.mjs`，单一来源）；`verify-container` 另对**旧镜像**做一次对齐（非语义码 ⇒ 按首个失败步骤映射） | 退出码契约在容器侧也成立 | 中 | `done`（⚠️ 镜像需**重建**才带上此修法：闸门源码是构建期拷进去的） |
| D13 | **镜像输入指纹不含被烤进镜像的闸门源码** ⇒ "镜像与源码同源"是**过度声明**；旧镜像无法被发现（真实的假绿） | 实测（E2b 改闸门判据后）：镜像 LABEL 一字未变 ⇒ "同源"照样成立；直到容器里的闸门 4（旧 smoke + 旧 schema）拒收新产物的 `enhancement` 字段，表现为「**容器挂、本地过**」的假差异。修法：① 指纹改按**源码树**算（`core/tools/adapters`，与上下文装配**同一份清单** `IMAGE_SOURCE_DIRS`/`IMAGE_CONTEXT_EXCLUDES`），并且**只覆盖能影响判据的代码**（排除 `*-selftest*`/`fixtures`，否则改个自检就要求重建镜像）；② `verify-container` 加**前置检查**：指纹不同源 ⇒ 拒绝执行并给出重建命令（`--allow-stale-image` 才放行，且输出里留痕）；③ C9 的 `images-same-source` 不再依赖构建上下文存在 | 同源判定必须覆盖全部被烤进去的东西；(D8 同类) | 中 | `done`（四个变体已重建并同源） |

### 23.2 演进项（按改动面从小到大）

| # | 项 | 判据 | 依赖 | 状态 |
|---|---|---|---|---|
| E1 | 钩子声明契约（事件名集合 + 版本 pin） ✅ | 已做：`adapter.yaml` 的 `hookEvents` 声明可订阅集合（pi **39 个**，带 `reproduce` 复算命令；"版本 pin"由同文件的 `version` 承担 —— 不另立字段，避免同一事实两个真源）；`enhancements[].events`（**数组**：基座轨迹扩展自己就订阅 **6** 个）逐个对名字 ⇒ 闸门 1 `enhance/events`；负例 `13-enhance-hook-bad-event`（`tool_calls`）**只因该原因**红；顺手堵上"基座 seed 的声明没人校验"这个后门 | D1 | `done` |
| E1b | **接入缝里的钩子事件名**也进判据（E1 只覆盖定义层与基座 seed） ✅ | 已做：`manifest.hookEvents` 早已随 E1 进产物契约；启动期 `applyOverlay` 现在用它校验 overlay 声明的事件名 —— 写错 ⇒ **响亮失败并点名**（退出码 2）；`enumerated: false` 的运行时不做假校验，但会如实提示"按未验证处理"；钩子没写 `events` 同样红。自检新增两条负例（`startup-selftest` 37 项）。（闸门 2 侧的覆盖天然成立：`stageRenderDir` 走的就是同一条 startup 路径，集合断言已含 overlay 合并进来的声明） | E1 | `done` |
| E2 | **钩子确实触发** ✅ | `probe/hooks-evidenced`（原 `hook-fired`）：轨迹事件带 `emitter: hook\|post-hoc`；声明了钩子就必须有钩子当场发出的事件。⚠️ 另一运行时的轨迹是事后映射 ⇒ 如实报"不适用" | E1 | `done` |
| E2b | 钩子**逐条**自证：每个声明的钩子都要留痕（否则只能证明发射路径在工作） ✅ | 已做：轨迹事件新增可选字段 `enhancement`（= 写这条事件的**声明 id**，两侧种子写入器都带上了）；闸门 3 的判据升级为 `probe/hooks-evidenced` —— 每条声明的钩子要么有带自己 id 的痕迹，要么**红并点名**；判据抽成纯函数 `core/gates/hooks.mjs`（五态：none-declared / evidenced / silent / not-applicable / no-hook-events），自检 `probe-selftest` 既断言每个分支，也**真跑正/负两个夹具**（留痕的业务钩子 ⇒ 通过并点名两条；声明了却不留痕 ⇒ 红并点名 + 给出修法） | E2 | `done` |
| E3 | 上层镜像**接入缝**：镜像内可加钩子（运行时覆盖目录 或 镜像内渲染，二者选一并声明） | 上层镜像里钩子生效有证据 | D-0014 | `done` —— 即 §25 **P3**（overlay 暂存副本；实测闸门 2 把 overlay 声明计入，集合相等 2 项）。**勿重复做** |
| E4 | 上层镜像**自证能力**：携带闸门工具（或 slim 验证器）+ 一条容器内跑四闸门的实测 | 上层镜像内 `verify` 全绿 | D-0014 | `done` —— 即 §25 **P2**（`docker run <镜像> verify` 实测闸门 2/3/4 全过、离线零凭据）。**勿重复做** |
| E5 | 服务形态契约（L4）：会话生命周期/并发上限/状态外置/审批通道的声明面 | 多会话并发与审批留痕各一条实测 | 主运行时选型 | **审批通道已做**（A6/A6b：两侧审批门 + `approval.decision` + fail-closed）；**其余三项按接口约定收口为上层义务**：会话身份/落盘目录/续跑留痕与结束标记由基座给（可验证），并发调度、状态外置、多租户是上层服务 —— 依据 [`docs/design/2026-09-28-service-form-conventions.md`](../design/2026-09-28-service-form-conventions.md) | 无（基座侧收口） |
| E6 | loop 策略声明（L3）：最大轮次 / 时长预算 / 终止条件 / 委派深度 | 越界可断言、续跑可留痕 | 主运行时选型 | ✅ **两项判据达成，另两项如实划界**（2026-09-28）：① **预算**（`loop:` 三个上限 + 闸门 4 从轨迹数并断言，越界点名 run/实际/上限；挂钟真执行）；② **续跑留痕**（基座持有会话身份 + 核验实际 id，两条 run 轨迹同一 session、续跑标 `resumed`；自检 `pi-session-selftest`）。③ **终止条件**：不由基座声明（循环何时结束由模型与运行时决定）—— 但新增轨迹事件 **`run.end`（第 12 类，reason 用运行时原话）**，于是「正常跑完」与「中途被掐断」在证据上分得开；闸门 4 的 `smoke/run-end` 有则报 reason、无则**如实说看不到**（不据此判成败）。④ **委派深度**：**不可断言**——实测本环境**没有委派工具**（`pi list` 只有两个无关扩展），且轨迹没有父子关联字段 | 无（本项按"可断言/不可断言"收口） |
| E7 | 隔离与故障边界：每租户一容器/进程；钩子失败语义（阻断 vs 记录）显式声明 | 一个插件崩溃不影响其它会话有实测 | E5 | **钩子失败语义部分完成**（2026-09-28）：新增轨迹事件 `hook.error`（第 11 类）+ `guardedHook()`（默认接上写入器，业务侧只多一层包装）；定义里 `hooks.onFailure: record / block`（渲染器写成产物里的 `_hook-policy.mjs`，业务钩子 import 它，不手抄）；闸门 1 的 `hooks/failure-policy` 拦「声明了语义却没用包装」；闸门 4 的 `smoke/hook-failures` 看见失败就报，**policy=block ⇒ 本次运行判失败（退出码 40）**。**实测边界**：运行时自己**静默吞掉**钩子异常（退出 0、轨迹无痕）⇒ block 由**基座的闸门**执行，不是运行时中止。自检 `emit-selftest` 8 条（先留痕再处置 · 写入器坏了也不吞原错 · 非法参数响亮拒绝） | 每租户隔离与「插件崩溃不影响其它会话」仍待做 |；**每租户隔离与「插件崩溃不影响其它会话」按接口约定收口为上层义务**（基座给容器隔离参数与钩子失败语义，编排层负责多租户；见 `docs/design/2026-09-28-service-form-conventions.md` §2.2/§2.5） |
| E8 | 成本与审计面：token/成本归因、脱敏外发（dsh OTel 已有，pi 无） | 成本可归因到会话/人；脱敏可验证 | 主运行时选型 | **部分完成**（2026-09-28）：`make cost-report TRACE=…` 按 run 归因**次数与时长**（模型调用/工具调用/挂钟 + 钩子失败/审批次数）+ 身份（agent/harness/run/生效配置摘要）。**实测边界**：统一轨迹里没有 token 用量，主运行时的 `after_provider_response` 钩子只给 `{type,status,headers}`、**不透出 usage** ⇒ 归因工具**不编造成本数字**，如实说"没有"；轨迹 schema 预留**可选** `usage` 字段，将来某侧愿意透出时归因代码不必改。**归因到「人」做不到**：缺身份入口（会话头/平台变量）。自检 `trace-selftest` 新增 7 条 | 身份入口 + 脱敏外发仍待做 |；**脱敏外发与「归因到人」按接口约定收口为上层义务**（基座侧缺的是身份入口；见 `docs/design/2026-09-28-service-form-conventions.md` §2.4/§3） |
| E9 | 多语言业务代码（D-0012 的落地） | 非 JS 业务零胶水注册并被闸门 3/4 调用 | D-0012 | `pending` |

**前置待决**：业务层主运行时（dsh / pi / 两侧都做）—— 决定 E5–E8 的落点，见设计文档 §7.1。

---

## 24. 开放性与支持度（2026-09-26 登记，**未实现**）

> 来源：D-0015 与 `docs/design/2026-09-26-base-value-and-openness.md`。
> 目标：把"基座保证什么"讲清，同时**不设卡** —— 保证范围外的做法允许做，基座给缝并如实标注"未验证"。

| # | 项 | 判据 | 风险 | 状态 |
|---|---|---|---|---|
| O1 | **开放命名空间**：中性定义与 `enhancements.yaml` 允许 `x-*` / `customizations:` 与扩展 `kind`；内容**原样透传**进产物与清单 ✅ | 已做：三个 schema 加 `patternProperties: "^x-*"` + `customizations`（`additionalProperties:false` **不动** ⇒ 拼错的已知字段仍硬错误，负例 `01-unknown-field` 仍然红）；增强 `kind` 允许 `x-*`（schema `anyOf` + `catalog/enum-sync` 同时校验"自定义通道存在"）；共用实现 `core/spec/open-namespace.mjs`，闸门 1（`open/unverified-declarations`）与两个渲染器（清单字段 `unverifiedDeclarations`）都调它；正例夹具 `positive/open-namespace` 断言"全绿且列出" | — | `done` |
| O2 | **支持声明口径统一** ✅ | 已做：口径写成三-段式（保证/允许但不保证/明确不管）并落在设计稿 §4（`2026-09-26-base-value-and-openness.md`），把"不预留任何未来字段"旧说法显式标为**旧口径**并给出落地处；能力目录头部与统一设计的第三 harness 表述一并改口径；`make validate-selftest` 的正例就是这条口径的可执行证据 | O1 | `done` |
| O3 | **未验证声明进报告** ✅ | 已做：闸门 1 新增 `open/unverified-declarations`（列出每条：字段名 + 它是哪一层的东西）；清单字段 `unverifiedDeclarations`；会话内 `/project enhancements` 也列出（"未验证声明：无"也明说）；正例夹具断言三者中有名字可查 | O1 | `done` |
| O4 | **"基座能力自检"**：把 §1 的自检问题落成一份**可执行**清单（哪项能力、有没有判据、判据在哪） ✅ | 已做：`make selfcheck`（`JSON=1` 给 AI）+ 闸门 1 的 `docs/capability-judgements`，共用 `core/spec/capability-judgements.mjs`：逐行解析 §1/§2 的"证据/判据"到**真实存在**的 `make` 目标 / `node` 脚本 / 路径 / 闸门检查 id；解析不到 ⇒ 红（"指不出的能力"要删除或降级）；显式「未实测」算**降级态**并单独计数。落地过程中它当场抓出 3 条指不出判据的行（其中一条是**已填平却仍标"缺"**的陈旧行：钩子触发闸门 E2/P4/E2b）—— 已改准。自检 `gates-selftest` 含解析器四态（有判据 / 指不出 / 缺口记录 / 显式降级） | — | `done` |
| O5 | 业务层深定制的**样例契约**：钩子/loop/服务各一个最小样例（放在上层镜像示例里） | **重新界定**：与 E2/E3/E5–E8 是同一件事的两种说法（§23 的 E 系列已覆盖钩子面；loop/服务形态的声明面是 E5–E8，而它们卡在**主运行时选型**）。因此 O5 不单独做：等主运行时定了，按 E5–E8 的声明面一起做，样例随 `core/image/derived/` 的派生骨架给 | E5–E8（主运行时选型） | `pending`（并入 E5–E8） |
| O6 | **把 `docs/14` 的判据也纳入机器复核**（O4 只覆盖了 `docs/13`）✅ | 已做：解析器扩展 —— 认得**容器调用形式**的判据（`docker run … <子命令>` ⇒ 子命令必须在 `entrypoint.sh` 的 case 表里，**单一真源**）、认得 conformance 的 `C<n>` 用例 id、跳过表头行与缺口表行；清单从 29 条扩到 **72 条**（`docs/13` §1/§2 + `docs/14` §1/§3/§4），全部可解析（71 有判据 · 1 显式降级）。**过程中抓到两处真问题**：① `docs/14` 两次让人跑 `make trace-view`，而该目标**根本不存在** ⇒ 把查看器入口做出来（`tools/trace-view/labels.mjs` 早已实现，只差 Makefile 入口 + 真轨迹验证）；② 几行判据只写行为不写复核方式 ⇒ 补上可跑的命令/用例 id（判据必须可指认） | O4 | `done` |

---

## 25. 开发者契约的缺口（2026-09-26 登记；**P1–P4 已实现**，P5 待做）

> 来源：`docs/13-developer-contract.md` §4 与决策 D-0016。这些是"起点"的最低门槛：
> **P1–P4 已交付**（2026-09-26 实测），起点门槛已打通；剩 P5 是把"契约表必须随实现更新"制度化。

| # | 缺口 | 判据（什么算补上） | 依赖 | 状态 |
|---|---|---|---|---|
| P1 | **派生镜像骨架** ✅ | `core/image/derived/Dockerfile` + `make image-derived`；实测构建成功 | D-0014 | `done` |
| P2 | **镜像内自证** ✅ | `docker run <镜像> verify` 实测闸门 2/3/4 全过（离线零凭据） | P1 | `done` |
| P3 | **接入缝**（overlay）✅ | `/opt/agent-base/overlay/`；闸门 2 实测把 overlay 的声明计入（集合相等 2 项） | P1 | `done` |
| P4 | **钩子触发闸门** ✅ | 假网关触发 `tool_call` 断言钩子留痕（`probe/hooks-evidenced` + 轨迹 `emitter`）；"拦截生效"由 D6 的 `probe/model.tools`=1 覆盖 | —（**已先于 E1 落地**） | `done` |
| P5 | **契约表随实现更新**：`docs/13` §2 的每一行都要有"最后一次实测"的日期/命令 ✅ | 已做：§2 的 18 条断言逐行标注（17 条「日期 + 可重跑命令」，1 条如实标 **未实测**——§3 的跨版本承诺目前没有机器判据）；新增闸门 1 检查 `docs/contract-dates`：解析 §2 表格，缺日期/命令且没写「未实测」⇒ 红；并且**解析行数 < 15 也红**（防"解析器空转 = 假绿"）；本轮引用的每条命令都真跑过（含 `make compare` / `make walkthrough`）。⚠️ 它拦不住"标了假日期"—— 那部分只能靠纪律，已在表头写明 | P4 | `done` |

---

## 26. 会话内的项目自省命令（2026-09-26 登记，**用户实测提出**）

> 来源：用户实测 `examples/idea-to-proof` —— `run-local` 进交互 pi，**调试很方便**；
> 但"当前这个项目有哪些信息、我该验什么"要靠人翻文档。
> 用户原话（含一次口径更正）：**要的是智能体的斜杠命令**，在交互会话里随时可查，
> **内容全部来源于项目文件/代码本身**，非常有助于调试；
> 而且**靠补全功能反过来能知道"一个项目应该有哪些信息"**。
> ~~`make guide`（Makefile 目标）~~ 是被否的形态 —— 它要求你先退出会话、且只能看全基座通用的那张表。
>
> 机制（本机实测，非推测）：pi 扩展 API 有 `registerCommand(name, { description, getArgumentCompletions, handler })`；
> `get_commands` 报出的命令带 `source`：`skill`（技能自动成为 `skill:<name>` 命令）或 `extension`（扩展注册的）。
> 实测一个渲染产物在会话里可见 4 条命令：`llama`（source=extension）+ 3 条 `skill:*`。
> ⇒ **补全列表本身**就是"这个项目有哪些信息"的可发现面。
>
> 定位：不是新能力，而是**把已有的事实摊开给人看**（事实已在产物里：`agent-dir/` 的
> `settings.json` / `models.json*` / `mcp.json` / `skills/` / `enhancements.yaml`，
> 以及 `adapters/<h>/adapter.yaml` 的可订阅事件集合）。所以它必须**从产物现算**，
> 不能是第二份手写文案 —— 否则又会变成"文档说有、实现没有"（本轮已收口 7 处同类缺陷）。

| # | 项 | 判据（什么算做完） | 依赖 | 状态 |
|---|---|---|---|---|
| V1 | **基座不变量扩展注册一条自省命令**（pi 先做，走 `adapters/pi/seed/`）✅ | 已做：`/project`（`adapters/pi/seed/extensions/project-info.ts` + 纯逻辑 `_project-info.mjs`）。实测：① 会话里 `source=extension` 出现；② 二级补全 = 产物里真实的值（删技能即少一项）；③ 每项都标来源文件；④ 钩子事件名与运行时 39 个集合**逐个核对**，写错标 ❌；⑤ 读不到产物**响亮失败**；⑥ 可移植性结论与闸门 1 **同源**（自检里直接断言两者一致）；⑦ 自检 `make pi-project-info-selftest`（21 项，含真起 pi 的 `get_commands` 取证） | P1–P3 | `done` |
| V2 | **同一份数据、两个出口**：`make`/CLI 侧也能打印同一份项目自省（CI 与容器里可用），与 V1 **共用同一实现**，不写第二份文案 ✅ | 已做：`tools/project-info.mjs` + `make project-info`（文本 / `JSON=1` 机器可读 / `CATEGORY=<名>` 单类）。**同源的落法**：逻辑搬到 `core/introspect/project-info.mjs`（中性、无运行时常量名），渲染器像 `_trace-emit.mjs` 那样把它拷进产物 `extensions/_project-info.mjs` 供会话内入口 import ⇒ **一份源码两处用**；自检断言"CLI 的文本与逻辑层逐字一致" | V1 | `done` |
| V3 | **本运行时侧的等价入口** ✅ | 已做：`adapters/dsh/seed/plugins/project-info/`（基座不变量插件，row 指向入口文件）+ **同一份自省逻辑**（`core/introspect/project-info.mjs`，渲染期注入）+ **本运行时的产物读法**（`adapters/dsh/project-layout.mjs`）。为此把自省逻辑改成**清单优先 + 布局可选**：core 不再认识任何运行时的产物形状，`collect()` 的产物读法由各适配器的 `project-layout.mjs` 提供（含 `configDir()`——两个运行时的配置目录位置不同）。⚠️ **如实声明的不对称**：本运行时的命令注册接口只有 `input.hint`、**没有动态补全回调** ⇒ 分类清单写进 hint 作最接近的等价物，并记进 `adapters/dsh/exemptions.yaml` 的 `command-completions-unavailable`（不假装等价）。自检 `dsh-project-info-selftest`（真产物渲染 + 未知分类拒绝 + 缺产物响亮失败 + 不对称已声明 + 闸门 2 认得 row + 真跑无 import 失败）。**交互面证据（2026-09-27 补齐）**：主运行时侧已**端到端**验过（`pi-project-info-selftest` 用 RPC 真发 `/project skills`，断言报告作为自定义消息进会话且内容来自产物）；本侧**无头模式不派发斜杠命令**（实测：提示词进了模型，无 command 事件）⇒ 交互面需 UI 宿主（tui/ACP），已记进 `adapter.yaml` 的 `capabilities.commandsHeadless: unsupported` 与 harness 设计文档实测表（实验 I），并在自检里留了**边界检查**（该运行时若开始支持无头派发，它会变红、应升级成正向检查） | V1 | `done` |


---

## 27. 开箱可用的编码起步包（2026-09-26 登记，**用户提出**）

> 来源：用户指出 —— 镜像里的 pi/dsh 是"裸的"，而 `run-local` 进交互后其实已经具备**直接做
> AI Coding** 的条件；如果基座镜像能带上常用的编程相关 skills / plugins / MCP，会非常好用。
>
> **先说结论：这件事的机制基座早就有了**（`core/image/preinstall.yaml` 就是"基座的能力目录"，
> 带 `namedReferences` ⇒ 开发者只写 `ref: git`，不必知道包名/版本/参数；锁文件已装
> **npm 12 + apt 6**，含 git / ripgrep / jq / filesystem / repomix / playwright /
> chrome-devtools / inspector / context7 等）。缺的是**三处**，不是从零设计。

> **设计稿（先看它）**：[`docs/design/2026-09-26-capability-bundles.md`](../design/2026-09-26-capability-bundles.md)
> —— 用户明确要求"**要有包的概念，不能一个一个选**"，且包要**动态使能**（验证时纯净、编程时打开）。
> 本文的三处缺口在该设计里重新归位：**D9 → 默认「包组合」**（不再是"默认开几个连接器"）·
> **C1 → `coding` 包的技能内容** · **C2 → 包定义里的 `plugins` 字段**。
> **进度：设计稿已评审；用户决定「先记录、择机实现」——本节的项不占当前队列。**
> 落地顺序定为 **B1 包机制本体 → C4 技能落盘（含"基座技能进声明"）→ B2 `/project bundles` → C3 默认组合（兑现 D9）**。

### 27.1 三处缺口（实测评据）

| # | 缺口 | 实测证据 | 性质 |
|---|---|---|---|
| **D9** | **模板默认子集是空头承诺** | `preinstall.yaml` 注释写着「模板（S3）会默认启用一个开发常用子集，让 `new-agent` 之后立刻能 `verify`（N4 开箱可跑）」，而 `template/connectors.yaml` 实测是 `mcpServers: []`（只有注释示例）⇒ 新智能体拿到的仍是"裸"环境 | **缺陷**（与本轮已收口 8 处同类：文档说有、实现没有） |
| **C1** | **技能（skills）落盘数 = 0** | 锁文件统计 `npm 12 · apt 6 · 技能 0`；3 条编码技能仍是 `planned`：`skill-code-navigation` / `skill-debugging` / `skill-verification` | **缺口**（用户"裸"的感受主要在轴上） |
| **C2** | **"插件/扩展"这一轴没有预装类目** | `preinstall.yaml` 分类只有 reference / memory-reasoning / dev-debug / browser / docs-research / skills；**没有 pi packages 或 dsh 插件**这一类 ⇒ 用户提到的 plugins 今天无处声明 | **缺口**（新轴） |

### 27.2 设计后果（必须先定，否则一做就红）

- **基座提供的技能进产物会撞闸门 2**：硬断言 1 是「实际加载的技能集合 == 声明集合」。
  基座技能若直接塞进产物 `skills/` 而不进"声明"，**每个智能体的闸门 2 都会红**。
  ⇒ 处理方式应与基座不变量增强一致：基座技能也**进声明**（渲染器合并 seed 技能 ∪ 智能体技能，
  写进产物清单），闸门 2 的断言才继续有意义。
- **"装了 ≠ 启用"这条理由仍然成立**：工具描述每次请求都要读，连得越多模型越选不准；
  闸门 2 的断言集只含 enabled 的连接器 ⇒ 默认全开会让断言失去意义。
  所以：**预装（能力）与默认启用（选择）是两件事**（P-a 能力/选择分离）。

### 27.3 项

| # | 项 | 判据（什么算做完） | 依赖 | 状态 |
|---|---|---|---|---|
| B1 | **包机制本体**（设计稿 §2 / §6）✅ **落地完成**（2026-09-28，用户指示开工） | 包定义（`core/catalog/bundles.yaml`：验证基线默认开 / 编码辅助默认关 / 浏览器 planned）· 选择与解析（`core/bundles/index.mjs`，单一实现）· 闸门 1 `bundles/definition` · 清单烤入可用集合 · startup 校验（**未知包名响亮失败**并列出允许集合）· **激活真的生效**：按激活集合从暂存产物里摘掉未激活包的连接器（`core/bundles/filter.mjs`，按清单声明的落点与**格式**处理；没声明落点就不摘并如实记 `enforced=false`）· **期望集合 = 声明 ∩ 当前启用**（`expectedConnectorNames()` 一份实现，startup 与闸门 2 共用）· `verify --json` 带 `bundles` 字段 · 激活集合进轨迹与生效配置摘要 · 自检 `make bundles-selftest` + `make regression` 35 项。**实测**：同一产物默认组合 ⇒ 暂存里只有 `memory`；开 `coding` ⇒ `filesystem` 也进来；`typo-bundle` ⇒ 启动中止。**如实声明的差异**：另一侧连接器是构建期烤进 patch 的 insert row（文件含 `!!js`，重写会破坏插值）⇒ **该侧不摘**，写进 `adapters/dsh/exemptions.yaml`（`bundle-connector-removal-not-enforced`，含解除条件） | 无 | `done` |
| B2 | **发现面接线** ✅ **完成**（2026-09-28） | `/project` 新增 `bundles` 分类：列出**可用包 + 当前激活 + 默认组合 + 包里有什么 + 怎么开**，并写明「切换需重载会话」与「未知包名会启动失败」；二级**补全 = 清单里可用的包名**（沿用 V1 的同一份逻辑，不写第二份文案）。技能分类改为显示**本组合实际加载**的那套，并把「属于未激活包因此未加载」的明确列出来 + 给出开启命令（回答「为什么调不到那个技能」）。为此清单新增 `bundles.members`（每个包里有什么，是**数据**：运行期不重新解释包定义）。**实测**：默认组合 ⇒ `当前组合 verify-baseline ← 未显式指定`，`coding` 标未激活、技能列出未加载；`AGENT_BUNDLES=coding` ⇒ 编码三件套进来。自检：`pi-project-info-selftest` 新增 8 条（补全含包名 · 已激活/未激活 · 含什么 · 怎么开 · 重载提示 · 技能未加载标注） | B1 | `done` |
| C3 | **兑现模板默认组合（D9）** ✅ **完成**（2026-09-28） | 模板默认组合 = `coding`（`BUNDLES ?= coding` + `export AGENT_BUNDLES`）；模板 `connectors.yaml` 启用「开发常用子集」**只用 `ref:`**（filesystem / git / repomix —— 不写包名/版本，换 pin 只改基座一处）；README 写清默认组合、「纯验证怎么切」（`BUNDLES=verify-baseline`）与 `/project bundles`。**实测（判据②：默认启用的连接器真的连上了，不是「声明了」）**：端点侧工具名 —— `coding` ⇒ `mcp__filesystem, mcp__git, mcp__repomix`（共 8 个工具）；`verify-baseline` ⇒ 只剩 `mcp`（共 5 个）。自检 `new-agent-selftest` 新增 7 条（含按工具名对比）。⚠️ 记为**已解决的不稳定**：该对比起初偶发红 —— 真因是 MCP 服务器**异步**注册工具，取数时还没到位；改为**有界等待**（最多 20s）而不是重试掩盖 | — | `done` |
| C4 | **落盘 3 个编码技能（C1）**，并定「基座技能如何进产物且进声明」（见 27.2）✅ **完成**（2026-09-28） | ① `preinstall.lock.txt` 技能数 **0 → 3**（`planned-skill` 与 `lock-sync` 都绿）；② **闸门 2 的技能集合断言在每个示例上仍绿**（`make regression` 36 项 · 两侧 conformance 10/10）；③ 三个技能各有一份 `SKILL.md`（frontmatter + 实质内容 + 无占位字样）+ 一条可执行自检（`make base-skills-selftest`）；④ 离线/双架构不受影响（是内容不是包）。**机制（27.2）**：基座技能**不塞进 `declaredSkills`**（那个字段的语义是"定义声明了什么"，跨侧 C3/C4 按它核对定义→产物），而是记进清单的 `bundles.baseSkills`；`expectedSkillNames()`（与连接器**同一份共享实现**）算「定义技能 ∪ 激活包的技能」；startup 按激活集合**真的删掉**未激活包的技能目录（技能是纯目录 ⇒ 两侧都能摘）。**实测**：默认组合暂存里只有智能体自己的技能；`AGENT_BUNDLES=coding` 才有编码三件套 | C3 | `done` |
| C5 | **补「插件/扩展」预装类目（C2）** ✅ **完成**（2026-09-28） | 新类目 `coding-plugins`（**运行时专有**：两侧各一条，不假装等价）：pi 侧 `pi-web-access-plugin`（`auspia-web-access@1.0.0`，编码时查文档/API）· dsh 侧 `dsh-plan-plugin`（`@deepseek-ai/dsh-client-ui-plan@0.1.7-rc.1`，先只读探一遍再动手）——都写了 pin、`verifiedAlive: 2026-09-28`（实测 `npm view`）与「开发时拿它做什么」；`coding` 包按侧挂上（`plugins.pi / plugins.dsh`）。**加载（判据③）**：pi 侧**已接线** —— 包插件随激活集合进 `settings.packages`（`pluginSurface`，kind `json-packages`），实测默认组合 `[]`、`coding` ⇒ `["auspia-web-access"]`；自检 4 条（摘未激活/留激活/没声明不假装/未知格式不猜）。闸门 1 新增校验：包引用的插件必须在预装清单里、且必须是**该侧自己的**。⚠️ dsh 侧**不接线、也不声称已加载**（插件写在 profile 的 `bundles` 里、该 patch 含 `!!js`；且无头模式下 UI 插件无意义）—— 写进 `adapters/dsh/exemptions.yaml`（`bundle-plugin-loading-not-wired`，含解除条件） | — | `done` |
| C6 | **判据纪律（横切）**：新增的每一条预装内容都必须满足 | pin 精确 + `npm view` 存活实测日期 + 双架构可构建 + 运行期离线可用 + 落进 `preinstall.lock.txt` + 至少一条闸门/自检覆盖"真的生效" | — | `pending` |
| C7 | **「会话的工作区是什么」（用户问出来的相邻缺口）**：`run-local` 故意把 cwd 放在**中立临时目录**（杀掉"沿 cwd 祖先找 `.agents/skills`"这条隐式源），于是**会话里看不见你的仓库**，也没有 `--cwd/--workspace` 开关；`AGENT_WORKSPACE_ROOT` 目前只有 dsh 侧在用。要"进会话就能改代码"，必须先回答：工作区指向哪、仓库的 `AGENTS.md`/`CLAUDE.md` 要不要被吸进来（吸进来就是行为变化，得显式声明） | ① 有一条受支持的方式把会话工作区指向真实仓库（参数层，进 `params.yaml` 与闸门 1 检查）；② 隐式技能源仍然被隔离（`--no-skills` 已在，需实测确认）；③ 仓库指令文件是否被读取**显式声明**并有判据（不许"某个目录下行为不同"而无人知）；④ 与"验证用纯净环境"不冲突（默认仍是中立，编码包启用时才指向工作区） | B1 | `pending` |

**暂不做**：第三个镜像变体（`-dev` / coding）。理由：`preinstall.yaml` 自己写了
「现在拆是过早优化，只会让开发变慢」，且镜像语义是**验证快照**不是生产镜像；
等真出现"生产档"需求再拆，拆的时候只是 `FROM base` 加一层（debug 变体已示范过这条路径）。

---

## 28. 环境一致性与结论权威性（2026-09-26 登记，**用户质疑引出**）

> 来源：用户在 `run-local` 里看到 `/private/var/folders/...` 后追问 ——
> "那和容器内运行还是有差别的。那 agent-base 容器完全没起作用呀，镜像中缺省装的都没用上。"
>
> 核对结论：**"容器完全没起作用"过重，但"默认开发/验证循环不经过容器"属实**，而且
> **两个环境之间没有任何一致性判据** —— 这才是真问题。

### 28.1 实测事实（哪些对、哪些过头）

| 说法 | 核对结果 |
|---|---|
| `run-local` 不经过容器 | ✅ **属实**：`tools/run-local.mjs` 里 docker 调用数 = 0，跑的是宿主 `pi`/`dsh` + 文件系统隔离 |
| 镜像里缺省装的东西没用上 | ⚠️ **部分属实**：本机有**对应物** `.local-packages`（含 `@modelcontextprotocol`/`@cyanheads`/`@browserbasehq`/`@playwright`/`repomix` 等），harness 版本由 `make dev-env --check` 与 pin 对齐；**但** `.local-packages` **没有 package.json、没有锁、没有任何检查**对照 `preinstall.lock.txt`，而 apt 那 6 项（git/ripgrep/jq/curl/bash/ca-certificates）在本地不是"装了"而是"**宿主碰巧有**" |
| 容器完全没起作用 | ❌ **过头**：容器承担的是另一类职责 —— ① 交付路径（`make image-derived` 派生业务镜像 + 镜像内 `verify`）② **C9 只能在容器里成立**（非 root / 只读根 / 能力全丢 / 断网 / 双架构 / 同源摘要）③ `make debug` 的诊断 shell（**实测可跑**，退出码 0，走的是 `MODE=debug && VARIANT=debug` 分支：打印一行诊断头后 `exec /bin/bash`，不经过产物检查） |

**结论**：不是"容器没用"，而是 **"用途不同 + 没有判据把两边钉在一起"**：
本地是**迭代**环境（快），容器是**权威取证/交付**环境（可信）。
缺的是：本地得出的结论与容器内得出的结论**可能不一致，而没有任何东西会发现** ——
这正是本仓库反复在收口的那一类（静默不一致）。

### 28.2 缺陷

| # | 缺陷 | 证据 | 性质 |
|---|---|---|---|
| **D11** | **本地 ↔ 镜像没有一致性判据** | `.local-packages` 无锁无校验；`preinstall.lock.txt` 的 12 个 npm + 6 个 apt 在本地**没有任何对应检查**；`run-local` 零 docker 调用 ⇒ "本地可用、镜像不可用"（或反之）**不可见** | 静默不一致（本轮已收口 10 处同类） |

### 28.3 目标：把"调两遍"变成"调一遍 + 确认一遍"

用户追问一针见血：**"这不变成了本地调一遍、进容器还要再调一遍？"**
—— 只"标注差异"不够。目标要定死成一条**可测的判据**：

> **本地过 ⇒ 容器过**，且**例外集合恰好等于已声明集合**（多一条 = bug；少一条 = 声明过期）。

为什么这条能消灭"调两遍"：
- **调试只在一个环境做**（本地，因为快）；容器里那次是**回归确认** —— 跑**同一份产物**、**不改任何东西**。
- 只有当差异**未被声明**时，容器那次才退化成"第二次调试"（本地过、容器挂，然后你去容器里查为什么）。
  所以要做的不是让两个环境完全一样（不可能，也不必要），而是让差异**可见 + 可预检 + 数量小且稳定**。

**差异受管**（沿用既有 `exemptions.yaml` 的纪律：可以不一样，但不许**悄悄**不一样）：

| 已知差异 | 为什么必须差 | 本地能否预检 |
|---|---|---|
| 安全下限（非 root / 只读根 / capability 全丢 / 断网） | 本机没有等价机制（macOS 无 OS 级沙箱） | ❌ 只能容器验 —— **但已声明**，不算"未知" |
| apt 工具链（git / ripgrep / jq / curl / bash） | 容器由 apt 装；本地由**宿主**提供 | ✅ 可预检（缺了本地当场报） |
| 镜像同源 / 双架构 / 镜像内自证 | 只有镜像有 | ❌ 只在容器与构建侧 |

| # | 项 | 判据（什么算做完） | 依赖 | 状态 |
|---|---|---|---|---|
| Q1 | **本地预检（"降调试次数"的核心）** ✅ | 已做：`make env-check`（文本 / `JSON=1`）。开始验证前就查：harness 版本与 pin 一致（与 `make dev-env --check` **共用** `core/catalog/adapter-pins.mjs` 这一份"期望"）、预装 npm 包在本机镜像里是否齐、宿主是否有那套工具、以及哪些**本地查不了**（如实列出）。结果进 `verify --json` 的 `environment` 字段。自检 `env-check-selftest`（含"每个 apt 包要么可查、要么明确标不可查"这条不变量 —— 第一次实现就踩了：apt 包名 ≠ 命令名，`ripgrep` 的命令是 `rg`） | — | `done` |
| Q2 | **`env-exemptions` 受管**：逐条声明"本地 vs 容器差在哪、为什么必须差、本地能否预检"；出现**未声明的**差异 ⇒ 红 ✅ | 已做：声明在 `core/env/parity.mjs`（容器断言那部分**直接来自** `_container-only.mjs`，不另列一份）+ 宿主工具链 / 预装 npm 本地镜像 / 宿主 node_modules 三类；`classify()` 把命中未声明分类的差异列为 `undeclared` 并让 `make env-check` **非零退出**（自检里有该负例：版本漂移必须红） | Q1 | `done` |
| Q3 | **对照取证 + 出处标注**（**与 §30 A3 合流**，不再各算一项） | 见 **A3**：`verify --json` 已给出 `environment.where`（宿主/容器）与 `notCoveredHere`（本次未覆盖的容器断言）；A3 再补 `image` 摘要与 `covered` 清单 | A2 | `部分`（`where` + `notCoveredHere` 已随 Q1 落地） |
| W1 | **业务方走查（②：自研连接器 + Python 能力）** ✅ **完成**（2026-09-28） | 派生一个新智能体，只按它的 README + 基座文档走，给它加一个 **Python 能力**（`capabilities/`）与一个 **自研连接器**（`mcp-servers/`）。**结论**：两条路都走得通且是**零胶水**（能力两侧按同一份描述注册；连接器代码随产物走）—— `make validate` 51 项绿、`make verify` 四道闸门全过、容器内同样过。端点侧取证：工具名单里同时出现 `change_window_check`（业务能力）与 `mcp__corpus`（自研连接器）。**抓到 3 个真问题（全部已修 + 反向验证）**：① **自研连接器的相对路径运行期起不来**（产物写 `mcp-servers/…`，运行时 cwd 不对 ⇒ **静默**少一组工具）⇒ 启动期统一解析成暂存绝对路径（产物保持可搬）；② **闸门当时抓不到①**：只说「包就位」，而自研连接器没有包 ⇒ 新增硬断言 `resolution/connectors-start`（**逐个真启动 + 握手**，起不来红并给 stderr 尾巴；反向验证：指向不存在的文件 ⇒ 红且点名）；③ **文档与真源不一致**：设计稿写的嵌套 `stdio: {command…}` 过不了 schema（真源是平铺）⇒ 改正；另：模板**完全没有"怎么写业务代码"的指引、也没有可照抄的最小连接器** ⇒ 新增 `docs/15-business-code-cookbook.md`（每段都跑通过）+ 模板 README 指过去 | — | `done` |
| W2 | **文档自足性走查（③：只看 `docs/` 不看代码）** ✅ **完成**（2026-09-28） | 按 `docs/01-quickstart.md` **逐条照做**（生成物清单 · 四步 · 常用变体 · 容器片段），用实测找文档与现实的差。**结论**：主干路径自足（`make dev-env` → `new-agent` → `validate` → `verify` → `verify JSON=1` 出合法报告 · `HARNESS=dsh` 同样过 · `render && doctor` 正常 · `examples/README` 可照做）。**抓到 4 处文档与现实不符，全部已修**：① 生成物清单里写了 `trace-labels.yaml`（实际不派生，是**可选自建**）；② 容器片段把产物指到 `dist/pi/<名字>`（派生目录里其实在 `.render/<运行时>`）且镜像 tag 写死 ⇒ 改成「用 `docker images` 取本机 tag + 挂 `.render/pi`」并指向 `make verify-container`（改后**逐字实测可跑**：可用·镜像内自证通过）；③ `make image` / `make image-all` 是**基座仓库**的目标，派生目录里跑会 `No rule to make target` ⇒ 文档写明「智能体不产镜像，产物是挂进基座镜像的」；④ `make run-local` 的变体没写「要告诉它端点」（不给会响亮失败——行为正确，文档缺一句）⇒ 补上并指向本地模型一节。另修：`docs/README.md` 自称「12 篇」（实际 00–15）⇒ 改为按范围表述（数出来的就会腐烂） | — | `done` |
| W3 | **收口两条 dsh 侧能力包豁免 + 状态文档同步** ✅ **完成**（2026-09-28，用户指示「完成剩下的已知留白」） | ① **技术理由被实测推翻**：原写「YAML 里 `!!js` 会被重写破坏」⇒ 用 yaml Document API + `lineWidth: 0` 摘 insert row，其余内容（含 `!!js` 长标量）**逐字保留**，且写回前有**保真校验**（语义不符就拒绝写并响亮失败）。实现 `enforceYamlInsertRows`（落点与匹配列由清单声明，core 不认运行时）+ 插件落点支持**点分字段**。**对照实验**：连接器默认组合 ⇒ 暂存 patch 只剩非包连接器；开 `coding` ⇒ 包连接器回来；插件列表同理；两种组合**四道闸门都过**（容器内也过）。两条豁免条目**已删除**（豁免表只放**当前**不对称；故事留在 JOURNAL）。② 顺带测出**一处既有的未声明差异**：候选运行时**在容器内起不来**（镜像缺它的 Linux 版原生二进制）——用「不摘任何内容」的对照证明与本轮改动无关；已在 `core/env/parity.mjs` 声明（含解除条件）并入归因，实跑验证归因给出「已声明差异」而不是「未声明」。③ 状态文档按真相同步（`CURRENT-STATE.md` 的闸门项数与事件类数早已腐烂：29→34 · 10→12；`RESUME-NEXT-SESSION.md` 重写） | — | `done` |
| Q4 | **本地预装集有锁**：`.local-packages` 从 `preinstall.lock.txt` 生成/校验（镜像预装清单的本地对应物） ✅ **完成**（2026-09-28） | ① 可复算：`.local-packages.lock.json`（npm 逐项 name@version + apt 逐项标注 + `lockDigest` 指向同一份镜锁），`make local-packages-lock` 生成；② 同源：`make local-packages` 按**同一份锁**装入；③ 如实标注：apt 7 项标为**宿主提供**（不假装本地镜像管了它）；**检查进回归**（`make local-packages-check`，含三项：与锁一致 · 版本全对 · **锁变了而镜像没重刷**能被抓——靠指纹里的 `lockDigest`）。**触发它的事故**：`npm install --prefix .local-packages <两个包>` 把其余包全剪掉（闸门 3 + 模板自检 + examples-check 连锁失败）⇒ 手工目录的代价。**仍不是全部**：指纹覆盖「锁声明了什么 + 本地落在什么版本」，**不是**逐字节内容比对（镜像里是全局安装树，逐字节比不可行也不必要） | Q1 | `done` |
| Q5 | **容器内交互**（可选，长期）：让"你调试的就是要交付的"——`-debug` 变体里挂上产物根跑真正的运行时，而不只是诊断 shell | 容器内会话里 `/project` 与 `verify` 都能用；与 `run-local` 的差异**有判据**（不靠人记） | B1 / Q3 | `pending` |

**暂不做**：把宿主路线**强制**替换掉。⚠️ 原先这里写的"容器文件系统性能更差"**已被实测否定**（见 29.4）——
保留宿主循环的理由改成"**不强制单一形态**"；而当 §29 的开发者容器可用时，本章 Q1/Q2 的差异清单会**大幅缩小**
（两处不同源的问题从"永远存在"变成"dev 镜像 `FROM` delivery 同 digest"这一条可证的事实）。

---

## 29. 开发者容器：进容器做全套（2026-09-26 登记，**用户提出**）

> 来源：用户在读完 §28 后说明了自己的预期模型 ——
> "我还以为是起 agent-base 容器，exec 或 ssh 进入后，再运行我们这一套。"
>
> 核对结果：**这个模型离可用只差一点**。实测基础镜像里已经有：`node v24.21.0`、`npm`、`git`、`jq`、
> `rg`、`bash`、**两个 harness 的 pin 版本**（`/usr/local/bin/pi`、`/usr/local/bin/dsh`），以及
> **整套工具链**（`/opt/agent-base/gates/` 下有 `tools/`、`core/`、`adapters/`、`node_modules/`、
> `verify-in-image.mjs`）。缺的只有三样：**`make`**（镜像里没有，Makefile 也不在镜像里）、
> **你的仓库**（定义/示例不在镜像里，要挂进去）、以及**一条受支持的入口**（今天只有
> `agent | config-check | verify | shell | debug`，没有"挂仓库 + 工具有齐"的开发 shell）。

### 29.1 为什么这个模型值得认真对待

**它一举消掉 §28 的整个问题**：如果开发发生在容器里，就不存在"本地 vs 容器"两个环境 ——
只有一个。§28 的一致性判据随之**大幅简化**：不再是"宿主环境 vs 镜像环境"，而是
**"dev 镜像 vs delivery 镜像"**，而后者可以**证同源**（dev 就是 `FROM delivery` 同一 digest 加一层，
仓库已有这条纪律：`Dockerfile.debug` 是唯一加装点，生产 entrypoint 遇到 `AGENT_RUN_MODE=debug` 直接拒绝）。

### 29.2 三条路线的取舍

| 路线 | 是什么 | 代价 |
|---|---|---|
| 甲（我原 §28） | 宿主开发 + 差异受管（Q1–Q5） | 差异永远存在，只能"受管 + 可预检"；用户担心的"调两遍"风险一直在 |
| **乙（用户模型，建议为主）** | **开发容器为唯一环境**，宿主只当编辑器；`docker run -it -v $PWD:/work` + `make` 全套 | 需要一份 dev 变体并保持与 delivery 同源；"从容器里构建派生镜像"需要 docker socket（**规定构建仍在宿主/CI 做**即可避开）。**"I/O 更慢"已被实测否定，见 29.4** |
| 丙 | 两者并存（宿主快循环 + 容器全量） | 又回到"两个环境"；只有明确需要宿主体感时才值得 |

**建议：乙为主、丙兜底。** 理由：① 直接消灭"调两遍"的**根源**（不是打标签）；② 镜像已具备九成；
③ 同源可证，不是"两套东西碰巧长得像"；④ 与既有纪律一致（调试/开发工具不进交付镜像已有先例）。

### 29.3 项

| # | 项 | 判据（什么算做完） | 依赖 | 状态 |
|---|---|---|---|---|
| W1 | **一条命令进开发容器**：`make dev-shell`（或 `ab dev`）——挂载仓库到 `/work`、带上 `make`、`cd /work` 进 bash；进去就是全套（`node tools/validate.mjs`、`make verify`、`make run-local`、`pi`/`dsh` 交互） | ① 从零开始一条命令进得去、且**当场能跑通**"渲染 → 四道闸门 → 交互会话 `/project`"；② 不需要人手装任何东西（镜像里已装齐，缺的 `make` 补进 dev 变体）；③ 退出后宿主工作树**零副作用**（写只落在挂载目录与容器内） | — | `pending` |
| W2 | **dev 变体与 delivery 同源且隔离**：dev = `FROM` delivery **同一 digest** 加一层（工具：make 等）；**dev 工具绝不进交付镜像**；production entrypoint 继续拒绝 debug/dev 模式 | ① 变体 LABEL 记基础镜像 digest，可核对同源；② 有一条检查"交付镜像里不含 dev 工具"；③ 生产变体遇 `AGENT_RUN_MODE=debug` 仍退出码 2（已有，别退化） | — | `pending` |
| W3 | **构建仍从宿主/CI 发起**：不在开发容器里做 docker-in-docker（不给 socket）；容器内负责"渲染 + 四道闸门 + 交互"，镜像构建与多架构打包留给宿主/CI | 文档与入口都把这条写清；容器里跑构建会**明确失败并说明原因**（不是含混报错） | W1 | `pending` |
| W4 | **与 §28 的关系写清**：采乙之后，§28 的 Q1/Q2（宿主 vs 容器的差异清单与预检）降级为"丙兜底时才需要"；**必留**的是 Q3（结论出处标注）与 Q4（预装集有锁） | `docs/13`/`docs/14` 不再同时讲两套互相矛盾的口径 | W1 | `pending` |

### 29.4 实测：I/O 顾虑不成立；真正要做的是"挂载矩阵"

用户对"macOS 容器 I/O 慢"的判断是对的 —— **不是问题**。本机实测（同一份仓库 bind-mount 到 `/work`）：

| 动作 | 宿主 | 容器 | 绝对差 |
|---|---|---|---|
| 写 300 × 4KB 小文件 | 21 ms | 55 ms | +34 ms |
| 读 300 个文件（1.2 MB） | 6 ms | 10 ms | +4 ms |
| 遍历 149 个文件（core/tools/adapters） | 2 ms | 17 ms | +15 ms |
| **纯 node 启动**（3 次一致） | 40–50 ms | **13–17 ms** | 容器更快 |

相对倍数看着吓人（最多 ~8×），绝对量是**几十毫秒**；而循环里真正花时间的是模型调用（秒级）。
容器里的 node 启动甚至更快（镜像里是干净的 Linux 二进制，宿主用的是 Homebrew 那份）。
⇒ **"容器 I/O 慢"不该作为否掉这条路的理由**（已按用户意见收回）。

**真正要设计的是挂载矩阵**（用户提醒：只挂仓库、不挂配置与缓存 ⇒ 重启容器就从空开始）：

| 挂什么 | 容器内落点 | 模式 | 不挂会怎样 |
|---|---|---|---|
| 仓库 | `/work` | rw | 没有定义/示例，什么都跑不了 |
| **pi 登录态** | `AGENT_HARNESS_HOME`（凭据文件 `auth.json`） | rw | 每次重启容器都要重新登录 |
| **dsh home** | `DSH_HOME` | rw | 登录态与会话历史一起丢 |
| **npm 缓存** | 命名卷 → `~/.npm` | rw | 每次重启都要重下依赖（宿主 `~/.npm` 在本机 DSH 沙箱里被拒写，容器内无此问题） |
| **宿主的 `node_modules`** | —— | **不挂** | 宿主是 macOS 构建的原生模块，进 Linux 容器会炸；`yaml`/`ajv` 恰好是纯 JS 才没炸 —— **那是运气，不是设计**。用容器侧卷或在容器内装 |
| docker socket | —— | **不挂** | 见 W3（构建留在宿主/CI） |

另有一个必踩的坑：容器内以 root 写挂载目录，**宿主文件属主会变成 root**。
对策：`--user $(id -u):$(id -g)`（同时保证 HOME 与 npm 缓存可写），或让写操作只落在容器侧目录。
**这些都要进 W1 的判据**，不能停留在"某人的 shell 别名里"。

**判据总纲（与 §28 同一条）**：无论走哪条路，**"一处通过 ⇒ 另一处通过"的例外必须恰好等于已声明集合**。
乙的强处在于：那个集合几乎可以缩到空 —— 因为两处本来就同源。

---

## 30. AI 代理的容器验证（2026-09-26 登记，**用户提出**）

> 用户提出：容器作为完整环境**约束太大**；现在都是 AI Coding —— 能否**本地调试为主**，
> **需要容器验证/调试时交给 AI 去做**，但**中间的协议约定**与**框架对这种模式的有效支撑**要想清楚。
>
> 设计稿（先看它）：[`docs/design/2026-09-26-agent-drivable-verification.md`](../design/2026-09-26-agent-drivable-verification.md)
> **好消息：协议已有一半**（实测）：`verify --json` 顶层已带 8 个字段（声明 + 三个摘要 + `gates[]` + `usable`）·
> 退出码语义单一定义 · 容器内取证入口已在。缺的是四处（见下）。

| # | 项 | 判据（什么算做完） | 依赖 | 状态 |
|---|---|---|---|---|
| A1 | **意图面 `verify-plan`**：机器可读地说明"要验什么、哪些只能在容器验、为什么" ✅ | 已做：`make verify-plan`（`JSON=1` 给 AI）+ 会话内 `/project plan`，两者共用 `core/introspect/project-info.mjs`。输出含 `identity`（定义/产物/渲染输入/生效配置；镜像输入摘要在有构建上下文时给出）· `local[]`（四道闸门的命令与期望）· `container[]`（四条，每条带 `why`）· `notCovered[]`。**"加一条容器断言"的判据按可达形式落实**：新断言要在 `core/introspect/_container-only.mjs` 归类，自检会揪出"C9 里写了却未归类"的 id（静态扫 `add("…")` 字面量；变量拼 id 扫不到 —— 该限制已写进文件顶部） | §26 V1 | `done` |
| A2 | **执行面：受控容器验证入口**（封闭命令；**绑定面 = 当前项目**，由基座生成）✅ | 已做：`make verify-container AGENT_DIR=… [ARCH=…] [DRY=1] [JSON=1]`（`tools/verify-container.mjs`）。**受控是可验证的**（自检 30+ 项）：① 旗标表封闭 —— `--privileged` / `-v /:/host` / `--mount …src=/…` / `--net host` 全部被拒（含"单横线旗标混成位置参数"这条）；② 绑定面**恰好两处、都是只读**、落点固定（`/work/agent`、`/opt/agent-base/artifact`）；③ 网络 `none`、根只读、`/tmp` 才可写、`--cap-drop ALL`、`no-new-privileges`、镜像取**生产变体**；④ 符号链接项目 / 无 `agent.yaml` / `/` / 家目录 / 仓库根一律拒绝；⑤ **真跑一次**（本机 arm64 镜像）：容器内闸门 1（agent-only）+ 2 + 3 + 4 全过，离线零凭据，输出带 `where=container` 与镜像摘要。⚠️ **未做**：审批留痕（"谁放行了这次验证"）—— 该命令是**唯一需要审批的面**，但把它作为受审批的工具接进各运行时的工具面属独立一步，见 A6 | 用户已定绑定面 | `done`（审批留痕除外） |
| A6 | **把受控入口接成「需要审批的工具」**（A2 的 ⑤）· **主运行时侧** ✅ | 已做：基座不变量命令 `/verify-container`（`adapters/pi/seed/extensions/verify-container.ts`，在 seed `enhancements.yaml` 里声明 ⇒ 闸门 2 的集合断言同样覆盖它）。流程：**先摊开将要执行的参数**（调受控入口 `--dry-run`）→ `ctx.ui.confirm` 人在环审批 → **决定记进统一轨迹**（新增第 10 类事件 `approval.decision`：granted / denied / **unavailable**）→ 只有放行才调用受控入口。**fail-closed**：无应答者（非交互）或容器会话里没有定义目录 ⇒ 记 `unavailable` 并放弃，绝不默默跑。自检 `pi-verify-container-selftest`（17 项：四种走向 + 事件过 schema + **静态断言「扩展没有自己拼 docker 的路」**），另有真运行时注册取证。同时**收窄了两侧既有的审批豁免**（`tool.call.decision` 仍不可回答「谁放行」；`approval.decision` 对走审批门的动作可信） | A2 | `done` |
| A6b-1 | **量清另一侧的审批与插件接口**（A6b 的前置）✅ | 已做（可重跑：`make dsh-approval-probe`，结论写进 `docs/design/2026-09-25-dsh-harness-design.md` §3.8.1 + §3.11 实验 F/G/H）：① 接缝 = `ctx.approval.request(req) → allowed-once \| rejected \| cancelled \| unavailable`（**fail-closed**）、`approval/request` 是 waterfall、`ctx.commands.register(def) → disposer`；② **审批审计事件不在统一轨迹所读的 `--json` 事件流里**（两种权限模式都是 0 条），会话文件本次运行也只有 `session` 引导事件 ⇒ **事后映射这条路不通**；③ 基座插件可用 profile patch 的**相对路径 insert row** 装载，但 `name` **必须指入口文件**（指目录 ⇒ `failed to import`，ESM 无目录解析）。顺带**更正一处过度声明**：本侧豁免里原写"可回答谁放行了这次调用"，实测不成立，已改准 | — | `done` |
| A6b-2 | **另一侧的受控入口 + 审批门**（按 A6b-1 量到的形态落地）✅ | 已做：**基座不变量插件脚手架**（此前不存在）—— `adapters/dsh/seed/{enhancements.yaml,plugins/verify-container/}`；渲染器把 seed 插件拷进 profile、insert row 指向**入口文件**（`./plugins/verify-container/index.js`，实测指目录会 `failed to import`）、注入 `core/trace/emit.mjs` 作事件写入器；清单补 `agentEnhancements`（**只含智能体自己的**，基座不变量不算不可移植性）与 `augmented` 同义字段。插件注册 `/verify-container`，走 `ctx.approval.request`（四种结果 → `approval.decision`，`unavailable`/未知 ⇒ **fail-closed 放弃**），只调受控入口。自检 `dsh-verify-container-selftest`（35 项：审批四走向 + 无审批服务 + 审批报错 + 干跑失败 + 静态「不拼 docker」+ **集成**：产物就位 / 闸门 2 认得 row / 真跑无 import 失败） | A6b-1（已量）、A6（参照实现） | `done` |
| A3 | **结果面：出处 + 覆盖范围**：每条结论带 `{where, image, covered, notCovered, why}` ✅ | 已做：宿主侧 `verify --json` 的 `environment` 带 `where=host` + `covered:[static,resolution,probes,smoke]` + `notCoveredHere` + 差异清单；容器侧 `verify-container --json` 带 `where=container` + `image`/`imageDigest` + `covered` + `notCovered`（安全下限/双架构/同源）。**交付口径**已写进 `docs/14`（容器内自证为准） | A2 | `done` |
| A4 | **失败面：归因分类** ✅ | 已做：`core/verify/attribution.mjs`（纯逻辑，可被自检直接断言）+ `verify-container` 失败时**自动跑一次宿主验证作对照**。**五类**（比原计划多一类，见下）：`local-reproducible`（真缺陷）· `declared-env-difference`（已声明，不是缺陷）· `container-only-failure`（容器专有断言挂 ⇒ 真缺陷，改镜像/参数）· **`local-unverified`**（本地**没跑到**这道闸门）· `unknown`（本地跑到且过、差异又没声明 ⇒ **响亮上报**）。⚠️ 第五类的由来：宿主 `verify` 是**首败即停**的，而容器内自证会跑完四步 —— 把"没跑到"当"本地通过"会凭空造出"容器专有失败"（本轮实测踩中）。`unknown` 无声明时 `ok=false`，输出里明确要求"要么消差、要么去 `core/env/parity.mjs` 登记理由，别猜" | §28 Q1/Q2 | `done` |
| A5 | **端到端无人值守判据** ✅ | 已做：`make unattended-selftest`（`tools/unattended-selftest.mjs`）—— 一条脚本把「改定义 → 本地闸门 1 → 验证计划 → 环境预检 → 受控容器验证 → 失败归因」串起来，**全程管道调用、无 TTY**；对整条链路做**属性断言**（每步 stdout 可解析、退出码在语义集合、覆盖五个环节）。**重复触发一致**：同输入第二次**命中缓存**（只缓存通过，`--no-cache` 可绕过）。这条断言当场抓出一个一直存在的**契约违规**（见 D12） | A1–A4 | `done` |

**安全边界（用户已定，2026-09-26）**：**绑定面 = 当前项目**（不是主机根）—— 受控入口由基座生成 allowlist：
项目只读（验证）／可写（仅显式 dev 模式）· 基座工具链**来自镜像，不挂** · 宿主 `node_modules` 不挂 ·
socket / `--privileged` / `--net=host` / `--cap-add` / `-v /` 一律拒绝。
实测三条（设计稿 §5.1）：① 只挂定义 ro + 断网即可在容器内**渲染成功**；② 容器里跑宿主入口 `tools/verify.mjs` 会出 **2 个假失败**（缺仓库 docs）⇒ 必须走 agent-only 入口；③ 挂产物 ro + 镜像自带 `verify` = **闸门 2/3/4 全过**（离线零凭据）⇒ 受控入口复用它。

**与 §29 的关系**：本模式以人为本（人不进容器），§29 的开发者容器降为**可选的第三种形态**。
**与 §28 的关系**：差异清单从"给人看"升级为"**给 AI 读的归因依据**" —— Q1/Q2 由优化项变为本模式的**前提**。
