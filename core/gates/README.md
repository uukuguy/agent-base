# core/gates —— 四道闸门框架（基座不变量）

> **本层纪律（统一设计 §12.1 原话）**
>
> 放：中性定义规范、能力目录、闸门框架、统一轨迹 schema、基座镜像。
> **不放**：任何 harness 名字、任何业务概念的具体取值。

> 本目录的代码与 schema **不得出现 harness 名**（`tools/validate.mjs` 的 `core/harness-name` 检查会拦）。
> Markdown 文档豁免——纪律原话本身必须点名。

## 职责边界（§5.1）

| 基座（本目录） | 适配器（`adapters/<h>/`） |
|---|---|
| 编排四道闸门的顺序 | 提供 `render` / `doctor` / `probe` / `smoke` 实现 |
| 断言语言（可序列化，供 `conformance` 与冒烟断言集复用） | 声明自身能力与降级行为 |
| §6.7 的报告格式与退出码 | 报告「实际加载了什么」 |
| 参数层清单的执法（§2.3） | 声明已知静默失败并实现检测 |

**一句话**：适配器是翻译层 + 自证层；编排、断言与判定口径属于基座。

## 文件

| 文件 | 作用 |
|---|---|
| `exit-codes.mjs` | §6.7 退出码表的唯一定义处（验证工具与运行时共用同一套语义，§8.2） |
| `report.mjs` | §6.7 报告格式；`GateReport` 区分 **ok**（跑过的闸门都过）与 **usable**（§6.8：四道全过） |
| `assertions.mjs` | 断言语言（12 个种类）+ `isLoudFailure`（C5/C8 的灵魂） |
| `orchestrator.mjs` | 四道闸门按序编排，默认在首个失败处停下 |
| `digest.mjs` | 确定性摘要（`definitionDigest` / `artifactsDigest`，N19） |
| `selftest.mjs` | 框架自检：断言集能跑通、注入式静默失败必须被抓到、报告形状符合 §6.7 |

## 断言语言的约定（无歧义是刻意的）

```yaml
- id: skills-set
  assert: set-equals          # 集合相等：多一个也不行（§6.3 硬断言 1）
  actual: doctor.skills       # **总是** context 路径；路径不存在即失败
  expected: [example]         # **总是**字面量，让人读用例就能看懂期望
- id: tools-present
  assert: at-least            # §6.4：必须断言 tools=N>0
  actual: probe.model.tools
  expected: 1
- id: negative-injection
  assert: fails               # 注入场景必须响亮失败；静默通过即判失败
  actual: inject.forbiddenParam.exitCode
```

需要拿 context 里的另一个值做比较时用 `expectedPath`（例如「doctor 实际集合 == 定义声明集合」，§6.3）。

**加新断言种类之前**：先确认现有 12 种表达不了，而不是懒得组合。断言种类越多，「用例怎么读」这件事就越依赖文档。

## 命令

```bash
make gates-selftest     # 框架自检
make validate           # 闸门 1（唯一已实现的闸门，见 docs/plans/IMPLEMENTATION-ROADMAP.md）
```
