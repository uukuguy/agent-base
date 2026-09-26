# privacy-redaction · 隐私 / 敏感信息处理审查

一个**只读**的隐私审查助手：先把敏感字段清点分级，再核对脱敏方案的残留风险，
最后按证据纪律把结论写清楚。它不给合规认证、不给法律意见、不替数据责任人做决定。

## 它解决什么问题

「我们已经脱敏了」「只保留了后四位」「用了某某工具」—— 这类说法听起来像结论，实际没法检验。
本智能体把它变成三样可核验的东西：

1. **一份敏感字段清单**：每个字段属于哪一类（直接标识符 / 准标识符 / 敏感属性 / 一般属性）、
   为什么是这一级；
2. **一份脱敏残留风险表**：每个字段的脱敏方法是否与级别匹配，还剩什么链接/组合/残留副本风险，
   以及「要拿到什么信息才能把这条记录重新对回某个人」；
3. **一段守纪律的结论**：每条结论带范围 / 依据 / 限制 / 确定性标注，并明确写出**本次没覆盖什么**。

边界是刻意的：`tools.deny: [bash, write, edit]`。它**只读**——不改文件、不执行命令、
不产出可直接上线的处理脚本，也不产出一个"批准"。判断"能不能对外披露"是数据责任人与法务的事。

## 结构

```
agent.yaml                         它是谁、用哪个模型、边界（只读：deny bash/write/edit）
connectors.yaml                    空 —— 不带连接器（输入面最小，见「已知边界」）
trace-labels.yaml                  业务给轨迹起的说法（基座不解释，只机械查找后呈现）
Makefile                           由 tools/new-agent.mjs 生成，薄转发层，不用改
README.md                          本文件
skills/
  sensitive-field-inventory/       敏感字段识别与分级（含一个表格自检脚本）
    scripts/check-inventory.mjs    只读自检：四列齐备 + 枚举合法 + 依据非空
  redaction-plan-audit/            脱敏方法核对 + 残留风险清单
  compliance-claim-discipline/     结论表述纪律（三种确定性标注 + 必带边界声明）
```

**没有 `harness/` 目录**是刻意的：本示例只用到中性定义能表达的东西，
所以它能原样跑在 pi 与 dsh 两个运行时上（`make compare` 会验这一点）。

## 构建与验证过程

**在这个目录里开发** —— 每个示例自带 Makefile，不用回仓库根：

```bash
cd examples/privacy-redaction
```

### 开发循环：改 → 查 → 跑 → 验

```bash
# ① 改完立刻查：秒级，不用网络、不用密钥（定义/引用/分层/增强声明都查）
make validate
#   期望：闸门 1：全绿，末尾没有 ❌（写错的地方会点名字段；**不写死项数**，免得数字一漂就过期）

# ② 真跑一次
make run-local ENDPOINT=<端点> API_KEY=<密钥> PROMPT="清点这段数据里的敏感字段，并核对脱敏残留风险"
#   期望：敏感字段清单 + 脱敏残留风险 + 按证据纪律给出的可核验结论；退出码 0

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
node skills/sensitive-field-inventory/scripts/check-inventory.mjs --selftest
#   期望：退出码 0
```

### 四道闸门分别在证明什么

| 闸门 | 证明什么 | 本示例的看点 |
|---|---|---|
| 1 静态 | 定义合法、引用与分层合规 | 技能名与目录一致、模型名在该供应商名单内、增强声明合法 |
| 2 解析自证 | 运行时**实际加载**到的东西与声明一致 | 技能/增强真的进了产物（不是写在定义里就算） |
| 3 集成探针 | 模型可达、工具字段在、流式没降级 | 端点侧收到的请求里有工具字段 |
| 4 端到端冒烟 | 它真的能干活、且没越界用工具 | 闸门 4 的看点：只读边界被**实测**（被禁的工具不会出现在冒烟轨迹里） |

它只读：`deny: [bash, write, edit]`


## 改它

| 我要改 | 改哪 |
|---|---|
| 人设、只读边界 | `agent.yaml` 的 `persona` / `tools` |
| 换模型 | `agent.yaml` 的 `model`（provider 必须是基座目录里有的名字，写错时闸门 1 会列出可用值） |
| 加/改技能 | 新建或编辑 `skills/<名字>/SKILL.md`（frontmatter 必须有 `name` / `description`，且 `name` 与目录名一致） |
| 技能脚本 | 放在 `skills/<名字>/scripts/`，在 SKILL.md 里用相对路径引用；脚本要支持 `--selftest` |
| 换业务说法 | `trace-labels.yaml`（定位符语法：`agent` / `model:<provider>` / `skill:<name>` / `connector:<name>` / `tool:<原始工具名>` / `log:<命名空间>` / `gate:<闸门名>`） |
| 接外部系统 | `connectors.yaml`（按名引用基座预装条目，例如 `- ref: filesystem`；本示例刻意留空） |

改完按顺序再跑一次：`node tools/validate.mjs examples/privacy-redaction`，
然后两个 `verify`，最后 `compare`。命令与期望结果同上。

表格自检脚本可以单独跑：

```bash
node examples/privacy-redaction/skills/sensitive-field-inventory/scripts/check-inventory.mjs --selftest
node examples/privacy-redaction/skills/sensitive-field-inventory/scripts/check-inventory.mjs 你的清单.md
```

## 已知边界

诚实起见，这个示例**不覆盖**以下内容；它们不是"以后再说"，而是当前形态的真实边界：

- **只读边界由闸门 4 实测，不是口头承诺**。它证明的是「本次冒烟运行没有触碰被禁工具」，
  不等于运行时的所有路径都被穷尽证明。真正的强制在运行时侧的 deny 机制，不在提示词里。
- **本示例不带连接器**（`connectors.yaml` 的 `mcpServers: []`）。它审查的是调用方交进来的材料，
  不主动读库/读盘 —— 这样"审查者"不会变成"又一个数据访问方"。需要读文件时，
  由调用方把材料贴进会话或按需挂载，而不是给智能体一个全盘读取的口子。
- **两个运行时的工具边界粒度不同**。pi 侧可以精细到单个工具；dsh 侧 `read`/`write`/`edit`
  属于同一个 tool-fs row，禁了 `write`/`edit` 等于连 `read` 也没了（文件访问改由连接器提供）。
  这是**已声明的**跨运行时差异（记在各 runtime 的 exemptions 里，`compare` 会把它们列出来），
  不是本示例写错了。
- **`skill:` 标签在两种情况下才出现**：运行时上报了技能事件，**或**基座从"某次工具调用读了
  `skills/<名>/SKILL.md`"推导出技能使用（推导出来的那条会标注"按路径推导"）。
  没读技能文件的轨迹里本来就没有技能事件 —— 那不是标签失效，而是**那条轨迹里确实看不到技能**。
