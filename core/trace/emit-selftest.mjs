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
import { LEVELS, TraceWriter, createLogger, digestOf, logEvent, validateShape , guardedHook } from "./emit.mjs";

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

// ---------------------------------------------------------------------------
// guardedHook（E7）：钩子失败必须**留痕**，再按声明处置
// 背景：实测运行时自己会静默吞掉钩子异常（退出 0、轨迹无痕）—— 静默失败不可接受。
// ---------------------------------------------------------------------------
console.log("\n── 钩子失败语义 ──");
{
  const written = [];
  const sink = (rec) => written.push(rec);
  const boom = () => { throw new Error("业务钩子故意抛异常"); };

  const rec = guardedHook({ id: "h1", event: "before_provider_request", policy: "record", writer: sink }, boom);
  const r = await rec();
  check("record：不抛出（一个业务钩子出错不该让会话崩掉）", r === undefined);
  check("record：**先留痕**（hook.error 事件，带声明 id / 事件名 / 失败语义）",
    written.length === 1 && written[0].type === "hook.error" && written[0].enhancement === "h1"
    && written[0].event === "before_provider_request" && written[0].policy === "record",
    JSON.stringify(written[0]));
  check("record：错误信息原样带出（不解释、不吞）", /故意抛异常/.test(written[0].message));

  written.length = 0;
  const blk = guardedHook({ id: "h2", policy: "block", writer: sink }, boom);
  let threw = null;
  try { await blk(); } catch (e) { threw = e; }
  check("block：**先留痕再抛出**（留痕不能因为要抛就省掉）",
    written.length === 1 && written[0].policy === "block", JSON.stringify(written));
  check("block：抛出的是**原始错误**（不包装成别的东西）", threw instanceof Error && /故意抛异常/.test(threw.message), String(threw));

  // 写入器自己坏了：不许因此吞掉原始错误
  written.length = 0;
  const brokenSink = () => { throw new Error("写入器坏了"); };
  let threw2 = null;
  try { await guardedHook({ id: "h3", policy: "block", writer: brokenSink }, boom)(); } catch (e) { threw2 = e; }
  check("写入器不可用时，block 仍然抛出**原始**错误", threw2 instanceof Error && /故意抛异常/.test(threw2.message), String(threw2));
  const swallowed = await guardedHook({ id: "h4", policy: "record", writer: brokenSink }, boom)();
  check("写入器不可用时，record 仍然不抛出", swallowed === undefined);

  check("成功路径不写任何事件（没失败就不该有 hook.error）",
    (await guardedHook({ id: "h5", writer: sink }, async () => 42)()) === 42 && written.length === 0);
  check("缺声明 id ⇒ 响亮拒绝（否则痕迹归谁都不知道）",
    (() => { try { guardedHook({ policy: "record" }, boom); return false; } catch { return true; } })());
  check("非法 policy ⇒ 响亮拒绝",
    (() => { try { guardedHook({ id: "h6", policy: "ignore" }, boom); return false; } catch { return true; } })());
  {
    const base = { ts: "2026-09-28T00:00:00Z", seq: 0, run: "r", type: "hook.error", effectiveConfigDigest: `sha256:${"a".repeat(64)}` };
    const problems = validateShape(base);
    check("形状自检认得 hook.error：缺 enhancement 与 message 都被点出来（不数个数，按内容断言）",
      problems.some((x) => /enhancement/.test(x)) && problems.some((x) => /message/.test(x)), JSON.stringify(problems));
    check("形状自检：字段齐全的 hook.error 无问题",
      validateShape({ ...base, enhancement: "x", message: "m", policy: "record" }).length === 0,
      JSON.stringify(validateShape({ ...base, enhancement: "x", message: "m", policy: "record" })));
  }
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${failures === 0 ? "业务级 logger 自检：全绿" : `业务级 logger 自检：失败 ${failures} 项`}`);
process.exit(failures === 0 ? EXIT_CODES.ok : 1);
