# 05 · 连接器怎么配

连接器 = 智能体"能连哪些系统"。走 **MCP**（Model Context Protocol）。

## 两种写法：推荐按名引用

基座镜像里**预装**了一批常用 MCP 服务器。你**不需要知道包名、版本、启动参数**，写一个名字就行：

```yaml
apiVersion: agent-base/v1
mcpServers:
  - ref: filesystem       # 按名引用基座预装条目
    enabled: true
```

`ref` 的名字来自 `core/image/preinstall.yaml` 的 `namedReferences`（见 `03-capability-catalog` 生成的真源；
`make validate` 会校验你写的名字是否存在）。当前可用的名字：

| 名字 | 你会拿它做什么 | 需要凭据 |
|---|---|---|
| `filesystem` | 让智能体读写挂载目录里的文件 —— 处理本地数据的第一步 | 否 |
| `memory` | 跨会话记住事实 —— 验证多轮场景时不用每次重讲背景 | 否 |
| `thinking` | 把推理过程显式化 —— 开发时能看见「它为什么这么决定」 | 否 |
| `git` | 读/搜/改代码仓库 —— 研发类智能体的基础动作 | 否 |
| `repomix` | 把整个仓库打包成一份上下文 —— 排查时一眼看全 | 否 |
| `inspector` | 看一个 MCP 服务器**实际**暴露了什么 —— 连接器不生效时先用它 | 否 |
| `reference-server` | 协议面最全的测试靶子 —— 调连接器时拿它当对照 | 否 |
| `playwright` | 操作网页 —— 网页调研、表单填写、UI 验证 | 否 |
| `chrome` | 看网页的网络请求/控制台报错/性能 | 否 |
| `cloud-browser` | 不想在镜像里带 Chromium 时的云浏览器备选 | **是** |
| `docs` | 拉库/框架的最新文档 —— 避免模型知识过期导致结论错 | 可选 |

**排除项的坑**：预装清单里明确排除了若干"网上排行常见但实际不可用"的服务器
（已 deprecated、只有宿主机形态、或需要每用户 OAuth）。选连接器时**别照抄网络排行** ——
清单里的每条都经过 npm 存活实测，理由逐条写在 `core/image/preinstall.yaml` 的 `excluded` 里。

## 完整写法：自研或清单里没有的系统

```yaml
mcpServers:
  - name: jira
    transport: streamable-http        # stdio | streamable-http
    urlRef: AGENT_JIRA_ENDPOINT_PROD  # 端点只写**引用名**
    credentialRef: JIRA_TOKEN         # 凭据同样只写引用名
    enabled: true
    description: 工单系统              # 会进系统提示词，写给模型看
```

| 字段 | 说明 |
|---|---|
| `transport` | `stdio`（本地程序）或 `streamable-http`（HTTP 服务） |
| `command` / `args` | `stdio` 用；指向你自己的程序时用相对路径 |
| `urlRef` | 端点**引用名**，真值运行期注入 |
| `credentialRef` | 凭据**引用名**，真值运行期注入 |
| `enabled` | 默认 `true`；置 `false` 表示先声明、暂不启用 |
| `description` | 会进系统提示词 —— **写给模型看的一句话**，值得认真写 |

## 凭据与端点：定义里永远不写真值

**引用名约定**（`make validate` 会校验）：

```
连接器端点   ^AGENT_[A-Z0-9_]+_ENDPOINT_[A-Z0-9_]+$
凭据         <名字>_(TOKEN|SECRET|KEY|PASSWORD)
```

跑的时候注入：

```bash
AGENT_JIRA_ENDPOINT_PROD=https://jira.example.com \
JIRA_TOKEN=xxx \
make verify
```

**为什么这么切**：端点和密钥是**环境属性**，写进定义等于把环境焊死在产物里；而定义是要被渲染成
产物、被打成镜像、被反复复用的。

## 两个运行时的差异（这是真实差异，不是实现细节）

| | pi | dsh |
|---|---|---|
| MCP 支持 | **原生没有，已用基座种子扩展补上**（`pi-mcp-adapter`，精确 pin，构建期装好） | ✅ 原生支持（`dsh-mcp-client`） |
| 渲染成什么 | `agent-dir/mcp.json`（`mcpServers` + 安全姿态设置）+ `settings.json` 的 `packages` 声明扩展的本地路径 | 每服务器一条 `insert` row |

**这对你不可见** —— 你照常写 `connectors.yaml`，两侧各自处理。基座承担的是：
把扩展**在构建期**装进镜像（所以运行期不需要网络）、把连接器渲染成它认的配置、
并在"声明了扩展但运行环境里没有它"时**响亮失败**（而不是跑出一个没有 MCP 客户端的智能体）。

实测证据：同一智能体，不带连接器时模型端点收到 **4** 个工具，带 `filesystem` 连接器时收到 **7** 个 ——
该 MCP 服务器的工具确实注册进来了。

## 怎么确认它真的连上了

```bash
make validate            # 闸门 1：引用名存在、凭据引用在允许清单里
make render && make doctor RENDER_DIR=.render/pi
#   → 闸门 2 断言「实际启用的连接器集合 == 声明的启用集合」
make verify              # 闸门 3 还会确认它**可达**（声明了连接器却连不上 → 探针失败）
```

**零凭据验证**：闸门 3/4 默认用基座自带的**假网关**跑，不需要任何真实端点或密钥 ——
所以你可以在拿到凭据之前就把连接器配置调好。

**本地运行时的一个前提**：产物里写的是扩展的**镜像内路径**，本地跑需要 `AGENT_MCP_ADAPTER_PATH` 指向本地安装；不给则运行器**拒绝运行**（不静默降级）。

**连接器不生效时的排查顺序**：① 用 `inspector` 看它实际暴露了什么 →
② 看 `07-troubleshooting` 里"连接器"那几行 → ③ 确认不是凭据/端点引用名写错（闸门 1 会拦）。
