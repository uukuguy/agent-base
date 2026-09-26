# local-model-dev

用本机部署的 OpenAI 兼容模型（Ollama / vLLM / LM Studio）做开发验证：核对端点与模型、
离线评测提示词与输出、记录本地模型的能力边界。

> 由 `agent-base` 基座派生并改写成示例。它是 `examples/` 的一部分，**不是基座的一部分**。

## 它解决什么问题

同一个开发任务，把模型从云端换成"本机那个"，会立刻冒出一串没人替你回答的问题：
端点通不通？`/v1/models` 里列出的名字与要写进定义的模型名是不是同一个？这个模型到底支不支持工具调用？
换成 4-bit 量化后结构化输出还稳不稳？哪些活它能干、哪些不能？

本示例把这些变成一条**有边界、可复现的验证流程**：

先把事实从端点问出来 → 改定义只改一行 → 跑四道闸门 → 真跑一次并与基线比对 →
把能力边界记下来（**测过不通过**与**没测过**分开写）。

它交付的是**结论 + 证据**，不是"应该没问题"。

## 结构

```
agent.yaml           它是谁（persona）、用哪个模型（model.provider: ollama，auth: none，不需要密钥）、
                     边界（tools.deny: [write, edit] —— 验证者不许改动被验证的对象）
connectors.yaml      空 mcpServers: [] —— 本地模型端点走 model.provider，不走 MCP；保持零外部依赖
trace-labels.yaml    业务给机械轨迹起的说法（基座不解释，只机械查找后原样呈现）
skills/
  endpoint-swap-checklist/  换模型 / 量化 / 端点前后的核对清单（要跑的命令 + 核对表）
  prompt-eval-offline/      离线评测方法：固定用例集 + 重复 N 次 + 统计通过率
    scripts/eval-check.mjs  机械判分器（requiresAll / requiresNone / mustMatch / mustParseJson / mustCallTool）
    cases.example.json      评测用例样例，可照抄
  capability-boundary-log/  能力边界记录法：硬边界 / 性能边界 / 质量边界分开记
Makefile             薄转发层（由 tools/new-agent.mjs 生成，AGENT_BASE_DIR=../..），不改
README.md            本文件
```

## 构建与验证过程

**在这个目录里开发** —— 每个示例自带 Makefile，不用回仓库根：

```bash
cd examples/local-model-dev
```

### 开发循环：改 → 查 → 跑 → 验

```bash
# ① 改完立刻查：秒级，不用网络、不用密钥（定义/引用/分层/增强声明都查）
make validate
#   期望：闸门 1：全绿，末尾没有 ❌（写错的地方会点名字段；**不写死项数**，免得数字一漂就过期）

# ② 真跑一次
make run-local ENDPOINT=<端点> PROMPT="核对本机端点与模型是否可用，并给出结论"
#   期望：本机端点/模型的核对结论（可用性 + 依据）；退出码 0

# ③ 四道闸门 → 给一个「可用 / 不可用」的结论
make verify
#   期望：✅ 可用：四道闸门全过（§6.8）
#   闸门 3/4 默认走基座自带的**零凭据假网关**，不需要任何密钥
```

### 端点与密钥怎么给（三选一）

```bash
# ① 命令行（临时用）
make run-local ENDPOINT=<端点> PROMPT="…"

# ② 放这个目录下的 .env（之后不用再敲；**真实环境变量优先于它**）
printf 'OLLAMA_BASE_URL=<端点>\n' > .env
make run-local PROMPT="…"

# ③ 凭据目录（CI / 生产）：AGENT_SECRETS_DIR=/dir，读 /dir/<参数名>
```

本示例的参数名：`ENDPOINT` → `OLLAMA_BASE_URL`（本地模型**不需要密钥**）

### 不知道有哪些模型可用

```bash
make providers-init ENDPOINT=<端点> 
#   期望：打印该端点的模型名单，并写成 ./providers.yaml
#   这个文件会被自动采用；`agent.yaml` 里的 model.name 写错了，闸门 1 当场拦住
```

### 换一个运行时再验一次 / 看等价性

```bash
make verify HARNESS=dsh     # 期望：同样「可用：四道闸门全过」
make compare                # 期望：等价性通过（差异必须有声明，不许沉默）
```

### 零凭据地只看链路与边界

```bash
make probe    # 闸门 3：模型可达、工具字段没被吞、流式没被降级
make smoke    # 闸门 4：真的干活、且没越界用工具
```

### 改了技能自带的脚本，就跑它的自检

