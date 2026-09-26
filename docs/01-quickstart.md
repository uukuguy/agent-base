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
  connectors.yaml     能连哪些系统（默认空）
  skills/example/     一个能跑的示例技能
  trace-labels.yaml   业务给轨迹起的说法（可选）
  Makefile            薄转发层，不用改
  README.md
```

### 3. 改定义

| 我要改 | 改哪 |
|---|---|
| 人设、边界 | `agent.yaml` 的 `persona` / `tools` |
| 换模型 | `agent.yaml` 的 `model.name`（`model.route` 是基座声明的路由，不能随便写） |
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

## 接一个真实端点（以 DeepSeek 为例）

手里有密钥、想用它真跑一次，四步：

```bash
# 1) 问端点有哪些模型，写成一份路由目录（不用手记模型名）
make new-agent NAME=my-ds-agent DESCRIPTION="用 DeepSeek 的验证智能体"
make routes-init ENDPOINT=https://api.deepseek.com API_KEY=sk-你平台的key \
     ROUTE=deepseek OUT=../my-ds-agent/routes.yaml
#   → 输出会列出端点实际提供的模型（例如 deepseek-flash / deepseek-v4-pro）

# 2) 改 agent.yaml：route 用 deepseek，name 用上一步列出来的某一个
cd ../my-ds-agent
#   model:
#     route: deepseek
#     name: deepseek-flash        # ← 上一步打印出来的名字

# 3) 四道闸门（默认走自带零凭据假网关，**不需要**你的密钥）
make verify                     # → 可用：四道闸门全过

# 4) 真跑一次（这时才用到密钥）
make run-local ENDPOINT=https://api.deepseek.com API_KEY=sk-你平台的key PROMPT="说一句话"
```

要点：

- `routes.yaml` 放**智能体旁边**就会自动生效（生成的 Makefile 认它）——不必改基座、不必记环境变量。
- 参数名由**路由名**推导：路由叫 `deepseek` ⇒ `DEEPSEEK_BASE_URL` / `DEEPSEEK_API_KEY` / `DEEPSEEK_MODEL`。
  所以第 4 步也可以写成 `DEEPSEEK_BASE_URL=https://api.deepseek.com DEEPSEEK_API_KEY=… make run-local`。
- 真实端点要求运行环境**能出网到该端点**。若运行环境封闭，就把 `ENDPOINT` 换成你们的内部端点。
- 装进容器跑：把第 3 步渲染出的产物挂进去，参数用环境变量给：

```bash
docker run --rm -e HARNESS=pi \
  -e DEEPSEEK_BASE_URL=https://api.deepseek.com -e DEEPSEEK_API_KEY=… \
  -v "$PWD/dist/pi/my-ds-agent:/opt/agent-base/artifact:ro" \
  agent-base:0.1.0-arm64
```

## 常用变体

```bash
# 本地交互跑一次（不需要容器）
make run-local                      # 交互
make run-local PROMPT="把这段话拆成可验证的断言"   # 一次性

# 换运行时（定义不用改）
make verify HARNESS=dsh

# 针对**真实端点**跑闸门 3/4（不传 = 零凭据假网关）
CORP_GATEWAY_API_KEY=xxx \
make verify ENDPOINT=https://your-endpoint.example/v1

# 只想知道"运行时实际加载了什么"
make render && make doctor RENDER_DIR=.render/pi

# 出镜像（可选）
make image                # 当前架构
make image-all            # 两个架构分别构建 + 合并多架构 manifest
```

## 拿到结论之后

`verify` 的结论 + 可复现的镜像快照 + 交接文档 = **验证证据包**，用来支撑
「继续投入 / 放弃 / 进入生产化」的决策。

```bash
make image-all            # 产出镜像与多架构 manifest（默认落在 dist/image/）
make verify JSON=1        # §6.7 报告
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
