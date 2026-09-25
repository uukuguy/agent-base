# pi 原生轨迹 → 统一轨迹 schema 的映射（`adapters/pi/trace.mjs` 的规格）

> **回答的问题**：dsh 的 trajectory 很好，pi 有没有类似的？—— **有，而且是原生的**，不需要我们自己写审计扩展。
> 本文件是实测结论 + 映射规格。**每一行都标注保真度**：哪些是原生等价、哪些是推算、哪些是缺口。

## 一、pi 提供什么（实测 pi 0.87.1）

| 能力 | 形态 | 实测证据 |
|---|---|---|
| **结构化事件流** | `pi --mode json` 输出严格 JSONL：首条 `session` 头，随后 `agent_start` / `turn_start` / `turn_end` / `message_start` / `message_update` / `message_end` / `tool_execution_start` / `tool_execution_update` / `tool_execution_end` / `agent_end` / `agent_settled`，以及 `queue_update` / `entry_appended` / `session_info_changed` / `thinking_level_changed` / `compaction_*` / `auto_retry_*` / `summarization_retry_*` | 一次真实运行捕获 19,215 条记录，0 条解析失败 |
| **进程 I/O 契约与 §8.2 天然一致** | stdout 专供 JSONL，诊断与日志走 stderr | 上游 `docs/json.md`「Framing and process I/O」 |
| **RPC 复用同一事件形状** | `pi --mode rpc` 发出同样的 session 事件（无 `session` 头） | 上游 `docs/json.md` 首段 |
| **版本化会话文件** | `~/.pi/agent/sessions/--<path>--/<ts>_<id>.jsonl`，v3，`id`/`parentId` 构成树，支持就地分支 | 上游 `docs/session-format.md` |
| **工具集合可观测** | 系统消息的 `message_start` 带 `toolsAdded`（名称 + 描述 + 参数 schema）。实测得到 `['read','bash','edit','write']` | 实测 |
| **模型身份可观测** | assistant 的 `message_start` 带 `provider` / `model` / `api` / `usage` / `stopReason` / `responseId`。实测得 `corp-gateway / corp-think / openai-completions` | 实测 |
| **工具调用可观测** | `tool_execution_start`：`toolCallId` / `toolName` / `args`；`tool_execution_end`：`isError` / `result` | 实测 |

## 二、映射表（原生 → `core/trace/schema.json`）

| 统一事件 | pi 原生来源 | 字段映射 | 保真度 |
|---|---|---|---|
| `run.meta` | JSON 模式的 `session` 头（RPC 模式无 → 由基座补） | `run` ← `id`；`ts` ← `timestamp`；`mode` ← 基座注入的 `AGENT_RUN_MODE` | ✅ 原生等价 |
| `tool.call` | `tool_execution_start` | `tool` ← `toolName`；`inputDigest` ← H(`args`)（**只存 digest，不存明文**，§8.3）；`decision` ← 无原生字段 → 记为 `allow` | ⚠️ 近似（缺口 G3） |
| `tool.result` | `tool_execution_end` | `ok` ← `!isError`；`outputDigest` ← H(`result`)；`ms` ← **事件到达时间差** | ⚠️ `ms` 是推算值（缺口 G2） |
| `model.request` | assistant 的 `message_start` | `route` ← `provider`；`model` ← `model`；`tools` ← ⚠️ **无 wire 级计数**；`stream` ← ⚠️ **无标志**（`message_update` 增量的存在只是间接证据） | ❌ **部分缺口（G1）** |
| `model.error` | `message_update.assistantMessageEvent.type === "error"`，或 `auto_retry_start.errorMessage` | `code` ← `reason`（需归一）；`route` ← 当前 provider | ⚠️ 需推导 |
| `gate` | 无（基座自己产出） | — | — |
| `native.raw` | `compaction_*`、`auto_retry_*`、`summarization_retry_*`、`queue_update`、`entry_appended`、`session_info_changed`、`thinking_level_changed`、未知新事件 | `nativeType` ← 原生 `type`；`raw` ← 原记录；`reason` ← 为何未映射（**必填**） | ✅ 兜底，不丢事件（P1 决策） |

## 三、三处缺口（必须写进设计与文档，不许含糊）

| # | 缺口 | 影响 | 处置 |
|---|---|---|---|
| **G1** | 事件流没有 wire 级的 `tools` 计数与 `stream` 标志 | §6.4 门 3 最重要两条断言（网关吞 tools / 降级流式）**无法**由 harness 事件流支撑 | **链路观测**：记录代理放在智能体与端点之间（复用假网关的协议适配层）。见设计 §6.4 补充 |
| **G2** | `tool_execution_end` 无耗时字段 | 性能类结论会失真 | 统一轨迹里 `ms` 标注为**推算值** |
| **G3** | `tool.call.decision` 无原生字段 | 答不出"谁放行了这次调用" | 暂记 `allow`，进 `exemptions.yaml`；补审批扩展后再做实 |

## 四、一个额外收益：G3 之外的**闭环检测**

pi 有原生 `thinking_level_changed` 事件。把它接进统一轨迹后，**`failures.md` F5 的静默钳位检测可以自动完成**：

```
定义声明 model.reasoningEffort: high
  → 事件流里若没有 level=high 的 thinking_level_changed，
    且 assistant 消息的推理块为空 → 闸门 2 直接抓到「声明了但被静默降级」
```

实测已确认该现象真实存在：`settings.json` 的 `defaultThinkingLevel: high` 与 CLI `--thinking high` **都**得到 `thinkingLevel=off`（模型无 thinking 元数据时被静默钳位）。

## 五、实现要点

1. **按 LF 切分，不要用 Node 的 `readline`** —— 上游明确警告它会误认 Unicode 行分隔符（U+2028/U+2029）。
2. **持续消费 stdout** —— 读端停下会让 pi 因管道缓冲写满而阻塞。
3. **必须处理 `message_update` 的 delta 语义** —— 线上去掉了累积快照，重建时要靠 `text_end` / `toolcall_end` / `message_end` 的权威值覆盖，不能只拼 delta。
4. `seq` 由**映射器**递增生成（原生事件没有统一序号）；`effectiveConfigDigest` 由基座按 §6.7 注入。
