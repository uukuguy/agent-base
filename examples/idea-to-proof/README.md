# idea-to-proof · 把想法变成可验证的断言

把一段模糊的想法拆成**可独立证伪的断言**，排出验证顺序，并明确说出哪些现在无法验证。

## 它解决什么问题

「我觉得客服响应慢是因为人多」这类说法**不能直接验证** —— 它听起来是结论，实际是信念。
本智能体把它变成：几条可独立证伪的断言 + 每条的证伪条件 + 一个"先验哪条"的顺序。
产出是**可执行的验证计划**，不是建议，不是方案。

它同时是 agent-base 的**最小完整示例**：一份中性定义 + 几个技能，不连外部系统、不需要任何密钥。
想学"一个符合规范的智能体长什么样"，从这里看最快。

## 结构（这就是全部）

| 文件 | 干什么 |
|---|---|
| `agent.yaml` | 它是谁、用哪个模型、边界（只读：`tools.deny: [bash, write, edit]`） |
| `connectors.yaml` | 空 —— 纯技能型，不连外部系统 |
| `trace-labels.yaml` | 业务给轨迹起的说法（基座不解释这些词，只按定位符机械查找后原样呈现） |
| `skills/claim-extraction/SKILL.md` | 把想法拆成可独立证伪的断言 |
| `skills/falsifier-design/SKILL.md` | 为每条断言写出"什么结果算被推翻" |
| `skills/evidence-grading/SKILL.md` | 给证据分级并排验证顺序 |
| `skills/evidence-grading/scripts/check-table.mjs` | 校验产出表格结构的脚本（技能自带、可单独自检） |
| `Makefile` | 薄转发层：跑闸门、渲染、本地运行（改定义就行，不用改它） |

**没有 `harness/` 目录**是刻意的：这个示例的价值就是证明"中性定义 + 技能"已经够用。
真需要自定义工具/钩子时才加 `harness/<运行时>/enhancements.yaml`。

## 构建与验证过程

在**仓库根**执行（下面的命令都能直接粘）：

```bash
# ① 静态校验：定义合法、引用存在、命名与分层合规
make validate AGENT_DIR=examples/idea-to-proof
#   期望：闸门 1：全绿（38 项检查）；末尾没有 ❌

# ② 四道闸门：闸门 2 解析自证 → 3 集成探针 → 4 端到端冒烟
node tools/verify.mjs examples/idea-to-proof --harness pi
#   期望：✅ 可用：四道闸门全过（§6.8）—— 这个想法被证明走通了
#   闸门 3/4 走基座自带的**零凭据假网关**，不需要任何密钥

# ③ 换一个运行时再验一次（同一份定义必须两边都可用）
node tools/verify.mjs examples/idea-to-proof --harness dsh
#   期望：同样「可用：四道闸门全过」

# ④ 跨运行时等价性：两边渲染出的能力集合必须一致，差异必须有声明
node tools/compare.mjs examples/idea-to-proof
#   期望：等价性通过

# ⑤ 技能自带脚本的自检（改了脚本就跑）
node examples/idea-to-proof/skills/evidence-grading/scripts/check-table.mjs --selftest
#   期望：退出码 0
```

四道闸门分别在证明：

| 闸门 | 证明什么 | 本示例的看点 |
|---|---|---|
| 1 静态 | 定义合法、引用与分层合规 | 技能名与目录一致、`deny` 里的工具名是已知工具 |
| 2 解析自证 | 运行时**实际加载**到的技能与声明一致 | 三个技能都真的进了产物（不是写在定义里就算） |
| 3 集成探针 | 模型可达、工具字段没被吞、流式没被降级 | 与本地模型无关：探针指向零凭据假网关 |
| 4 端到端冒烟 | 它真的能干活、且没越界用工具 | 声明了 `deny: [bash, write, edit]`，冒烟里只应出现 `read` |

**真跑一次**（需要真实端点；想用本地模型见 `examples/local-model-dev/`）：

```bash
make run-local AGENT_DIR=examples/idea-to-proof PROMPT="客服响应慢，我觉得是人手不够"
#   期望：输出一份表格（断言 / 证伪条件 / 证据等级 / 不可验证项），
#        最后一句是「下一步先验第 N 条，因为 ……」；退出码 0
```

## 改它

| 想改什么 | 改哪里 |
|---|---|
| 人设 / 边界 | `agent.yaml` 的 `persona.instructions`、`tools.deny` |
| 加一个技能 | 新建 `skills/<名字>/SKILL.md`（frontmatter 必须有 `name` / `description`，`name` 与目录名一致） |
| 技能要带脚本 | 放 `skills/<名字>/scripts/`，在 SKILL.md 里用**相对路径**引用；脚本写 `--selftest` 子命令 |
| 换模型 / 换供应商 | `agent.yaml` 的 `model.provider` / `model.name`（供应商见 `core/catalog/providers.yaml`） |
| 接外部系统 | `connectors.yaml`（推荐 `- ref: <预装条目名>`，例如 `- ref: filesystem`） |
| 业务轨迹用词 | `trace-labels.yaml` |

改完**再跑一次** `make validate AGENT_DIR=…` + `node tools/verify.mjs …` —— 闸门会把你写错的地方当场指出来（例如模型名不在该供应商的名单里、技能引用了不存在的目录）。

## 已知边界

- **不评价模型回答质量**：闸门只证明"调用成功、工具字段没被吞、流式没被降级、没越界用工具"。
- 闸门 3/4 默认走**零凭据假网关**：要"真的能用"的证据用 `LIVE=1`（见 `docs/01-quickstart.md`）。
- **只读边界由闸门 4 实测**，不是靠约定：`deny` 里的工具真的不该出现在冒烟轨迹里。
- 这个示例**不带连接器**，也不带 `harness/` 增强：那是刻意的，用来证明最小形态就够用；
  需要连接器看 `examples/contract-review/`。
