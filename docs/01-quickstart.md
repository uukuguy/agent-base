# 01 · 快速开始

目标：**从零跑通一个智能体，并拿到"可用 / 不可用"的结论。** 全程不需要任何密钥
（闸门 3/4 默认用零凭据假网关）。

## 四步

### 1. 让本机环境就位

```bash
make dev-env            # 按 adapters/*/adapter.yaml 的 pin 校验/安装 harness
```

只看不改：`make dev-env CHECK=1`。它会把「期望版本 / 本机版本 / 可执行版本」逐行列出。

### 2. 派生一个智能体

```bash
make new-agent NAME=my-agent DESCRIPTION="一句话说明它做什么"
```

它落在**基座之外**（默认基座的同级目录 `../my-agent`）。**应用不是基座的一部分** ——
你随便改那里，基座不受影响。

生成的东西：

```
my-agent/
  agent.yaml          它是谁、用哪个模型、边界
  connectors.yaml     能连哪些系统（默认启用开发常用子集：filesystem / git / repomix）
  skills/example/     一个能跑的示例技能
  Makefile            薄转发层，不用改（BUNDLES=… 选能力包、HARNESS=… 选运行时）
  README.md
```

> `trace-labels.yaml`（业务给轨迹起的说法）**不是派生的**：需要时自己新建这一个文件，
> 渲染器会原样带进产物（见 `docs/14-how-to-verify.md` 的轨迹一节）。

### 3. 改定义

| 我要改 | 改哪 |
|---|---|
| 人设、边界 | `agent.yaml` 的 `persona` / `tools` |
| 换模型 | `agent.yaml` 的 `model.name`（`model.provider` 必须是 provider 目录里有的名字，写错会当场列出可用值） |
| 加技能 | 新建 `skills/<名字>/SKILL.md`（frontmatter 必须有 `name`/`description`，且 `name` 与目录名一致） |
| 接外部系统 | `connectors.yaml` |

```bash
cd ../my-agent
make validate           # 改完先跑这个：定义合法吗
```

### 4. 四道闸门 → 结论

```bash
make verify             # 依次跑闸门 1→4，最后给出「可用 / 不可用」
```

看到这行就成了：

```
可用：四道闸门全过（§6.8）—— 这个想法被证明走通了
```

拿机器可读的报告（交给别人评审用这个）：

```bash
make verify JSON=1 > verify-report.json
```

## 用本地模型跑（Ollama / vLLM / LM Studio …）

本地服务都是 OpenAI 兼容、**都不需要密钥** —— 基座内置了 `ollama` / `vllm` / `local` 三家：

```yaml
# agent.yaml 里只改这一处
model:
  provider: ollama          # 或 vllm；通用自建服务用 local（端点由 LOCAL_BASE_URL 给）
  name: llama3.2            # 本机已拉取的模型名
```

```bash
make verify                 # 四道闸门（仍走自带假网关，与本地模型无关）
make run-local PROMPT="说一句话"
#   provider: local 时给端点：make run-local ENDPOINT=http://localhost:1234/v1 PROMPT=…
```

- **本机有哪些模型**：`make providers-init ENDPOINT=http://localhost:11434/v1 PROVIDER=ollama`（vLLM 换 8000）。
- **容器里访问宿主机**：Docker Desktop / OrbStack 用 `http://host.docker.internal:11434/v1`；
  Linux 上可 `--network host`。
- 三家默认端点：`ollama` → `http://localhost:11434/v1` · `vllm` → `http://localhost:8000/v1` ·
  `local` → 由 `LOCAL_BASE_URL` 给（LM Studio 常用 `http://localhost:1234/v1`）。

## 用订阅登录（如 Codex 订阅），不配密钥

pi 支持订阅登录：**在运行环境里登录一次**，凭据落在 pi 自己的目录（`auth.json`），
之后这个 provider 就**不需要任何 API Key** —— 基座不注入密钥，交给 pi 的凭据库：

```yaml
model:
  provider: openai-codex     # 内置，作用域只有 pi
  name: gpt-5.5
```

```bash
pi auth check --provider openai-codex --json     # 看订阅是否就绪（oauth）
make verify                                       # 闸门 1/2 实证；3/4 对订阅型显式「不适用」
```

- **为什么要显式带登录态**：产物是只读的、暂存目录是新建的。跑的时候用
  `AGENT_HARNESS_HOME=<pi 的 agent 目录> make run-local`（或 `--harness-home`）把登录态带进暂存副本；
  容器里把该目录挂进去即可。
- **要"真的能用"的证据就加 `LIVE=1`**（打真实端点，会实际调用模型）：

```bash
make verify LIVE=1          # 四道闸门全部对着真实端点跑
```

  默认（不加 LIVE）走零凭据假网关：快、封闭、不花额度，但订阅型/云供应商的端点无法重定向，
  这种产物上闸门 3/4 会**如实报告"不适用"**并要求你用 LIVE 确证 —— 而不是伪装成通过。
- 登录态由基座自动带上：产物用的是订阅型 provider 时，暂存副本会自动取
  `PI_CODING_AGENT_DIR`（默认 `~/.pi/agent`）里的 `auth.json`；容器里挂那个目录即可，
  找不到会**明确报错**，不会静默失败。

## 接一个真实端点（以 DeepSeek 为例）

**两步，不用建任何配置文件。** 基座内置了常用供应商（`deepseek` / `openai` / `corp-gateway` …），
`model.provider` 写名字即可 —— 端点、凭据名、模型名单都来自内置目录。

