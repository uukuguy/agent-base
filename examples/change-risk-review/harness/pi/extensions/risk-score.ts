// ============================================================================
// pi 的**接入件**：把共享业务代码包成 pi 的工具（业务规则不在这里）
//
// 与另一个运行时的接入件相比，差别只有"怎么接"：
//   · 这里用 `pi.registerTool()`，参数用 JSON Schema 对象
//   · 那边用 cordis 插件 + `ctx.tools.register()`，参数用它的参数 DSL
// 而 `../business/risk-score.mjs` 是**同一份文件**（渲染器把它拷进产物）。
//
// 一个容易踩的坑：产物 `extensions/` 目录里的**每个文件**都会被登记成扩展
// （只有基座发射器 `_trace-emit.mjs` 被按名字排除）。所以这个目录里只放接入件，
// 业务代码放 `harness/shared/`（会被拷到产物的 `business/`）。
// ============================================================================

import { TOOL, run } from "../business/risk-score.mjs";

export default function (pi) {
  pi.registerTool({
    name: TOOL.name,
    label: TOOL.label,
    description: TOOL.description,
    promptSnippet: TOOL.promptSnippet,
    parameters: TOOL.parameters,
    async execute(_toolCallId, params) {
      const r = run(params);
      return { content: [{ type: "text", text: r.text }], details: r.details };
    },
  });
}
