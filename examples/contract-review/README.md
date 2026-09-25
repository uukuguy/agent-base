# contract-review · 合同条款审阅

这个示例回答一个问题：**同一份中性定义，能不能在两个运行时上都跑通，并且真的用上外部系统？**

它与另一个示例的分工：

| | `idea-to-proof` | `contract-review`（本篇） |
|---|---|---|
| 形态 | 纯技能型 | **带连接器**（MCP） |
| 用来演示 | 最快路径 | **双运行时交付 + 等价性比对** |

## 它做什么

读一份合同（通过文件连接器访问挂载目录），产出**条款级审阅表**：

| 条款号 | 原文摘录 | 风险等级 | 依据 | 建议 | 确定性 |
|---|---|---|---|---|---|

三条纪律贯穿三个技能：**结论必须能回到原文** · **分级必须写依据** · **不确定就说不确定**。

## 怎么跑

```bash
# 准备本地运行环境（装上连接器服务器与 pi 的 MCP 客户端扩展）
make dev-env

# 四道闸门（零凭据：闸门 3/4 用基座自带的假网关，不需要任何密钥）
make verify AGENT_DIR=examples/contract-review                    # pi（默认）
make verify AGENT_DIR=examples/contract-review HARNESS=dsh

# 跨运行时等价性比对
make compare AGENT_DIR=examples/contract-review
```

## 实测证据（这个示例的意义就在这里）

**四道闸门**：两个运行时都给出 **可用**。

**连接器真的生效**（不是"我们声明了"）——模型端点侧收到的工具数：

| 场景 | 端点收到的工具数 |
|---|---|
| 不带连接器 | **4** |
| 带 `filesystem` 连接器（pi） | **7** |
| 带 `filesystem` 连接器（dsh） | **36** |

**等价性比对**：

```
✅ 技能集合     两侧一致（citation-anchoring, clause-extraction, risk-grading）
✅ 连接器集合   两侧一致（filesystem）
✅ 模型路由     两侧一致（corp-gateway）
✅ 路由协议形状 两侧一致（openai-completions）
✅ 差异均有声明（见下）
```

## 你要知道的两条不等价（已声明，不是意外）

| 差异 | 说明 |
|---|---|
| **连接器机制** | dsh 原生支持 MCP；pi 原生没有，靠基座种子扩展补上。**能力两边都有**，实现方式不同 |
| **工具边界的粒度** | 本示例禁了 `bash`/`write`/`edit`。在 dsh 上，`read`/`write`/`edit` 属于**同一个** `tool-fs` row —— 禁一个等于禁三个，所以 dsh 侧连 `read` 也没了（文件访问改由连接器提供）。pi 侧可以精细到单个工具 |

第二条正是"同一份定义在两个运行时行为不完全一致"的**真实例子** —— 基座的纪律不是假装它不存在，
而是**必须写下来**（`adapters/*/exemptions.yaml`，`make compare` 会把它们列出来）。

## 文件

```
agent.yaml                       人设、模型、边界（只读：禁 bash/write/edit）
connectors.yaml                  ref: filesystem（零凭据、可离线）
skills/clause-extraction/        逐条抽条款并回指原文
skills/risk-grading/             分级 + 依据
skills/citation-anchoring/       回指自检（带可执行的机械自检脚本）
trace-labels.yaml                业务给轨迹起的说法（基座不解释这些词）
```

`skills/citation-anchoring/scripts/check-anchors.mjs` 是一个可以直接用的工具：
给一份审阅表与合同原文，它逐行检查「原文摘录」能否逐字找到。**它就是"结论必须能回到原文"这条纪律的可执行形态。**
