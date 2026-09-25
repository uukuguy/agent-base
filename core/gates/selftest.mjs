// ============================================================================
// 闸门框架自检（包 S1 的验收证据）
//
// 自检的对象不是某个智能体，而是**框架本身**。它必须证明的不只是「能跑」，
// 而是那些容易被做软的性质：
//   · 集合断言「多一个也不行」（§6.3 硬断言 1 —— 隐式加载源没隔离干净就是这么暴露的）
//   · 注入场景**静默通过即判失败**（C5/C8 的灵魂：不许只打警告）
//   · context 路径缺失是失败，不按 undefined 蒙过去
//   · 崩溃（50）与闸门判定失败（10/20/30/40）是两件事
//   · usable 严格等于「四道闸门全过」（§6.8），跑一个闸门不能宣称可用
//
// 用法：node core/gates/selftest.mjs  （或 make gates-selftest）
// ============================================================================

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  EXIT_CODES,
  GATE_IDS,
  GateReport,
  digestCanonical,
  digestDirectory,
  evaluateAssertion,
  isLoudFailure,
  resolvePath,
  runGates,
} from "./index.mjs";

let failures = 0;
function check(name, cond, extra = "") {
  const ok = !!cond;
  if (!ok) failures++;
  console.log(`${ok ? "✅" : "❌"} ${name}${ok || !extra ? "" : `\n      ${extra}`}`);
}

const REQUIRED_REPORT_KEYS = [
  "agent", "harness", "harnessVersion", "definitionDigest", "artifactsDigest",
  "paramNames", "effectiveConfigDigest", "gates", "usable",
];

// ---------------------------------------------------------------------------
console.log("── 断言语言 ──");
{
  const ctx = {
    definition: { skills: ["example"], connectors: ["jira"] },
    doctor: { skills: ["example", "leaked-from-home"], connectors: ["jira"] },
  };
  check("set-equals 抓到「多出来的技能」",
    evaluateAssertion({ id: "s", assert: "set-equals", actual: "doctor.skills", expectedPath: "definition.skills" }, ctx).ok === false);
  check("set-equals 抓到「少掉的连接器」",
    evaluateAssertion({ id: "s", assert: "set-equals", actual: "doctor.connectors", expected: ["jira", "gitlab"] }, ctx).ok === false);
  check("set-equals 集合相等时通过",
    evaluateAssertion({ id: "s", assert: "set-equals", actual: "definition.skills", expected: ["example"] }, ctx).ok === true);
  check("context 路径缺失 = 失败（不按 undefined 蒙过）",
    evaluateAssertion({ id: "s", assert: "truthy", actual: "doctor.enhancements" }, ctx).ok === false);
  check("at-least 1 表达 tools=N>0",
    evaluateAssertion({ id: "s", assert: "at-least", actual: "doctor.skills.length", expected: 1 }, { doctor: { skills: { length: 2 } } }).ok === true);
  check("未知断言种类 = 失败",
    evaluateAssertion({ id: "s", assert: "looks-fine", actual: "definition.skills" }, ctx).ok === false);
}

// ---------------------------------------------------------------------------
console.log("\n── 「静默通过即判失败」（C5/C8 的灵魂）──");
{
  const silent = evaluateAssertion({ id: "neg", assert: "fails", actual: "inject.exitCode" }, { inject: { exitCode: 0 } });
  check("注入后 exit 0 → 断言失败（静默通过被抓到）", silent.ok === false);
  check("注入后 exit 0 → 失败信息点明「静默通过」", /静默通过/.test(silent.detail), silent.detail);
  check("注入后 exit 3 → 通过", evaluateAssertion({ id: "neg", assert: "fails", actual: "inject.exitCode" }, { inject: { exitCode: 3 } }).ok === true);
  check("注入后 ok:false → 通过", isLoudFailure({ ok: false }) === true);
  check("注入后 ok:true → 不算失败", isLoudFailure({ ok: true }) === false);
  check("什么都没观察到 → 不算失败", isLoudFailure({}) === false);
}

