// ============================================================================
// 轨迹映射自检 —— 判据是三条纪律：
//   ① 不许丢事件（映射不了走 native.raw 并带 reason）
//   ② 不许把推算值当实测值（ms 必须标 msIsEstimated）
//   ③ 不许假装知道不知道的事（tools 是 harness 侧计数、stream 是推断值）
// 外加：输出每一行都必须过 core/trace/schema.json。
// ============================================================================

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { EXIT_CODES } from "../../core/gates/index.mjs";
import { mapEventStream } from "./trace.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");

let failures = 0;
const check = (name, cond, extra = "") => {
  if (!cond) failures++;
  console.log(`${cond ? "✅" : "❌"} ${name}${cond || !extra ? "" : `\n      ${extra}`}`);
};

const D = `sha256:${"a".repeat(64)}`;
const T0 = 1766000000000; // 固定基准，保证自检可复现

// 取材自实测的原生事件形状（pi 0.87.1）
const records = [
  { type: "session", version: 3, id: "sess-1", timestamp: "2026-09-25T10:00:00.000Z", cwd: "/tmp" },
  { type: "agent_start" },
  { type: "turn_start" },
  { type: "message_start", message: { role: "system", content: "", toolsAdded: [{ name: "read" }, { name: "bash" }, { name: "edit" }, { name: "write" }], timestamp: T0 } },
  { type: "message_end", message: { role: "system", timestamp: T0 } },
  { type: "message_start", message: { role: "assistant", provider: "corp-gateway", model: "corp-think", api: "openai-completions", timestamp: T0 + 10 } },
  { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "查" }, timestamp: T0 + 20 },
  { type: "message_update", assistantMessageEvent: { type: "toolcall_start", toolName: "bash" }, timestamp: T0 + 30 },
  { type: "message_end", message: { role: "assistant", provider: "corp-gateway", model: "corp-think", stopReason: "tool_calls", timestamp: T0 + 40 } },
  { type: "tool_execution_start", toolCallId: "call_1", toolName: "bash", args: { command: "ls" } },
  { type: "tool_execution_end", toolCallId: "call_1", toolName: "bash", result: { content: [{ type: "text", text: "a.txt" }] }, isError: false },
  { type: "thinking_level_changed", level: "off" },
  { type: "compaction_end", reason: "threshold", result: { summary: "…" }, aborted: false },
  { type: "auto_retry_start", attempt: 1, maxAttempts: 3, errorMessage: "529 overloaded" },
  { type: "turn_end" },
  { type: "agent_end" },
];
// 到达时刻（现场流水线能提供）：call_1 用了 840ms
const arrivals = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 849, 850, 851, 852, 853, 854].map((x) => T0 + x);

const ctx = { run: "run-selftest", agent: "contract-review", harness: "test-harness", harnessVersion: "0.0.0-test", effectiveConfigDigest: D, definitionDigest: D, mode: "oneshot", contentMode: "full" };
const { events, stats } = mapEventStream(records, ctx, { arrivals });

console.log("── 映射结果 ──");
for (const e of events) console.log(`   ${String(e.seq).padStart(3)} ${e.type.padEnd(15)} ${JSON.stringify(e).slice(0, 130)}`);

// ---------------------------------------------------------------------------
console.log("\n── 纪律 ①：不许丢事件 ──");
check("输入条数 == 输出条数（一条都不丢）", stats.input === events.length, `输入 ${stats.input} 输出 ${events.length}`);
check("dropped = 0", stats.dropped === 0, String(stats.dropped));
{
  const raws = events.filter((e) => e.type === "native.raw");
  const bad = raws.filter((e) => !(e.reason && e.reason.length > 5));
  // 阈值 6 不是随手取的：它挡住"同上""见上"这类**不自解释**的 reason ——
  // 轨迹文件的读者没有上下文，reason 必须自己说明白。
  check("每条 native.raw 的 reason 都自解释（不是「同上」这类）", bad.length === 0, `${raws.length} 条 native.raw，${bad.length} 条不合格`);
}
check("未映射的原生类型被保留（nativeType）",
  events.filter((e) => e.type === "native.raw").map((e) => e.nativeType).join(",").includes("compaction_end"));
check("上游新增的未知事件也不会被吞",
  mapEventStream([...records, { type: "something.brand.new", x: 1 }], ctx).events.some((e) => e.nativeType === "something.brand.new"));

// ---------------------------------------------------------------------------
console.log("\n── 纪律 ②：推算值必须标注 ──");
const tr = events.find((e) => e.type === "tool.result");
check("tool.result 的 ms 是推算值并已标注", tr?.msIsEstimated === true, JSON.stringify(tr));
check("ms 用到达时间差算出（840ms）", tr?.ms === 840, String(tr?.ms));
const offline = mapEventStream(records, ctx); // 不给 arrivals
check("离线解析（拿不到到达时刻）时 ms 记 0 且仍标注推算",
  offline.events.find((e) => e.type === "tool.result")?.ms === 0 &&
  offline.events.find((e) => e.type === "tool.result")?.msIsEstimated === true);

// ---------------------------------------------------------------------------
console.log("\n── 纪律 ③：不假装知道不知道的事 ──");
const mr = events.find((e) => e.type === "model.request");
check("model.request 的 tools 取自 harness 侧声明的工具数", mr?.tools === 4, JSON.stringify(mr));
check("stream 由增量块推断（见到 text_delta 即 true）", mr?.stream === true, JSON.stringify(mr));
check("tool.call 的入参只存 digest，不存明文",
  events.find((e) => e.type === "tool.call")?.inputDigest?.startsWith("sha256:") &&
  !JSON.stringify(events.find((e) => e.type === "tool.call")).includes("ls"));
check("decision 记为 allow（缺口 G3 的诚实近似）", events.find((e) => e.type === "tool.call")?.decision === "allow");

// ---------------------------------------------------------------------------
console.log("\n── 关联与顺序 ──");
check("run.meta 是第一条", events[0].type === "run.meta");
check("seq 从 0 起严格递增", events.every((e, i) => e.seq === i));
check("tool.call 与 tool.result 用同一 callId 配对",
  events.find((e) => e.type === "tool.call")?.callId === events.find((e) => e.type === "tool.result")?.callId);
check("每条都带 effectiveConfigDigest", events.every((e) => e.effectiveConfigDigest === D));
check("run.meta 带 definitionDigest（供业务标签 join）", events[0].definitionDigest === D);
check("ts 全部是 Z 结尾的 UTC", events.every((e) => /Z$/.test(e.ts)));

// ---------------------------------------------------------------------------
console.log("\n── 权威校验：每一行都要过 core/trace/schema.json ──");
const ajv = new Ajv2020({ allErrors: true, strict: false });
const validate = ajv.compile(JSON.parse(fs.readFileSync(path.join(REPO, "core/trace/schema.json"), "utf8")));
let bad = 0;
for (const e of events) if (!validate(e)) { bad++; console.log("   ❌", JSON.stringify(validate.errors?.[0] ?? {}), JSON.stringify(e).slice(0, 140)); }
check(`${events.length} 行全部通过 schema`, bad === 0, `${bad} 行不合规`);

console.log(`\n${failures === 0 ? "轨迹映射自检：全绿" : `轨迹映射自检：失败 ${failures} 项`}`);
process.exit(failures === 0 ? EXIT_CODES.ok : 1);
