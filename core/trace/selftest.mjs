// ============================================================================
// 统一轨迹 schema 自检（包 S1 的验收证据）
//
// 自检要证明的不是「schema 是个合法 JSON」，而是 P1 决策真的被强制住了：
//   · 七类事件都能通过
//   · 每条事件都必须带 effectiveConfigDigest（§8.3：事后归因不必再问「当时生效的是什么」）
//   · 任何**未映射**的原生事件只能走 native.raw，且必须说明 reason
//   · 未声明的新形状**不可能静默混进来**（extra 字段被拒）——
//     这正是「不许丢弃、必须显式」的另一面：没有偷偷扩字段这条捷径
//
// 用法：node core/trace/selftest.mjs  （或 make trace-selftest）
// ============================================================================

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { renderUsage, usageReport } from "./usage.mjs";
import { EXIT_CODES } from "../gates/index.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_FILE = path.join(HERE, "schema.json");

let failures = 0;
function check(name, cond, extra = "") {
  const ok = !!cond;
  if (!ok) failures++;
  console.log(`${ok ? "✅" : "❌"} ${name}${ok || !extra ? "" : `\n      ${extra}`}`);
}

const ajv = new Ajv2020({ allErrors: true, strict: false });
const validate = ajv.compile(JSON.parse(fs.readFileSync(SCHEMA_FILE, "utf8")));

const A = "a".repeat(64);
const B = "b".repeat(64);
const base = {
  ts: "2026-09-25T10:00:00Z",
  seq: 12,
  run: "3f9a1c2e-0000-4000-8000-000000000001",
  effectiveConfigDigest: `sha256:${A}`,
  agent: "contract-review",
  harness: "test-harness",
  harnessVersion: "0.0.0-test",
};

console.log("── 七类事件必须通过 ──");
const validEvents = {
  "run.meta": { ...base, type: "run.meta", mode: "debug" },
  "model.request": { ...base, type: "model.request", provider: "corp-gateway", model: "corp-think", tools: 10, stream: true },
  "model.error": { ...base, type: "model.error", code: "MISSING_CREDENTIAL", provider: "corp-gateway" },
  "tool.call": { ...base, type: "tool.call", callId: "call_abc", tool: "mcp__jira__get_issue", inputDigest: `sha256:${B}`, decision: "allow" },
  "tool.result": { ...base, type: "tool.result", callId: "call_abc", tool: "mcp__jira__get_issue", ok: true, ms: 840 },
  "带业务扩展位的核心事件": { ...base, type: "gate", name: "probes", target: "jira", ok: true, biz: { "contract.id": "C-1024", "risk.level": 3 } },
  "biz.event（业务日志）": { ...base, type: "biz.event", namespace: "contract.amount", level: "warn", message: "金额超阈值，转法务复核", data: { amount: 1200000 } },
  "gate": { ...base, type: "gate", name: "probes", target: "jira", ok: true },
  "native.raw": { ...base, type: "native.raw", nativeType: "brand.new.event", reason: "统一 schema 尚无对应形状", raw: { whatever: [1, 2, 3] } },
};
for (const [name, ev] of Object.entries(validEvents)) {
  const ok = validate(ev);
  check(`${name} 通过`, ok, ok ? "" : ajv.errorsText(validate.errors));
}

