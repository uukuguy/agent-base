#!/usr/bin/env node
// ============================================================================
// conformance runner（统一设计 §5.6）
//
// 新 harness 的准入门槛。**C1–C10 全为阻断性门槛**（P3）：
//   · 任何一项不通过 → 该 harness 不予接入
//   · **未实现的用例不算通过**（记 pending 并让 runner 非零退出）——
//     悄悄跳过会让"conformance 全绿"变成一句空话，而被软化的往往正是 C5/C8
//
// 用法：
//   node conformance/run.mjs [--json] [--only C5,C7]
//
// 退出码：0 全过 / 1 有未通过或未实现 / 2 用法错误。
// 说明：conformance 是**开发适配器时**跑的工具，不属 §6.7 那套"智能体验证"的退出码语义。
// ============================================================================

import cases from "./cases/index.mjs";

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  process.stderr.write("用法: node conformance/run.mjs [--json] [--only C5,C7]\n");
  process.exit(0);
}
const json = args.includes("--json");
const onlyIdx = args.indexOf("--only");
const only = onlyIdx >= 0 ? new Set(String(args[onlyIdx + 1] ?? "").split(",").map((s) => s.trim()).filter(Boolean)) : null;

const selected = cases.filter((c) => !only || only.has(c.id));
const results = [];
for (const c of selected) {
  const started = Date.now();
  let outcome;
  try {
    outcome = await c.run();
  } catch (e) {
    outcome = { ok: false, detail: `用例抛错：${e?.message ?? e}` };
  }
  results.push({
    id: c.id,
    title: c.title,
    ok: outcome.ok === true,
    pending: outcome.pending === true,
    detail: outcome.detail ?? "",
    evidence: outcome.evidence ?? null,
    ms: Date.now() - started,
  });
}

const failed = results.filter((r) => !r.ok && !r.pending);
const pendingCases = results.filter((r) => r.pending);
const allOk = failed.length === 0 && pendingCases.length === 0;

if (json) {
  process.stdout.write(JSON.stringify({ allOk, results, failed: failed.map((r) => r.id), pending: pendingCases.map((r) => r.id) }, null, 2) + "\n");
} else {
  for (const r of results) {
    const mark = r.ok ? "✅" : r.pending ? "⏳" : "❌";
    process.stderr.write(`${mark} [${r.id}] ${r.title}\n`);
    if (r.detail) process.stderr.write(`      ${r.detail}\n`);
  }
  process.stderr.write("\n");
  if (allOk) {
    process.stderr.write(`conformance：全绿（${results.length} 项阻断性门槛全过）\n`);
  } else {
    if (failed.length) process.stderr.write(`conformance：未通过 ${failed.map((r) => r.id).join(", ")}\n`);
    if (pendingCases.length) {
      process.stderr.write(`conformance：未实现 ${pendingCases.map((r) => r.id).join(", ")} —— **未实现不算通过**，因此本次不是全绿\n`);
    }
  }
}
process.exit(allOk ? 0 : 1);
