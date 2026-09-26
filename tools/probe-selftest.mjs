// ============================================================================
// 闸门 3「钩子逐条自证」自检（路线图 §23 E2b）
//
// E2 的判据是"有钩子事件就算过" —— 声明 3 个钩子只跑 1 个也绿。E2b 要求**逐条**：
// 每条声明的钩子要么留下带自己 id 的痕迹（`enhancement`），要么红并点名。
//
// 这里既断言纯函数的每个分支，也**真跑**两个夹具：
//   · 会留痕的业务钩子 ⇒ `probe/hooks-evidenced` 通过，且点名两条（基座 trace + 业务钩子）
//   · 声明了但什么都不写的业务钩子 ⇒ **红**，并在 detail 里点名它
// 第二条是这条判据可信度的来源：没有它，这个检查就只是"看起来在工作"。
//
// 用法：node tools/probe-selftest.mjs  （或 make probe-selftest）
// ============================================================================

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { hookEvidence } from "../core/gates/index.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");

let failures = 0;
const check = (name, cond, extra = "") => {
  if (!cond) failures++;
  console.log(`${cond ? "✅" : "❌"} ${name}${cond || !extra ? "" : `\n      ${extra}`}`);
};

console.log("── A. 纯函数分支 ──");
{
  const ev = (id, n = 1) => Array.from({ length: n }, () => ({ emitter: "hook", enhancement: id, type: "run.meta" }));
  check("未声明钩子 ⇒ none-declared（不假装验过）",
    hookEvidence({ declaredHooks: [], events: [] }).status === "none-declared");
  const all = hookEvidence({ declaredHooks: ["a", "b"], events: [...ev("a"), ...ev("b", 2)] });
  check("每条都留痕 ⇒ evidenced，且给出条数", all.status === "evidenced" && /b\(2 条\)/.test(all.detail), all.detail);
  const one = hookEvidence({ declaredHooks: ["a", "b"], events: ev("a") });
  check("有一条哑掉 ⇒ silent 且点它的名", one.status === "silent" && one.silent.join() === "b", one.detail);
  const noAttr = hookEvidence({ declaredHooks: ["a"], events: [{ emitter: "hook", type: "run.meta" }] });
  check("有钩子事件但没写归属 ⇒ 仍判 silent，并提示怎么修",
    noAttr.status === "silent" && /enhancement/.test(noAttr.detail), noAttr.detail);
  check("事后映射 ⇒ 如实 not-applicable（不假装通过）",
    hookEvidence({ declaredHooks: ["a"], events: [{ emitter: "post-hoc" }] }).status === "not-applicable");
  check("既无钩子事件也无事后映射 ⇒ no-hook-events（红）",
    hookEvidence({ declaredHooks: ["a"], events: [] }).status === "no-hook-events");
}