```bash
node skills/prompt-eval-offline/scripts/eval-check.mjs --selftest
#   期望：退出码 0
```

### 四道闸门分别在证明什么

| 闸门 | 证明什么 | 本示例的看点 |
|---|---|---|
| 1 静态 | 定义合法、引用与分层合规 | 技能名与目录一致、模型名在该供应商名单内、增强声明合法 |
| 2 解析自证 | 运行时**实际加载**到的东西与声明一致 | 技能/增强真的进了产物（不是写在定义里就算） |
| 3 集成探针 | 模型可达、工具字段在、流式没降级 | 闸门 3/4 会打到你本机的端点 —— 先确认 Ollama/vLLM 已起来 |
| 4 端到端冒烟 | 它真的能干活、且没越界用工具 | 被禁的工具不会出现在冒烟轨迹里（边界是**实测**的，不是约定的） |

本示例用**本地模型**：不需要密钥；`OLLAMA_BASE_URL` 默认 `http://127.0.0.1:11434/v1`


## 改它

| 我要改 | 改哪 | 改完跑什么 |
|---|---|---|
| 换模型 / 量化 | `agent.yaml` 的 `model.name` | 步骤 1–3，再真跑一次并与基线比 |
| 换端点 / 供应商 | `agent.yaml` 的 `model.provider`（`ollama` → `vllm` / `local`） | 步骤 8 问模型名 → 步骤 1–4 |
| 改人设、边界 | `agent.yaml` 的 `persona` / `tools.deny` | 步骤 1–4（闸门 4 会实测工具边界） |
| 加技能 | 新建 `skills/<名字>/SKILL.md`，frontmatter 必须含 `name` / `description`，且 `name` 与目录名一致 | 步骤 1–3 |
| 加技能脚本 | 放 `skills/<名字>/scripts/`，在 SKILL.md 里用相对路径引用 | 脚本要支持 `--selftest`；`node tools/examples-check.mjs --fast` 会跑它 |
| 接外部系统 | `connectors.yaml`（推荐按名引用基座预装条目，如 `- ref: filesystem`） | 步骤 1–4 |

改完统一再跑一遍四条自证命令：

```bash
node tools/validate.mjs examples/local-model-dev
node tools/verify.mjs examples/local-model-dev --harness pi
node tools/verify.mjs examples/local-model-dev --harness dsh
node tools/compare.mjs examples/local-model-dev
```

## 已知边界

- **闸门 3/4 用的是自带零凭据假网关，不是你的本地模型**（也与本机有没有 Ollama 无关）。
  所以"四道全过"证明的是**契约成立**：定义合法、技能在产物中就位、请求里带工具、不越界用工具。
  它**不**证明你的本地模型答得好，也**不**证明端点连通——那是步骤 6 的事。
- **真跑需要本机有一个 OpenAI 兼容服务**：默认假设 Ollama 在 `http://localhost:11434/v1`。
  服务没起、或模型名没拉取时，`make run-local` 会**显式失败**，不会静默跳过。
- **模型名不在闸门 1 的校验范围内**：Ollama 的模型名单在基座 provider 目录里是空的（本机拉了哪些只有你知道），
  闸门 1 只保证"名字非空"，写错要到真跑才暴露。用步骤 8 问出来。
- **是否支持工具调用由模型决定**：`ollama show <模型>` 的 capabilities 里没有 `tools` 时该模型发不了工具调用。
  本示例的人设不依赖工具调用也能工作；闸门 3 的 tools>0 是**运行时**层面的断言，不是模型能力断言。
- **多数本地模型不认 `reasoningEffort`**，所以本示例不声明它（声明了在 dsh 上会进豁免清单）。
- `make run-local` 对 Ollama **仍要求显式端点**（`make run-local ENDPOINT=… PROMPT=…`）。
  产物里为它声明了默认端点 `http://localhost:11434/v1`，但当前 `tools/run-local.mjs` 只读
  `--endpoint` 与 `OLLAMA_BASE_URL`，没有回退到该默认值。
- `make providers-init` 目标在当前由 `tools/new-agent.mjs` 生成的 `Makefile` 里有一处旗标 bug
  （判断 `ROUTE` 却传 `PROVIDER`，且默认输出文件仍是旧形状）。本示例的 `Makefile` 是生成物，
  按约定不手写、未修改；README 因此直接给 node 命令。
- **未验的部分**：容器里跑、真实模型的质量评分（本示例只给评测方法，不给某台机器上的具体分数）。