```bash
# 1) 把密钥放进环境或一个变量文件里（真环境变量优先；文件只是兜底）
#    通行名字就是 DEEPSEEK_API_KEY —— 不用照着 provider 名去推一个变量名
echo 'DEEPSEEK_API_KEY=sk-你平台的key' >> .env      # 或者 export DEEPSEEK_API_KEY=…
```

```yaml
# 2) agent.yaml 里写这个
model:
  provider: deepseek          # 供应商名（不是 URL）。旧名 model.route 等价
  name: deepseek-flash        # 该供应商的模型名；写错时闸门 1 会列出可用取值
```

```bash
make new-agent NAME=my-ds-agent DESCRIPTION="用 DeepSeek 的验证智能体"
cd ../my-ds-agent
#   把上面那两处改进去
make verify                                          # 四道闸门（走自带假网关，不需要真密钥）
make run-local PROMPT="说一句话"                      # 真跑：端点用内置的 api.deepseek.com
```

要点：

- **端点**：内置 provider 已带公开端点，不必给；要换成镜像/代理，就设 `DEEPSEEK_BASE_URL=…`
  （或写自己的 `providers.yaml` 覆盖同名条目 —— 那也是 `AGENT_PROVIDERS_FILE` 指一下的事）。
- **模型名单**：内置目录里写的是常用名字；要确认端点实际提供哪些，用
  `make providers-init ENDPOINT=https://api.deepseek.com API_KEY=sk-… PROVIDER=deepseek` 问一次。
- **换成别的供应商**：`model.provider` 改成 `openai` 就用 `OPENAI_API_KEY`，其余照旧。
- **内部网关**：在 `providers.yaml` 里加一条（`baseUrlParam: CORP_GATEWAY_BASE_URL` 表示端点由部署给），
  或直接用内置的 `corp-gateway` 并设 `CORP_GATEWAY_BASE_URL`。
- **装进容器**：派生目录里的产物在 `.render/<运行时>`（基座自己跑才用 `dist/<运行时>/<名字>`）。
  自己起容器时把**渲染产物目录**挂到 `/opt/agent-base/artifact`，镜像 tag 用本机实际有的那个
  （`docker images | grep agent-base`）：

  ```bash
  IMAGE=$(docker images --format '{{.Repository}}:{{.Tag}}' | grep '^agent-base:' | head -1)
  docker run --rm -e HARNESS=pi -e DEEPSEEK_API_KEY=… -e DEEPSEEK_BASE_URL=… \
    -v "$PWD/.render/pi:/opt/agent-base/artifact:ro" "$IMAGE"
  ```

  更省事：**不用自己拼 docker 参数** —— 在基座仓库里跑
  `make verify-container AGENT_DIR=<你的智能体目录>`（绑定面与安全下限都由基座给，失败还会自动归因）。

## 常用变体

```bash
# 本地交互跑一次（不需要容器）—— **要告诉它端点**（定义里只写引用名，不写端点）
make local ENDPOINT=https://your-endpoint.example/v1 API_KEY=…      # 进交互会话（最常用）
make run-local ENDPOINT=https://… API_KEY=… PROMPT="把这段话拆成可验证的断言"   # 一次性
#   ⚠️ 不给端点会**响亮失败**并列出三种给法（这是刻意的：不会替你编一个端点）
#   用本地模型（ollama/vllm/local）时端点来自内置目录，可省 —— 见上面「用本地模型跑」一节

# 换运行时（定义不用改）
make verify HARNESS=dsh

# 针对**真实端点**跑闸门 3/4（不传 = 零凭据假网关）
CORP_GATEWAY_API_KEY=xxx \
make verify ENDPOINT=https://your-endpoint.example/v1

# 只想知道"运行时实际加载了什么"
make render && make doctor RENDER_DIR=.render/pi

```

> **`make image` / `make image-all` 是基座仓库的目标**（出的是"运行时 + 闸门"的镜像），
> 派生出来的智能体目录里**没有**它们 —— 智能体不产生新镜像，它的产物（`.render/<运行时>`）
> 是**挂进**基座镜像的。在派生目录里跑会得到 `No rule to make target`。

## 拿到结论之后

`verify` 的结论 + 可复现的镜像快照 + 交接文档 = **验证证据包**，用来支撑
「继续投入 / 放弃 / 进入生产化」的决策。

```bash
make verify JSON=1        # §6.7 报告（机器可读，交给别人评审用这个）
#   要"容器里也成立"的结论：在基座仓库里跑
#   make verify-container AGENT_DIR=<你的智能体目录>
#   要在基座侧出镜像（可选）：基座仓库里 make image-all
```

## 出错了怎么办

**先看 `07-troubleshooting.md`。** 一句话版本：按**退出码**判断是哪道闸门的问题 ——
`10` 是定义写错、`20` 是"运行时加载的 ≠ 你声明的"、`30` 是部件不可达、`40` 是能干但干不成活。

## 值得先知道的三件事

1. **"能启动"不算可用。** `usable` 的定义是四道闸门全过。基座里很多机制存在的意义就是
   不让"看起来没问题"蒙混过关。
2. **定义里永远不写端点和密钥**，只写**引用名**（如 `CORP_GATEWAY_BASE_URL`），真值运行期注入。
   理由见 `02-concepts` 的「行为烤、参数下放」。
3. **失败大多是静默的。** 这个环境下"配了没生效"往往退出码 0、照常启动。所以别只看"跑起来了"，
   看闸门 2 的报告（它对着运行时**实际加载的东西**断言）。
