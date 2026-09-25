# pi 原生轨迹 → 统一轨迹 schema 的映射（`adapters/pi/trace.mjs` 的规格）

> **回答的问题**：dsh 的 trajectory 很好，pi 有没有类似的？—— **有，而且是原生的**，不需要我们自己写审计扩展。
> 本文件是实测结论 + 映射规格。**每一行都标注保真度**：哪些是原生等价、哪些是推算、哪些是缺口。

## 〇、两条来源，同一条 schema（先读这一节）

轨迹有两个来源，**产出同一份统一 schema**，不是二选一：

| 来源 | 何时用 | 优点 | 代价 |
|---|---|---|---|
| **① 回调式（主路径）**：基座轨迹扩展订阅 loop 回调，**实时**发事件 | 运行时正常路径 | 能拿到 `message_update`/会话文件里**看不到**的东西：发出去的 provider 请求体、工具判定的 allow/deny | 需要一个基座扩展（进 `seed/`），且必须与业务扩展**安全共存**（见第四节） |
| **② 事后映射（兜底）**：`trace.mjs` 解析原生事件流/会话文件 | 别人的会话、扩展没加载、离线复盘 | 零侵入、可离线 | 拿不到请求体与判定（缺口 G1/G3） |

**基座对回调的纪律（因为业务层也会叠加回调）**：

1. **只订阅，不改变行为**：基座轨迹回调**一律不返回值**。文档明确"some events transform data, replace results, or cancel an operation"——基座一旦返回值，就可能覆盖或取消业务扩展的意图。
2. **绝不抛异常**：文档明确「`tool_call` handler 失败会**阻断该工具**（fail-safe）」。一个写日志的回调把业务工具调用搞挂，是不可接受的反向依赖。所有回调体包 try/catch，失败只记本地问题。
3. **幂等 + 可重入**：`session_shutdown`、reload、session replacement、进程退出会汇聚到同一清理路径（文档原文），flush 必须幂等。
4. **自己也在 `enhancements.yaml` 里声明**：这样闸门 2 的「已加载扩展 id 集合 == 声明集合」也覆盖它自己——基座不给自己开后门。
5. **业务可叠加**：`pi.on()` 的处理器按**注册顺序**执行，`tool_result` 的处理器**显式 compose**（每个 handler 看到前一个的改动）。所以业务扩展可以直接再订阅同一批事件，无需与基座协商。

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
| **loop 回调点（扩展可订阅）** | `before_provider_request`（`event.payload` = **发往 provider 的请求体**）、`after_provider_response`（`status` / `headers`）、`tool_call`（`toolName` / `input`，可返回 `{block, reason}`）、`tool_result`（handler 之间 **compose**）、`turn_start`/`turn_end`、`agent_start`/`agent_end`/`agent_settled`、`message_end`、`before_agent_start`、`session_*`、`input` | 实测事件名 + 上游 `docs/extensions.md` 与官方示例 |
| **payload 的确切字段（实测）** | `before_provider_request` 的 `payload` 键为 `max_completion_tokens, messages, model, prompt_cache_key, prompt_cache_retention, store, stream, stream_options, tools`；实测 `tools` 是**数组**（`tools.length` = 4）、`stream: true`、`model: "corp-think"` | 本机实测（假网关 + 独立进程，1184 次请求） |
| **响应侧可见什么** | `after_provider_response` 给 `status`（200）与 `headers`（实测含网关自定义头 `x-fake-gateway-tools` / `x-fake-gateway-stream`） | 本机实测。**这给了第三条检测路径**：把「发出去的工具数」与「响应头里回显的工具数」对照，可在进程内发现中间件动了手脚 |

## 二、映射表（原生 → `core/trace/schema.json`）

| 统一事件 | pi 原生来源 | 字段映射 | 保真度 |
|---|---|---|---|
| `run.meta` | JSON 模式的 `session` 头（RPC 模式无 → 由基座补） | `run` ← `id`；`ts` ← `timestamp`；`mode` ← 基座注入的 `AGENT_RUN_MODE` | ✅ 原生等价 |
| `tool.call` | ① **回调式（主）**：`tool_call` 事件（`toolName`/`input`）+ 其它 handler 是否返回了 `{block}` → **真实的 allow/deny**<br>② 事后映射（兜底）：`tool_execution_start` → `decision` 只能记 `allow` | 回调式能把 `decision` 写成真值；兜底路径是**近似** | ① 好 ② 近似（G3） |
| `tool.result` | `tool_execution_end` | `ok` ← `!isError`；`outputDigest` ← H(`result`)；`ms` ← **事件到达时间差** | ⚠️ `ms` 是推算值（缺口 G2） |
| `model.request` | ① **回调式（主）**：`before_provider_request` 的 `event.payload` → `tools` 取请求体里的工具数组长度、`stream` 取请求体字段（字段名待实测）<br>② 事后映射（兜底）：assistant `message_start` 的 `provider`/`model`，`tools` 取系统消息的 `toolsAdded` 长度（**harness 侧声明值**），`stream` 由是否出现增量块推断 | ⚠️ 两种来源**可信度不同，必须在事件里区分**：回调式 = 实际发出的请求；事后映射 = harness 侧声明 + 推断 | ① 好 ② 部分（G1） |
| `model.error` | `message_update.assistantMessageEvent.type === "error"`，或 `auto_retry_start.errorMessage` | `code` ← `reason`（需归一）；`route` ← 当前 provider | ⚠️ 需推导 |
| `gate` | 无（基座自己产出） | — | — |
| `native.raw` | `compaction_*`、`auto_retry_*`、`summarization_retry_*`、`queue_update`、`entry_appended`、`session_info_changed`、`thinking_level_changed`、未知新事件 | `nativeType` ← 原生 `type`；`raw` ← 原记录；`reason` ← 为何未映射（**必填**） | ✅ 兜底，不丢事件（P1 决策） |

