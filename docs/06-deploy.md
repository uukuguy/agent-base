# 06 · 部署与运行契约

面向平台/运维：镜像里有什么、怎么跑、注入什么、能看到什么。

## 一、两种镜像变体

| 变体 | 用途 | 里面有什么 |
|---|---|---|
| `agent-base:<版本>-<架构>` | **生产/验证** | 工具链 + 两个运行时 + 预装的 MCP 服务器 + 基座不变量设置。**没有**调试工具 |
| `agent-base:<版本>-debug-<架构>` | 交互式调试（§10.1 第 ④ 道手段） | `FROM` 上面那个**同 digest**，只多一层诊断工具（`strace`/`tcpdump`/`nc`/`ps`/`less`） |

**架构**：`arm64` 与 `amd64` 都有。两个变体都承诺双架构。

**纪律**：调试工具**绝不进生产镜像**；生产入口遇到 `AGENT_RUN_MODE=debug` 会**明确拒绝**（退出码 2）
并让你去用 `-debug` 变体。这样即使有人把调试环境变量带到生产镜像上，也拿不到诊断 shell。

## 二、镜像内的固定路径

| 路径 | 是什么 | 谁挂它 |
|---|---|---|
| **`/opt/agent-base/artifact`** | **渲染输出整体**（`render-manifest.json` + 各运行时的产物目录）。挂载点可用 `AGENT_ARTIFACT_DIR` 改 | 构建时拷进去，或运行期挂载（**推荐只读**） |
| `/opt/agent-base/startup.mjs` | 启动期准备脚本（参数下放 + 可写暂存的落地点） | 镜像自带，只读 |
| `/opt/agent-base/harnesses.json` | 装了哪些运行时（包名+版本，构建时生成） | 镜像自带，只读 |
| `/etc/agent-base-variant` | `production` 或 `debug` | 镜像自带，只读 |
| `/run/agent-base` | **暂存出来的可写运行目录**（镜像内路径，可用 `AGENT_RUN_DIR` 改） | 启动脚本自己建（`/tmp` 兜底） |

**产物挂载点是"整体"，不是某个运行时的配置目录。** 各运行时的配置目录（`PI_CODING_AGENT_DIR` /
`DSH_HOME` / 工作目录）由**启动脚本**按产物清单里的运行期布局契约暂存后决定 —— 于是交付镜像不必知道
"这份产物是给哪个运行时的"，也就能同时装两个运行时。

**为什么技能与工作区是"固定路径"**：渲染期路径与运行期路径必须解耦 —— 产物里写死渲染机的临时路径，
到了容器里必然失效。所以产物里写的是**镜像内固定路径**，本地运行时由运行器把副本里的路径改写成
本地暂存路径（产物本身不动）。

## 三、运行期环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `HARNESS` | 无（**必填**） | 用哪个运行时。没给或镜像里没有 → 退出码 2，并列出镜像里装了什么 |
| `AGENT_HARNESS_ARGS` | 空 | 传给运行时的参数串。**入口不解释它** —— 各运行时的参数形态由适配器决定 |
| `AGENT_RUN_MODE` | `oneshot` | `interactive` / `oneshot` / `rpc` / `debug`。`debug` 在生产变体上会被拒绝 |
| `AGENT_TRACE_DEST` | 空 | 轨迹文件路径（JSONL）。空则不打文件 |
| `AGENT_TRACE_CONTENT` | `digest` | `digest` = 工具入参/结果只留摘要；`full` = 保留明文。**两者性质不同，会写进轨迹标注** |
| `AGENT_PERMISSION_MODE` | 取决于运行时 | 放行策略。⚠️ **无人值守时必须显式给** —— 审批在无应答者时是 fail closed（等人），不是报错 |
| `AGENT_CRASH_TAIL_LINES` | 30 | 崩溃时把轨迹末多少行打到 stderr |
| `<PROVIDER>_BASE_URL` / `<PROVIDER>_API_KEY` | 端点：provider 已带公开端点时不必给；凭据：**必填** | **模型端点与凭据**。`<PROVIDER>` 是供应商名（见 `02-concepts`）；内置 provider 直接给出通行密钥名（如 `DEEPSEEK_API_KEY`） |
| `<PROVIDER>_MODEL` | 定义里的 `model.name` | **模型名的运行期覆盖**。同一份制品在不同环境常要指向不同模型名；取值须在该 provider 的模型名单内 |
| `<任意引用名>_FILE` | 无 | **从文件读**该值。文件结尾的换行会被去掉 |
| `AGENT_SECRETS_DIR` | 无 | **凭据目录**：读 `<目录>/<引用名>` 作为该参数的值（一次挂一整套凭据时省事）。优先级低于环境变量与 `_FILE` |
| `AGENT_PROVIDERS_FILE` / `AGENT_CATALOG_DIR` | 基座内置 provider 目录 | **供应商目录**（连哪个端点、端点服务哪些模型）。构建/校验期用；运行期不需要（名单已记进产物清单）。旧名 `AGENT_ROUTES_FILE` 仍被接受 |
| `AGENT_ENV_FILE` | 无 | **变量文件**路径（`.env` 这类）。工具链会读它补环境变量；**真环境变量优先**。容器里挂一份进去也可以 |
| `AGENT_ARTIFACT_DIR` | `/opt/agent-base/artifact` | 产物根挂载点 |
| `AGENT_RUN_DIR` | `/run/agent-base`（不可写时退回 `/tmp/agent-base-run`） | 暂存可写副本的位置 |
| `<连接器引用名>` | 无 | 连接器的端点/凭据（如 `AGENT_JIRA_ENDPOINT_PROD`、`JIRA_TOKEN`） |

