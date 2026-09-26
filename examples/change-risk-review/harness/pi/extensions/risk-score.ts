// ============================================================================
// 业务级增强：企业风险评分工具
//
// ## 为什么这是个"能给人抄"的扩展
//
//   · **零依赖**：不 import 任何东西。参数 schema 用**普通 JSON Schema 对象**即可
//     （运行时的加载器只要求 `parameters` 是个对象），所以不需要打包/编译，
//     也不会因为依赖解析失败而加载不上。
//   · **确定性**：同样的输入永远得同样的分数。审计要能复算，就不能有随机、不能读时钟。
//   · **规则版本显式**：分数里带 `ruleVersion`，规则改了旧分数仍能解释。
//
// ## 扩展契约（本运行时的约定）
//
//   `export default function (pi) { pi.registerTool({...}) }`
//   —— 文件由渲染器拷进产物的 `extensions/`，并在 `settings.extensions` 里登记；
//      运行时用 jiti 直接加载 TypeScript，**不需要编译步骤**。
//
// ## 一个容易踩的坑
//
//   产物 `extensions/` 目录里的**每个文件**都会被登记成扩展（只有基座发射器
//   `_trace-emit.mjs` 被按名字排除）。所以**别把"帮助函数"随手丢进这个目录** ——
//   它会被当成扩展加载。共享代码请放在扩展内部，或另找位置。
// ============================================================================

const RULE_VERSION = "2026-09-1";

/** 权重表：改这里就要改 RULE_VERSION（分数必须可解释）。 */
const WEIGHTS = {
  touchedSurfaces: 12,   // 每个受影响面
  environments: 8,       // 每多一个环境
  dataMigration: 20,     // 含数据迁移
  noRollback: 22,        // 没有回滚方案
  peakWindow: 10,        // 高峰期执行
  unowned: 12,           // 没有明确负责人
};

function score(params) {
  const touched = Array.isArray(params.touchedSurfaces) ? params.touchedSurfaces : [];
  const envs = Array.isArray(params.environments) ? params.environments : [];
  const factors = [];
  let total = 0;

  const add = (name, value) => { factors.push({ factor: name, value, weight: value }); total += value; };

  add("受影响面数量", Math.min(3, touched.length) * WEIGHTS.touchedSurfaces);
  if (envs.length > 1) add("多环境执行", (envs.length - 1) * WEIGHTS.environments);
  if (params.dataMigration === true) add("含数据迁移", WEIGHTS.dataMigration);
  if (params.rollback === "none" || params.rollback === undefined) add("无回滚方案", WEIGHTS.noRollback);
  if (params.window === "peak") add("高峰期执行", WEIGHTS.peakWindow);
  if (!params.owner) add("无明确负责人", WEIGHTS.unowned);

  const bounded = Math.max(0, Math.min(100, total));
  const level = bounded >= 60 ? "high" : bounded >= 30 ? "medium" : "low";
  return { score: bounded, level, factors, ruleVersion: RULE_VERSION };
}

/** 关键事实缺失时**拒绝算分** —— 编一个分数比不给分数更糟。 */
function missingFacts(params) {
  const missing = [];
  if (!Array.isArray(params?.touchedSurfaces) || params.touchedSurfaces.length === 0) missing.push("touchedSurfaces（这次变更动了什么）");
  if (!Array.isArray(params?.environments) || params.environments.length === 0) missing.push("environments（要在哪些环境执行）");
  if (params?.rollback === undefined) missing.push("rollback（回滚方案：none / scripted / feature-flag）");
  return missing;
}

export default function (pi) {
  pi.registerTool({
    name: "corp_risk_score",
    label: "企业风险评分",
    description:
      "用企业风险规则给一次变更打分（确定性、可复算）。"
      + "关键事实不全时会拒答并列出缺什么 —— 不要用你自己的判断补上再调用。",
    promptSnippet: "corp_risk_score：按企业规则给变更打分（确定性、可审计）",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        touchedSurfaces: {
          type: "array",
          items: { type: "string" },
          description: "这次变更影响的面（模块 / 服务 / 表），一条一句",
        },
        environments: {
          type: "array",
          items: { type: "string" },
          description: "执行环境（dev / staging / prod …）",
        },
        dataMigration: { type: "boolean", description: "是否包含数据迁移" },
        rollback: { type: "string", enum: ["none", "scripted", "feature-flag"], description: "回滚方案" },
        window: { type: "string", enum: ["off-peak", "peak"], description: "执行时间窗" },
        owner: { type: "string", description: "变更负责人" },
      },
      required: ["touchedSurfaces", "environments"],
    },
    async execute(_toolCallId, params) {
      const missing = missingFacts(params);
      if (missing.length) {
        const text = `拒答：关键事实不全 —— 缺 ${missing.join("；")}。补齐后再调用；不要猜。`;
        return { content: [{ type: "text", text }], details: { refused: true, missing }, isError: false };
      }
      const result = score(params);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  });
}
