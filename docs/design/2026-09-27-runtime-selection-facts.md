<!-- 由 `make gen-selection-facts` 生成 —— 不要手改（闸门 1 的 `docs/selection-facts-sync` 会拦） -->

# 运行时选型：事实材料（决策输入，不是结论）

> 这是**决策门的输入**。每条都从真源现算，命令在文末给全 —— 事实过期比没有事实更坏，
> 所以它由 `tools/gen-selection-facts.mjs` 生成、由闸门 1 守同步，**不手写**。
> 结论与取舍写在 `docs/status/DECISIONS.md` 与路线图的决策门里，不在这份文件里。

生成时间不写进文件（那会让每次生成都不同、同步检查失去意义）；真源：`core/catalog/capabilities.yaml` · `adapters/*/adapter.yaml` · `adapters/*/seed/` · `adapters/*/exemptions.yaml`。

## 1. 声明面覆盖（中性定义的每个字段，两侧各支持到什么程度）

字段总数 **31**（真源：能力目录）。

| 运行时 | supported | partial | unsupported | unknown | 已实测(verified) | 未实测 |
|---|---|---|---|---|---|---|
| `dsh` | 23 | 8 | 0 | 0 | 23 | 8 |
| `pi` | 20 | 10 | 0 | 1 | 22 | 9 |

## 2. 机制差异（两侧**必然不同**的地方，来自各自的 adapter.yaml）

能力维度（两侧 adapter.yaml 声明的键的并集，共 12 个）：

| 能力 | `dsh` | `pi` |
|---|---|---|
| `childAgents` | `supported` | `partial` |
| `commandsHeadless` | `unsupported` | `supported` |
| `configInclude` | `partial` | `unsupported` |
| `hmr` | `supported` | `unsupported` |
| `implicitSkillSources` | `partial` | `partial` |
| `mcpClient` | `supported` | `extension` |
| `nativeParamInterpolation` | `supported` | `unsupported` |
| `osSandbox` | `partial` | `unsupported` |
| `permissionModel` | `supported` | `extension` |
| `runModes` | `interactive/oneshot/rpc/debug` | `interactive/oneshot/rpc/debug` |
| `runtimeWritableConfig` | `partial` | `supported` |
| `traceEmit` | `supported` | `supported` |

形态与工程事实：

| 维度 | `dsh` | `pi` |
|---|---|---|
| 版本 pin | `0.1.7-rc.1`（**预发布**） | `0.87.1` |
| 包 | `@deepseek-ai/dsh` | `@earendil-works/pi-coding-agent` |
| 生命周期事件是否**穷举** | **否** ⇒ 该侧钩子事件名只能标「未验证」 | 是（39 个） |
| 增强形态 | `package` | `file` |
| 轨迹通道 | 事后映射（`trace.mjs`，emitter=post-hoc） | 进程内钩子（`seed/extensions/trace.ts`，emitter=hook） + 事后映射（`trace.mjs`，emitter=post-hoc） |
| 有 seed（基座不变量落地处） | 有 | 有 |
| 已记录的坑（adapter 声明） | 11 条 failures + 18 条 failureCases | 11 条 failures |
| 已声明的等价性豁免 | 10 条 | 9 条 |

各能力维度的**实测备注**（真源里就写在 `*Note` 字段，这里只截首段；要全文看 adapter.yaml）：