**定义里永远不写这些值**，只写引用名；上面这些变量就是"引用名 → 真值"的注入点。

## 四、入口契约

```bash
docker run … <镜像> agent      # 默认：按 HARNESS 起智能体
docker run … <镜像> config-check   # 只校验运行期配置与产物，不跑模型（生产里当就绪探针）
docker run … <镜像> shell      # 调试用：进 shell（`shell -c '…'` 也支持）
docker run … <镜像> <命令…>     # 其他：直接 exec 透传
```

| 情况 | 行为 |
|---|---|
| 生产变体 + `AGENT_RUN_MODE=debug` | **拒绝**，退出码 2，提示去用 `-debug` 变体 |
| 调试变体 + `AGENT_RUN_MODE=debug` | 打印诊断信息（变体/运行时/产物路径 + 轨迹末 N 行）后给 shell |
| 没给 `HARNESS`，或镜像里没有该可执行文件 | 退出码 2，**列出镜像里实际装了什么**，并且**不会**用别的运行时替代（那会让跨运行时结论失真） |
| 找不到渲染产物 | 退出码 2，明确说"构建镜像时要把产物拷进去或挂载" |
| 进程被信号杀掉等未预期崩溃 | 退出码 50，把**轨迹末 N 行 + 生效配置摘要**打到 stderr |
| `verify` 子命令（镜像内自证）失败 | **取首个失败闸门的语义码**（10/20/30/40），且**首败即停**（与宿主 `verify` 同一条规矩，见 `07-troubleshooting` 第一节） |

退出码的完整语义见 `07-troubleshooting` 第一节。

## 五、stdout / stderr 契约

- **stdout 只放结果**：运行时的机器可读输出（例如 `--json` 的事件流）或最终答复
- **stderr 放诊断**：进度、告警、崩溃证据、用法提示
- **轨迹**默认不打 stdout（用 `AGENT_TRACE_DEST` 指文件）—— 否则结果与日志混在一起，下游没法稳定解析

这条契约与基座自身的工具一致：`make verify JSON=1 > report.json` 拿到的就是纯 JSON。

## 六、容器里怎么配 LLM

**两件事分开看：用哪个模型是定义决定的，连哪个端点是部署决定的。**

**实际环境很杂**，所以基座**不假定任何编排层、也不假定哪一种给法是"标准"**。
同一个值有四种给法，任选其一（优先级固定：① > ② > ③ > ④）：

| # | 给法 | 形态 | 常见场景 |
|---|---|---|---|
| ① | 环境变量 | `NAME=value` | 任何地方都能用：`docker run -e`、systemd、CI、shell |
| ② | 指向文件 | `NAME_FILE=/path/to/value` | 交给外部的密钥文件、临时凭证文件 |
| ③ | **凭据目录** | `AGENT_SECRETS_DIR=/dir`，读 `/dir/NAME` | 一次性把整套凭据挂进一个目录（不必逐个文件设变量） |
| ④ | 定义里的默认值 | `agent.yaml` 的 `model.name` 等 | 该参数有默认值时才成立 |

