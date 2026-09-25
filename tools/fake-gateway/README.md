# 零凭据假网关（`tools/fake-gateway/`）

统一设计 §6.4 的实现：一个**不需要任何凭据**的假 LLM 网关，让闸门 3（`probe/model`、
`probe/skills`、`probe/connectors`）在零凭据下可跑。它是基座自身回归能**脱离外部系统**的前提
（N14），也是「网络层问题 vs 配置层问题」能被分开的原因（§8.5 第 ③ 道调试面）。

它是 **harness 无关**的：只讲协议，不讲 harness。任何 harness 只要能配一个 OpenAI 兼容的
`base_url`，就能拿它当模型端点。

---

## 本层纪律（§12.1 / N6）

- **放**：协议无关的确定性核心、协议适配层（请求解析 / 响应序列化 / SSE）、本地 HTTP 服务入口、
  统一轨迹发射、自检。判据是「这条逻辑换个协议还成立吗」——成立进 `core.mjs`，不成立进 `protocols/`。
- **不放**：
  - **不放任何凭据概念**。不读 `Authorization`、不读 `api-key`、没有 key 变量、没有"可选鉴权"。
    多一个凭据字段，就多一条让合法探针失败、把假网关变成外部依赖的路径。
  - **不放确定性之外的东西**。响应体里不许有时间戳、随机数、自增计数、环境相关的取值；
    唯一的不确定量（`ts`、`run`）只出现在轨迹里（N19）。
  - **不放 harness 名字与 harness 逻辑**。它是协议适配层，不是 harness 适配层（那是 `adapters/<h>/`）。
  - **不放业务概念**：不认识技能、连接器、增强、`agent.yaml`。它只认识「一次模型调用」。
  - **不放判定**：「探针过没过」是 `core/gates/` 与 `tools/verify.mjs` 的事，不是假网关的事。

---

## 目录结构

```
tools/fake-gateway/
├── core.mjs                 协议无关核心：规范化请求 → 确定性响应（纯逻辑，不碰 HTTP）
├── protocols/openai.mjs     OpenAI 兼容协议适配：请求解析 + 响应序列化 + SSE 流式
├── server.mjs               HTTP 服务 + 统一轨迹 + CLI + 编程入口 startFakeGateway()
├── selftest.mjs             自检：临时端口上跑全部断言，退出码 0/1
└── README.md                本文件
```

依赖仅有 `node:` 内置模块（`ajv` 只在 `selftest.mjs` 里用于校验轨迹 schema）。
没有新增 npm 包，不进任何智能体制品（`package.json` 的依赖是基座工具链自己的）。

---

## 怎么用

### 1) 命令行（给 shell / Makefile 用）

```bash
node tools/fake-gateway/server.mjs --port 0
# stdout 只打印一行 base URL：
#   http://127.0.0.1:54321/v1
```

stdout **只放结果**（一行 base URL），人读提示与统一轨迹 JSONL 都走 stderr（§8.2）。
脚本直接取 stdout 即可：

```bash
BASE=$(node tools/fake-gateway/server.mjs --port 0 2>/dev/null & echo $!)
```

选项：

| 选项 | 说明 |
|---|---|
| `--port <n>` | 监听端口，`0` = 自动分配空闲端口（默认 `0`） |
| `--host <addr>` | 监听地址，默认 `127.0.0.1`（零凭据服务不对外暴露） |
| `--route <name>` | 轨迹里的 `model.route`，默认 `fake-gateway` |
| `--model <name>` | `/v1/models` 暴露的模型名，默认 `fake-model` |
| `--no-trace` | 不产轨迹 |
| `--help` | 帮助（退出码 0） |

退出码沿用 §6.7：`0` 正常；`2` 用法/参数错误。容器内 `make doctor` 级别的离线自检可依赖它。

### 2) 编程入口（闸门 3 用）

```js
import { startFakeGateway } from "<repo>/tools/fake-gateway/server.mjs";

const gateway = await startFakeGateway({ port: 0, trace: true });
// gateway.url        → "http://127.0.0.1:<port>/v1"   （直接当 OpenAI base_url）
// gateway.port       → 实际端口（port:0 时由内核分配）
// gateway.traceLines → string[]，本次会话的全部轨迹行（live 数组，close 后仍可读）
// gateway.config / gateway.effectiveConfigDigest / gateway.run → 归因用
// await gateway.close()   → 关闭并断开所有连接（含 SSE / keep-alive），无残留句柄

// 可选参数（都有零配置缺省值）：
await startFakeGateway({
  port: 0,                 // 0 = 空闲端口
  trace: true,             // false = 完全不产轨迹（traceLines 保持空）
  host: "127.0.0.1",
  route: "corp-gateway",   // 缺省取 FAKE_GATEWAY_ROUTE，再缺省 "fake-gateway"
  model: "corp-think",     // 缺省取 FAKE_GATEWAY_MODEL，再缺省 "fake-model"
  traceDest: "stderr",     // 缺省取 AGENT_TRACE_DEST，再缺省 "stderr"；可给文件路径
  env: process.env,        // 轨迹上下文来源（便于测试注入）
});
```

