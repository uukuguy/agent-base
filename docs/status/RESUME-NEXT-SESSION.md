# Live Session Checkpoint

> Updated: 2026-09-25 15:00. **Session remains active — not a final handoff.**

## TL;DR

1. 状态层已建（`docs/status/`），bootstrap 分类为 **managed**，权威工作清单 = `docs/plans/IMPLEMENTATION-ROADMAP.md`（包 S0–S7）。
2. **S0（中性定义契约）已交付并验证**：两个 JSON Schema + 能力目录 + 参数层清单 + 闸门 1 校验器；`make validate-selftest` 全绿（16 项检查 + 9 个样本）。
3. 下一个包 = **S1**（四闸门框架 + 假网关 + 统一轨迹 schema），**尚未开工** —— 等用户对三个待确认点表态（见下）。

## Where things stand

- 分支 `main`；两次提交已落地，工作树干净：
  - `1fcda95` 状态层 + 路线图
  - `81499bb` S0 契约 + 闸门 1（46 文件）
- `make validate` 全绿（7 项基座自洽检查）；`make validate AGENT_DIR=core/spec/fixtures/valid` 全绿（16 项）。
- 未实现目标（`render`/`doctor`/`probe`/`smoke`/`verify`/`image`/`debug`/`conformance`/`dev-env`/`run-local`/`new-agent`）在 Makefile 里**显式失败**并指向所属包，不静默通过。
- 依赖：`ajv@8.17.1` + `yaml@2.6.1`（精确 pin，`node_modules/` 已 gitignore，lockfile 已提交）。

## Next steps (immediate, action-level)

1. 确认三个待确认点（下方 Open decisions），必要时改 `core/catalog/params.yaml` 与 `tools/validate.mjs` 的检查范围。
2. 进入 S1：`core/gates/`（编排 + 断言语言 + 报告格式）先从**闸门 1 的现有报告格式**抽象出来，避免造第二套报告形状。
3. S1 第二件：`core/trace/schema.json`（P1 决策：无法映射的原生事件必须输出 `native.raw`，不许丢弃）。
4. S1 第三件：`tools/fake-gateway/`（协议无关核心 + 协议适配；I1 未到位时的默认模型探针目标）。

## Open decisions (需用户判断)

1. **依赖策略**：S0 已选 `ajv` + `yaml`（两个 npm 依赖）。替代方案是自研零依赖校验器/schema 子集——更契合 §8.4 离线自检与 I2「内网禁 npm」，但要自己维护 schema 语义。当前选择可逆（只影响 `tools/validate.mjs` 一个文件）。
2. **`core/` 的 harness 名禁令范围**：设计 §12.1 说 core/ 不放任何 harness 名字，但 §4.6 又要求能力目录记录「支持该字段的 harness 及降级行为」，二者直接冲突。当前处置：禁令只覆盖**代码与 schema**（`.mjs` / `.json`），`catalog/*.yaml` 与 Markdown 按 §4.6 / §12.1 本身豁免；schema 描述里已删除 harness 名。
3. **`connector-credential` 命名约定**：§2.3 表格没有逐项列出连接器凭据，当前按 §4.3 的 `JIRA_TOKEN` / `GITLAB_TOKEN` 示例归纳出 `^[A-Z][A-Z0-9_]*_(TOKEN|SECRET|KEY|PASSWORD)$`，用于判定 `credentialRef` 是否合法。这是 `params.yaml` 里**唯一由示例归纳而非表格原文**的条目。

另有一个 v1 范围问题记录在案：`tools.allow`（工具白名单）未纳入 v1——§4.2/§4.6 只有 `deny`。若业务需要白名单，属公开契约变更，需先改设计正文。

## Don't go down these paths again (ruled out)

- **一镜像多智能体 + 运行期 `--patch`**：违反 N19，且 `--patch` 失败静默、绕过制品签名（§15.3）。
- **瘦镜像 + 配置由卷下发**：同一镜像不同行为，把可执行内容的管控从镜像签名挪到平台 RBAC（§15.3）。
- **先造「假 harness」桩验证契约**：多一份无业务价值产物；`conformance` C1–C10 本身就是契约的可执行形态（P4）。
- **`conformance` 部分项仅告警**：会被软化的正是 C5/C8（最危险的两类退化）（P3）。
- **把端点/凭据写进 `agent.yaml` / `connectors.yaml`**：违反 R1/N21，企业网关一换就要重建全部智能体（§2.2）；定义里只写引用名。
- **未实现目标静默成功**：Makefile 里未实现的命令必须非零退出并说明归属包——静默通过正是 §5.5 在治的病。

## Ready-to-paste commands

```bash
make validate                        # 闸门 1：基座自洽
make validate AGENT_DIR=core/spec/fixtures/valid
make validate-selftest               # 注入式负向自检
node tools/validate.mjs --json core/spec/fixtures/valid   # 机器可读报告

# 若 npm 报 EPERM 且提到 ~/.npm：本仓库安装依赖要换 cache 目录
npm install --cache /tmp/agent-base-npm-cache --no-audit --no-fund

# 设计正文按需取段（1593 行，勿全文加载）
sed -n '399,570p'   docs/design/2026-09-25-unified-agent-base-design.md   # §4 中性定义单元
sed -n '570,709p'   docs/design/2026-09-25-unified-agent-base-design.md   # §5 适配契约与 conformance
sed -n '709,760p'   docs/design/2026-09-25-unified-agent-base-design.md   # §6.1–6.3 四闸门与 doctor 硬断言
```
