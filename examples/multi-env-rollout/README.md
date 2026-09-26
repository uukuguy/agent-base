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

下面所有 `node` 命令都在**基座仓库根目录**（`agent-base/`）执行；
带 `make` 的命令在**示例目录**里执行（那才是 Makefile 所在）。

**全程不需要任何真实密钥**：闸门 3/4 用基座自带的零凭据假网关，
「换值换环境」那段用的是临时伪造值 —— 仓库里不出现真实凭据。

### 第 0 步：闸门 1 —— 定义合法吗

做什么：确认定义能过 schema、引用都存在、provider 覆盖生效。

```bash
node tools/validate.mjs examples/multi-env-rollout
```

看什么 / 期望结果：退出码 `0`，最后一行是 `闸门 1：全绿（39 项检查）`。特别看两行：

- `providers/source` 显示 provider 目录来自「基座内置 + agent-local」—— 证明本目录的
  `providers.yaml` 真的被读到了（没配的话这一行只有内置）。
- `model/declared-in-provider` 显示 `corp-think` 在 `corp-gateway` 的模型名单内 ——
  这个名单正是被本目录 `providers.yaml` 覆盖过的。

也可以进示例目录跑同一件事（Makefile 是薄转发层）：

```bash
cd examples/multi-env-rollout && make validate
```

### 第 1 步：四道闸门 × 两个运行时，加一次等价性比对

做什么：让两个运行时都**真的把这份定义跑起来**（渲染 → 自证 → 探针 → 冒烟）。

```bash
node tools/verify.mjs examples/multi-env-rollout --harness pi
node tools/verify.mjs examples/multi-env-rollout --harness dsh
node tools/compare.mjs examples/multi-env-rollout
```

同一组检查也可以走 Makefile（在示例目录里执行，是同一件事的薄封装）：

```bash
cd examples/multi-env-rollout
make validate               # = 第 0 步那条
make verify                 # = 上面 pi 那条
make verify HARNESS=dsh     # = 上面 dsh 那条
make compare                # = 上面 compare 那条
```

看什么 / 期望结果：两条 `verify` 退出码 `0`，stderr 末行 `✅ 可用：四道闸门全过`；
`compare` 退出码 `0`，输出 `✅ 等价性通过`。本仓库实测：

| 命令 | 退出码 | 关键实测 |
|---|---|---|
| `validate` | 0 | 39 项全绿；`providers/source` = 基座内置 + agent-local |
| `verify --harness pi` | 0 | `probe/model.tools`：端点收到 `tools=3`；`smoke`：5 条轨迹过 schema，只用到 `read` |
| `verify --harness dsh` | 0 | `probe/model.tools`：端点收到 `tools=19`；`smoke`：12 条轨迹过 schema，未触碰禁用清单 |
| `compare` | 0 | 技能集合两侧一致（3 个）、连接器集合一致（空）、路由一致（`corp-gateway`）、协议形状一致（`openai-completions`），16 条差异均有声明 |

带连接器的 `contract-review` 里，pi 与 dsh 的工具数差很多是**已声明**的机制差异；
本示例不连外部系统，两边的差异都被 `adapters/<运行时>/exemptions.yaml` 覆盖，所以 `compare` 通过。

### 第 2 步：同一份制品，给 dev / staging / prod 分别给值（四种给法都出现）

先渲染**一次** pi 产物（后面几次实验都复用它，证明「制品只有一份」）：

```bash
node adapters/pi/render.mjs examples/multi-env-rollout --out /tmp/mer-render --json
```

> 为什么用 pi 做这个实验：pi 的配置（models.json）不做环境插值，参数由启动期渲染 ——
> 于是 `startup prepare` 的 `--json` 里能直接看到每个值**从哪来**。
> 四种给法与优先级见 `../../docs/06-deploy.md` 第六节：① > ② > ③ > ④。

**dev —— ① 环境变量**（最直白，任何地方都能用）：

```bash
CORP_GATEWAY_BASE_URL=https://gw.dev.internal/v1 \
CORP_GATEWAY_API_KEY="$DEV_KEY" \
CORP_GATEWAY_MODEL=corp-think \
node core/image/startup.mjs prepare --artifact /tmp/mer-render --run-dir /tmp/mer-run-dev --json
```

**staging —— ② 指向文件**（密钥文件由外部挂进来，不放进环境）：

```bash
printf '%s\n' "$STAGING_KEY" > /tmp/mer-staging.key      # 只在机器上，绝不 commit
CORP_GATEWAY_BASE_URL=https://gw.staging.internal/v1 \
CORP_GATEWAY_API_KEY_FILE=/tmp/mer-staging.key \
CORP_GATEWAY_MODEL=corp-think-staging \
node core/image/startup.mjs prepare --artifact /tmp/mer-render --run-dir /tmp/mer-run-staging --json
```

**prod —— ③ 凭据目录**（一次挂一整套：目录里的**文件名就是引用名**）：