`selftest.mjs` 里 `await gateway.close()` 之后进程**自然退出**（不靠 `process.exit` 硬退），
这就是「不留句柄」的可执行证据。

### 3) 端点

| 端点 | 说明 |
|---|---|
| `POST /v1/chat/completions` | OpenAI 兼容补全。支持 `stream: true`（SSE）与 `tools`。**不校验凭据** |
| `GET /v1/models` | 确定性模型列表（部分 harness 启动时会先探它） |
| `GET /healthz` | 零凭据健康探针（§8.4），返回 `credentials: "none"` |

---

## 为什么是零凭据

§6.4 要求闸门 1–3 在零凭据下可跑。只要有**任何**一条路径需要真实 key，基座回归就会在
CI 里依赖外部系统：上游网关抖动、key 过期、配额耗尽都会让"基座坏了"与"外部系统坏了"
变成同一个红叉，而设计反复强调要把这两类问题分开（§6.4、§8.5 第 ③ 道）。

实现上的具体后果：

- 代码里**没有**读取 `Authorization` / `api-key` / `x-api-key` 的分支。不是"校验被关掉了"，
  而是"不存在校验"——不会有人误打开一个 flag 让它开始要 key。
- `core.mjs` 不认识"凭据"这个词，`protocols/openai.mjs` 只解析 body 与一个路由覆盖头。
- 健康探针同样零凭据（§8.4：`rpc` 健康检查也必须是零凭据可答的探针调用）。

---

## `tools` 计数与 `stream` 标记怎么暴露给调用方

企业网关最常见的故障是**吞掉 `tools` 字段**或**静默把流式降级成非流式**（pi 实测结论，§6.4）。
所以这两个值必须在**三个互相独立的地方**都看得见——只留一处，就会被那一处的实现缺陷掩盖，
或者变成"断言在断言自己"：

| 位置 | 形态 |
|---|---|
| ① 响应体 | `fake_gateway: { protocol, route, model, tools, stream, requestDigest, marker }` |
| ② 响应头 | `x-fake-gateway-tools: 3`、`x-fake-gateway-stream: true`（流式响应也带） |
| ③ 统一轨迹 | `{"type":"model.request","route":…,"model":…,"tools":3,"stream":true}` |

流式时 ① 挂在**首帧**的 `fake_gateway` 里，② 在响应头上，③ 照旧。

闸门 3 的用法（`probe/model`）：

1. 发一个带 N 个 `tools` 的**流式**请求；
2. 断言 HTTP 200、`content-type: text/event-stream`、流以 `data: [DONE]` 收尾；
3. 断言 `x-fake-gateway-tools == N`（**N > 0**）且 `x-fake-gateway-stream == "true"`；
4. 断言轨迹里出现 `model.request` 且 `tools === N`、`stream === true`。

第 3 步是关键：**只断言"有返回"是不够的**——吞掉 tools 的网关照样有返回。

---

## 统一轨迹契约（§8.3）

每条请求向 **stderr** 写一行 JSONL，全部通过 `core/trace/schema.json`（`selftest.mjs` 用
已安装的 `ajv` 逐行校验，schema 的 `unevaluatedProperties: false` 会拒绝任何臆造字段）。

| 事件 | 何时 | 事件专属字段 |
|---|---|---|
| `model.request` | 每次进入模型调用的请求 | `route` `model` `tools` `stream` |
| `model.error` | 请求解析失败 / 方法不对 / 路径未知 / 载荷过大 | `code` `route` `message?` |

公共字段：`ts`（UTC，`Z` 结尾）、`seq`（同一 run 从 0 严格递增）、`run`、`type`、
`effectiveConfigDigest`（`sha256:<64 hex>`），已知时再带 `agent` / `harness` / `harnessVersion`。

上下文全部来自环境变量，**缺省值保证零配置可跑**：

| 环境变量 | 缺省 |
|---|---|
| `AGENT_TRACE_DIGEST` | `H(假网关自身确定性配置)`（name/version/protocol/route/model） |
| `AGENT_RUN_ID` | 随机 uuid（随机量只进轨迹，绝不进响应体） |
| `AGENT_NAME` / `HARNESS` / `HARNESS_VERSION` | 不带（未知就不写，不编造） |
| `AGENT_TRACE_DEST` | `stderr`；给文件路径则改为追加写入该文件 |
| `FAKE_GATEWAY_ROUTE` / `FAKE_GATEWAY_MODEL` | `fake-gateway` / `fake-model` |

**写轨迹绝不会影响 HTTP 响应**：所有轨迹 I/O 都裹在 `try/catch` 里，写失败只丢一条审计。
否则一个 stderr 被打满的容器会把"审计故障"伪装成"探针失败"，正是 §6.4 要防的那类误判。

