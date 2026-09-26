#!/usr/bin/env node
// ============================================================================
// 离线评测的机械判分器（技能脚本示例）
//
// 为什么要有这个脚本：本地模型**慢且不稳定**，同一提示词两次输出可能不同。
// 于是"这次看起来更好"不构成结论 —— 结论只能来自：固定用例集 + 固定参数 + 重复 N 次 + 通过率。
// 而"通过"必须是**可机械判定的性质**（必须出现什么、不得出现什么、必须能 JSON.parse、
// 必须发出工具调用），不能是逐字比对（本地模型措辞不稳定）也不能是整体印象。
//
// 它抓的三类失效：
//   · 某条用例**根本没跑过**，却被当成通过（结果里没有它的 id）
//   · 结果里出现用例集之外的 id（改了用例集却没重跑，数字对不上）
//   · 同一条用例 N 次里只过了几次，却被一句"实测可用"盖过去（本脚本按次统计，不给平均）
//
// 用法：
//   node eval-check.mjs <cases.json> <results.jsonl>   # 判分
//   node eval-check.mjs --selftest                     # 自检（内置样本，不需要外部文件）
// 退出码：0 全部通过 / 2 用法错误 / 1 有任何失败或问题
// ============================================================================

import fs from "node:fs";

/**
 * 对一次运行判分，返回失败原因数组（空数组 = 通过）。**纯函数**，自检可直接喂合成数据。
 * @param {object} c 用例：{ requiresAll?, requiresNone?, mustMatch?, mustParseJson?, mustCallTool? }
 * @param {object} r 一次结果：{ id, output?, toolCalls? }
 */
export function checkOne(c, r) {
  const reasons = [];
  const output = String(r.output ?? "");
  for (const s of c.requiresAll ?? []) if (!output.includes(s)) reasons.push(`缺少必须出现的「${s}」`);
  for (const s of c.requiresNone ?? []) if (output.includes(s)) reasons.push(`出现了不该出现的「${s}」`);
  if (c.mustMatch) {
    let re;
    try { re = new RegExp(c.mustMatch); } catch { reasons.push(`用例正则非法：/${c.mustMatch}/`); }
    if (re && !re.test(output)) reasons.push(`不匹配正则 /${c.mustMatch}/`);
  }
  if (c.mustParseJson) {
    try { JSON.parse(output); } catch (e) { reasons.push(`不是合法 JSON：${e.message}`); }
  }
  if (c.mustCallTool && !(Array.isArray(r.toolCalls) && r.toolCalls.length)) reasons.push("没有发出工具调用");
  return reasons;
}

/**
 * 判分全部用例。**纯函数**（不读文件）。
 * @param {Array} cases   用例数组
 * @param {Array} results 结果数组（同一 id 可重复出现 —— 那就是"重复 N 次"）
 * @returns {object} { rows: Array, problems: string[] }
 */
export function grade(cases, results) {
  const problems = [];
  const byId = new Map(cases.map((c) => [c.id, c]));
  const grouped = new Map(cases.map((c) => [c.id, []]));
  const unknown = [];
  for (const r of results) {
    if (!byId.has(r.id)) { unknown.push(r.id); continue; }
    grouped.get(r.id).push(r);
  }
  if (unknown.length) problems.push(`结果里出现用例集没有的 id：${[...new Set(unknown)].join(", ")} —— 换了用例集就必须重跑`);

  const rows = [];
  for (const c of cases) {
    const runs = grouped.get(c.id) ?? [];
    if (!runs.length) { problems.push(`用例 ${c.id} 没有任何结果 —— 它没被跑过，不能算通过`); continue; }
    let passed = 0;
    const failures = [];
    for (const r of runs) {
      const reasons = checkOne(c, r);
      if (reasons.length) failures.push({ reasons, output: String(r.output ?? "") });
      else passed += 1;
    }
    rows.push({ id: c.id, runs: runs.length, passed, failures });
  }
  return { rows, problems };
}

const clip = (s, n = 60) => (s.length > n ? `${s.slice(0, n)}…` : s);

function report({ rows, problems }) {
  let failedRuns = 0;
  for (const row of rows) {
    const ok = row.passed === row.runs;
    if (!ok) failedRuns += row.runs - row.passed;
    console.log(`${ok ? "✅" : "❌"} ${row.id}　${row.passed}/${row.runs} 通过`);
    for (const f of row.failures) {
      console.log(`     - ${f.reasons.join("；")}　原文：${clip(f.output)}`);
    }
  }
  for (const p of problems) console.log(`❌ ${p}`);
  const totalRuns = rows.reduce((a, r) => a + r.runs, 0);
  console.log(`\n共 ${rows.length} 条用例 / ${totalRuns} 次运行，失败 ${failedRuns} 次，结构问题 ${problems.length} 处。`);
  if (!rows.length) console.log("⚠️ 没有任何用例被判分 —— 确认 cases.json 里有 cases 数组。");
  return problems.length === 0 && failedRuns === 0;
}

