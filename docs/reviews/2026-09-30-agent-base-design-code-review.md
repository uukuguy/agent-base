# agent-base 设计与代码实现评审

日期：2026-09-30

## 结论

当前仓库具备较好的基础架构：中性 Agent 定义、Pi/DSH 双适配器、四道验证闸门、产物清单和本地/容器路径统一思路都比较清晰。

以下是实施前的基线评审结论：当时版本属于高风险开发验证阶段，主要问题包括仓库及 Git 历史中的疑似真实 API Key、宿主环境变量继承、DSH 权限默认值、Trace 泄漏、验证编排误判和 `npm test` 缺失。对应的代码加固已在本轮完成；API Key 轮换/历史清理与生产 CI 证据仍属于外部收尾事项。

## 验证证据

| 检查项 | 结果 | 说明 |
|---|---:|---|
| `node --check` | 通过 | 关键 JavaScript 文件语法正确 |
| `git diff --check` | 通过 | 当前无空白格式错误 |
| `npm test` | 失败 | `package.json` 没有 `test` 脚本 |
| `make regression` | 失败 | 总体退出码 2，包含 14 项失败 |
| `npm audit` | 无法完成 | 当前环境无法访问 npm advisory 服务 |
| Docker 验证 | 无法完成 | 镜像标签或构建环境不可用 |
| 本地网络测试 | 部分失败 | 沙箱禁止监听 `127.0.0.1`，出现 `listen EPERM` |

部分回归失败来自当前执行环境限制，不能全部归因于代码；但仓库本身仍有独立的可用性和安全缺陷。

## 关键发现

### P0：立即处理

1. **API Key 已提交到仓库**：`.env:1` 被 Git 跟踪，历史提交 `c72b692` 中也可恢复。应立即轮换凭据、清理历史、加入 `.gitignore` 和 secret scanning。
2. **宿主环境变量全部传给 Agent**：[core/image/startup.mjs:636](/Users/sujiangwen/sandbox/agentic-2026/agent-base/core/image/startup.mjs:636)、[adapters/dsh/run.mjs:117](/Users/sujiangwen/sandbox/agentic-2026/agent-base/adapters/dsh/run.mjs:117)、[tools/run-local.mjs:179](/Users/sujiangwen/sandbox/agentic-2026/agent-base/tools/run-local.mjs:179)。应改为 allowlist。
3. **DSH 默认权限过高**：[adapters/dsh/run.mjs:137](/Users/sujiangwen/sandbox/agentic-2026/agent-base/adapters/dsh/run.mjs:137) 默认 `danger-full-access`。应改为 `workspace-write` 或 `ask`。
4. **Trace 可能泄漏原始内容**：[adapters/pi/trace.mjs:184](/Users/sujiangwen/sandbox/agentic-2026/agent-base/adapters/pi/trace.mjs:184)、[adapters/dsh/trace.mjs:108](/Users/sujiangwen/sandbox/agentic-2026/agent-base/adapters/dsh/trace.mjs:108)、[core/image/startup.mjs:671](/Users/sujiangwen/sandbox/agentic-2026/agent-base/core/image/startup.mjs:671)。生产默认应使用 digest 和字段 allowlist。

### P1：发布前处理

5. **产物摘要没有覆盖控制面清单**：`render-manifest.json` 包含 `runtimePlan`、路径重写和工具参数，但被 `artifactsDigest` 排除。应增加独立 `manifestDigest` 并在启动前校验。
6. **工具 deny 可被后置参数覆盖**：[core/image/entrypoint.sh:102](/Users/sujiangwen/sandbox/agentic-2026/agent-base/core/image/entrypoint.sh:102)、[core/image/startup.mjs:647](/Users/sujiangwen/sandbox/agentic-2026/agent-base/core/image/startup.mjs:647)。应使用结构化参数并让安全策略最后生效。
7. **渲染输出目录可被递归删除**：[adapters/pi/render.mjs:144](/Users/sujiangwen/sandbox/agentic-2026/agent-base/adapters/pi/render.mjs:144)、[adapters/dsh/render.mjs:274](/Users/sujiangwen/sandbox/agentic-2026/agent-base/adapters/dsh/render.mjs:274)。应限制输出根目录并要求 marker 或显式 `--force`。
8. **Overlay/module capability 没有签名和完整性边界**：[core/image/startup.mjs:176](/Users/sujiangwen/sandbox/agentic-2026/agent-base/core/image/startup.mjs:176)、[core/capabilities/registry.mjs:145](/Users/sujiangwen/sandbox/agentic-2026/agent-base/core/capabilities/registry.mjs:145)。生产环境应验证来源和 digest，不可信能力走独立进程。
9. **验证编排存在误判和挂死风险**：[tools/verify.mjs:48](/Users/sujiangwen/sandbox/agentic-2026/agent-base/tools/verify.mjs:48)、[core/gates/report.mjs:113](/Users/sujiangwen/sandbox/agentic-2026/agent-base/core/gates/report.mjs:113)。应处理非零退出、超时、空 gate/check 和非法报告。
10. **运行目录 fallback 固定为共享目录**：[core/image/startup.mjs:349](/Users/sujiangwen/sandbox/agentic-2026/agent-base/core/image/startup.mjs:349)。应 fail closed 或使用唯一临时目录。