## 三、三处缺口（必须写进设计与文档，不许含糊）

| # | 缺口 | 影响 | 处置 |
|---|---|---|---|
| **G1** | **事件流/会话文件**里没有 wire 级的 `tools` 计数与 `stream` 标志（实测：19,215 条事件无顶层 `tools` 字段） | 只看事后映射时，门 3 的两条断言无从下手 | **分成两半，各有对策**（原先把 G1 说成"只能靠代理"是不准确的）：<br>· **「harness 没把 tools 带上」**（如 `--exclude-tools` 配错、工具未注册）→ 由**回调式**主路径的 `before_provider_request` 观测请求体解决（官方示例即日志该 payload，且可替换，说明它就是请求体）<br>· **「网关吞了 tools / 降级流式」**（中间件行为）→ 回调**看不到**；要么链路观测（记录代理），要么用**响应侧不一致检测**：发出 N 个工具却既无 tool_calls 又未流式 ⇒ 可疑<br>· payload 里 `tools` / `stream` 的**具体字段名待实测确认**（本机探针未跑通，不写成结论） |
| **G2** | `tool_execution_end` 无耗时字段 | 性能类结论会失真 | 统一轨迹里 `ms` 标注为**推算值** |
| **G3** | 事后映射路径下 `tool.call.decision` 无原生字段 | 答不出"谁放行了这次调用" | **回调式可解**：`tool_call` 的处理器可返回 `{block, reason}`，基座扩展据此记 `allow`/`deny`（与 `protected-paths` 这类业务/基座安全扩展**叠加**时，任一 handler 阻断即记 `deny`）。兜底路径仍记 `allow` 并标明来源 |

## 四、一个额外收益：G3 之外的**闭环检测**

pi 有原生 `thinking_level_changed` 事件。把它接进统一轨迹后，**`failures.md` F5 的静默钳位检测可以自动完成**：

```
定义声明 model.reasoningEffort: high
  → 事件流里若没有 level=high 的 thinking_level_changed，
    且 assistant 消息的推理块为空 → 闸门 2 直接抓到「声明了但被静默降级」
```

实测已确认该现象真实存在：`settings.json` 的 `defaultThinkingLevel: high` 与 CLI `--thinking high` **都**得到 `thinkingLevel=off`（模型无 thinking 元数据时被静默钳位）。

## 五、业务开发层叠加回调（原生支持，但有雷区）

| 事实 | 含义 |
|---|---|
| `pi.on()` 处理器按**注册顺序**执行；`tool_result` 的处理器**链式 compose** | 业务扩展可以直接再订阅同一批事件，**不需要与基座协商**，也不需要基座提供"扩展点" |
| 事件语义**分四类**：通知型 / 变换型 / 替换型 / 取消型（文档原文） | 叠加**不是**处处都安全：`before_agent_start` 返回 `systemPrompt` 会**整体替换** prompt；`cache_warming_decision` 是**最后一个返回者获胜** |
| 「`tool_call` handler 失败会**阻断该工具**」；其它 handler 错误"能被报告就报告，然后继续" | 轨迹回调必须**绝不抛异常** —— 否则写日志这件事会反向影响业务工具调用 |

**因此基座的轨迹回调**：只订阅（不返回值）、只记录（不改数据）、包 try/catch、flush 幂等。
**业务侧要做的**：订阅自己的事件即可；若需要改变行为（阻断/改写），那是**业务级增强**的职责，与轨迹互不干扰 —— 但两边必须都能看见对方的痕迹（同一份轨迹里同时出现基座的 `tool.call` 与业务的 `biz.event`）。

## 六、实现要点

> **⚠️ 一处实测纠正（别照直觉写）**：我原本以为「`tool_call` 返回 `{block: true}` 能终止假网关那个无限循环」。**实测不成立** —— 阻断只是让该次调用变成错误结果，智能体随即带着错误结果再次请求模型，循环照旧（实测 1184 次请求）。所以 gate 3/4 的会话终止必须靠**假网关自身**（例如按轮次改为回文本），不能指望回调阻断。

1. **按 LF 切分，不要用 Node 的 `readline`** —— 上游明确警告它会误认 Unicode 行分隔符（U+2028/U+2029）。
2. **持续消费 stdout** —— 读端停下会让 pi 因管道缓冲写满而阻塞。
3. **必须处理 `message_update` 的 delta 语义** —— 线上去掉了累积快照，重建时要靠 `text_end` / `toolcall_end` / `message_end` 的权威值覆盖，不能只拼 delta。
4. `seq` 由**映射器**递增生成（原生事件没有统一序号）；`effectiveConfigDigest` 由基座按 §6.7 注入。
