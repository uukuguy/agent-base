# contract-review · 合同条款审阅

这个示例回答一个问题：**同一份中性定义，能不能在两个运行时上都跑通，并且真的用上外部系统？**

它与另一个示例的分工：

| | `idea-to-proof` | `contract-review`（本篇） |
|---|---|---|
| 形态 | 纯技能型 | **带连接器**（MCP） |
| 用来演示 | 最快路径 | **双运行时交付 + 等价性比对** |

## 它解决什么问题

读一份合同（通过文件连接器访问挂载目录），产出**条款级审阅表**：

| 条款号 | 原文摘录 | 风险等级 | 依据 | 建议 | 确定性 |
|---|---|---|---|---|---|

三条纪律贯穿三个技能：**结论必须能回到原文** · **分级必须写依据** · **不确定就说不确定**。

## 结构

| 文件 | 干什么 |
|---|---|
| `agent.yaml` | 人设、模型、边界（只读：`deny: [bash, write, edit]`） |
| `connectors.yaml` | `ref: filesystem`（零凭据、可离线 —— 服务器包在构建期预装进镜像） |
| `skills/clause-extraction/SKILL.md` | 逐条抽条款并回指原文 |
| `skills/risk-grading/SKILL.md` | 分级 + 依据 |
| `skills/citation-anchoring/SKILL.md` | 回指自检（"结论必须能回到原文"的可执行形态） |
| `skills/citation-anchoring/scripts/check-anchors.mjs` | 机械自检脚本：给审阅表与原文，逐行验证摘录能否逐字找到 |
| `trace-labels.yaml` | 业务给轨迹起的说法（基座不解释这些词，只按定位符机械查找后原样呈现） |
| `Makefile` | 薄转发层（跑闸门、渲染、本地运行、比对） |

## 构建与验证过程

**在这个目录里开发** —— 每个示例自带 Makefile，不用回仓库根：

```bash
cd examples/contract-review
```

### 开发循环：改 → 查 → 跑 → 验

```bash
# ① 改完立刻查：秒级，不用网络、不用密钥（定义/引用/分层/增强声明都查）
make validate
#   期望：闸门 1：全绿，末尾没有 ❌（写错的地方会点名字段；**不写死项数**，免得数字一漂就过期）

# ② 真跑一次
make run-local ENDPOINT=<端点> API_KEY=<密钥> PROMPT="把这段试用期条款逐条定位、分级，并给出可核查的修改建议"
#   期望：逐条定位到原文的审阅结果（条款 / 风险等级 / 修改建议 / 不确定性说明）；退出码 0

# ③ 四道闸门 → 给一个「可用 / 不可用」的结论
make verify
#   期望：✅ 可用：四道闸门全过（§6.8）
#   闸门 3/4 默认走基座自带的**零凭据假网关**，不需要任何密钥
```

### 端点与密钥怎么给（三选一）

```bash
# ① 命令行（临时用）
make run-local ENDPOINT=<端点> API_KEY=<密钥> PROMPT="…"

# ② 放这个目录下的 .env（之后不用再敲；**真实环境变量优先于它**）
printf 'CORP_GATEWAY_BASE_URL=<端点>\nCORP_GATEWAY_API_KEY=<密钥>\n' > .env
make run-local PROMPT="…"

# ③ 凭据目录（CI / 生产）：AGENT_SECRETS_DIR=/dir，读 /dir/<参数名>
```

本示例的参数名：`ENDPOINT` → `CORP_GATEWAY_BASE_URL`；密钥 → `CORP_GATEWAY_API_KEY`

### 不知道有哪些模型可用

```bash
make providers-init ENDPOINT=<端点> API_KEY=<密钥> 
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
node skills/citation-anchoring/scripts/check-anchors.mjs --selftest
#   期望：退出码 0
```

### 四道闸门分别在证明什么

| 闸门 | 证明什么 | 本示例的看点 |
|---|---|---|
| 1 静态 | 定义合法、引用与分层合规 | 技能名与目录一致、模型名在该供应商名单内、增强声明合法 |
| 2 解析自证 | 运行时**实际加载**到的东西与声明一致 | 技能/增强真的进了产物（不是写在定义里就算） |
| 3 集成探针 | 模型可达、工具字段在、流式没降级 | 闸门 3 的看点：端点侧收到的工具里包含连接器带来的工具（不是只写了配置就算） |
| 4 端到端冒烟 | 它真的能干活、且没越界用工具 | 被禁的工具不会出现在冒烟轨迹里（边界是**实测**的，不是约定的） |

它连了一个 MCP 连接器：`make doctor` 的看点就是**连接器与工具真的挂上了**


## 改它

| 想改什么 | 改哪里 |
|---|---|
| 审阅纪律 / 人设 | `agent.yaml` 的 `persona.instructions` |
| 换连接器 | `connectors.yaml`（`- ref: <预装条目>` 或完整写法带 `pin`） |
| 加技能 | 新建 `skills/<名字>/SKILL.md`（frontmatter 的 `name` 必须与目录名一致） |
| 挂载范围 | **不由参数层决定**：容器里把合同目录挂进 `/workspace`，智能体就只能看到那个目录 |
| 业务轨迹用词 | `trace-labels.yaml` |

改完再跑 ②③④ 三条 —— 尤其 **④**：改了连接器或工具边界后，`compare` 会告诉你两侧是否还等价、
差异有没有声明。

## 已知边界

- **不评价审阅质量**：闸门证明"连接器真的挂上、工具数变了、两边等价"，不证明条款判得对。
- 本示例的 `filesystem` 连接器是**零凭据**的（谁 clone 下来都能跑）；真实企业的连接器通常要凭据，
  给法见 `docs/06-deploy.md`（环境变量 / `_FILE` / `AGENT_SECRETS_DIR`）。
- 两条不等价**是真实差异**，已在 `adapters/*/exemptions.yaml` 声明；它们不会消失，
  只会被如实列出来。
- 闸门 3/4 默认走零凭据假网关；要"真的能用"的证据加 `LIVE=1`。