```bash
install -d -m 700 /tmp/mer-secrets
printf '%s\n' "$PROD_KEY" > /tmp/mer-secrets/CORP_GATEWAY_API_KEY
CORP_GATEWAY_BASE_URL=https://gw.prod.internal/v1 \
AGENT_SECRETS_DIR=/tmp/mer-secrets \
CORP_GATEWAY_MODEL=corp-think-prod \
node core/image/startup.mjs prepare --artifact /tmp/mer-render --run-dir /tmp/mer-run-prod --json
```

**④ 定义里的默认值**（④ 只有在该参数有默认值时才成立；这里不设模型名）：

```bash
CORP_GATEWAY_BASE_URL=https://gw.dev.internal/v1 \
CORP_GATEWAY_API_KEY="$DEV_KEY" \
node core/image/startup.mjs prepare --artifact /tmp/mer-render --run-dir /tmp/mer-run-default --json
```

看什么：`--json` 输出里的 `params.<引用名>.source`。**凭据只报来源、永不打印值。**
本仓库实测（把四次输出里的 source 摘出来）：

| 给法 | 环境 | 命令给的引用名 | `params.CORP_GATEWAY_API_KEY.source` | `params.CORP_GATEWAY_MODEL` |
|---|---|---|---|---|
| ① 环境变量 | dev | `CORP_GATEWAY_API_KEY` | `env` | source `env`，value `corp-think` |
| ② `_FILE` | staging | `CORP_GATEWAY_API_KEY_FILE` | `file:/tmp/mer-key.XXXXXX` | source `env`，value `corp-think-staging` |
| ③ `AGENT_SECRETS_DIR` | prod | `/tmp/mer-secrets/CORP_GATEWAY_API_KEY` | `secrets-dir:/tmp/mer-secrets.XXXXXX/CORP_GATEWAY_API_KEY` | source `env`，value `corp-think-prod` |
| ④ 定义默认值 | （任意） | 不给 `CORP_GATEWAY_MODEL` | `env` | source `definition-default`，value `corp-think` |

上面这些检查用的是零凭据模式（凭据是显式占位值），所以**不需要**任何一个真实密钥也能全绿。

### 第 3 步：证明「同一份产物，换值就换环境」

做什么：对照源产物与暂存副本，确认**制品没被改动**，改的只是可写副本。

```bash
# 源产物里仍是占位符（制品没动）
grep -E 'baseUrl|"id"' /tmp/mer-render/agent-dir/models.json.tmpl
# 暂存副本里已换成 staging 的值
grep -E 'baseUrl|"id"' /tmp/mer-run-staging/agent-dir/models.json
grep -E 'defaultProvider|defaultModel' /tmp/mer-run-staging/agent-dir/settings.json
```

看什么 / 期望结果（本仓库实测）：

```
源产物   models.json.tmpl : "baseUrl": "${CORP_GATEWAY_BASE_URL}"
                            "id": "${CORP_GATEWAY_MODEL}"      ← 仍是占位
暂存副本 models.json      : "baseUrl": "https://gw.staging.internal/v1"
                            "id": "corp-think-staging"          ← 已换成 staging 的值
暂存副本 settings.json    : "defaultModel": "corp-think-staging"
```

把 `--run-dir` 与值换成 prod 那一组，同样的产物就落到 prod。
**结论**：同一份渲染产物 + 换一次值 = 换一个环境；制品本身一个字节都没改
（`startup prepare` 只往 `/run/...` 复制一份可写副本再渲染）。

顺带一提：两个运行时渲染出的 `artifactsDigest` **不同**（产物形状本就不同），
但 `definitionDigest` **相同**（实测两边都是 `sha256:00398864…`）——
这说明两边跑的是**同一份中性定义**，产物差异来自运行时机制，且都由各运行时的 exemptions.yaml 声明。

### 第 4 步：技能脚本自检

做什么：本示例的技能带一个可执行的自检脚本，验证制品一致性核对表。

```bash
node examples/multi-env-rollout/skills/artifact-consistency/scripts/check-artifact-identity.mjs --selftest
```

看什么 / 期望结果：退出码 `0`，最后一行 `check-artifact-identity 自检：全绿`。
它内置了 7 个样本（合法表、摘要不一致、用了 `:latest`、缺列、环境为空、只有一个环境、缺来源），
**非法样本必须逐个变红**。也可以拿它校验真实核对表：

```bash
node examples/multi-env-rollout/skills/artifact-consistency/scripts/check-artifact-identity.mjs 你的核对表.md
```

### 不要做：别把真实密钥写进仓库

- 端点与凭据**只以引用名出现**（`CORP_GATEWAY_BASE_URL` / `CORP_GATEWAY_API_KEY`），
  值在运行期按上面四种给法注入。定义里、示例目录里**不该有** `*_API_KEY=真实值`。
- `.gitignore` 已忽略 `.render/`、`dist/`、`*.log`；临时密钥文件请放 `/tmp` 之类仓库之外的位置。
- 真实模型名不要手抄：问端点拿实测名单，再写进 `providers.yaml`
  （`make providers-init ENDPOINT=… PROVIDER=corp-gateway`，见 `../../docs/08-conventions.md`）。

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
