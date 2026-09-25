# idea-to-proof

把一段模糊的想法拆成**可验证的断言**，排出验证顺序，并明确说出哪些现在无法验证。

## 它解决什么问题

「我觉得客服响应慢是因为人多」这类说法**不能直接验证** —— 它听起来是结论，实际是信念。
本智能体把它变成：几条可独立证伪的断言 + 每条的证伪条件 + 一个"先验哪条"的顺序。
产出是**可执行的验证计划**，不是建议、不是方案。

## 结构（这就是全部）

```
agent.yaml          它是谁、用哪个模型、边界（只读：deny bash/write/edit）
connectors.yaml     空 —— 纯技能型，不连外部系统
trace-labels.yaml   业务给轨迹起的说法（基座不解释，只机械查找后呈现）
skills/
  claim-extraction/    把想法拆成可独立证伪的断言
  falsifier-design/    为每条断言写出"什么结果算被推翻"
  evidence-grading/    给证据分级并排验证顺序（带一个校验表格结构的脚本）
```

**没有 `harness/` 目录**是刻意的：这个示例的价值就是证明"纯中性定义 + 技能"已经够用。
等真的需要自定义工具/钩子时再加 `harness/<runtime>/`（那是业务级增强，见基座 README）。

## 跑起来

```bash
make verify AGENT_DIR=examples/idea-to-proof      # 四道闸门，给出「可用 / 不可用」
make run-local AGENT_DIR=examples/idea-to-proof   # 本地交互跑一次
```

四道闸门分别证明：定义合法（1）、运行时**实际加载**的技能与声明一致（2）、
模型与技能真的可达（3）、它真的能干活且没越界用工具（4）。

第 4 道会实测它**只用了允许的工具**：本示例声明 `tools.deny: [bash, write, edit]`，
所以冒烟里只应出现 `read`。

## 改它

- 换人设 / 边界 → `agent.yaml`
- 加技能 → 新建 `skills/<名字>/SKILL.md`（frontmatter 必须有 `name` / `description`，
  且 `name` 与目录名一致）；技能要带脚本就放 `skills/<名字>/scripts/`，在 SKILL.md 里用相对路径引用
- 接外部系统 → `connectors.yaml`（推荐按名引用基座预装条目，例如 `- ref: filesystem`）

改完再跑一次 `make verify`。

## 技能脚本的自检

```bash
node examples/idea-to-proof/skills/evidence-grading/scripts/check-table.mjs --selftest
node examples/idea-to-proof/skills/evidence-grading/scripts/check-table.mjs 产出表格.md
```