/** 造一个带业务钩子的 pi 夹具。`evidence: false` ⇒ 钩子声明了但什么都不写。 */
function makeAgent(name, { evidence }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "probe-selftest-"));
  const agent = path.join(root, name);
  fs.mkdirSync(path.join(agent, "skills", "alpha"), { recursive: true });
  fs.mkdirSync(path.join(agent, "harness", "pi", "extensions"), { recursive: true });
  fs.writeFileSync(path.join(agent, "agent.yaml"),
    `apiVersion: agent-base/v1\nname: ${name}\ndescription: 钩子自证自检\npersona: { instructions: 自检。 }\n`
    + `model: { provider: corp-gateway, name: corp-think }\nconnectorsFile: connectors.yaml\n`);
  fs.writeFileSync(path.join(agent, "connectors.yaml"), "apiVersion: agent-base/v1\nmcpServers: []\n");
  fs.writeFileSync(path.join(agent, "skills", "alpha", "SKILL.md"), "---\nname: alpha\ndescription: 一句话\n---\n正文\n");
  fs.writeFileSync(path.join(agent, "harness", "pi", "enhancements.yaml"), [
    "apiVersion: agent-base/v1",
    "harness: pi",
    "enhancements:",
    "  - kind: hook",
    "    id: audit-hook",
    "    entry: extensions/audit-hook.ts",
    "    events: [tool_call]",
    "    description: 自检用业务钩子",
    "",
  ].join("\n"));
  // 留痕版：用产物里注入的写入器（基座把它放在扩展同目录）并写明自己的声明 id
  const body = evidence
    ? `import { TraceWriter } from "./_trace-emit.mjs";\n`
      + `const DIGEST = process.env.AGENT_EFFECTIVE_CONFIG_DIGEST ?? "";\n`
      + `export default function (pi) {\n`
      + `  if (!/^sha256:[0-9a-f]{64}$/.test(DIGEST)) return;\n`
      + `  const w = new TraceWriter({ run: process.env.AGENT_RUN_ID ?? "selftest", effectiveConfigDigest: DIGEST,\n`
      + `    enhancement: "audit-hook", harness: "pi", dest: process.env.AGENT_TRACE_DEST || null, validate: false });\n`
      + `  pi.on("tool_call", () => { try { w.write({ type: "gate", name: "static", target: "audit-hook", ok: true, detail: "钩子确实跑了" }); } catch {} });\n`
      + `}\n`
    : `export default function (pi) {\n  pi.on("tool_call", () => {});\n}\n`;
  fs.writeFileSync(path.join(agent, "harness", "pi", "extensions", "audit-hook.ts"), body);
  return agent;
}

/** 渲染 + 跑闸门 3，取 `probe/hooks-evidenced` 这条检查。 */
function runGate3(agent) {
  const renderDir = path.join(agent, "..", `${path.basename(agent)}-render`);
  const r = spawnSync(process.execPath, [path.join(REPO, "adapters/pi/render.mjs"), agent, "--out", renderDir], { encoding: "utf8", cwd: REPO });
  if (r.status !== 0) return { error: `渲染失败：${(r.stderr ?? "").slice(-300)}` };
  const p = spawnSync(process.execPath, [path.join(HERE, "probe.mjs"), renderDir, "--json", "--harness", "pi"],
    { encoding: "utf8", cwd: REPO, timeout: 900000 });
  let doc = null;
  try { doc = JSON.parse(p.stdout); } catch { doc = null; }
  const gates = (doc?.gates ?? doc?.gate?.gates ?? []);
  const found = gates.flatMap((g) => g.checks ?? []).find((c) => c.id === "probe/hooks-evidenced");
  return { status: p.status, found, renderDir };
}

console.log("\n── B. 真跑：会留痕的业务钩子 ⇒ 逐条自证通过 ──");
{
  const r = runGate3(makeAgent("hook-evidenced", { evidence: true }));
  check("拿到 `probe/hooks-evidenced` 这条检查", !!r.found, r.error ?? "（没有这条检查）");
  check("判为通过", r.found?.status === "pass", JSON.stringify(r.found ?? null).slice(0, 300));
  check("点名了基座 trace 与业务 audit-hook 两条",
    /trace/.test(r.found?.detail ?? "") && /audit-hook/.test(r.found?.detail ?? ""), r.found?.detail);
}

console.log("\n── C. 真跑负例：声明了却不留痕 ⇒ 必须红并点名 ──");
{
  const r = runGate3(makeAgent("hook-silent", { evidence: false }));
  check("判为**失败**（这正是 E2 抓不到的那一类）", r.found?.status === "fail", JSON.stringify(r.found ?? null).slice(0, 300));
  check("detail 里点出 audit-hook 没有留痕",
    /audit-hook/.test(r.found?.detail ?? "") && /没有留痕|没留痕/.test(r.found?.detail ?? ""), r.found?.detail);
  check("并给出修法（enhancement 归属）", /enhancement/.test(r.found?.detail ?? ""), r.found?.detail);
  check("闸门 3 整体非零退出（这条失败要真的挡住）", r.status !== 0, String(r.status));
}

console.log("");
if (failures) {
  console.log(`❌ 闸门 3 钩子逐条自证自检：失败 ${failures} 项`);
  process.exit(1);
}
console.log("✅ 闸门 3 钩子逐条自证自检：全绿");
 