```bash
# 直白的一种（不依赖任何编排）
docker run --rm \
  -e HARNESS=pi \
  -e CORP_GATEWAY_BASE_URL=https://your-endpoint.internal/v1 \
  -e CORP_GATEWAY_API_KEY=… \
  -e CORP_GATEWAY_MODEL=corp-think \          # 可选：覆盖定义里的默认模型名
  -v /path/to/render:/opt/agent-base/artifact:ro \
  agent-base:0.1.0-arm64

# 也可以用"凭据目录"一次给全（目录里的文件名 = 引用名）
docker run --rm -e HARNESS=pi \
  -e CORP_GATEWAY_BASE_URL=https://your-endpoint.internal/v1 \
  -e AGENT_SECRETS_DIR=/secrets \
  -v ./my-secrets:/secrets:ro \
  -v /path/to/render:/opt/agent-base/artifact:ro \
  agent-base:0.1.0-arm64
```

启动时依次做四件事，**任何一步不满足就退出码 2 并说清缺什么**（不做静默降级）：

1. **解析运行期参数**：四种给法按固定优先级取（环境变量 → `…_FILE` → `AGENT_SECRETS_DIR` → 定义默认值）→ 缺必填项就失败
2. **校验模型名**：必须在该 provider 的模型名单内（写错当场报错并列出可用值，而不是等端点回一句看不懂的错）
3. **暂存可写副本**：产物按只读挂载，运行时要写会话/缓存 ⇒ 复制一份到 `/run/agent-base` 再跑。
   **产物本身永不改写**（它有摘要，改了摘要就不成立）
4. **原子渲染**（仅当该运行时的配置不支持环境插值）：把 `${引用名}` 换成真值，临时文件 + rename

**凭据永不打印**：日志与 `--json` 输出里只显示 `***`（以及它来自环境变量还是文件）。
**就绪探针**用 `config-check`：只校验、不落盘、不跑模型。
**手工运行**（有人在机器上直接跑）：`make run-local` 提供了 `--endpoint` / `--api-key` / `--model` / `--secrets-dir` / `--param NAME=VALUE`
这些便利开关 —— 直接映射到产物声明的运行期参数，不必去记引用名。
**只有一个运行时**时容器不必显式传 `HARNESS`（入口会按唯一那个起，并**在 stderr 明确说明**）；
装了多个则仍然必须显式指定 —— 基座不替调用方挑运行时。

## 七、运行期无外网

**约束**：运行环境**不能出外网**（构建期不受此限）。

架构是 **「构建期装齐、运行期断网」**：

| 环节 | 做法 |
|---|---|
| 构建期 | 走公网拉基础镜像与 npm；按**精确 pin 全局安装**两个运行时与预装的 MCP 服务器 |
| 运行期 | 连接器以 `npx -y <包>@<版本>` 启动，靠**已装的那个精确版本**解析，不临时拉取 |
| 验证 | 以 `--network none` 实跑：两个运行时都能自报版本，**11 个预装连接器 0 失败**（`conformance/C9` 逐条验） |

⚠️ **仍需注意**：运行时里任何**静默联网**（遥测、自更新检查）都会表现为"启动变慢或莫名报错"，
而不是清晰失败。基调是**关掉它们**而不是容忍。

## 八、推荐的加固运行参数

```bash
docker run --rm \
  --read-only --tmpfs /tmp \
  --cap-drop ALL --security-opt no-new-privileges \
  --network none \
  -e HARNESS=pi \
  -e <PREFIX>_BASE_URL=… -e <PREFIX>_API_KEY=… \
  -v /path/to/render:/opt/agent-base/artifact:ro \
  -v /path/to/workspace:/workspace:rw \
  agent-base:<版本>-<架构>
```

容器内实测（`conformance/C9`，每次改镜像都会重跑）：

| 项 | 实测结果 |
|---|---|
| 身份 | 非 root（uid **10001**） |
| 根文件系统 | 只读（`/tmp` 可写） |
| 能力 | `CapEff` **全 0** |
| 网络 | `--network none` 下运行时与 11 个连接器均可用 |

## 九、构建镜像

