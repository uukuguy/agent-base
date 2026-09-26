# multi-env-rollout · 同一份制品，换值换环境

这个示例回答一个问题：**同一份智能体制品，能不能在 dev / staging / prod 三个环境里跑，
而只换运行期给的值、不改定义、不改基座？**

它与另外两个示例的分工：

| | `idea-to-proof` | `contract-review` | `multi-env-rollout`（本篇） |
|---|---|---|---|
| 形态 | 纯技能型 | 带连接器（MCP） | **自带 provider 配置 + 多环境参数** |
| 用来演示 | 最快路径 | 双运行时交付 + 等价性比对 | **同一份制品换值换环境 + 四种参数给法** |

## 它解决什么问题

「同一份东西在三个环境里跑」最容易坏的方式，不是某次部署失败，而是**悄悄跑了两份东西**：
一个环境用了重建的镜像、staging 的模型名进了 prod、某个端点值只在一个环境设了。

本示例把这件事变成**可核对的流程**：

- **钉住「同一份」**：制品必须用内容寻址摘要比对（`artifact-consistency`），
  `latest` 这类可变标签不算证据。
- **差异必须分类**：环境之间每处不同都归入 `该不同` / `取值不同` / `不该不同`
  （`env-parity-check`），分不出类的写「需人工判断」。
- **放行与回滚一起定**：没有可观测回滚判据的上线计划不许放行（`rollback-criteria`）。

而支撑这一切的机制是基座的两条约定：**行为烤进制品，参数运行期下放**，
以及 **供应商配置是配置，不是基座代码**。

## 结构

```
examples/multi-env-rollout/
  agent.yaml            它是谁 / 用哪个模型 / 边界（只读：禁 bash、write、edit）
  providers.yaml        第二份 provider 配置：与内置同名 id 按字段合并（这里只覆盖 models）
  connectors.yaml       空 —— 不连外部系统，保持零依赖、clone 下来就能跑
  trace-labels.yaml     业务给轨迹起的说法（基座不解释，只机械查找后呈现）
  skills/
    env-parity-check/       环境差异分类：该不同 / 取值不同 / 不该不同
    artifact-consistency/   证明三环境同一制品（含可执行自检脚本）
    rollback-criteria/      放行检查单 + 可观测回滚判据
  Makefile              基座模板生成，未手写；AGENT_BASE_DIR=../..，并导出 providers.yaml
  README.md
```

**没有 `harness/` 目录**是刻意的（和 `idea-to-proof` 一样）：纯中性定义 + 技能就够，
证明这个题材不需要业务级增强。也没有 package.json —— 定义目录不是 node 工程。

`providers.yaml` 只在 agent.yaml 旁边，就会被基座工具自动认（解析链第 ③ 层 agent-local），
并与 `../../core/catalog/providers.yaml` 的**同名 id 按字段合并**：
这里只写了 `displayName` / `models` / `note`，其余（协议形状、端点引用名、凭据引用名）全部继承内置。

## 构建与验证过程

**在这个目录里开发** —— 每个示例自带 Makefile，不用回仓库根：

```bash
cd examples/multi-env-rollout
```

### 开发循环：改 → 查 → 跑 → 验

```bash
# ① 改完立刻查：秒级，不用网络、不用密钥（定义/引用/分层/增强声明都查）
make validate
#   期望：闸门 1：全绿，末尾没有 ❌（写错的地方会点名字段；**不写死项数**，免得数字一漂就过期）

# ② 真跑一次
make run-local ENDPOINT=<端点> API_KEY=<密钥> PROMPT="同一份制品要进 staging，给出环境差异核对与上线检查单"
#   期望：环境差异核对表 + 制品一致证明 + 上线检查单与回滚判据；退出码 0

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
node skills/artifact-consistency/scripts/check-artifact-identity.mjs --selftest
#   期望：退出码 0
```

### 四道闸门分别在证明什么

| 闸门 | 证明什么 | 本示例的看点 |
|---|---|---|
| 1 静态 | 定义合法、引用与分层合规 | 技能名与目录一致、模型名在该供应商名单内、增强声明合法 |
| 2 解析自证 | 运行时**实际加载**到的东西与声明一致 | 技能/增强真的进了产物（不是写在定义里就算） |
| 3 集成探针 | 模型可达、工具字段在、流式没降级 | 闸门 1 的看点：环境差异只出现在**参数层**，不许写进中性定义 |
| 4 端到端冒烟 | 它真的能干活、且没越界用工具 | 被禁的工具不会出现在冒烟轨迹里（边界是**实测**的，不是约定的） |

它的看点是把**同一份产物**在不同环境参数下跑（见 `## 改它` 里的环境差异）


## 改它

- **换人设 / 边界** → `agent.yaml`（`tools.deny` 目前是只读：禁 `bash` / `write` / `edit`）。
- **换端点 / 换模型别名** → `providers.yaml`。只写要改的字段，同名 id 按字段合并；
  注意 `models` 是**整字段替换**，所以默认名 `corp-think` 必须保留。
  只想换运行期的值，则不用改文件：给 `CORP_GATEWAY_BASE_URL` / `CORP_GATEWAY_MODEL` 即可。
- **加技能** → 新建 `skills/<名字>/SKILL.md`，frontmatter 必须有 `name` / `description`，
  且 `name` 与目录名一致；要带脚本就放 `skills/<名字>/scripts/`，脚本要支持 `--selftest`。
- **接发布系统 / CI / 监控** → 在 `connectors.yaml` 里按名引用基座预装条目
  （写法见 examples/contract-review 的 `connectors.yaml`）。
- 改完重跑：`make validate` → `make verify` → `make compare`。
- `Makefile` **不用改**（它是基座模板生成的薄转发层）；本目录的 `providers.yaml`
  会被 Makefile 自动导出为 `AGENT_PROVIDERS_FILE`。

## 已知边界

- **`corp-gateway` 与三个模型别名都是示例值。** `corp-gateway` 是基座内置的示例供应商
  （自带假网关是它的零凭据等价物），`corp-think-staging` / `corp-think-prod` 是本示例声明的别名，
  用来演示「模型名单可以按环境声明」。真实环境请用 `providers-init` 问端点拿真名单。
- **`providers.yaml` 的 `models` 是整字段替换，不是追加。** 覆盖它时忘了写回默认名 `corp-think`，
  闸门 1 的 `model/declared-in-provider` 会当场变红（这正是想要的：早失败）。
- **只读边界的粒度在 dsh 上更粗。** 本示例禁 `bash` / `write` / `edit`；dsh 里
  `read` / `write` / `edit` 同属一个 `tool-fs` row，降级规则由适配器豁免声明
  （`compare` 会把它列出来）。本示例不依赖 `read`，所以不影响四道闸门。
- **启动期渲染的演示只覆盖 pi。** pi 的配置不支持环境插值，所以参数在启动期落盘；
  dsh 走运行时插值，值不写进文件。两者都是「参数下放」，只是落点不同（见 `../../docs/06-deploy.md`）。
- **本示例不是生产部署方案。** 它演示的是核对方法与参数注入契约；
  真实上线还需要审批流、鉴权、发布编排 —— 那些不在基座范围。
