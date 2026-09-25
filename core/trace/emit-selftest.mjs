// ============================================================================
// 业务级 logger 自检 —— 判据是那个具体场景：
// 「业务很清楚某点要做逻辑控制判断，介入后轨迹能清楚显示业务流操作」
//
// 走完整链路：logger 一行调用 → JSONL → schema 权威校验 → 查看器渲染。
// 任何一环让这一步变成隐形，即判失败。
// ============================================================================

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { EXIT_CODES } from "../gates/index.mjs";
import { LEVELS, TraceWriter, createLogger, digestOf, logEvent, validateShape } from "./emit.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const VIEWER = path.join(REPO, "tools/trace-view/labels.mjs");

let failures = 0;
const check = (name, cond, extra = "") => {
  if (!cond) failures++;
  console.log(`${cond ? "✅" : "❌"} ${name}${cond || !extra ? "" : `\n      ${extra}`}`);
};

const DIGEST = `sha256:${"a".repeat(64)}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "emit-selftest-"));
const traceFile = path.join(tmp, "trace.jsonl");

// ---------------------------------------------------------------------------
console.log("── 形状：就是个 logger（命名空间 + 级别 + 消息 + 字段）──");
check("四个级别齐备", LEVELS.join(",") === "debug,info,warn,error");
check("正常一条日志能构造", logEvent("contract", "info", "扫描完成", { clauses: 12 }).event !== null);
check("命名空间可点分（相当于 logger category）", logEvent("contract.amount", "info", "x").event !== null);
check("缺消息被拒", logEvent("contract", "info", "").event === null);
check("级别非法被拒", logEvent("contract", "verbose", "x").event === null);
check("命名空间含大写被拒", logEvent("Contract", "info", "x").event === null);
check("字段值必须标量（拒绝嵌套对象）", logEvent("contract", "info", "x", { nested: { a: 1 } }).event === null);

// ---------------------------------------------------------------------------
console.log("\n── 业务只写一行，公共字段由基座补齐 ──");
const log = createLogger({
  namespace: "contract",
  run: "run-selftest",
  effectiveConfigDigest: DIGEST,
  agent: "contract-review",
  harness: "test-harness",
  harnessVersion: "0.0.0-test",
  dest: traceFile,
});
log.info("合同扫描完成", { clauses: 12 });
// 这就是「业务逻辑控制判断」那一步：
log.warn("金额 1.2M 超过阈值 1.0M，转法务复核", { amount: 1200000, threshold: 1000000, decision: "legal_review_required" });
log.error("工单系统不可达", { server: "jira" });

check("三次调用写出三条事件", fs.readFileSync(traceFile, "utf8").split("\n").filter(Boolean).length === 3);
check("logger 自己没记下问题", log.problems.length === 0, JSON.stringify(log.problems));

console.log("\n── 坏输入不得静默：记问题并拒发 ──");
const bad = createLogger({ namespace: "contract", run: "r", effectiveConfigDigest: DIGEST, dest: path.join(tmp, "bad.jsonl") });
check("缺消息被拒发", bad.info("") === null);
check("嵌套字段被拒发", bad.info("x", { nested: {} }) === null);
check("问题被记录下来（不是无声丢日志）", bad.problems.length === 2, JSON.stringify(bad.problems));

console.log("\n── 写坏了不许静默（构造期就拦） ──");
let threw = false;
try { new TraceWriter({ run: "r", effectiveConfigDigest: "not-a-digest" }); } catch { threw = true; }
check("非法 effectiveConfigDigest 直接抛错", threw);

// ---------------------------------------------------------------------------
console.log("\n── 权威校验：写出的每一行都要过 core/trace/schema.json ──");
const ajv = new Ajv2020({ allErrors: true, strict: false });
const validate = ajv.compile(JSON.parse(fs.readFileSync(path.join(HERE, "schema.json"), "utf8")));
const lines = fs.readFileSync(traceFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
check(`写出的 ${lines.length} 行全部通过 schema`, lines.every((l) => validate(l)), JSON.stringify(validate.errors));
check("形状自检与 schema 结论一致（无漏网）", lines.every((l) => validateShape(l).length === 0));
check("公共字段被自动补齐（ts/seq/run/digest）",
  lines.every((l) => l.ts && Number.isInteger(l.seq) && l.run === "run-selftest" && l.effectiveConfigDigest === DIGEST));
check("ts 是 Z 结尾的 UTC", lines.every((l) => /Z$/.test(l.ts)));
check("seq 从 0 起递增", lines.map((l) => l.seq).join(",") === "0,1,2");

// ---------------------------------------------------------------------------
console.log("\n── 查看器：业务判断那一步必须**显形** ──");
const { renderTimeline } = await import(VIEWER);
const rendered = renderTimeline(lines, { "log:contract": "合同校验" });
console.log(rendered.split("\n").filter(Boolean).map((l) => "   " + l).join("\n"));

const warnLine = rendered.split("\n").find((l) => l.includes("转法务复核")) ?? "";
check("业务判断出现在时间轴上", warnLine.length > 0);
check("级别可见（[WARN]）", /\[WARN\]/.test(warnLine), warnLine);
check("判定结论作为字段可见", warnLine.includes("decision=legal_review_required"), warnLine);
check("判定依据（消息正文）可见", warnLine.includes("金额 1.2M 超过阈值 1.0M"), warnLine);
check("相关字段可见", warnLine.includes("amount=1200000") && warnLine.includes("threshold=1000000"), warnLine);
check("命名空间用了业务说法", warnLine.includes("合同校验"), warnLine);
check("没有业务标签表时也不隐形（退化为命名空间 + 原文）",
  renderTimeline(lines, {}).includes("contract: 金额 1.2M 超过阈值 1.0M"));

// ---------------------------------------------------------------------------
console.log("\n── 关联外部工件：内容摘要 ──");
check("digestOf 对同一内容稳定", digestOf({ a: 1 }) === digestOf({ a: 1 }));
check("digestOf 对内容敏感", digestOf({ a: 1 }) !== digestOf({ a: 2 }));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${failures === 0 ? "业务级 logger 自检：全绿" : `业务级 logger 自检：失败 ${failures} 项`}`);
process.exit(failures === 0 ? EXIT_CODES.ok : 1);