### 唯一的请求头扩展

`x-fake-gateway-route: <route>` 覆盖**本次调用**的 `model.route`。
用途：闸门 3 正在断言某条路由时，能让轨迹里的 `route` 与它在断言的那条对齐，
从而把「我探的是哪条路由」也写进审计。不传则用服务级 `route`。

---

## 确定性（N19）

**同一份规范化请求 ⇒ 逐字节相同的响应体**（流式也一样）。做法不是"尽量稳定"，而是结构上排除变量：

- 响应 `id` 由请求摘要派生（`chatcmpl-<digest24>`），不用自增计数器；
- `created` 固定为 `0`——响应载荷里**不放时间戳**，宁可不像真网关，也不让 golden 比对漂移；
- 工具调用入参由工具 `parameters` 的 `properties` **按键排序**逐字段生成确定性占位值
  （`string → "fake"`、`number → 0`、`boolean → false`、`array → []`、`object → {}`、有 `enum` 取首个）；
- `usage` 由内容长度确定性推导，不调 tokenizer；
- 规范化请求本身用**键排序的规范化 JSON** 做摘要，所以客户端换个字段顺序不会改变响应。

`selftest.mjs` 断言了三种逐字节一致：非流式两次、流式两次、以及**纯适配层输出 == HTTP 响应体**
（后者证明 HTTP 层没有偷偷加字段）。

`created: 0` 与响应体里的 `fake_gateway` 字段是**有意的非标准扩展**：前者换确定性，
后者换可观测性。两者都只加字段、不改标准字段语义；SDK 若严格拒绝未知字段，
以响应头 `x-fake-gateway-*` 为准（这是把它同时放两处的另一个理由）。

---

## 自检

```bash
node tools/fake-gateway/selftest.mjs
```

在临时端口（`port: 0`）上跑，逐条打印 ✅/❌，退出码 `0` = 全绿 / `1` = 有失败项。覆盖：

- `port: 0` 真的拿到空闲端口；`effectiveConfigDigest` 格式合法
- 无 `Authorization` 的 `healthz` 与 `chat/completions` 都成功
- 非流式响应含确定性标记，`tools` / `stream` 在 body 与 header 上一致
- 两次相同请求（非流式 + 流式）逐字节一致
- `stream: true` ⇒ `text/event-stream`、每个 `data:` 帧可解析、以 `data: [DONE]\n\n` 收尾
- N=3 个工具 ⇒ 发出工具调用、`tools === 3` 三处可见、`finish_reason === "tool_calls"`
- 非法 JSON ⇒ 400 + `model.error` 留痕
- **每一行轨迹都过 `core/trace/schema.json`**（ajv 2020）、`seq` 严格递增、`run` 唯一、
  每条都带同一个 `effectiveConfigDigest`
- `close()` 可等待且断开全部连接，进程随后自然退出

失败即报错：它不会为了"看起来绿"而放宽断言。

---

## 怎么再加一个协议适配（Anthropic 是后续项）

Anthropic 兼容协议**本阶段不实现**：外部输入 I1 尚未结论（企业实际用的是哪家的兼容层、
是否要求 `/v1/messages` 的 `tool_use` 块形状），猜出来的适配层只会是假的确定性。

第二个适配层该插在哪，边界已经划好：

1. 新增 `protocols/anthropic.mjs`，只导出三样与 openai 同构的东西：
   - `PROTOCOL_ID`
   - `parse<Protocol>Request(body, headers)` → `core.normalizeRequest` 的输入
     （**同样不读任何凭据头**）
   - `serialize<Protocol>Response(normalized, result)` / `serialize<Protocol>Stream(...)`
     → 纯数据 / 纯字符串，不碰 HTTP
2. `server.mjs` 里按路径分派（如 `/v1/messages` → anthropic 适配层），并把
   `x-fake-gateway-*` 元数据照旧挂上——`tools` / `stream` 的可观测性是**协议无关要求**，
   不是 OpenAI 的形状。
3. `core.mjs` **一行都不用改**：它只认识规范化请求与中性结果。
   如果为了接第二个协议要动 `core.mjs`，说明中性形状被协议细节污染了。
4. `selftest.mjs` 加一组同构断言，并把 `gatewayConfig({ protocol })` 的取值扩成枚举
   ——协议名进配置摘要，所以换协议会改变 `effectiveConfigDigest`，这是对的：
   当时生效的确实是另一套东西。

---

## 与其他目录的关系

- `core/trace/schema.json`：本目录轨迹的**唯一真源**，只读引用。
- `core/gates/`、`tools/verify.mjs`、`tools/probe.mjs`：判定与编排方，调用本目录（编程入口）。
- `adapters/<h>/`：把各自 harness 指向 `gateway.url`——那一层知道 harness，本目录不知道。
- `Makefile`：`probe` / 自检目标的接线**由基座负责人统一维护**，本目录不碰 Makefile。