// ---------------------------------------------------------------------------
console.log("\n── 编排：顺序、短路、退出码 ──");
{
  const ctx = {};
  const report = new GateReport({ agent: "selftest", harness: "test-harness", harnessVersion: "0.0.0-test" });
  const { results } = await runGates({
    ctx,
    report,
    gates: [
      { id: "static", handler: (c) => { c.static = { ok: true }; } },
      {
        id: "resolution",
        handler: (c) => { c.doctor = { skills: ["example", "leaked"] }; c.definition = { skills: ["example"] }; },
        assertions: [
          { id: "doctor-skills-set", assert: "set-equals", actual: "doctor.skills", expectedPath: "definition.skills" },
        ],
      },
      { id: "probes", handler: () => {}, assertions: [{ id: "never-reached", assert: "truthy", actual: "static.ok" }] },
    ],
  });

  check("闸门 2 失败后短路，闸门 3 未跑", results.map((r) => r.id).join(",") === "static,resolution",
    `实际跑了：${results.map((r) => r.id).join(",")}`);
  check("退出码 = 首个失败闸门的码（20）", report.exitCode === EXIT_CODES.resolution, `实际 ${report.exitCode}`);
  check("ok=false 但 crashed=false（判定失败 ≠ 崩溃）", report.ok === false && report.crashed === false);
  check("usable=false（没跑满四道）", report.usable === false);

  const keys = Object.keys(report.toJSON());
  check("报告含 §6.7 全部字段", REQUIRED_REPORT_KEYS.every((k) => keys.includes(k)),
    `缺：${REQUIRED_REPORT_KEYS.filter((k) => !keys.includes(k)).join(", ")}`);
  check("报告里 gates[].ok 与 checks 一致",
    report.toJSON().gates.every((g) => g.ok === g.checks.every((c) => c.status === "pass")));
}

// ---------------------------------------------------------------------------
console.log("\n── 崩溃（50）与闸门判定失败（20）必须可分 ──");
{
  const report = new GateReport({ harness: "test-harness", harnessVersion: "0.0.0-test" });
  await runGates({
    report,
    ctx: {},
    gates: [{ id: "resolution", handler: () => { throw new Error("模拟 harness 输出无法解析"); } }],
  });
  check("handler 抛异常 → crashed=true", report.crashed === true);
  check("handler 抛异常 → 退出码 50（不是 20）", report.exitCode === EXIT_CODES.crash, `实际 ${report.exitCode}`);
  check("崩溃也留在报告里（可归因）", report.failures.some((f) => f.id === "crash/resolution"));
}

// ---------------------------------------------------------------------------
console.log("\n── usable 严格等于「四道闸门全过」（§6.8）──");
{
  const report = new GateReport({ agent: "selftest", harness: "test-harness", harnessVersion: "0.0.0-test" });
  await runGates({
    report,
    ctx: { allGood: { ok: true } },
    gates: GATE_IDS.map((id) => ({ id, assertions: [{ id: "g", assert: "truthy", actual: "allGood.ok" }] })),
  });
  check("四道全绿 → usable=true", report.usable === true, JSON.stringify(report.toJSON().gates.map((g) => [g.id, g.ok])));
  check("四道全绿 → 退出码 0", report.exitCode === EXIT_CODES.ok);

  const onlyStatic = new GateReport();
  await runGates({ report: onlyStatic, ctx: { x: true }, gates: [{ id: "static", assertions: [{ id: "c", assert: "truthy", actual: "x" }] }] });
  check("只跑闸门 1 全绿 → ok=true 但 usable=false", onlyStatic.ok === true && onlyStatic.usable === false);
}

// ---------------------------------------------------------------------------
console.log("\n── 摘要确定性（N19）──");
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-base-digest-"));
  fs.mkdirSync(path.join(dir, "skills", "a"), { recursive: true });
  fs.writeFileSync(path.join(dir, "agent.yaml"), "name: x\n");
  fs.writeFileSync(path.join(dir, "skills", "a", "SKILL.md"), "---\nname: a\n---\n");
  const d1 = digestDirectory(dir);
  const d2 = digestDirectory(dir);
  check("同目录两次摘要一致", d1 === d2, `${d1} vs ${d2}`);
  fs.writeFileSync(path.join(dir, "skills", "a", "SKILL.md"), "---\nname: a\n---\nchanged\n");
  check("内容变化后摘要改变", digestDirectory(dir) !== d1);
  check("键序不影响规范化摘要", digestCanonical({ a: 1, b: 2 }) === digestCanonical({ b: 2, a: 1 }));
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
console.log(`\n${failures === 0 ? "闸门框架自检：全绿" : `闸门框架自检：失败 ${failures} 项`}`);
process.exit(failures === 0 ? EXIT_CODES.ok : 1);
