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
| `/opt/agent-base/agent-dir` | 渲染产物（pi 用；也可作为通用挂载点） | 构建时拷进去，或运行期挂载 |
| `/opt/agent-base/skills` | 技能目录（渲染产物声明指向这里） | 同上 |
| `/opt/agent-base/dsh-home` | dsh 的 `DSH_HOME`（profile 在里面） | 同上 |
| `/workspace` | **工作目录**（人设文件在这里被发现） | 挂载工作区 |
| `/opt/agent-base/harnesses.json` | 装了哪些运行时（包名+版本，构建时生成） | 镜像自带，只读 |
| `/etc/agent-base-variant` | `production` 或 `debug` | 镜像自带，只读 |

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
| `<PREFIX>_BASE_URL` / `<PREFIX>_API_KEY` | 无 | **模型端点与凭据**。`<PREFIX>` 由路由名推导（见 `03-capability-catalog`） |
| `<连接器引用名>` | 无 | 连接器的端点/凭据（如 `AGENT_JIRA_ENDPOINT_PROD`、`JIRA_TOKEN`） |

**定义里永远不写这些值**，只写引用名；上面这些变量就是"引用名 → 真值"的注入点。

## 四、入口契约

```bash
docker run … <镜像> agent      # 默认：按 HARNESS 起智能体
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

退出码的完整语义见 `07-troubleshooting` 第一节。

## 五、stdout / stderr 契约

- **stdout 只放结果**：运行时的机器可读输出（例如 `--json` 的事件流）或最终答复
- **stderr 放诊断**：进度、告警、崩溃证据、用法提示
- **轨迹**默认不打 stdout（用 `AGENT_TRACE_DEST` 指文件）—— 否则结果与日志混在一起，下游没法稳定解析

这条契约与基座自身的工具一致：`make verify JSON=1 > report.json` 拿到的就是纯 JSON。

## 六、运行期无外网

**约束**：运行环境**不能出外网**（构建期不受此限）。

架构是 **「构建期装齐、运行期断网」**：

| 环节 | 做法 |
|---|---|
| 构建期 | 走公网拉基础镜像与 npm；按**精确 pin 全局安装**两个运行时与预装的 MCP 服务器 |
| 运行期 | 连接器以 `npx -y <包>@<版本>` 启动，靠**已装的那个精确版本**解析，不临时拉取 |
| 验证 | 以 `--network none` 实跑：两个运行时都能自报版本，**11 个预装连接器 0 失败**（`conformance/C9` 逐条验） |

⚠️ **仍需注意**：运行时里任何**静默联网**（遥测、自更新检查）都会表现为"启动变慢或莫名报错"，
而不是清晰失败。基调是**关掉它们**而不是容忍。

## 七、推荐的加固运行参数

```bash
docker run --rm \
  --read-only --tmpfs /tmp \
  --cap-drop ALL --security-opt no-new-privileges \
  --network none \
  -e HARNESS=pi \
  -e <PREFIX>_BASE_URL=… -e <PREFIX>_API_KEY=… \
  -v /path/to/render/agent-dir:/opt/agent-base/agent-dir:ro \
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

## 八、构建镜像

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

**构建环境注意**：本机 Docker 由 OrbStack 管理，其 `docker` 驱动**不支持多平台构建** ——
`make image-all` 会自动准备一个 `docker-container` 驱动的 builder 来完成。手敲多平台命令前先
`make image-builder`。

## 九、这份镜像是什么语义

**「验证快照」，不是生产镜像。** 它存在的意义是让验证环境足够接近生产、结论才可信；
生产化（鉴权、审批流、多租户、高可用、SBOM 签名、常驻服务编排）不在基座范围。
所以：**别把它当生产部署方案**，把它当"这次验证是在什么环境里跑出来的"的可复现证据。
