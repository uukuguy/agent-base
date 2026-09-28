// ============================================================================
// 报告格式（统一设计 §6.7）
//
// 这是 verify 的输出契约，也是**所有**闸门工具的唯一报告形状——单一真源，
// 避免出现「validate 一套形状、verify 另一套形状」的第二套语义。
//
// 两条容易搞混、必须分清的性质：
//   ok     —— 跑过的闸门是否都通过
//   usable —— §6.8 的「可用」：**四道闸门全过**。只跑了一个闸门就宣称可用，
//             正是「能启动」与「可用」的混淆，所以这里严格按四道全在才算数。
//
// stdout 只放这份 JSON；人读日志与轨迹走 stderr（§8.2）。
// ============================================================================

import { createHash } from "node:crypto";
import { EXIT_CODES, GATE_IDS, exitCodeForGate } from "./exit-codes.mjs";

const STATUS = Object.freeze({ pass: "pass", fail: "fail" });

export function sha256(text) {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

/**
 * §6.7 的 effectiveConfigDigest = H(harness 版本 + 适配器版本 + artifactsDigest + 参数名集合)。
 *
 * 参数名进 digest、参数值不进：既保证「同一制品 + 同一组参数 = 同一行为」(N19)，
 * 又不会把密钥写进日志。
 */
export function computeEffectiveConfigDigest({
  harnessVersion = null,
  adapterVersion = null,
  artifactsDigest = null,
  paramNames = [],
  extra = {},
}) {
  return sha256(
    JSON.stringify({
      harnessVersion,
      adapterVersion,
      artifactsDigest,
      paramNames: [...paramNames].sort(),
      ...extra,
    }),
  );
}

export class GateReport {
  /**
   * @param {object} meta
   * @param {string|null} meta.agent            智能体名
   * @param {string|null} meta.harness          harness 名（闸门 1 阶段可为 null：故意不暴露 harness 概念，§1.3）
   * @param {string|null} meta.harnessVersion   harness 版本
   * @param {string|null} meta.adapterVersion   适配器版本
   * @param {string|null} meta.definitionDigest 定义目录摘要
   * @param {string|null} meta.artifactsDigest  渲染产物摘要
   * @param {string[]}    meta.paramNames       参数层引用名（**只放名字，不放值**，§6.7）
   */
  constructor(meta = {}) {
    this.agent = meta.agent ?? null;
    this.harness = meta.harness ?? null;
    this.harnessVersion = meta.harnessVersion ?? null;
    this.adapterVersion = meta.adapterVersion ?? null;
    this.definitionDigest = meta.definitionDigest ?? null;
    this.artifactsDigest = meta.artifactsDigest ?? null;
    this.paramNames = [...(meta.paramNames ?? [])].sort();
    /**
     * 是否发生过「无法判定」的崩溃（§6.7 退出码 50）。
     * 与「闸门判定失败」必须区分：前者是我们没拿到可判定的结果。
     */
    this.crashed = false;
    /** @type {Array<{id:string, checks:Array<{id:string,status:string,detail:string}>}>} */
    this.gates = [];
  }

  /** 取（或建）一个闸门的检查列表。 */
  gate(gateId) {
    if (!GATE_IDS.includes(gateId)) throw new Error(`未知闸门 id：${gateId}`);
    let g = this.gates.find((x) => x.id === gateId);
    if (!g) {
      g = { id: gateId, checks: [] };
      this.gates.push(g);
    }
    return g;
  }

  record(gateId, check) {
    const entry = { id: check.id, status: check.status, detail: check.detail ?? "" };
    if (check.extra !== undefined) entry.extra = check.extra;
    this.gate(gateId).checks.push(entry);
  }

  pass(gateId, checkId, detail = "") {
    this.record(gateId, { id: checkId, status: STATUS.pass, detail });
  }

  fail(gateId, checkId, detail = "", extra = undefined) {
    this.record(gateId, { id: checkId, status: STATUS.fail, detail, extra });
  }

  /** 跑过的闸门里所有失败项。 */
  get failures() {
    return this.gates.flatMap((g) =>
      g.checks.filter((c) => c.status === STATUS.fail).map((c) => ({ gate: g.id, ...c })),
    );
  }

  /** 全部检查项（带所属闸门）。 */
  get checks() {
    return this.gates.flatMap((g) => g.checks.map((c) => ({ gate: g.id, ...c })));
  }

  /** 跑过的闸门是否全部通过。空报告（没跑任何闸门）不算通过。 */
  get ok() {
    if (!this.gates.length) return false;
    return this.gates.every((g) => g.checks.every((c) => c.status === STATUS.pass));
  }

  /** §6.8：可用 = 四道闸门全过。缺任何一道都只能说 ok，不能说 usable。 */
  get usable() {
    const ran = new Set(this.gates.map((g) => g.id));
    return GATE_IDS.every((id) => ran.has(id)) && this.ok;
  }

  get firstFailedGate() {
    const g = this.gates.find((x) => x.checks.some((c) => c.status === STATUS.fail));
    return g?.id ?? null;
  }

  get exitCode() {
    // 崩溃优先：没拿到可判定的结果时，报「某个闸门判定失败」是误导
    if (this.crashed) return EXIT_CODES.crash;
    const g = this.firstFailedGate;
    return g ? exitCodeForGate(g) : EXIT_CODES.ok;
  }

  /** §6.7 的 effectiveConfigDigest（由实例元信息算出）。 */
  get effectiveConfigDigest() {
    if (!this.harnessVersion && !this.artifactsDigest) return null;
    return computeEffectiveConfigDigest({
      harnessVersion: this.harnessVersion,
      adapterVersion: this.adapterVersion,
      artifactsDigest: this.artifactsDigest,
      paramNames: this.paramNames,
    });
  }

  /** §6.7 的输出契约。 */
  toJSON() {
    return {
      agent: this.agent,
      harness: this.harness,
      harnessVersion: this.harnessVersion,
      adapterVersion: this.adapterVersion,
      definitionDigest: this.definitionDigest,
      artifactsDigest: this.artifactsDigest,
      paramNames: this.paramNames,
      effectiveConfigDigest: this.effectiveConfigDigest,
      gates: this.gates.map((g) => ({
        id: g.id,
        ok: g.checks.every((c) => c.status === STATUS.pass),
        checks: g.checks,
      })),
      usable: this.usable,
      // 环境结论（§28 Q1/Q3）：本地跑出来的结论**不含**容器才能验的那几类，差异必须可见。
      // 只有 `verify` 会填它；其它工具保持 null（字段只增不改，见 §6.7 的输出契约）。
      environment: this.environment ?? null,
      // 能力包组合（L4）：结论必须绑定组合（同一产物、不同组合 ⇒ 行为不同）。
      // 只有 `verify` 会填它；其它工具保持 null（同样是只增不改）。
      bundles: this.bundles ?? null,
    };
  }

  /**
   * 按 §8.2 输出：JSON 走 stdout，人读日志走 stderr。
   * @param {{json?: boolean, stdout?: {write:Function}, stderr?: {write:Function}}} [opts]
   */
  print({ json = false, stdout = process.stdout, stderr = process.stderr } = {}) {
    if (json) {
      stdout.write(JSON.stringify(this.toJSON(), null, 2) + "\n");
      return;
    }
    for (const g of this.gates) {
      stderr.write(`── 闸门 ${g.id} ──\n`);
      for (const c of g.checks) {
        stderr.write(`${c.status === STATUS.pass ? "✅" : "❌"} [${c.id}] ${c.detail}\n`);
      }
    }
    stderr.write("\n");
    const summary = this.usable
      ? "可用：四道闸门全过（§6.8）"
      : this.ok
        ? "已跑的闸门全绿，但尚未四道齐全 —— 只能说 ok，不能说「可用」（§6.8）"
        : `失败 ${this.failures.length} 项`;
    stderr.write(`${summary}\n`);
  }
}
