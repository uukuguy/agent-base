// ============================================================================
// 能力的**通用桥**（本运行时侧）—— D-0013 的落地
//
// 与另一个运行时的同名桥是**同一件事、两种注册形状**：
//   · 那边：`pi.registerTool({...})`，参数用 JSON Schema 对象
//   · 这里：cordis 插件（`apply` + `inject: ["tools"]`）+ `ctx.tools.register(...)`
// 两边都：读产物里的能力清单 → 逐个注册 → 调用交给 `_capabilities.mjs`
// （两条通道与协议在那里，**单一真源**）。
//
// ## 两条硬约束
//
//   ① 本文件**不许出现任何具体能力的名字**（出现一个它就不是桥了）。
//      自检 `dsh-capabilities-selftest` 会拿真产物逐条比对。
//   ② **不许裸导入**：产物里的模块解析不到 `node_modules` 之外的包（本仓库踩过），
//      所以清单用构建期生成的 JSON，本文件只 import 内置模块与注入的 `_capabilities.mjs`。
// ============================================================================

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { invokeCapability } from "./_capabilities.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
/**
 * 产物根：插件位于 `<产物>/<DSH_HOME>/profiles/<智能体>/plugins/<插件>/`
 * ⇒ 从这里上**五**层才回到产物根（数错一层就会读不到清单，而"读不到"我设计成返回空，
 * 于是能力会**静默消失** —— 这条路径必须有自检盯着，不能只靠肉眼数）。
 */
const PRODUCT = path.resolve(HERE, "../../../../..");
const INDEX = path.join(PRODUCT, "capabilities", "index.json");

export const name = "agent-base-capabilities";
export const inject = ["tools"];

export function readCapabilityIndex(indexFile = INDEX) {
  try {
    const doc = JSON.parse(fs.readFileSync(indexFile, "utf8"));
    return Array.isArray(doc?.capabilities) ? doc.capabilities : [];
  } catch {
    return [];
  }
}

export function toCapability(entry, capsDir) {
  return {
    name: entry.name,
    label: entry.label,
    description: entry.description,
    promptSnippet: entry.promptSnippet,
    parameters: entry.parameters,
    result: entry.result,
    declaration: entry.declaration,
    execution: entry.execution,
    __file: path.join(capsDir, `${entry.name}.yaml`),   // 只用于算实现文件的基准目录
  };
}

/**
 * JSON Schema 的 `required` 列表 → 本运行时的参数 DSL（`required: true` 标记）。
 * 两边参数形状不同，所以这段转换**必须**在各自的桥里（不能进 core）。
 */
export function toRuntimeParameters(schema = {}) {
  const required = new Set(schema.required ?? []);
  const out = {};
  for (const [key, spec] of Object.entries(schema.properties ?? {})) {
    const { items, enum: choices, ...rest } = spec;
    out[key] = {
      ...rest,
      ...(required.has(key) ? { required: true } : {}),
      ...(choices ? { enum: choices } : {}),
      ...(items ? { items: { type: items.type } } : {}),
    };
  }
  return out;
}

export function apply(ctx, deps = {}) {
  const capsDir = deps.capsDir ?? path.join(PRODUCT, "capabilities");
  const entries = deps.entries ?? readCapabilityIndex(deps.indexFile ?? INDEX);
  for (const entry of entries) {
    const cap = toCapability(entry, capsDir);
    ctx.tools.register({
      name: cap.name,
      description: cap.description,
      parameters: toRuntimeParameters(cap.parameters),
      // 注册接口要求 `output` 是对象、`output.render` 是函数（缺了会抛 TypeError），
      // `render(args, value)` 收到的是 execute 的返回值。形状**照该运行时自带的工具插件**写
      // （实测结论来自本示例早先的手写接入件，见 git 历史）。
      //
      // `schema` 用宽松形状而不是描述里的 `result`：描述里的 schema 是**我们自己的闸门**用来断言
      // "返回形状没变"的判据；运行期的渲染 schema 若与它耦合，业务改一次结果就得同时动两处。
      output: {
        schema: { type: "object", additionalProperties: true },
        render: (_args, value) => [{ type: "text", text: typeof value?.text === "string" ? value.text : String(value ?? "") }],
      },
      async execute(params) {
        const r = await invokeCapability(cap, params, { cwd: capsDir });
        if (!r.ok) {
          // **响亮失败**：把原因交给模型（它才能改参数或换做法），不让它看起来像成功
          return { text: `能力 ${cap.name} 执行失败：${r.error}${r.stderr ? `\n${r.stderr}` : ""}`, ok: false, error: r.error, channel: r.channel };
        }
        // 返回值即工具结果：文本 + 结构化细节（schema 允许附加字段，与手写接入件的做法一致）
        return { text: r.text, ...(r.details && typeof r.details === "object" ? r.details : {}), ...(r.refused ? { refused: true } : {}) };
      },
    });
  }
}
