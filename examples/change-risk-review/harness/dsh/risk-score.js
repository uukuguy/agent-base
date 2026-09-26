// ============================================================================
// dsh 的**接入件**：把共享业务代码包成 cordis 插件（业务规则不在这里）
//
// 与 pi 侧的对照：
//   · pi ：`pi.registerTool({...})`，参数用 JSON Schema
//   · 这里：cordis 插件（`export { apply, inject, name }`）+ `ctx.tools.register(...)`，
//           参数要转成该运行时的参数 DSL，还要给 `output.schema` / `output.render`
// 业务逻辑两边都是 `../business/risk-score.mjs` —— **同一份文件**。
//
// ## 为什么这里一个包都不 import
//
// 最初写的是 `import { defineTool } from "@deepseek-ai/dsh-tools"` —— 运行期直接
// **failed to import**：接入件位于产物里（不在该运行时的 node_modules 之下），裸导入解析不到。
// 两条路：① 让基座在暂存时把它接进运行时的 node_modules（产物就不自足了）
//         ② 接入件不依赖该包，按注册接口**要求的最少形状**写（就是本文件）
// 选了 ②。注册接口只要求 `name` / `parameters` / `output.render`（函数），
// 参数校验由业务层自己负责（缺关键事实就拒答，见共享模块的 `missingFacts`）。
// 代价是自己保证形状正确 —— 所以下面每段都注明它对应哪条要求。
// ============================================================================

import { TOOL, run } from "../business/risk-score.mjs";

/** cordis 用它做身份标识（与 enhancements.yaml 里的 id 不必相同）。 */
const name = "corp-risk-score";
/** 需要的能力 seam：只用到工具注册。 */
const inject = ["tools"];

/** JSON Schema 的 required 列表 → 该运行时的 `required: true` 标记（两边参数 DSL 不同）。 */
function toDshParameters(schema) {
  const required = new Set(schema.required ?? []);
  const out = {};
  for (const [key, spec] of Object.entries(schema.properties ?? {})) {
    const { description, items, enum: choices, ...rest } = spec;
    out[key] = {
      ...rest,
      ...(required.has(key) ? { required: true } : {}),
      ...(description ? { description } : {}),
      ...(choices ? { enum: choices } : {}),
      ...(items ? { items: { type: items.type } } : {}),
    };
  }
  return out;
}

function apply(ctx) {
  ctx.tools.register({
    name: TOOL.name,
    description: TOOL.description,
    parameters: toDshParameters(TOOL.parameters),
    // 注册接口要求 output 是对象、且 output.render 是函数（缺了会抛 TypeError）。
    // 形状照该运行时自带的工具插件写：render 返回 [{ type: "text", text }]。
    output: {
      schema: { type: "object", additionalProperties: true },
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
    },
    async execute(params) {
      // 返回值即工具结果：给模型看的文本 + 结构化细节（schema 允许附加字段）
      const r = run(params);
      return { text: r.text, ...r.details };
    },
  });
}

export { apply, inject, name };
