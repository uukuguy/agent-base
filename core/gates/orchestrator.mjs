// ============================================================================
// 闸门编排（统一设计 §6）
//
// 四道闸门按 1→2→3→4 顺序跑，**默认在第一个失败的闸门停下**。理由不是省时间，
// 而是语义：闸门 2 报的「技能少了一个」在闸门 1 失败时毫无意义（定义本身就非法），
// 继续跑只会产出噪声，掩盖真正的首个失败点。§6.7 的退出码也按「首个失败闸门」定义。
//
// 适配器只提供 render / doctor / probe / smoke（§5.1）；**编排顺序是基座的职责**，
// 不在适配器里。
// ============================================================================

import { GATE_IDS } from "./exit-codes.mjs";
import { runAssertions } from "./assertions.mjs";

/**
 * @param {object} opts
 * @param {Array<{id:string, handler?:(ctx:object, report:object)=>any, assertions?:object[], skip?:boolean}>} opts.gates
 * @param {object} opts.ctx     闸门之间传递的上下文（handler 往里写，断言从里读）
 * @param {import("./report.mjs").GateReport} opts.report
 * @param {boolean} [opts.stopOnFirstFailure=true]
 * @returns {Promise<{report:object, results:Array<{id:string, ok:boolean, thrown:Error|null}>}>}
 */
export async function runGates({ gates, ctx = {}, report, stopOnFirstFailure = true }) {
  const results = [];
  for (const spec of gates) {
    if (spec.skip) continue;
    if (!GATE_IDS.includes(spec.id)) throw new Error(`未知闸门 id：${spec.id}`);

    // 先登记该闸门已跑：即使 handler 抛异常，报告里也要留下它失败的痕迹
    report.gate(spec.id);

    let thrown = null;
    try {
      if (spec.handler) await spec.handler(ctx, report);
      if (spec.assertions) runAssertions(spec.assertions, ctx, { gate: spec.id, report });
    } catch (e) {
      thrown = e;
      // §6.7 退出码 50：harness 未预期崩溃 / 无法解析其输出。
      // 这不是「闸门 2 判定失败」，而是「我们没能得到可判定的结果」——两者必须区分。
      report.crashed = true;
      report.fail(spec.id, `crash/${spec.id}`, `闸门 ${spec.id} 抛出未预期异常：${e?.message ?? e}`);
    }

    const gate = report.gates.find((g) => g.id === spec.id);
    const ok = gate.checks.every((c) => c.status === "pass");
    results.push({ id: spec.id, ok, thrown });

    if (!ok && stopOnFirstFailure) break;
  }
  return { report, results };
}
