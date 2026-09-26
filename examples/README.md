# 示例智能体

> ⚠️ **这些不是基座的一部分。** 整个 `examples/` 可以删掉，基座仍然 `make validate` + `conformance` 全绿
> （不变量 N5）。它们是**参考项目**：给"我要照着做一个自己的智能体"的人看的完整样本。

## 为什么示例值得认真写

真实开发不是"跑一条命令"，而是**在一个项目里持续改**：改定义、加技能、换供应商、接外部系统，
每改一次都要能自己验证。所以每个示例都是一份**完整可跑的项目**（定义 + 技能 + 标签 + Makefile + README），
而不是一段片段。示例的 README 必须讲清**构建与验证过程**：做什么 → 跑哪条命令 → 看什么 → 期望结果。

## 覆盖了哪些场景

| 示例 | 形态 | 覆盖的 agent-base 机制 |
|---|---|---|
| [`idea-to-proof/`](idea-to-proof/) | 纯技能型（只读） | 最小完整定义 · 技能目录发现 · `tools.deny` 边界 · 业务轨迹标签 · 跨运行时双跑 |
| [`contract-review/`](contract-review/) | 带外部系统（MCP 连接器） | 连接器声明与预装条目引用 · 连接器**真的挂上**的实测证据 · 跨运行时**等价性比对**与已声明差异 |
| [`local-model-dev/`](local-model-dev/) | 本地模型（无凭据） | `auth: none` 供应商（Ollama / vLLM / 任意自建 OpenAI 兼容服务）· 零密钥开发循环 · 离线验证 |
| [`multi-env-rollout/`](multi-env-rollout/) | 同一制品多环境 | 运行期参数**四种给法**与优先级 · 自带 `providers.yaml` 覆盖内置（不改基座）· 部署层取值 |
| [`privacy-redaction/`](privacy-redaction/) | 只读 + 多技能 + 观测 | 多技能协作 · 只读边界 · 业务轨迹标注（换业务只换词，基座与查看器一行不改） |
| [`change-risk-review/`](change-risk-review/) | **业务级增强**（harness 层） | 中性定义管不到的业务能力怎么加：`harness/<运行时>/enhancements.yaml` + 扩展实现 · 闸门 2 实测"声明==加载" · 闸门 3 工具数 3→4 证明工具真的发给了模型 · 可移植性降级被显式报告 |

**这些示例合计覆盖的机制**：中性定义与 schema · 技能目录发现与技能自带脚本 · 工具边界 · 连接器（MCP）·
**harness 层业务增强（工具扩展）** · 模型供应商与三种凭据模式 · 运行期参数分层 · 统一轨迹与业务标签 ·
四道闸门 · 跨运行时等价性与可移植性等级。

## 怎么跑

每个示例的 README 里有完整的构建与验证过程；这里是速查：

```bash
# 单个示例：四道闸门（零凭据，不需要任何密钥）
make verify AGENT_DIR=examples/idea-to-proof
make verify AGENT_DIR=examples/idea-to-proof HARNESS=dsh

# 跨运行时等价性比对
make compare AGENT_DIR=examples/contract-review

# 本地真跑一次（需要端点或本地模型，见各示例 README）
make run-local AGENT_DIR=examples/idea-to-proof PROMPT="…"

# 全部示例一起校验：结构 + README 完整性 + 两个运行时各四道闸门 + 等价性 + 技能脚本自检
make examples-check
```

## 示例的验收标准（由 `make examples-check` 强制）

| 要求 | 为什么 |
|---|---|
| 闸门 1 全绿 | 定义必须合法、引用必须存在、命名与分层必须合规 |
| **每个运行时都给出「可用」** | "可移植"是可执行承诺，不是口号 —— 只验一个运行时等于没验 |
| 多运行时下等价性通过 | 集合一致 + 差异都有声明（不许沉默地不等价） |
| 技能自带脚本 `--selftest` 通过 | 示例里的脚本必须是能跑的，不是摆设 |
| README 含必备小节且过程可执行 | 别人 clone 下来要能照着跑起来；缺节或太空直接红 |
| README 提到的文件都存在 | 不许描述不存在的东西 |

## 从示例开始自己的智能体

```bash
make new-agent NAME=my-agent            # 派生一个自己的目录（含 Makefile）
# 然后照最接近你场景的示例改，改完跑：
#   make validate AGENT_DIR=my-agent
#   node tools/verify.mjs my-agent --harness pi   （以及 --harness dsh）
```
