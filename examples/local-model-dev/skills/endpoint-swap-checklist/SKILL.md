---
name: endpoint-swap-checklist
description: 换模型、换量化或换本地端点时的核对清单：先把事实问出来，再改一行，最后与基线比对
whenToUse: 要把开发用的本地模型换成另一个模型/量化，或从 Ollama 换到 vLLM/LM Studio 等另一个端点时
---

# 换模型 / 换端点的核对清单

## 先分清「换什么」

三种"换"影响面完全不同，报告时必须写清是哪一种：

| 换法 | 例子 | 影响 |
|---|---|---|
| **换模型**（同端点） | `llama3.2` → `qwen2.5-coder:7b` | 能力、上下文、是否支持工具调用都可能变 |
| **换量化**（同模型名不同 tag） | `qwen2.5-coder:7b` → `qwen2.5-coder:7b-q4_K_M` | 质量与显存变，协议能力通常不变 |
| **换端点**（换服务） | Ollama `:11434` → vLLM `:8000` | 默认参数、鉴权、模型名空间、错误形状都可能变 |

## 第一步：把事实问出来（不许凭记忆）

按顺序跑，每一步都要留下**实际输出**：

```bash
# ① 本机到底有哪些模型（注意看 NAME 列，它含 tag，就是 API 要用的模型名）
ollama list

# ② 这个模型的量化 / 上下文长度 / 参数规模 / 支持哪些能力（capabilities 里有没有 tools 很关键）
ollama show qwen2.5-coder:7b

# ③ 端点自称有哪些模型（OpenAI 兼容面；vLLM 换 8000，LM Studio 换 1234）
curl -s http://localhost:11434/v1/models

# ④ 最小 chat 请求：确认不是"只列得出模型、其实回不了话"
curl -s http://localhost:11434/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"qwen2.5-coder:7b","messages":[{"role":"user","content":"只回复 OK"}]}'
```

判定要点：

- ①的 `NAME` 是要写进 `model.name` 的**完整串**（含 tag）。写 `qwen2.5-coder` 少个 `:7b` 会被端点判为不存在。
- ②的 `capabilities` 没有 `tools` ⇒ 该模型**发不了工具调用**；这时"工具用不了"是模型限制，不是端点坏。
- ③返回里没有你想要的模型 ⇒ 先确认服务是否真的加载了它（vLLM 的模型名就是 `vllm serve <模型>` 里的那个）。
- ④若返回 `choices` 之外的结构（报错体），即使③能列出模型，也**不能**说端点可用。

## 第二步：改定义（只改一行）

```yaml
model:
  provider: ollama          # 端点变了才改这里：vllm / local（LM Studio 等用 local + LOCAL_BASE_URL）
  name: qwen2.5-coder:7b    # 换模型/量化就是改这一行
```

## 第三步：换完必跑（缺一不可）

1. **闸门 1**：`node tools/validate.mjs examples/local-model-dev`
   → 看输出里 `provider/declared` 与 `model.declared-in-provider`；期望退出码 0。
   （本地 provider 的模型名单是空的，闸门不会替你校验模型名 —— 所以第 ① 步的事实是唯一依据。）
2. **真跑一次**：`make run-local PROMPT="用一句话说明你能做什么"`
   → 期望退出码 0，且有正常文本回复；报错就把错误原文整段留下。
3. **与基线比对**：固定同一个 prompt，比较换之前的输出。
   → 只比**结构性质**（还是不是表格？还发不发 tool call？还守不守字数限制？），
   不要逐字比 —— 本地模型换一次不可能逐字一样。

## 核对表（填完再宣布结论）

| 项 | 从哪来 | 本次值 | 与基线一致？ |
|---|---|---|---|
| 端点 | 定义 / 环境变量 | | |
| 模型名（含 tag） | `ollama list` 的 NAME | | |
| 量化 | `ollama show` | | |
| 上下文长度 | `ollama show` | | |
| 支持工具调用 | `ollama show` 的 capabilities | | |
| 最小 chat 有回复 | 第 ④ 条 curl | | |
| 定义校验通过 | 闸门 1 | | |
| 固定 prompt 输出结构 | `run-local` + 基线 | | |

## 不要做

- 不要用 `ollama list` 里显示的**模型标题**当 API 名，也不要漏掉 tag。
- 不要只验 `/v1/models` 通了就宣布"端点可用"——那只是列目录。
- 不要在没有换前基线的情况下说"换完正常"；没有基线就如实写"未做对照"。
- 不要把「模型不支持工具调用」记成「端点坏了」——两者处置完全不同。
