# Journal — append-only event log

> One line per commit / verified result / dropped path. Never edit past lines.
> Format: `## YYYY-MM-DD` date headers, then `- HH:MM <fact> [commit hash if any]`

## 2026-09-25

- 14:22 仓库改名收尾：dsh-agent-base → agent-base 全部落地（README / 统一设计 §12.6 / 上位文档文件名）[f1a3236]
- 14:22 统一设计定稿 v2.4；四个骨架级决策 J1–J4 与 §15.1 其余取舍全部裁决 [99d1af2]
- 14:22 初始化 docs/status/ 状态层（CURRENT-STATE / JOURNAL / INDEX），项目路由暂为 unclassified
- 14:40 bootstrap 分类为 managed；权威工作清单 = docs/plans/IMPLEMENTATION-ROADMAP.md（包 S0–S7，派生自附录 B）[1fcda95]
- 14:52 S0 交付：中性定义 schema + 能力目录 + 参数层清单 + 闸门 1（tools/validate.mjs）[81499bb]
- 14:52 闸门 1 全绿：16 项检查 + 9 个注入式样本（1 合法 / 8 非法）全部符合预期 [81499bb]
- 14:52 校验器依赖定为 ajv 8.17.1 + yaml 2.6.1（精确 pin；node_modules 已 gitignore）——待用户复核 [81499bb]
- 14:52 环境实测：本仓库 npm install 须 --cache 指向 /tmp（~/.npm 被文件沙箱拒绝写，非权限 bug）[81499bb]
- 14:52 规则细化待确认：core/ 的 harness 名禁令只覆盖代码与 schema，catalog/ 与文档按 §4.6/§12.1 豁免 [81499bb]
- 14:52 待确认：params.yaml 的 connector-credential 命名约定由 §4.3 示例归纳，非 §2.3 表格原文 [81499bb]
