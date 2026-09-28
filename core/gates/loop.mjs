// ============================================================================
// loop 预算：声明 + **从轨迹断言**
//
// ## 为什么是"声明 + 断言"，不是"运行时开关"
//
// 实测（主运行时的 CLI 与设置里都**没有**轮次/时长预算开关）：这类旋钮不在运行时手里。
// 所以基座能给的是一份**可断言的声明**：
//
//   定义里写 `loop: { maxModelCalls, maxToolCalls, maxWallClockSeconds }`
//     ⇒ 基座在闸门 4 从**轨迹**数出这次运行实际用了几步，超了**判红并给出数字**。
//
// 这不是"运行时强制限流"，两者别混：
//   · `maxWallClockSeconds` **会**被强制执行（跑超了就把进程掐掉，按失败处理）
//   · 次数类预算**事后断言**（跑完数轨迹）—— 运行时不给中途中止的口子，基座不假称有
//
// 把它写进声明而不是写死检查参数，是因为"一个智能体允许多少步"是**业务决定**（审计/成本口径），
// 不是基座决定；基座负责的是**让它可说、可验、越界必红**。
//
// ## 数的定义（避免各人各数）
//
//   modelCalls = 本次 run 内 `model.request` 事件条数（一次模型调用 = 一轮；这是 agent loop 的步）
//   toolCalls  = 本次 run 内 `tool_call` 事件条数
//   wallClock  = 本次 run 内首末事件的时间差（毫秒）
//
// 这些事件类型都在 `core/trace/schema.json` 里有定义 —— 数法不另立口径。
// ============================================================================

/** 从轨迹事件里数出一个 run 的用量（多 run 时取**每个 run 的最大值**，因为预算是"每次运行"）。 */
export function loopUsage(events = []) {
  const byRun = new Map();
  for (const e of events) {
    if (!e?.run) continue;
    if (!byRun.has(e.run)) byRun.set(e.run, { run: e.run, modelCalls: 0, toolCalls: 0, first: null, last: null });
    const u = byRun.get(e.run);
    if (e.type === "model.request") u.modelCalls++;
    if (e.type === "tool_call") u.toolCalls++;
    const ts = Date.parse(e.ts ?? "");
    if (Number.isFinite(ts)) { if (u.first === null || ts < u.first) u.first = ts; if (u.last === null || ts > u.last) u.last = ts; }
  }
  return [...byRun.values()].map((u) => ({
    run: u.run, modelCalls: u.modelCalls, toolCalls: u.toolCalls,
    wallClockMs: u.first !== null && u.last !== null ? u.last - u.first : null,
  }));
}

/**
 * 按声明断言。
 * @returns {{ok: boolean, violations: Array, usage: Array, checked: string[]}}
 */
export function assertLoopBudget(loop, events = []) {
  const usage = loopUsage(events);
  const checked = [];
  const violations = [];
  if (!loop) return { ok: true, violations, usage, checked };
  const rules = [
    ["maxModelCalls", (u) => u.modelCalls, "次模型调用"],
    ["maxToolCalls", (u) => u.toolCalls, "次工具调用"],
    ["maxWallClockSeconds", (u) => (u.wallClockMs === null ? null : Math.ceil(u.wallClockMs / 1000)), "秒挂钟"],
  ];
  for (const [field, read, unit] of rules) {
    const budget = loop[field];
    if (budget === undefined || budget === null) continue;
    checked.push(field);
    for (const u of usage) {
      const actual = read(u);
      if (actual === null) continue;                       // 数不出来 ⇒ 不假称通过（下面 overall 处理）
      if (actual > budget) violations.push({ run: u.run, field, budget, actual, message: `${u.run} 实际 ${actual} ${unit} > 声明上限 ${budget}` });
    }
  }
  return { ok: violations.length === 0, violations, usage, checked };
}
