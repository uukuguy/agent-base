#!/usr/bin/env node
// ============================================================================
// 四道闸门编排：`verify`（统一设计 §6.7 / §12.4 流程甲）
//
// 「可用」= 四道闸门全过（§6.8），不是「能启动」。本命令把四道串起来，
// 输出 §6.7 的输出契约，并给出 `usable`。
//
// 它**不重新实现任何检查**：四道闸门各自的工具都已经存在，verify 只做编排与汇总。
// 这样"verify 说通过"与"单跑某道闸门说通过"永远一致 —— 否则就会出现两套判定口径。
//
// 流程：validate(闸门1) → render(制品) → doctor(闸门2) → probe(闸门3) → smoke(闸门4)
//   · render 失败记为闸门 1 类失败（定义/产物层面的问题），退出码 10
//   · 任一道闸门失败即停止（后续闸门在定义非法时毫无意义，继续跑只会产出噪声）
//
// 用法：node tools/verify.mjs <AGENT_DIR> [--harness pi] [--out RENDER_DIR] [--json]
// 退出码：0 可用 / 2 用法错误 / 10|20|30|40 首个失败闸门 / 50 异常
// ============================================================================

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { EXIT_CODES, GateReport, parseArgs } from "../core/gates/index.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const log = (m) => process.stderr.write(m + "\n");

const { values, flags, positionals, errors } = parseArgs(process.argv.slice(2), { valueFlags: ["--harness", "--out", "--endpoint"] });
const json = flags.has("--json");
const harness = values["--harness"] ?? "pi";
// LIVE=1 / --live：闸门 3/4 打**真实端点**（要"真的能用"的证据时用；默认仍走零凭据假网关）
const live = flags.has("--live") || process.env.AGENT_VERIFY_LIVE === "1";
// 不传 = 用零凭据假网关（默认，不需要任何密钥）；传了 = 针对真实端点跑闸门 3/4
const endpointArg = values["--endpoint"] ? ["--endpoint", values["--endpoint"]] : [];
const agentDirArg = positionals[0];

if (errors.length) { process.stderr.write(errors.join("；") + "\n"); process.exit(EXIT_CODES.usage); }
if (flags.has("--help") || flags.has("-h") || !agentDirArg) {
  process.stderr.write("用法: node tools/verify.mjs <AGENT_DIR> [--harness pi] [--out RENDER_DIR] [--endpoint URL] [--live] [--json]\n");
  process.exit(flags.has("--help") || flags.has("-h") ? EXIT_CODES.ok : EXIT_CODES.usage);
}

const agentDir = path.resolve(agentDirArg);
const renderDir = path.resolve(values["--out"] ?? path.join("dist", harness, path.basename(agentDir)));

/** 跑一个子工具，拿到它的 §6.7 报告（或 null）。 */
function runTool(args) {
  const r = spawnSync(process.execPath, args, { encoding: "utf8", cwd: REPO });
  let parsed = null;
  try { parsed = JSON.parse(r.stdout); } catch { /* 有的工具在失败时也只写 stderr */ }
  return { status: r.status, stderr: r.stderr ?? "", parsed };
}

/** 从各工具的 JSON 形态里取出 gate 列表。 */
function gatesOf(parsed) {
  if (!parsed) return null;
  if (Array.isArray(parsed.gates)) return parsed.gates;      // validate 直接给 §6.7
  if (parsed.gate?.gates) return parsed.gate.gates;          // doctor / probe / smoke 包了一层
  return null;
}

const report = new GateReport({ harness });
const collected = [];

function addGate(gates, fallbackId) {
  if (gates?.length) collected.push(...gates.map((g) => ({ id: g.id, checks: g.checks ?? [] })));
  else collected.push({ id: fallbackId, checks: [{ id: `${fallbackId}/no-report`, status: "fail", detail: "工具没有输出可解析的报告" }] });
}

// ---- 闸门 1：静态校验 ----
log("── 闸门 1：静态校验 ──");
const v = runTool([path.join(REPO, "tools/validate.mjs"), agentDir, "--json"]);
addGate(gatesOf(v.parsed), "static");
if (v.status !== 0) {
  report.gates = collected;
  finish();
}

// ---- 制品：渲染 ----
log("── 制品：渲染 ──");
const r = spawnSync(process.execPath, [path.join(REPO, `adapters/${harness}/render.mjs`), agentDir, "--out", renderDir, "--json"], { encoding: "utf8", cwd: REPO });
if (r.status !== 0) {
  collected.push({ id: "static", checks: [{ id: "render/product", status: "fail", detail: `渲染失败：${(r.stderr ?? "").slice(-300)}` }] });
  report.gates = collected;
  finish();
}
log(`   产物：${renderDir}`);

// ---- 闸门 2 / 3 / 4 ----
for (const [gateId, tool, label] of [
  ["resolution", `adapters/${harness}/doctor.mjs`, "闸门 2：解析自证"],
  ["probes", "tools/probe.mjs", "闸门 3：集成探针"],
  ["smoke", "tools/smoke.mjs", "闸门 4：端到端冒烟"],
]) {
  log(`── ${label} ──`);
  // harness 必须一路传下去：否则 probe/smoke 会用自己的默认运行时去跑另一个运行时的产物
  const res = runTool([path.join(REPO, tool), renderDir, "--json", "--harness", harness, ...(tool.includes("probe") || tool.includes("smoke") ? [...endpointArg, ...(live ? ["--live"] : [])] : [])]);
  addGate(gatesOf(res.parsed), gateId);
  const okNow = collected.every((g) => (g.checks ?? []).every((c) => c.status === "pass"));
  if (!okNow) break; // 首个失败即停：闸门 1 都不过时，闸门 3 的结论毫无意义
}

report.gates = collected;
finish();

function finish() {
  // 只统计四道闸门里跑过的；crashed 由退出码 50 兜底
  if (json) process.stdout.write(JSON.stringify(report.toJSON(), null, 2) + "\n");
  else {
    report.print({ json: false, stderr: process.stderr });
    if (report.usable) log("✅ 可用：四道闸门全过（§6.8）—— 这个想法被证明走通了");
    else if (report.ok) log("已跑的闸门全绿，但四道未齐 —— 不能说「可用」");
  }
  process.exit(report.exitCode);
}