console.log("\n── 必须被拒的写法 ──");
const invalidCases = {
  "缺 effectiveConfigDigest": { ts: base.ts, seq: 1, run: base.run, type: "run.meta", mode: "debug" },
  "本地时区时间戳（+08:00）": { ...base, ts: "2026-09-25T18:00:00+08:00", type: "run.meta", mode: "debug" },
  "摘要格式非法": { ...base, effectiveConfigDigest: "sha256:zzz", type: "run.meta", mode: "debug" },
  "未声明字段混入": { ...base, type: "run.meta", mode: "debug", brandNewField: 1 },
  "未知事件类型（未映射又想蒙过）": { ...base, type: "something.new", detail: "…" },
  "native.raw 缺 reason": { ...base, type: "native.raw", nativeType: "x", raw: {} },
  "native.raw 缺 raw": { ...base, type: "native.raw", nativeType: "x", reason: "…" },
  "model.request 缺 tools（tools 计数是闸门 3 的核心断言对象）": { ...base, type: "model.request", provider: "r", model: "m", stream: true },
  "model.request tools 为负": { ...base, type: "model.request", provider: "r", model: "m", tools: -1, stream: false },
  "tool.call 的 decision 取值非法": { ...base, type: "tool.call", tool: "t", inputDigest: `sha256:${B}`, decision: "maybe" },
  "gate 的 name 不是四道闸门之一": { ...base, type: "gate", name: "lint", target: "x", ok: true },
  "run.meta 的 mode 非法": { ...base, type: "run.meta", mode: "production" },
  "biz 键没有命名空间（大写）": { ...base, type: "run.meta", mode: "debug", biz: { ContractId: "x" } },
  "biz 值不是标量（嵌套对象）": { ...base, type: "run.meta", mode: "debug", biz: { "contract.id": { nested: 1 } } },
  "biz.event 缺 level": { ...base, type: "biz.event", namespace: "contract", message: "x" },
  "biz.event 的 level 非法": { ...base, type: "biz.event", namespace: "contract", level: "verbose", message: "x" },
  "biz.event 缺 message": { ...base, type: "biz.event", namespace: "contract", level: "info" },
  "biz.event 的 namespace 含大写": { ...base, type: "biz.event", namespace: "Contract", level: "info", message: "x" },
  "tool.call 缺 callId（画不出调用配对）": { ...base, type: "tool.call", tool: "t", inputDigest: `sha256:${B}`, decision: "allow" },
  "contentMode 取值非法": { ...base, type: "run.meta", mode: "debug", contentMode: "verbose" },
};
for (const [name, ev] of Object.entries(invalidCases)) {
  const rejected = !validate(ev);
  check(`${name} → 拒绝`, rejected, rejected ? "" : "竟然通过了");
}

// ---------------------------------------------------------------------------
// 用量归因（E8）：有 token 就汇总，没有就**如实说没有**（不编造成本数字）
// ---------------------------------------------------------------------------
console.log("\n── 用量归因 ──");
{
  const base = { effectiveConfigDigest: `sha256:${"a".repeat(64)}`, agent: "demo", harness: "x", ts: "2026-09-28T00:00:00Z" };
  const withUsage = [
    { ...base, run: "r1", seq: 0, type: "run.meta" },
    { ...base, run: "r1", seq: 1, type: "model.request", usage: { input: 100, output: 20 } },
    { ...base, run: "r1", seq: 2, type: "tool.call", tool: "read" },
    { ...base, run: "r1", seq: 3, type: "hook.error", enhancement: "h", message: "m", policy: "record" },
    { ...base, run: "r2", seq: 0, type: "model.request", usage: { input: 10, output: 5, total: 15 } },
  ];
  const rep = usageReport(withUsage);
  check("按 run 分组", rep.runs.length === 2 && rep.totals.runs === 2, JSON.stringify(rep.totals));
  // r1 只给 input/output ⇒ total 按 100+20=120 补；r2 显式给 total=15 ⇒ 合计 120+15=135
  check("有 usage 就汇总 token（缺 total 时按 input+output 补，显式给了就用它）",
    rep.totals.tokens?.input === 110 && rep.totals.tokens?.output === 25 && rep.totals.tokens?.total === 135,
    JSON.stringify(rep.totals.tokens));
  check("次数与事件也归因", rep.totals.toolCalls === 1 && rep.totals.hookErrors === 1);
  check("有用量时说明写的是可归因 token", /可归因 token/.test(rep.note), rep.note);

  const noUsage = usageReport([
    { ...base, run: "r3", seq: 0, type: "model.request" },
    { ...base, run: "r3", seq: 1, type: "model.request" },
  ]);
  check("**没有 usage ⇒ tokens 为 null**（不编造）", noUsage.totals.tokens === null && noUsage.hasUsage === false, JSON.stringify(noUsage.totals));
  check("没有用量时如实说明（点出「只能按次数与时长」）", /只能\*\*按次数与时长\*\*归因|只能按\*\*次数与时长\*\*归因/.test(noUsage.note), noUsage.note);
  check("给人看的报告里写明「归因到人做不到」", /归因到「人」/.test(renderUsage(noUsage)) && /做不到/.test(renderUsage(noUsage)));
  check("空轨迹不炸", usageReport([]).runs.length === 0 && /没有任何 run/.test(renderUsage(usageReport([]))));
}

console.log(`\n${failures === 0 ? "统一轨迹 schema 自检：全绿" : `统一轨迹 schema 自检：失败 ${failures} 项`}`);
process.exit(failures === 0 ? EXIT_CODES.ok : 1);
