# 示例智能体

> ⚠️ **这些不是基座的一部分。** 整个 `examples/` 可以删掉，基座仍然 `make validate` + `conformance` 全绿
> （不变量 N5）。它们的作用是回答"这东西用起来长什么样"，而不是给基座提供功能。

| 示例 | 形态 | 用来演示什么 |
|---|---|---|
| [`idea-to-proof/`](idea-to-proof/) | **纯技能型** | 最快路径：一句话定义 + 几个技能，就能把想法变成可验证的东西 |
| [`contract-review/`](contract-review/) | **带外部系统连接（MCP）** | 双运行时交付与**等价性比对**：同一份定义在 pi 与 dsh 上都跑通并真的用上连接器 |

## 怎么跑

```bash
# 四道闸门（零凭据，不需要任何密钥）
make verify AGENT_DIR=examples/idea-to-proof

# 本地交互跑一次
make run-local AGENT_DIR=examples/idea-to-proof

# 跨运行时等价性比对（两个运行时是否等价、差异是否都有声明）
make compare AGENT_DIR=examples/contract-review

# 逐个示例校验（结构 + 四道闸门 + 技能脚本自检）
make examples-check
```

## 从示例开始自己的智能体

直接派生一个新目录，然后照着示例改：

```bash
make new-agent NAME=my-agent
```
