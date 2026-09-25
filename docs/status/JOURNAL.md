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
- 15:05 用户同意两条细化，已回写设计正文 §2.3 / §12.1 + §15.1 记账（含校验器依赖策略）[b38b397]
- 15:20 S1 交付：core/gates 四闸门框架（编排/断言语言/§6.7 报告/退出码/摘要）[87ba18a]
- 15:20 S1 交付：core/trace/schema.json 统一轨迹（七类事件 + native.raw 兜底）[87ba18a]
- 15:20 S1 交付：tools/fake-gateway 零凭据假网关（协议无关核心 + OpenAI 适配，31 项自检）[87ba18a]
- 15:20 validate.mjs 重构到共用报告契约：退出码改为 §6.7（0/2/10），stdout 只放 JSON、日志走 stderr
- 15:20 修正路线图：S1 只负责轨迹 schema；两个 harness 的 trace.mjs 映射属 S2（§5.3/§5.7 适配器 SPI）
- 15:20 五个自检目标全绿：validate / validate-selftest / gates-selftest / trace-selftest / gateway-selftest
- 15:20 假网关残留风险：响应体的非标准字段 created:0 与 fake_gateway 若被严格 SDK 拒绝，以 x-fake-gateway-* 响应头为准
- 15:20 假网关未覆盖项：AGENT_TRACE_DEST 写文件仅手工验证过，selftest 刻意不造仓库内临时文件
