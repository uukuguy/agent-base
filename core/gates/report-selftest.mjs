#!/usr/bin/env node
import { GateReport } from "./report.mjs";
import { parseArgs } from "./cli.mjs";

const failures = [];
const check = (name, ok, detail = "") => { if (!ok) failures.push(`${name}${detail ? `：${detail}` : ""}`); };

const empty = new GateReport({ harness: "test-harness" });
empty.gates = ["static", "resolution", "probes", "smoke"].map((id) => ({ id, checks: [] }));
check("空 gate 不可用", empty.usable === false);
const unknown = parseArgs(["--harness-home", "/tmp/home"], { valueFlags: [], strict: true });
check("未知旗标被拒绝", unknown.errors.length > 0);

if (failures.length) {
  console.error(`❌ report-selftest ${failures.length} 项失败`);
  for (const failure of failures) console.error(`  · ${failure}`);
  process.exit(1);
}
console.log("✅ report-selftest 通过");
