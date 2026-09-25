# adapters/pi/seed/ —— 基座种子（所有智能体完全一致的东西）

> **本层纪律（统一设计 §12.1 原话）**
>
> 基座镜像的 harness home 层：放所有智能体**完全一致**的东西（模型路由能力、安全姿态、审计、强制校验）。
> **不放**：任何智能体之间会分叉的东西 —— home 层钉住的 row 智能体层改不动，且失败静默。

渲染器把本目录的内容**并入**每个智能体的渲染产物。业务级增强（`harness/pi/`）在并入之后追加，不覆盖这里的安全键。

## 现有内容

| 文件 | 放什么 | 依据 |
|---|---|---|
| `settings.json` | 基座不变量安全姿态：`defaultProjectTrust: "never"`（不信任项目本地文件）、关闭遥测与分析、安静启动 | §10.4 H5 / §7.2 |
| `enhancements.yaml` | 基座不变量增强的**声明清单**。基座不给自己开后门：闸门 2 的「已加载扩展 id 集合 == 声明集合」同样覆盖它 | §4.5 / §6.3 |
| `extensions/trace.ts` | **基座轨迹扩展**：订阅 loop 回调产出统一轨迹。只订阅、不返回值、绝不抛异常（业务扩展会叠加同一批回调） | §8.3 / `../trace-mapping.md` |

**渲染时会把 `core/trace/emit.mjs` 拷成产物里的 `extensions/_trace-emit.mjs`**，扩展用相对路径 import 它 —— 这样**发射契约只有一处定义**，扩展不会自带一份会漂移的副本。

`defaultProjectTrust` 只能写在 agent-directory 的 settings 里（上游文档明确），所以它必须由基座种子提供 —— 这正是"基座不变量"的形态。

## 明确**不**放在这里的

| 不放 | 为什么 | 放哪 |
|---|---|---|
| 人设（`AGENTS.md`） | 每个智能体都不一样 | 定义层（渲染产出） |
| 技能 | 分两类：**基座不变量技能**与智能体技能。后者来自定义 | 前者见 `core/image/preinstall.yaml` 的 `skills` 条目；后者在渲染产物里 |
| `models.json` | 每个智能体的模型选择不同；且 `baseUrl` 必须启动期渲染 | 渲染产出 `models.json.tmpl` |
| `tools.deny` | 每个智能体的边界不同；且它靠**运行参数** `--exclude-tools` 生效（不是 settings 键） | `runArgs.excludeTools` 进 manifest，由入口脚本传递 |
| `audit-log` 扩展 | **实测后降级**：pi 原生就有结构化事件流与会话文件，轨迹应由 `trace.mjs` 映射而非扩展产出 | 见 `../trace-mapping.md`；该扩展仅在需补"审批语义"（缺口 G3）时才做 |

## 待补（S2 未完项）

- `protected-paths.ts`：写保护扩展（§10.4 H5）。在补上之前，写保护的硬底线由容器层的只读根承担。
- 写保护与 `--offline` 的组合验证：属 `conformance/C9`（安全声明与容器内实测一致）。