// ---------------------------------------------------------------------------
const SELFTEST_CASES = [
  {
    name: "全部通过 → 允许",
    expect: 0,
    cases: [
      { id: "json-only", mustParseJson: true, requiresNone: ["```"] },
      { id: "tool-call", mustCallTool: true },
      { id: "err-code", mustMatch: "^E[0-9]{4}$", requiresAll: ["E"] },
    ],
    results: [
      { id: "json-only", output: '{"ok":true}' },
      { id: "tool-call", output: "calling", toolCalls: [{ name: "read" }] },
      { id: "err-code", output: "E1024" },
      { id: "err-code", output: "E2048" },
    ],
  },
  {
    name: "缺少必须出现的子串 → 必须报",
    expect: 1,
    cases: [{ id: "mentions-endpoint", requiresAll: ["/v1/models"] }],
    results: [{ id: "mentions-endpoint", output: "我检查过了，没问题" }],
  },
  {
    name: "出现禁用子串 → 必须报",
    expect: 1,
    cases: [{ id: "no-fence", requiresNone: ["```"] }],
    results: [{ id: "no-fence", output: "```json\n{}\n```" }],
  },
  {
    name: "不是合法 JSON → 必须报",
    expect: 1,
    cases: [{ id: "json-only", mustParseJson: true }],
    results: [{ id: "json-only", output: "当然可以：{ok: true}" }],
  },
  {
    name: "没发工具调用 → 必须报",
    expect: 1,
    cases: [{ id: "tool-call", mustCallTool: true }],
    results: [{ id: "tool-call", output: "我建议你调用 read 工具" }],
  },
  {
    name: "用例没有结果 → 必须报（不许当成通过）",
    expect: 1,
    cases: [{ id: "a", requiresAll: ["x"] }, { id: "never-ran", mustParseJson: true }],
    results: [{ id: "a", output: "x" }],
  },
  {
    name: "结果里有用例集之外的 id → 必须报",
    expect: 1,
    cases: [{ id: "a", requiresAll: ["x"] }],
    results: [{ id: "a", output: "x" }, { id: "stale-case", output: "x" }],
  },
  {
    name: "N 次里只过几次 → 必须报（不给平均盖过去）",
    expect: 1,
    cases: [{ id: "stable-json", mustParseJson: true }],
    results: [
      { id: "stable-json", output: '{"ok":true}' },
      { id: "stable-json", output: "ok" },
      { id: "stable-json", output: '{"ok":true}' },
    ],
  },
];

function selftest() {
  let failures = 0;
  for (const c of SELFTEST_CASES) {
    const ok = report(grade(c.cases, c.results));
    const got = ok ? 0 : 1;
    const good = got === c.expect;
    if (!good) failures += 1;
    console.log(`${good ? "✅" : "❌"} ${c.name}（期望退出 ${c.expect}，实际 ${got}）\n`);
  }
  console.log(failures === 0 ? "eval-check 自检：全绿" : `eval-check 自检：失败 ${failures} 项`);
  process.exit(failures === 0 ? 0 : 1);
}

function usage() {
  process.stderr.write("用法: node eval-check.mjs <cases.json> <results.jsonl> | --selftest\n");
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--selftest")) return selftest();
  if (args.includes("--help") || args.includes("-h")) { usage(); process.exit(0); }
  const positional = args.filter((a) => !a.startsWith("-"));
  if (positional.length !== 2) { usage(); process.exit(2); }

  const [casesPath, resultsPath] = positional;
  if (!fs.existsSync(casesPath) || !fs.existsSync(resultsPath)) {
    process.stderr.write(`❌ 找不到文件：${[casesPath, resultsPath].filter((p) => !fs.existsSync(p)).join(", ")}\n`);
    process.exit(2);
  }
  let cases;
  try { cases = JSON.parse(fs.readFileSync(casesPath, "utf8"))?.cases; } catch (e) {
    process.stderr.write(`❌ cases.json 不是合法 JSON：${e.message}\n`);
    process.exit(2);
  }
  if (!Array.isArray(cases)) { process.stderr.write("❌ cases.json 里没有 cases 数组\n"); process.exit(2); }

  const results = [];
  const badLines = [];
  fs.readFileSync(resultsPath, "utf8").split("\n").forEach((line, i) => {
    if (!line.trim()) return;
    try { results.push(JSON.parse(line)); } catch { badLines.push(i + 1); }
  });
  if (badLines.length) {
    process.stderr.write(`❌ results.jsonl 有 ${badLines.length} 行不是合法 JSON（行号：${badLines.join(", ")}）\n`);
    process.exit(2);
  }

  process.exit(report(grade(cases, results)) ? 0 : 1);
}

// 被 import 时不执行 CLI（自检/复用判分函数）
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) main();
