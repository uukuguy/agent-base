#!/usr/bin/env node
// ============================================================================
// 用量归因报告：`make cost-report TRACE=<轨迹 JSONL>`
//
// 回答"这次运行贵在哪里"：每个 run 的模型调用/工具调用/挂钟 + 钩子失败/审批次数。
// **不编造 token 或成本**：轨迹里没有用量就说没有（实测该运行时不透出），
// 也**不假装能归因到人** —— 那需要一个身份入口，基座目前没有。
//
// 用法：node tools/cost-report.mjs <轨迹文件> [--json]
// ============================================================================

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { EXIT_CODES, parseArgs } from "../core/gates/index.mjs";
import { renderUsage, usageReport } from "../core/trace/usage.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
void HERE;

const { flags, positionals, errors } = parseArgs(process.argv.slice(2), { booleanFlags: ["--json", "--help"] });
if (errors?.length) { process.stderr.write(`❌ ${errors.join("；")}\n`); process.exit(EXIT_CODES.usage); }
if (flags.has("--help") || positionals.length !== 1) {
  process.stderr.write("用法: node tools/cost-report.mjs <轨迹 JSONL> [--json]\n");
  process.exit(flags.has("--help") ? EXIT_CODES.ok : EXIT_CODES.usage);
}
const file = path.resolve(positionals[0]);
if (!fs.existsSync(file)) { process.stderr.write(`❌ 找不到轨迹文件：${file}\n`); process.exit(EXIT_CODES.usage); }

const events = fs.readFileSync(file, "utf8").split("\n").filter(Boolean)
  .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const report = usageReport(events);
if (flags.has("--json")) process.stdout.write(JSON.stringify(report, null, 2) + "\n");
else process.stdout.write(renderUsage(report, { label: path.basename(file) }) + "\n");
process.exit(EXIT_CODES.ok);
