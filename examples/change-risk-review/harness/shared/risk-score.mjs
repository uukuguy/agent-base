// ============================================================================
// 业务代码：企业风险评分规则（**可共享**）
//
// ## 为什么单独一个文件
//
// 评分规则和"怎么把工具接进某个运行时"是两件事：
//   · 规则是**业务**：权重、阈值、规则版本、拒答条件 —— 换运行时不该换规则
//   · 接入是**运行时的事**：pi 用 `pi.registerTool()`，dsh 用 cordis 插件 + `ctx.tools.register()`
//
// 所以业务代码放这里，接入件只做两件事：**把这份规则包成该运行时的工具形状**。
// 本文件因此有两条硬约束（基座的闸门 1 会检查第二条）：
//   ① **零依赖**：不 import 任何东西（尤其是运行时的包）
//   ② 不出现任何运行时的名字/API —— 否则它就不再可共享
//
// ## 确定性
//
// 同样的输入永远得同样的分数：不随机、不读时钟、不访问网络。审计要能复算。
// ============================================================================

/** 规则版本。改权重/阈值就要改它 —— 旧分数必须仍能被解释。 */
export const RULE_VERSION = "2026-09-1";

/** 工具的对外形状（描述与参数 schema 也是业务，不属于任何运行时）。 */
export const TOOL = {
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
};

/** 权重表：改这里就要改 RULE_VERSION（分数必须可解释）。 */
const WEIGHTS = {
  touchedSurfaces: 12,   // 每个受影响面
  environments: 8,       // 每多一个环境
  dataMigration: 20,     // 含数据迁移
  noRollback: 22,        // 没有回滚方案
  peakWindow: 10,        // 高峰期执行
  unowned: 12,           // 没有明确负责人
};

/** 关键事实缺失时**拒绝算分** —— 编一个分数比不给分数更糟。 */
export function missingFacts(params = {}) {
  const missing = [];
  if (!Array.isArray(params.touchedSurfaces) || params.touchedSurfaces.length === 0) missing.push("touchedSurfaces（这次变更动了什么）");
  if (!Array.isArray(params.environments) || params.environments.length === 0) missing.push("environments（要在哪些环境执行）");
  if (params.rollback === undefined) missing.push("rollback（回滚方案：none / scripted / feature-flag）");
  return missing;
}

/** 确定性评分。纯函数：同样入参永远同样出参。 */
export function score(params = {}) {
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

/**
 * 工具的统一执行语义（两个运行时的接入件都调它）。
 * 返回 `{ text, details }`：文本给模型看，details 给结构化消费方。
 */
export function run(params = {}) {
  const missing = missingFacts(params);
  if (missing.length) {
    return {
      refused: true,
      text: `拒答：关键事实不全 —— 缺 ${missing.join("；")}。补齐后再调用；不要猜。`,
      details: { refused: true, missing },
    };
  }
  const result = score(params);
  return { refused: false, text: JSON.stringify(result, null, 2), details: result };
}
