#!/usr/bin/env node
// ============================================================================
// 审阅表「原文回指」机械自检
//
//   node check-anchors.mjs <审阅表.md> <合同文本.txt>   # 逐行检查摘录能否回到原文
//   node check-anchors.mjs --selftest                   # 自检（不需要外部文件）
//
// 它抓的是**审阅表里"原文摘录"那一列能否在合同文本里逐字找到**。
// 这是一条笨检查，但正好对付最要命的失效：结论看起来有依据、实际回不到原文。
//
// 校准过的三件事：
//   · 只比"字面出现"，不做模糊匹配 —— 模糊匹配会把"大致像"也放过，那就失去意义
//   · 标点差异容忍（全角/半角、引号种类），**用词差异不容忍** —— 那正是"概括"vs"原文"的分界
//   · 行号以 Markdown 表格为准，报出来的行号能直接跳过去看
// ============================================================================

import fs from "node:fs";

/** 归一化：只压掉空白与标点差异，**不动用词**。 */
const norm = (s) =>
  s
    .replace(/[\u3000\s]+/g, "")          // 空白（含全角空格）
    .replace(/[「」『』“”"'‘’]/g, '"')     // 引号统一
    .replace(/[，、]/g, ",")
    .replace(/[。！]/g, ".")
    .replace(/[：]/g, ":")
    .replace(/[；]/g, ";");

/**
 * 逐行检查：返回 { checked, missed, details[] }。**纯函数**（不读文件），这样自检能直接喂合成数据。
 * @param {string} tableText    审阅表（Markdown）
 * @param {string} contractText 合同原文
 */
export function checkAnchors(tableText, contractText) {
  const contract = norm(contractText);
  const details = [];
  let checked = 0;
  tableText.split("\n").forEach((line, i) => {
    if (!line.trim().startsWith("|")) return;
    const cells = line.split("|").map((c) => c.trim());
    if (cells.length < 4) return;
    if (/^[-: ]+$/.test(cells[2])) return;                   // 分隔行
    const excerpt = cells[2].replace(/^[「『"']|[」』"']$/g, "");
    if (!excerpt || excerpt.length < 6) return;              // 表头或过短
    if (/^(原文摘录|摘录)$/.test(excerpt)) return;            // 表头
    checked += 1;
    if (!contract.includes(norm(excerpt))) details.push({ line: i + 1, excerpt });
  });
  return { checked, missed: details.length, details };
}

function report({ checked, missed, details }) {
  for (const d of details) {
    console.log(`❌ 第 ${d.line} 行：原文里找不到 —— 「${d.excerpt.slice(0, 40)}${d.excerpt.length > 40 ? "…" : ""}」`);
  }
  console.log(`\n检查 ${checked} 条摘录，回指失败 ${missed} 条。`);
  if (!checked) console.log("⚠️ 没找到可检查的行 —— 确认审阅表用的是标准表格（第 2 列是原文摘录）。");
}

function selftest() {
  const contract = "第 3.2 条 乙方应在收到通知后 5 个工作日内以书面形式答复。\n第 4.1 条 本合同自双方签字之日起生效。";
  const table = [
    "| 条款号 | 原文摘录 | 风险等级 | 依据 | 建议 | 确定性 |",
    "|---|---|---|---|---|---|",
    '| 3.2 | 乙方应在收到通知后 5 个工作日内以书面形式答复 | 中 | 未限定答复内容 | 明确答复形式 | 可判定 |',   // 应命中（原文有）
    '| 4.1 | 本合同自双方盖章之日起生效 | 高 | 与原文不符 | 核对生效条件 | 可判定 |',                              // 应失败（原文是"签字"）
  ].join("\n");

  const r = checkAnchors(table, contract);
  const problems = [];
  if (r.checked !== 2) problems.push(`应检查 2 条，实际 ${r.checked}`);
  if (r.missed !== 1) problems.push(`应报 1 条失败，实际 ${r.missed}`);
  if (r.details[0]?.line !== 4) problems.push(`失败行号应为 4，实际 ${r.details[0]?.line}`);
  // 反向：标点差异**不该**被误报
  const r2 = checkAnchors("| 条款号 | 原文摘录 | 风险等级 | 依据 | 建议 | 确定性 |\n|---|---|---|---|---|---|\n| 3.2 | 乙方应在收到通知后 5 个工作日内以书面形式答复。 | 中 | x | y | 可判定 |", contract);
  if (r2.missed !== 0) problems.push("标点差异被误报了（应当容忍）");

  if (problems.length) {
    console.error("❌ 自检失败：\n  · " + problems.join("\n  · "));
    process.exit(1);
  }
  console.log("✅ 自检通过：能命中原文、能报出回指失败、标点差异不误报");
  process.exit(0);
}

// ---- 入口 ----
const argv = process.argv.slice(2);
if (argv.includes("--selftest")) selftest();

const [tableFile, contractFile] = argv;
if (!tableFile || !contractFile) {
  process.stderr.write("用法: node check-anchors.mjs <审阅表.md> <合同文本.txt>\n      node check-anchors.mjs --selftest\n");
  process.exit(2);
}
const r = checkAnchors(fs.readFileSync(tableFile, "utf8"), fs.readFileSync(contractFile, "utf8"));
report(r);
process.exit(r.checked && r.missed ? 1 : 0);
