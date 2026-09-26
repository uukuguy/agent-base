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

前提：本机已 `make dev-env`（按 `adapters/*/adapter.yaml` 的 pin 校验/安装两个运行时）。
下面所有命令都在**仓库根目录**执行，每一步都给出期望结果。

### 1. 闸门 1：定义合法吗

```bash
make validate AGENT_DIR=examples/privacy-redaction
# 等价写法（不进 examples/ 目录时更直接）
node tools/validate.mjs examples/privacy-redaction
```

期望：退出码 `0`，stderr 末尾出现「闸门 1：全绿」，其中应包含
`3 个技能的 frontmatter 合法`、`model.provider「corp-gateway」已声明`、
`model.name「corp-think」在 provider corp-gateway 的模型名单内`。
若这条失败，先改定义再往下走 —— 后面几道闸门都建立在定义合法之上。

### 2. 四道闸门：两个运行时都必须给出「可用」

```bash
node tools/verify.mjs examples/privacy-redaction --harness pi
node tools/verify.mjs examples/privacy-redaction --harness dsh
```

期望：两条都以退出码 `0` 结束，并打印「可用：四道闸门全过」。
四道闸门分别在证：定义合法（1）、运行时**实际加载**的技能与声明一致（2）、
模型与技能真的可达（3）、它真的能干活且没越界用工具（4）。

第 4 道会**实测只读边界**：冒烟运行产生的轨迹里不得出现被禁的工具。
判据是工具名的子串匹配，所以 `bash` / `write` / `edit` 三个词都不应出现在 `tool.call` 事件里。

### 3. 跨运行时等价性

```bash
node tools/compare.mjs examples/privacy-redaction
```

期望：退出码 `0`，输出「等价性通过」，四组集合两侧一致
（技能集合、连接器集合、模型路由、路由协议形状）。
任何差异都必须能被某个运行时的 exemptions 声明解释；解释不了的差异算失败 ——
基座的纪律是「可以不一样，但不许悄悄不一样」。

### 4. 让业务标签生效（实测，不是"声明了"）

业务标签分两层：**基座只管机械事实**（时间戳 / seq / 事件类型 / 工具的原始名），
业务在 `trace-labels.yaml` 里写自己的说法，查看器只做**字符串查找**（不是语义推断）。
所以顺序是：先跑出轨迹，再让查看器读它。

```bash
# ① 起一个零凭据假网关（不需要任何密钥），它会在 stdout 打印一行 base URL
node tools/fake-gateway/server.mjs --port 0 &
#    http://127.0.0.1:<port>/v1

# ② 本地真跑一次，拿到轨迹文件（run-local 会把路径打印在 stderr 的「轨迹」一行）
node tools/run-local.mjs examples/privacy-redaction --harness pi \
  --endpoint http://127.0.0.1:<port>/v1 \
  --zero-credential true \
  --prompt "帮我清点这份数据清单里的敏感字段并分级"

# ③ 用查看器把轨迹渲染成业务可读时间轴
#    注意真实签名是：<AGENT_DIR> --timeline <轨迹文件>
node tools/trace-view/labels.mjs examples/privacy-redaction --timeline <上一步打印的 trace.jsonl>
```

期望：第 ② 步 stderr 末尾出现「轨迹 N 条：…/trace.jsonl」（N > 0）；
第 ③ 步每行前面的 `◆` 表示这一行用了**业务说法**、`·` 表示机械回退，
stderr 还会打印「业务说法覆盖：N/M」。本仓库实测的一次输出是：

```
    0 ◆ 隐私与敏感信息处理审查助手
    1 ◆ 内网推理网关（携带 4 个工具，流式）
    2 ◆ 读取待审查材料
    3 ◆ 完成：读取待审查材料（1ms，耗时推算）
    4 ◆ 内网推理网关（携带 4 个工具，流式）
业务说法覆盖：5/5（其余 0 条为机械回退）
```

对照一下就知道标签确实在起作用：同一份轨迹如果交给一个没有标签表的目录
（例如 `examples/contract-review`），第 2/3 行会退回机械措辞「调用工具 read」「工具 read」——
机械事实一直都在，业务说法是从 `trace-labels.yaml` 里**查表得来的**，不是模型编的。

为什么查看器不自己"懂"这些词：它只知道"业务给 `agent` 起了这个名字"。
换一个业务、换一套词，基座与查看器一行都不用改 —— 这是分层纪律的可执行形态。

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
