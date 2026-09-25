# Live Session Checkpoint

> Updated: 2026-09-25 14:30. **Session remains active — not a final handoff.**

## TL;DR

1. `/project-state init` 完成：`docs/status/` 三个核心文件已建（CURRENT-STATE / JOURNAL / INDEX）。
2. Bootstrap 分类完成：**Project route = managed**，权威工作清单落在 `docs/plans/IMPLEMENTATION-ROADMAP.md`（包 S0–S7，派生自统一设计附录 B）。
3. 当前活动包：**`S0` 中性定义契约**（`core/spec/*.schema.json` + `core/catalog/{capabilities,params}.yaml` + `core/README.md`），S0–S1 是设计定的最小可评审单元。

## Where things stand

- 仓库处于**设计阶段，实现尚未开始**：仅有 `README.md` + `docs/design/` 三份设计文档（2656 行）。
- 分支 `main`，工作树此前干净；本次会话新增 `docs/status/`（未提交）与 `docs/plans/IMPLEMENTATION-ROADMAP.md`（未提交）。
- 设计已定稿 v2.4：四个骨架级决策 J1–J4 与 §15.1 其余取舍全部裁决，仅剩 §15.2 三项待外部输入，**不阻塞实现**。
- 环境实测：Node v24.20.0、npm 11.19.0；`pi @earendil-works/pi-coding-agent@0.87.1` 与 `dsh @deepseek-ai/dsh@0.1.7-rc.1` 均已全局安装。
- npm 直连可用（`npm install` 写本地 cache 成功）；注意 `npm view` 在本机会因 `~/.npm/_logs` 权限报错，改用 `--cache` 指向临时目录即可。

## Next steps (immediate, action-level)

1. 实现 S0：先写 `core/spec/agent.schema.json`、`core/spec/connectors.schema.json`（严格对齐 §4.2/§4.3，`additionalProperties: false`）。
2. 再写 `core/catalog/params.yaml`（§2.3 允许/禁止清单）与 `core/catalog/capabilities.yaml`（§4.6，每字段含所属层与 harness 支持度），并校验两者双向一致。
3. 写 `core/README.md`，开头写入 §12.1 的层纪律原话。
4. 补齐闸门 1 的最小可执行入口（`tools/validate.mjs` + `Makefile` 的 `validate` 目标），让 S0 的「可执行校验」验收成立。

## Open decision (需用户判断，见本轮对话)

- **校验器依赖策略**：`ajv`（npm 依赖，schema 校验完备）vs 自研零依赖 schema 子集校验器（契合 §8.4 离线自检与 I2「内网禁 npm」风险）。这会影响 `core/gates` 的形态。
- **S0 是否包含 validate 入口**：本路线图已把附录 B 的 `core/gates` 框架前移一小块到 S0（否则 schema 无校验器 = 空骨架）；需用户确认这个细化。

## Don't go down these paths again (ruled out)

- **一镜像多智能体 + 运行期 `--patch`**：违反 N19，且 `--patch` 失败静默、绕过制品签名（§15.3）。
- **瘦镜像 + 配置由卷下发**：同一镜像不同行为，把可执行内容的管控从镜像签名挪到平台 RBAC（§15.3）。
- **先造「假 harness」桩验证契约**：多一份无业务价值产物；`conformance` C1–C10 本身就是契约的可执行形态（P4 / §15.3）。
- **`conformance` 部分项仅告警**：会被软化的正是 C5/C8（最危险的两类退化）（P3）。
- **把端点/凭据写进 `agent.yaml`**：违反 R1/N21，企业网关一换就要重建全部智能体（§2.2）。

## Ready-to-paste commands

```bash
# 结构速览
sed -n '399,570p'  docs/design/2026-09-25-unified-agent-base-design.md   # §4 中性定义单元
sed -n '177,332p'  docs/design/2026-09-25-unified-agent-base-design.md   # §2 统一架构（含 §2.3 参数层清单）
sed -n '1528,1549p' docs/design/2026-09-25-unified-agent-base-design.md  # 附录 B 实施顺序

# 装了哪个 harness 版本（§10/§11 的实测基线）
dsh --version ; pi --version

# 若 npm 报 _logs 权限错，用临时 cache
npm install --cache /tmp/npm-cache ajv@8
```