```bash
make image                 # 当前架构（原生，最快）
make image ARCH=amd64      # 指定架构
make image DEBUG=1         # 连调试变体一起
make image-all             # 两个架构分别构建 + 合并多架构 manifest
make image-manifest        # 只产出多架构 manifest（OCI 归档落盘）
make image-push IMAGE_REF=registry.example.com/ns/agent-base:0.1.0   # 推送
make image-builder         # 多架构 builder 就绪并设为当前（让手敲 buildx 多平台命令可用）
```

**版本 pin 的单一真源**是 `adapters/*/adapter.yaml`（镜像构建从那里读包名与版本）。
**预装清单**的单一真源是 `core/image/preinstall.yaml`；构建输入是它生成的
`core/image/preinstall.lock.txt`（改了清单要跑 `make image-lock`，否则 `make validate` 会失败）。

**改了这些输入就必须重建镜像**：两个 `Dockerfile` · `entrypoint.sh` · `core/image/startup.mjs` ·
两份锁（`harnesses.lock.json` / `preinstall.lock.txt`）。构建期会把它们的指纹烤进镜像 LABEL
`agent-base.inputs-digest`，`conformance` 的 C9 会重算比对 —— **忘了重建会直接红**，
不会再出现"镜像在跑旧行为而所有检查全绿"。

**构建环境注意**：本机 Docker 由 OrbStack 管理，其 `docker` 驱动**不支持多平台构建** ——
`make image-all` 会自动准备一个 `docker-container` 驱动的 builder 来完成。手敲多平台命令前先
`make image-builder`。

## 十、这份镜像是什么语义

**「验证快照」，不是生产镜像。** 版本号怎么走、什么算破坏性变更，见根目录 [`CHANGELOG.md`](../CHANGELOG.md) 的版本策略一节。 它存在的意义是让验证环境足够接近生产、结论才可信；
生产化（鉴权、审批流、多租户、高可用、SBOM 签名、常驻服务编排）不在基座范围。
所以：**别把它当生产部署方案**，把它当"这次验证是在什么环境里跑出来的"的可复现证据。

## 派生镜像：业务层怎么加、怎么自证（P1–P3）

基座镜像是底座；**真正可用的智能体是它之上的一层镜像**。派生镜像的骨架在 `core/image/derived/Dockerfile`，
按约定放三样东西，基座启动时自动接上：

| 放到哪 | 是什么 | 效果 |
|---|---|---|
| `/opt/agent-base/artifact/` | 渲染产物 | **烤进镜像 ⇒ 运行时不必挂载** |
| `/opt/agent-base/definition/` | 中性定义 | 镜像内自证可连闸门 1 一起跑 |
| `/opt/agent-base/overlay/` | **接入缝**：业务代码与钩子 | 启动期**只改暂存副本**：拷 `extensions/`、`business/`，把 `enhancements` 并进副本的清单，并把扩展登记进 `settings.json` |

**接入缝的清单**（`overlay/overlay.yaml`）：

```yaml
apiVersion: agent-base/v1
harness: pi                 # 与当前运行时不符 ⇒ 明确失败（不猜、不静默跳过）
enhancements:
  - kind: hook
    id: corp-audit
    entry: extensions/corp-audit.ts
    events: [tool_call]     # 业务钩子：工具调用前审计/脱敏/策略（名字必须在 adapter.yaml 的 hookEvents 里）
```

**一条命令构建并自证**：

```bash
make image-derived AGENT_DIR=examples/idea-to-proof OVERLAY_DIR=./my-overlay IMAGE_REF=agent:mine
#   期望（离线、零凭据）：
#     ✅ 配置齐备（config-check，无挂载）
#     ✅ 缺凭据 fail-fast（不静默跑）
#     ✅ 可用：派生镜像构建成功，并在镜像内自证通过
```

**镜像内自证**（闸门 2/3/4；给了定义就连闸门 1）：`docker run --rm <镜像> verify`
—— 适合放进 CI 当验收步骤。它**不覆盖**容器的安全下限（C9），那部分只能在构建侧跑。

**权限坑（已处理）**：`COPY` 保留源文件权限位；开发机上的文件可能是 0600，容器里以非 root 跑会读不到
（本项目自己踩过一次）。派生骨架因此显式 `chmod -R a+rX` 产物/定义/接入缝。