- `dsh` / `childAgents`：原生 subagent 体系【实测：组合树含 dsh-subagent / dsh-subagent-spawn-in-process / dsh-tool-subagent 等 row】，另有 agent-team 实验插件。 
- `pi` / `childAgents`：subagent 扩展已加载，未跑真实委派（N20 的解除条件）。
- `dsh` / `commandsHeadless`：实测：无头 `--json` 模式下 `/project skills` 被当成**提示词**送进模型（无 command 事件、输出里没有报告）⇒ 斜杠命令的交互面需要 UI 宿主（tui/ACP），本基座**无法无头验它**。边界检查在 `dsh-project-info-selftest`（该…
- `pi` / `commandsHeadless`：实测：`pi --mode rpc` 发一个 `/project skills` 提示 ⇒ 命令被执行、报告作为自定义消息进会话（正向端到端检查在 `pi-project-info-selftest`）。⇒ 本运行时的斜杠命令**可被无头驱动**
- `dsh` / `configInclude`：四层合成（bundle → profile → home → `--patch`），但 patch 的 `config` 是**整体替换**而非深合并， 且 bundle 之间不可嵌套【文档 §11.1】。处置：渲染器产出**完整** config，不做增量假设。 
- `pi` / `configInclude`：settings.json 无 include/extends，不能多文件拼接。处置：构建期扁平化，渲染器产出完整最终值。 
- `dsh` / `hmr`：tui 上启用，headless/SDK/ACP 显式禁用（§9.1）。本地迭代用 tui，容器内验契约。
- `pi` / `hmr`：改配置需重启。处置：本地迭代用交互模式，见 §9.1。
- `dsh` / `implicitSkillSources`：**六个 rank 根**（project-dsh / project-agents / custom / user-dsh / user-agents / bundled）【文档 §11.1】， 关不掉。处置：文件系统隔离 + 渲染时把智能体技能**显式**写进 profile 的 `custom…
- `pi` / `implicitSkillSources`：两个隐式源，配置键都关不掉【实测】： ① $HOME/.agents/skills ② <cwd 祖先>/.agents/skills（沿工作目录向上发现，止于仓库根）—— **第二源常被忽略** 处置：文件系统隔离（固定 HOME + 中立化 cwd）+ `--no-skills --skill …
- `dsh` / `mcpClient`：**原生支持**（实测包存在：`@deepseek-ai/dsh-mcp-client`）。每服务器一条 insert row： - insert: - id: mcp-<name> name: '@deepseek-ai/dsh-mcp-client' config: { serverName, …
- `pi` / `mcpClient`：**原生没有，但已用扩展补上**（实测 + 已选型）。 ① 原生事实：pi 的 docs/README/CHANGELOG 对 MCP 零提及，包内无 mcp.json / allowInstall / hostConfigDiscovery，bundle 里的 mcpServers 全是第三方 S…
- `dsh` / `nativeParamInterpolation`：该 harness 的 patch 支持 `!!js` 表达式（实测 `--dump-config` 里就有 `disabled: !!js '!ctx.get(...)'`），因此凭据/端点可用 `!!js process.env.X` 在运行期解析。 但只允许读参数层清单里的名字（§11.3），…
- `pi` / `nativeParamInterpolation`：models.json 只对 apiKey 与 headers 做环境插值，baseUrl 不做【实测 + 文档 models.md】。 处置：渲染器产出 models.json.tmpl，entrypoint 在启动期用参数层渲染 —— 这正是「行为烤、参数下放」的实现。 
- `dsh` / `osSandbox`：landlock 仅 Linux【文档 §11.1】；macOS 上无等价物。处置：安全断言只在容器内算数（§7.2）。 
- `pi` / `osSandbox`：无 OS 级沙箱（Linux 下也没有等价物）。处置：容器层承担硬下限（§7.2）。
- `dsh` / `permissionModel`：原生权限预设 + 审批；**无应答者时 fail closed**【文档 §11.1】。 无人值守运行必须显式自动放行，否则卡死 —— 这条要进 failures.md。 
- `pi` / `permissionModel`：靠 protected-paths 扩展。
- `dsh` / `runtimeWritableConfig`：基座 home 层与 profile 由镜像提供；`--dump-config` 本身不写任何东西【实测】。 但运行会话会写 `$DSH_HOME/sessions/`（实测目录存在且按项目分桶），故仍需可写卷承载会话与状态。 
- `pi` / `runtimeWritableConfig`：连 --list-models 都会写 <agent-dir>/{models-store.json,auth.json}【实测】。 处置：只读种子 + 启动期暂存为可写副本。 
- `dsh` / `traceEmit`：原生会话轨迹：`$DSH_HOME/sessions/--<cwd>--/<id>/session.v4.jsonl`（**zstd 压缩的 JSONL**， 版本 v4）【实测】。记录以 `{type, seq, time, data}` 为骨架，type 用 `/` 命名空间 （`tool/ca…
- `pi` / `traceEmit`：**原生支持，不需要自建审计扩展**（实测修正：原文曾标为 extension；也不要自创 "native" 这种取值——它就是 supported）。 两条原生轨迹通道： ① `--mode json` 的结构化 JSONL 事件流（stdout 专供 JSONL，诊断走 stderr，与 §8.…

## 3. 基座不变量（同一份能力，两侧各自的落地形态）

基座不变量的声明 id 全集（两侧 seed 的并集）：`capabilities` · `project-info` · `trace` · `verify-container`

| 不变量 | `dsh` | `pi` |
|---|---|---|
| `capabilities` | **缺** | 产物内声明（seed 的 `capabilities`） |
| `project-info` | 产物内声明（seed 的 `project-info`） | 产物内声明（seed 的 `project-info`） |
| `trace` | 事后映射（`trace.mjs`，emitter=post-hoc） | 产物内声明（seed 的 `trace`） |
| `verify-container` | 产物内声明（seed 的 `verify-container`） | 产物内声明（seed 的 `verify-container`） |

## 4. 与选型相关、且**目前没有答案**的点（机器能判的都在这儿了，剩下的要人拍板）

- `dsh` 的生命周期事件集合**未穷举** ⇒ 该侧钩子声明只能标「未验证」（要穷举得先量清运行时的可订阅集合）。
- `dsh` 当前 pin 是**预发布版本**（`0.1.7-rc.1`）⇒ 升级抖动风险需要单独评估。
- `dsh` 的基座不变量**没有任何落地形态**：`capabilities`（选它当主运行时就得先补，见 §26 V3）。

## 5. 怎么复核这份文件

```bash
make gen-selection-facts        # 重新生成（内容不变就说明事实没漂）
make validate                   # 闸门 1 的 docs/selection-facts-sync 会拦不同步
make compare AGENT_DIR=<你的智能体目录>          # 两侧**等价性**（差异必须有声明）
node conformance/run.mjs --harness pi && node conformance/run.mjs --harness dsh  # 两侧同一套 C1–C10
```
