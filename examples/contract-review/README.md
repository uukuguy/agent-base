# contract-review · 合同条款审阅

这个示例回答一个问题：**同一份中性定义，能不能在两个运行时上都跑通，并且真的用上外部系统？**

它与另一个示例的分工：

| | `idea-to-proof` | `contract-review`（本篇） |
|---|---|---|
| 形态 | 纯技能型 | **带连接器**（MCP） |
| 用来演示 | 最快路径 | **双运行时交付 + 等价性比对** |

## 它解决什么问题

读一份合同（通过文件连接器访问挂载目录），产出**条款级审阅表**：

| 条款号 | 原文摘录 | 风险等级 | 依据 | 建议 | 确定性 |
|---|---|---|---|---|---|

三条纪律贯穿三个技能：**结论必须能回到原文** · **分级必须写依据** · **不确定就说不确定**。

## 结构

| 文件 | 干什么 |
|---|---|
| `agent.yaml` | 人设、模型、边界（只读：`deny: [bash, write, edit]`） |
| `connectors.yaml` | `ref: filesystem`（零凭据、可离线 —— 服务器包在构建期预装进镜像） |
| `skills/clause-extraction/SKILL.md` | 逐条抽条款并回指原文 |
| `skills/risk-grading/SKILL.md` | 分级 + 依据 |
| `skills/citation-anchoring/SKILL.md` | 回指自检（"结论必须能回到原文"的可执行形态） |
| `skills/citation-anchoring/scripts/check-anchors.mjs` | 机械自检脚本：给审阅表与原文，逐行验证摘录能否逐字找到 |
| `trace-labels.yaml` | 业务给轨迹起的说法（基座不解释这些词，只按定位符机械查找后原样呈现） |
| `Makefile` | 薄转发层（跑闸门、渲染、本地运行、比对） |

## 构建与验证过程

在**仓库根**执行：

```bash
# ① 准备本地运行环境：装上连接器服务器与 pi 的 MCP 客户端扩展（一次性）
make dev-env
#   期望：退出码 0；本地包与扩展就位

# ② 静态校验：定义、引用、命名、分层
make validate AGENT_DIR=examples/contract-review
#   期望：闸门 1：全绿（38 项检查）

# ③ 四道闸门 —— 两个运行时都要给出「可用」
make verify AGENT_DIR=examples/contract-review                     # 默认 pi
make verify AGENT_DIR=examples/contract-review HARNESS=dsh
#   期望：两行都是 ✅ 可用：四道闸门全过（§6.8）
#   闸门 3/4 走基座自带的零凭据假网关，**不需要任何密钥**

# ④ 跨运行时等价性：三组集合一致 + 差异都有声明
make compare AGENT_DIR=examples/contract-review
#   期望：等价性通过（技能集合 / 连接器集合 / 模型路由 / 协议形状 四行 ✅）

# ⑤ 技能脚本自检
node examples/contract-review/skills/citation-anchoring/scripts/check-anchors.mjs --selftest
#   期望：退出码 0
```

## 实测证据（这个示例的意义就在这里）

**四道闸门**：两个运行时都给出 **可用**。

**连接器真的生效**（不是"我们声明了"）—— 模型端点侧收到的工具数：

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

## 改它

| 想改什么 | 改哪里 |
|---|---|
| 审阅纪律 / 人设 | `agent.yaml` 的 `persona.instructions` |
| 换连接器 | `connectors.yaml`（`- ref: <预装条目>` 或完整写法带 `pin`） |
| 加技能 | 新建 `skills/<名字>/SKILL.md`（frontmatter 的 `name` 必须与目录名一致） |
| 挂载范围 | **不由参数层决定**：容器里把合同目录挂进 `/workspace`，智能体就只能看到那个目录 |
| 业务轨迹用词 | `trace-labels.yaml` |

改完再跑 ②③④ 三条 —— 尤其 **④**：改了连接器或工具边界后，`compare` 会告诉你两侧是否还等价、
差异有没有声明。

## 已知边界

- **不评价审阅质量**：闸门证明"连接器真的挂上、工具数变了、两边等价"，不证明条款判得对。
- 本示例的 `filesystem` 连接器是**零凭据**的（谁 clone 下来都能跑）；真实企业的连接器通常要凭据，
  给法见 `docs/06-deploy.md`（环境变量 / `_FILE` / `AGENT_SECRETS_DIR`）。
- 两条不等价**是真实差异**，已在 `adapters/*/exemptions.yaml` 声明；它们不会消失，
  只会被如实列出来。
- 闸门 3/4 默认走零凭据假网关；要"真的能用"的证据加 `LIVE=1`。
