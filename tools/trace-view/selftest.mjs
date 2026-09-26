// ============================================================================
// 轨迹查看器自检 —— 判据是**层次纪律**，不只是"能不能渲染"
//
// 关键断言：查看器不含任何业务词汇。它会渲染出「工单系统」，但源码里**一个字**都没有 ——
// 那句话来自业务提供的 trace-labels.yaml。这是"基座不需要知道业务语言，只需一个附加协议"
// 的可执行证明。
// ============================================================================

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EXIT_CODES } from "../../core/gates/index.mjs";
import { LABELS_FILE, coverage, describeEvent, loadLabels, locator, parseMcpToolName, renderTimeline } from "./labels.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const SRC = fileURLToPath(import.meta.url).replace(/selftest\.mjs$/, "labels.mjs");

let failures = 0;
const check = (name, cond, extra = "") => {
  if (!cond) failures++;
  console.log(`${cond ? "✅" : "❌"} ${name}${cond || !extra ? "" : `\n      ${extra}`}`);
};

const base = { ts: "2026-09-25T10:00:00Z", run: "r1", effectiveConfigDigest: `sha256:${"a".repeat(64)}` };
const events = [
  { ...base, seq: 0, type: "run.meta", mode: "oneshot" },
  { ...base, seq: 1, type: "model.request", provider: "corp-gateway", model: "corp-think", tools: 4, stream: true },
  { ...base, seq: 2, type: "tool.call", callId: "c1", tool: "mcp__jira__get_issue", inputDigest: `sha256:${"b".repeat(64)}`, decision: "allow", biz: { "contract.id": "C-1024" } },
  { ...base, seq: 3, type: "tool.result", callId: "c1", tool: "mcp__jira__get_issue", ok: true, ms: 840, msIsEstimated: true },
  { ...base, seq: 4, type: "biz.event", namespace: "contract", level: "warn", message: "金额超阈值，转法务复核", data: { clause: "7.2" } },
  { ...base, seq: 5, type: "tool.call", callId: "c2", tool: "read", inputDigest: `sha256:${"c".repeat(64)}`, decision: "allow" },
  { ...base, seq: 6, type: "gate", name: "probes", target: "jira", ok: true },
];

// ---------------------------------------------------------------------------
console.log("── 无业务标签表：机械渲染必须完整、且不发明业务含义 ──");
const bare = renderTimeline(events, {});
console.log(bare.split("\n").filter(Boolean).map((l) => "   " + l).join("\n"));
check("无标签时仍然完整渲染 7 条事件", bare.split("\n").filter(Boolean).length === 7);
check("无标签时只说事实（工具名原样出现）", bare.includes("mcp__jira__get_issue"));
check("无标签时不编造业务说法（不含任何标签表内容）", !/工单|合同金额校验/.test(bare));
check("覆盖率统计反映 0 条业务说法", coverage(events, {}).business === 0);

// ---------------------------------------------------------------------------
console.log("\n── 业务提供标签表：只做键查找，不做语义推断 ──");
const labels = {
  [locator.agent()]: "合同条款审阅助手",
  [locator.tool("mcp__jira__get_issue")]: "查询工单",
  [locator.connector("jira")]: "工单系统",
  [locator.log("contract")]: "合同金额校验",
  [locator.gate("probes")]: "连通性检查",
};
const rich = renderTimeline(events, labels);
console.log(rich.split("\n").filter(Boolean).map((l) => "   " + l).join("\n"));
check("业务标签被用上", rich.includes("查询工单") && rich.includes("合同条款审阅助手"));
check("日志命名空间被翻译", rich.includes("合同金额校验"));
check("闸门名被翻译", rich.includes("连通性检查"));
check("没给标签的环节机械回退（read 工具）", rich.includes("调用工具 read"));
check("覆盖率反映业务/机械各多少", coverage(events, labels).business === 5 && coverage(events, labels).mechanical === 2,
  JSON.stringify(coverage(events, labels)));
check("业务字段 biz 仍浮到表面", rich.includes("contract.id=C-1024"));
check("日志渲染出级别标签", /\[WARN\]/.test(rich), rich);
check("推算耗时被标出来（不冒充实测）", rich.includes("耗时推算"));

// ---------------------------------------------------------------------------
console.log("\n── 层次纪律：查看器的**可执行代码**里不得有业务词汇 ──");
// 只检查代码，不检查注释：协议必须给出示例，示例里必然出现示例词（否则没法看懂怎么写）。
// 真正的纪律是——**逻辑**里没有任何业务词汇，换一套业务、换一套词，代码一行都不用改。
const stripComments = (t) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/[^\n]*/g, "");
const src = stripComments(fs.readFileSync(SRC, "utf8"));
for (const term of ["工单系统", "合同条款", "风险条款", "查询工单", "把想法拆成", "转法务复核"]) {
  check(`可执行代码不含业务词汇「${term}」`, !src.includes(term));
}
check("协议示例确实写在注释里（供业务照抄）",
  /trace-labels\.yaml/.test(fs.readFileSync(SRC, "utf8")) &&
  /合同条款审阅助手/.test(fs.readFileSync(SRC, "utf8")));
check("标签文件名来自协议常量，而不是某个业务约定", LABELS_FILE === "trace-labels.yaml");

// ---------------------------------------------------------------------------
console.log("\n── 标签表形状：坏输入要说话，不许静默 ──");
const dir = fs.mkdtempSync(path.join(REPO, "dist", "labelselftest-"));
fs.writeFileSync(path.join(dir, "agent.yaml"), "apiVersion: agent-base/v1\nname: t\n");
check("没有标签表时不是错误（协议是可选附加）", loadLabels(dir).problems.length === 0);
fs.writeFileSync(path.join(dir, LABELS_FILE), "labels:\n  agent: 有\n  tool:x: [不是字符串]\n");
const bad = loadLabels(dir);
check("标签值不是字符串时给出问题而不是静默丢弃", bad.problems.length === 1 && bad.labels.agent === "有", JSON.stringify(bad));
fs.rmSync(dir, { recursive: true, force: true });

console.log(`\n${failures === 0 ? "轨迹查看器自检：全绿" : `轨迹查看器自检：失败 ${failures} 项`}`);
process.exit(failures === 0 ? EXIT_CODES.ok : 1);
