# pi 适配器已知静默失败表（统一设计 §5.5 强制交付物）

> **本表的每一行都必须配一个可执行的检测用例**（进 `conformance`）。检测归哪个闸门写在最后一列。
> 「静默失败」= 改了没生效、或配了没加载，而进程**不报错、退出码 0**。这是 dsh 上位文档里最痛的教训
> （实验 A：patch target 不存在，只打警告、exit 0、继续运行），也是本基座把 `doctor` 升格为强制接口的原因。

## 来自实测的失败模式（本机 pi 0.87.1）

| # | 现象 | 真实原因 | 检测方式 | 闸门 |
|---|---|---|---|---|
| F1 | 出现未声明的技能 | `$HOME/.agents/skills` 是隐式发现路径，**配置键关不掉** | `get_commands` 里 `source=skill` 的集合 == 声明集合（`set-equals`） | 2 |
| F2 | 出现未声明的技能（第二源） | `<cwd 祖先>/.agents/skills` 也会被发现，**止于仓库根** | 同上；用例必须在**带祖先目录的 cwd** 下跑，否则检测不到 | 2 |
| F3 | 端点配了没生效 | `models.json` 的 `baseUrl` **不做环境插值**（只有 apiKey/headers 插值） | 断言启动期渲染后的 `models.json` 里 `baseUrl` 来自参数层，而不是模板占位符 | 2 |
| F4 | 人设没生效 | `AGENTS.md` 解析失败，或 `AGENTS.override.md` 静默覆盖了它 | 断言 `get_state` 能起来且 agent-dir 指向本次渲染产物（`definitionPath`） | 2 |
| F5 | **推理强度配了没生效** | pi 把 thinking level **钳到模型声明支持的档位**；模型无该元数据时**静默降为 `off`**【实测：settings.json 的 `defaultThinkingLevel: high` 与 CLI `--thinking high` 都得到 `thinkingLevel=off`】 | 若定义声明了 `model.reasoningEffort`，断言 `get_state.thinkingLevel` 与之**一致**；不一致即失败（不许静默降级） | 2 |
| F6 | 扩展没加载 | 扩展加载抛错被忽略（pi 约束 7：扩展入参未校验） | 已加载扩展 id 集合 == `enhancements.yaml` 声明集合（`set-equals`） | 2 |
| F7 | 工具黑名单没生效 | `tools.deny` 靠**运行参数** `--exclude-tools` 生效（实测：不传时请求里 4 个工具，传 `--exclude-tools bash` 后 3 个）。**手工直接启动 pi 会绕过它** | ① 断言交付入口/`run-local` 确实传了 `--exclude-tools`；② 经假网关断言请求里的 `tools` 计数 == 内置集合减去 deny | 1 + 3 |
| F8 | 运行期写入失败被当成"配置错误" | pi 会写 `<agent-dir>/{models-store.json,auth.json}`，只读挂载下会失败 | 断言 agent-dir 可写，或断言已按启动期暂存为可写副本 | 1 |
| F9 | 配置目录不是本次渲染产物 | pi 从 `PI_CODING_AGENT_DIR` 取目录，环境变量缺失时回落到真实的 `~/.pi/agent`，**带着宿主机配置照常启动** | 断言 `doctor` 报告的 `definitionPath` == 期望的渲染产物路径 | 2 |
| F10 | **连接器被静默忽略** | pi **原生没有 MCP 客户端**（`capabilities.mcpClient: absent`）。若渲染器选择"跳过不支持的连接器"，就会渲染出一个没有连接器的智能体而无人察觉 | 声明了 `mcpServers` 时，渲染必须**显式失败**；选定第三方客户端扩展后，改为断言已加载的服务器集合 == 声明集合 | 1 + 2 |

## 与设计 §5.5 原有条目的对应

设计 §5.5 已列 pi 三条（端点不插值、未声明技能、增强没生效）→ 对应本表 F3 / F1+F2 / F6。本表在其上补了 **F5（推理强度静默钳位）、F7（deny 语义映射）、F8（运行期写配置）、F9（配置目录回落）、F10（连接器静默忽略）**，全部来自 S2 预检实测或上游文档核对。

## 尚未证实、暂不进表的疑点

- 有 thinking 元数据的模型是否尊重 `defaultThinkingLevel`：离线环境无内建模型目录（`--list-models` 报 "No models available"），**需真实 provider 才能实测**。F5 的检测用例不依赖该结论——它断言的是「声明的档位 == 实际档位」，两种情况下都成立。
- `settings.skills`（含入清单）与 `--skill` 是否等价：目前只用 `--skill`（已实测），`settings.skills` 的相对路径解析基准未验证。