### P2：可用性和维护性

11. `providers-init` 存在 SSRF、Bearer Token argv 泄漏和 YAML 字符串拼接问题。
12. manifest、secrets 目录和 runtime plan 缺少 realpath confinement。
13. Docker 基础镜像和部分 npm 依赖没有完全锁定，当前无法完成在线漏洞审计。
14. `npm test` 缺失，文档引用不存在的 `make verify-all`。
15. `--harness-home` 未加入参数解析，快速开始文档承诺无法实现。
16. Pi 登录态错误路径引用未定义的 `HARNESS_NAME`。
17. 多处使用 `Object.values(plan.env)[0]` 推断暂存目录，扩展 runtime plan 后会失效。
18. 损坏的 `mcp.json` 被静默当成无连接器处理。
19. README 和状态索引落后于实际实现，误导新用户。

## 实施路线

### 第一阶段：安全边界

- 删除工作树中的 `.env`，加入 `.gitignore` 和 secret scanning 配置。
- 为容器、Pi、DSH、本地执行建立共享环境变量 allowlist。
- DSH 默认权限改为 `workspace-write`。
- Trace 默认 digest，限制 raw 字段和崩溃输出。
- 禁止任意输出目录递归删除。

### 第二阶段：运行正确性

- 为 manifest 控制面增加规范化摘要并在 `prepare`、本地执行和容器入口校验。
- 对 manifest、runtime plan、secrets、overlay 路径执行 schema 和 realpath confinement。
- 增加显式 `configDir`、`workspaceDir` 字段。
- 损坏 `mcp.json` 响亮失败。
- 修复 `verify` 的退出码、超时和空报告问题。
- 让工具 deny policy 成为不可覆盖的最终策略。

### 第三阶段：开发入口和回归保障

- 增加 `npm test`。
- 修正 `verify-all` 文档漂移。
- 修复 `--harness-home`、Pi 错误路径和无效 `--keep-home`。
- 增加路径逃逸、manifest 篡改、权限覆盖、环境泄漏、超时和损坏配置负向测试。
- 在联网 CI 中加入 npm/OSV、镜像 SBOM 和容器回归。

## 发布验收标准

- `npm test`、`make regression FAST=1`、`make conformance` 和 `make examples-check` 通过。
- Pi、DSH 两个运行时的 `verify` 均通过。
- Secret scanning 无发现，`.env` 不再被 Git 跟踪。
- Agent 子进程只收到 allowlist 环境变量。
- 默认权限不是 `danger-full-access`。
- Trace 默认不包含原始模型和工具内容。
- 所有渲染输出路径经过安全约束。
- 非零退出、超时、空报告和非法报告均 fail closed。
- Docker 镜像、npm 依赖和 SBOM 可复现。

## 实施进度

本轮已完成并有自检覆盖：

- 删除工作树中的 `.env`，加入忽略规则和 hygiene selftest。
- 增加标准 `npm test` 入口。
- 建立共享子进程环境 allowlist，移除 Pi/DSH/本地/容器的默认全量环境继承。
- 将 DSH 默认权限改为 `workspace-write`。
- 增加 Trace raw 事件脱敏、digest 默认值和有上限的崩溃摘要。
- 增加 manifest 控制面摘要、启动期篡改检测和显式 `runtimePlan.configDir`。
- 增加输出目录危险路径保护、严格报告空检查判定、验证子进程超时和非零退出处理。
- 修复 `--harness-home` 参数解析和 Pi 未定义运行时名错误。
- 增加 GitHub Actions 生产验收工作流：先跑宿主快速回归，再用 Docker/QEMU 构建双架构镜像、生成 OCI manifest，最后执行完整 `node tools/regression.mjs --json` 并上传结构化证据。
- 修复 DSH 暂存布局契约：运行根目录与 profile 配置目录分开传递，新增 `dsh-staging-selftest` 防止技能目录和配置目录错位。
- 修复 Pi/DSH 自检在原生运行时保留 libuv 句柄导致 CI 挂起的问题；自检在判据完成后确定性退出，Pi 运行器同时释放子进程 stdio。
- 已在 OrbStack 上按最新源码重建四个镜像变体和 OCI manifest；完整回归已使用新镜像全绿。

仍需后续处理：API Key 的外部轮换与 Git 历史清理、Overlay/module 签名隔离、providers-init SSRF/YAML 安全、Docker digest/SBOM，以及 CI 中的完整生产验收。
