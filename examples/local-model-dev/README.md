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

> **全程不需要任何密钥。** 两个原因：① `model.provider: ollama` 在基座内置 provider 目录里是
> `auth: none` —— 本地服务，基座不产生凭据参数；② 下面步骤 2–4 里闸门 3/4 默认打**自带零凭据假网关**，
> 与你本机有没有模型服务无关。只有步骤 6 真跑时才需要 Ollama 真的在跑，但**仍然不需要密钥**。

### 步骤 1 · 闸门 1：定义合法吗（在**仓库根**跑）

- 做什么：确认 agent.yaml 通过 schema、`model.provider` 已声明、3 个技能的 frontmatter 合法。
- 命令：

```bash
node tools/validate.mjs examples/local-model-dev
```

- 看什么：关键行与末尾摘要。
- 期望结果：**退出码 0**，并看到

```
✅ [provider/declared] model.provider「ollama」已声明（openai-completions，端点 http://localhost:11434/v1）
✅ [skill/frontmatter] 3 个技能的 frontmatter 合法
✅ [model/declared-in-provider] provider ollama 未声明模型名单，跳过成员资格校验
闸门 1：全绿（39 项检查）
```

> 注意最后一行：本地 provider 不声明模型名单，所以**闸门 1 不会替你校验模型名**——
> 模型名必须像步骤 8 那样从端点实测。

### 步骤 2 · 闸门 1–4（pi）

- 做什么：把四道闸门串起来，得到「可用 / 不可用」的结论。
- 命令：

```bash
node tools/verify.mjs examples/local-model-dev --harness pi
```

- 看什么：逐道闸门的 ✅，以及最后一行结论。
- 期望结果：**退出码 0**，并看到

```
✅ [resolution/skills-set] 硬断言 1：实际加载的技能集合必须等于声明集合｜集合相等（3 项）
✅ [probe/model.tools] 端点收到的请求里 tools=3 > 0（证据来源：端点侧（假网关记录））
✅ [smoke/output-marker] 输出包含预期标记 FAKE_GATEWAY_OK
✅ [smoke/no-denied-tools] 调用到的工具都未触碰禁用清单：read
可用：四道闸门全过（§6.8）
```

四道闸门分别在证：定义合法（1）、运行时**实际加载**的技能与声明一致（2）、
模型与技能真的可达且请求里带工具（3）、它真的能干活且没越界用工具（4）。
本示例声明 `tools.deny: [write, edit]`，所以冒烟里出现 `read`（dsh 上是别的内置工具）正常，
出现 `write` / `edit` 才是越界。

### 步骤 3 · 闸门 1–4（dsh）

- 做什么：同一份定义换运行时，确认**可移植**。
- 命令：

```bash
node tools/verify.mjs examples/local-model-dev --harness dsh
```

- 期望结果：**退出码 0**，同样是 `可用：四道闸门全过`。dsh 的工具名与粒度与 pi 不同（它是 row 级），
  这些差异由适配器显式声明，不会沉默地不一样。

### 步骤 4 · 跨运行时等价性

- 做什么：确认中性定义层面的三组集合（技能 / 连接器 / 模型路由）两侧一致。
- 命令：

```bash
node tools/compare.mjs examples/local-model-dev
```

- 期望结果：**退出码 0**，并看到

```
✅ 技能集合
     dsh   capability-boundary-log, endpoint-swap-checklist, prompt-eval-offline
     pi    capability-boundary-log, endpoint-swap-checklist, prompt-eval-offline
✅ 路由协议形状：openai-completions
✅ 等价性通过：中性定义层的三组集合两侧一致，差异均有声明。
```

### 步骤 5 · 技能脚本自检

- 命令：

```bash
node examples/local-model-dev/skills/prompt-eval-offline/scripts/eval-check.mjs --selftest
```

- 期望结果：**退出码 0**，末行 `eval-check 自检：全绿`。

### 步骤 6 · 本机起 Ollama，真跑一次

前面几步验的是**契约**；真跑才是"你这台机器 + 这个模型"的证据。

```bash
# ① 确认本机有 Ollama 且在跑，并列出已拉取的模型（NAME 列就是要写进 model.name 的完整串，含 tag）
ollama list
ollama pull qwen2.5-coder:7b        # 或拉你想要的，或直接用 list 里已有的
```

```bash
# ② 在示例目录里真跑一次 —— **不用给端点**：产物里已带 Ollama 的默认端点，run-local 会自动用它
cd examples/local-model-dev
make run-local PROMPT="用一句话说明你能做什么"
```

- 看什么：头部会打印 `模型端点` / `暂存副本` / `轨迹`，然后是模型的回复。
- 期望结果：**退出码 0**，有正常文本回复。模型名写错时会在这一步**显式失败**（端点报 model not found），
  不会静默跳过——这正是要把模型名从端点问出来的原因。

用 `ollama list` 里已有的模型跑：

```bash
make run-local MODEL=<ollama list 里的 NAME> PROMPT="只回复 OK"
```

> 端点来源的优先级：`--endpoint` > 环境变量 `OLLAMA_BASE_URL` > **产物里的默认值**。
> 所以换机器/换端口时才需要显式给：`OLLAMA_BASE_URL=http://other-host:11434/v1 make run-local PROMPT="…"`。

### 步骤 7 · 换 vLLM / LM Studio

换端点只改 agent.yaml 里 `model.provider` 一行，其余不动。

```yaml
# vLLM：默认端点 http://localhost:8000/v1；模型名就是 `vllm serve <模型>` 的那个
model:
  provider: vllm
  name: Qwen/Qwen2.5-Coder-7B-Instruct
```

```yaml
# LM Studio / llama.cpp / 其它自建服务：provider 用 local（通用 OpenAI 兼容），端点由部署给
model:
  provider: local
  name: <LM Studio 里加载的模型 id>
```

```bash
# local 没写死端点（provider 里是 baseUrlParam）⇒ 必须显式给（LM Studio 常用 1234）
make run-local ENDPOINT=http://localhost:1234/v1 PROMPT="只回复 OK"
```

改完**重跑步骤 1–4**，再真跑一次。

### 步骤 8 · 问端点"你到底有哪些模型"

不要靠记忆填模型名——让端点自己回答：

```bash
make providers-init ENDPOINT=http://localhost:11434/v1 PROVIDER=ollama DRY_RUN=1
#   等价于：node tools/providers-init.mjs --endpoint http://localhost:11434/v1 --provider ollama --dry-run
```

- 看什么：它问 `GET <端点>/models`，把解析出的模型名列出来。
- 期望结果：**退出码 0**，并打印形如

```
▶ http://localhost:11434/v1/models 报告 N 个模型：
   · qwen2.5-coder:7b
   · ...
```

`--dry-run` 只问不写；去掉它会把结果写成一份 provider 目录（vLLM 换 8000，LM Studio 换 1234）。
基座自带的 `Makefile` 里也有 `providers-init` 目标，但它当前有旗标 bug，直接用上面这条 node 命令即可。

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
