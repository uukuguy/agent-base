// ============================================================================
// 用量归因（E8）：从轨迹算出**每个 run 的用量**，并把"拿不到的东西"如实标出来
//
// ## 实测边界（决定了本文件能承诺什么）
//
// 量过（两侧）：
//   · 统一轨迹里**没有** token 用量字段 —— 12 类事件里没有一格装它
//   · 主运行时的 `after_provider_response` 钩子只给 `{ type, status, headers }`，
//     **不暴露 usage**；端点的响应体里也没有可用的用量（假网关不返回，真端点要运行时愿意透出）
//
// 所以本文件**不编造 token/成本**。能归因的是**次数与时长**（一次运行让模型答了几次、用了几次工具、
// 跑了多久），这些都能从轨迹数出来、也都能回答"这次运行贵在哪里"这个实际问题。
//
// ## 为什么仍然预留 `usage`
//
// 轨迹 schema 的 `model.request` 有一个**可选** `usage` 字段。理由：等某个运行时愿意透出用量时，
// 归因代码不必改（有就汇总、没有就说没有）。预留字段本身不承诺任何东西 —— 承诺的是"不编造"。
//
// ## 归因到"谁"
//
// 轨迹能给出 **agent / harness / run / 生效配置摘要**；**给不出"人"** ——
// 那需要一个身份入口（会话头/平台变量），本基座目前没有。这条如实列在报告里，不假装能归因到人。
// ============================================================================

/**
 * 汇总一次或多次运行的用量。
 * @param {Array} events 轨迹事件（可含多个 run）
 * @returns {{runs: Array, totals: object, hasUsage: boolean, note: string}}
 */
export function usageReport(events = []) {
  const byRun = new Map();
  for (const e of events) {
    if (!e?.run) continue;
    if (!byRun.has(e.run)) {
      byRun.set(e.run, {
        run: e.run, agent: e.agent ?? null, harness: e.harness ?? null,
        effectiveConfigDigest: e.effectiveConfigDigest ?? null,
        modelCalls: 0, toolCalls: 0, first: null, last: null,
        tokens: { input: 0, output: 0, total: 0, seen: false },
        hookErrors: 0, approvals: 0, ended: false, endReason: null,
      });
    }
    const u = byRun.get(e.run);
    if (e.type === "run.end") { u.ended = true; u.endReason = String(e.reason ?? ""); }
    if (e.type === "model.request") {
      u.modelCalls++;
      // 有就用、没有就不算 —— 绝不拿"次数 × 猜测的每 token 单价"造一个看起来像成本的数
      const usage = e.usage;
      if (usage && (typeof usage.input === "number" || typeof usage.output === "number" || typeof usage.total === "number")) {
        u.tokens.seen = true;
        u.tokens.input += Number(usage.input ?? 0);
        u.tokens.output += Number(usage.output ?? 0);
        u.tokens.total += Number(usage.total ?? (Number(usage.input ?? 0) + Number(usage.output ?? 0)));
      }
    }
    if (e.type === "tool.call") u.toolCalls++;
    if (e.type === "hook.error") u.hookErrors++;
    if (e.type === "approval.decision") u.approvals++;
    const ts = Date.parse(e.ts ?? "");
    if (Number.isFinite(ts)) { if (u.first === null || ts < u.first) u.first = ts; if (u.last === null || ts > u.last) u.last = ts; }
  }
  const runs = [...byRun.values()].map((u) => ({
    run: u.run, agent: u.agent, harness: u.harness, effectiveConfigDigest: u.effectiveConfigDigest,
    modelCalls: u.modelCalls, toolCalls: u.toolCalls, hookErrors: u.hookErrors, approvals: u.approvals,
    wallClockMs: u.first !== null && u.last !== null ? u.last - u.first : null,
    // 结束标记：**有 ⇒ 正常收到结束信号；没有 ⇒ 看不到结束信号**（可能被掐断，也可能是该运行时不给）——
    // 两种情况都不由本报告判成败，但它必须被说清楚（否则截断的轨迹会被当成完整记录）。
    ended: u.ended, endReason: u.endReason,
    tokens: u.tokens.seen ? { input: u.tokens.input, output: u.tokens.output, total: u.tokens.total } : null,
  }));
  const hasUsage = runs.some((r) => r.tokens);
  const totals = {
    runs: runs.length,
    modelCalls: runs.reduce((n, r) => n + r.modelCalls, 0),
    toolCalls: runs.reduce((n, r) => n + r.toolCalls, 0),
    hookErrors: runs.reduce((n, r) => n + r.hookErrors, 0),
    wallClockMs: runs.reduce((n, r) => n + (r.wallClockMs ?? 0), 0),
    tokens: hasUsage
      ? { input: runs.reduce((n, r) => n + (r.tokens?.input ?? 0), 0), output: runs.reduce((n, r) => n + (r.tokens?.output ?? 0), 0), total: runs.reduce((n, r) => n + (r.tokens?.total ?? 0), 0) }
      : null,
  };
  return {
    runs, totals, hasUsage,
    note: hasUsage
      ? "轨迹里带 token 用量（该运行时愿意透出）⇒ 可归因 token"
      : "轨迹里**没有** token 用量（实测：响应钩子只给 status/headers）⇒ 只能按**次数与时长**归因，不编造成本数字",
  };
}

/** 给人看的报告。 */
export function renderUsage(report, { label = null } = {}) {
  const lines = [];
  lines.push(`${label ? `${label} · ` : ""}用量归因（按 run）`);
  lines.push("");
  if (!report.runs.length) return lines.concat("（轨迹里没有任何 run —— 检查轨迹文件是否为空）").join("\n");
  for (const r of report.runs) {
    lines.push(`· ${r.run}`);
    lines.push(`    身份      agent=${r.agent ?? "?"} harness=${r.harness ?? "?"} 摘要=${(r.effectiveConfigDigest ?? "?").slice(0, 19)}…`);
    lines.push(`    用量      模型调用 ${r.modelCalls} · 工具调用 ${r.toolCalls} · 挂钟 ${r.wallClockMs === null ? "数不出" : `${Math.round(r.wallClockMs / 1000)}s`}`
      + (r.tokens ? ` · tokens 输入 ${r.tokens.input}/输出 ${r.tokens.output}/合计 ${r.tokens.total}` : " · tokens **不可得**"));
    if (r.hookErrors || r.approvals) lines.push(`    事件      钩子失败 ${r.hookErrors} · 审批 ${r.approvals}`);
    // 结束标记：缺它时这份轨迹分不出「正常跑完」与「中途被掐断」—— 必须写出来，但不据此判成败
    lines.push(`    结束      ${r.ended ? `收到结束标记（reason=${r.endReason}）` : "看不到结束标记（可能被掐断，也可能该运行时不提供）"}`);
  }
  lines.push("");
  lines.push(`合计        ${report.totals.runs} 个 run · 模型调用 ${report.totals.modelCalls} · 工具调用 ${report.totals.toolCalls} · 钩子失败 ${report.totals.hookErrors}`);
  lines.push(`说明        ${report.note}`);
  lines.push("归因到「人」  目前**做不到**：轨迹能给出 agent/harness/run/生效配置摘要，但没有身份入口（会话头/平台变量）—— 要归因到人需先有这一个入口。");
  return lines.join("\n");
}
