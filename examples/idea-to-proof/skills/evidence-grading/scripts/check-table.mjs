#!/usr/bin/env node
// ============================================================================
// 校验「断验证队列」表的结构（技能脚本示例）
//
// 为什么要有这个脚本：本技能的产物是一张表，而它最容易坏的方式是**看起来完整、实则漏项** ——
//   · 某条断言的「什么结果算被推翻」是空的（于是它其实不可验证，却混在队列里）
//   · 「当前不可验证」的断言被混进验证队列（这是最坏的情况：看起来有结论，实际无从检验）
//   · 列被改名或删掉，下游按列名读就会静默读错
// 这些都不是"写错一句话"级别的问题，而是会让整份产出失去意义的问题。所以值得机器校验。
//
// 用法：
//   node check-table.mjs <表格文件.md>        # 校验文件
//   node check-table.mjs --selftest           # 自检（内置合法/非法样本）
// 退出码：0 通过 / 2 用法错误 / 1 有问题
// ============================================================================

import fs from "node:fs";

/** 表格必须有的列（顺序不限，但都要在）。 */
const REQUIRED_COLUMNS = ["断言", "什么结果算被推翻", "去哪里看", "代价"];
/** 表示"该断言当前不可验证"的措辞 —— 这类行**不许**留在验证队列里。 */
const UNVERIFIABLE = /当前不可验证|不可验证|无法验证/;

/**
 * @returns {{rows: number, problems: string[]}}
 */
export function checkTable(text) {
  const problems = [];
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("|"));
  if (!lines.length) return { rows: 0, problems: ["没有找到 Markdown 表格（行以 | 开头）"] };

  const cells = (l) => l.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
  const header = cells(lines[0]);
  for (const col of REQUIRED_COLUMNS) {
    if (!header.includes(col)) problems.push(`表头缺列「${col}」（现有：${header.join(" / ")}）`);
  }
  const body = lines.slice(1).filter((l) => !/^\|[\s|:-]+\|$/.test(l));   // 去掉分隔行
  if (!body.length) problems.push("表格没有数据行");

  body.forEach((line, i) => {
    const row = cells(line);
    const idx = (name) => header.indexOf(name);
    const rowNo = i + 1;
    const claim = idx("断言") >= 0 ? row[idx("断言")] : "";
    const falsifier = idx("什么结果算被推翻") >= 0 ? row[idx("什么结果算被推翻")] : "";
    const where = idx("去哪里看") >= 0 ? row[idx("去哪里看")] : "";

    if (!claim) problems.push(`第 ${rowNo} 行：断言为空 —— 它甚至还不是一条断言`);
    if (!falsifier) {
      problems.push(`第 ${rowNo} 行：证伪条件为空 —— 不可验证的断言不许混进验证队列`);
      return;
    }
    if (!where) problems.push(`第 ${rowNo} 行：没写去哪里看 —— 证伪条件无法执行`);
    // 允许在表里出现"当前不可验证"，但必须显式写清"缺什么"，否则等于占位
    if (UNVERIFIABLE.test(falsifier) && !/缺|需要/.test(falsifier)) {
      problems.push(`第 ${rowNo} 行：标了不可验证但没写「缺什么」—— 那是占位，不是产出`);
    }
  });

  return { rows: body.length, problems };
}

// ---------------------------------------------------------------------------
const SELFTEST_CASES = [
  {
    name: "合法表",
    expect: 0,
    text: [
      "| # | 断言 | 什么结果算被推翻 | 去哪里看 | 代价 |",
      "|---|---|---|---|---|",
      "| 1 | 客服首响中位数近三月高于 8 分钟 | 中位数低于 5 分钟 | 工单系统导出 | 低 |",
      "| 2 | 人均同时处理工单数上升 | 该指标近三月无趋势 | 同上 | 低 |",
    ].join("\n"),
  },
  {
    name: "证伪条件为空 → 必须报问题",
    expect: 1,
    text: [
      "| 断言 | 什么结果算被推翻 | 去哪里看 | 代价 |",
      "|---|---|---|---|",
      "| 客服响应慢 |  | 工单系统 | 低 |",
    ].join("\n"),
  },
  {
    name: "不可验证但写明缺什么 → 允许",
    expect: 0,
    text: [
      "| 断言 | 什么结果算被推翻 | 去哪里看 | 代价 |",
      "|---|---|---|---|",
      "| 团队士气下降 | 当前不可验证，缺季度匿名调研数据 | 无 | 高 |",
    ].join("\n"),
  },
  {
    name: "标了不可验证却没写缺什么 → 报问题",
    expect: 1,
    text: [
      "| 断言 | 什么结果算被推翻 | 去哪里看 | 代价 |",
      "|---|---|---|---|",
      "| 团队士气下降 | 不可验证 | 无 | 高 |",
    ].join("\n"),
  },
  {
    name: "表头缺列 → 报问题",
    expect: 1,
    text: [
      "| 断言 | 去哪里看 |",
      "|---|---|",
      "| 客服响应慢 | 工单系统 |",
    ].join("\n"),
  },
];

function selftest() {
  let failures = 0;
  for (const c of SELFTEST_CASES) {
    const { problems } = checkTable(c.text);
    const got = problems.length ? 1 : 0;
    const ok = got === c.expect;
    if (!ok) failures++;
    console.log(`${ok ? "✅" : "❌"} ${c.name}（期望退出 ${c.expect}，实际 ${got}）${ok || !problems.length ? "" : "  " + problems[0]}`);
  }
  console.log(failures === 0 ? "check-table 自检：全绿" : `check-table 自检：失败 ${failures} 项`);
  process.exit(failures === 0 ? 0 : 1);
}

const args = process.argv.slice(2);
if (args.includes("--selftest")) selftest();
else if (args.includes("--help") || args.includes("-h") || !args[0]) {
  process.stderr.write("用法: node check-table.mjs <表格文件.md> | --selftest\n");
  process.exit(args[0] || args.includes("--help") || args.includes("-h") ? 0 : 2);
} else {
  const text = fs.existsSync(args[0]) ? fs.readFileSync(args[0], "utf8") : args[0];
  const { rows, problems } = checkTable(text);
  if (problems.length) {
    process.stderr.write(`❌ 表格有问题（${rows} 行，${problems.length} 处）：\n`);
    for (const p of problems) process.stderr.write(`   - ${p}\n`);
    process.exit(1);
  }
  process.stdout.write(`✅ 表格合法（${rows} 行，列齐全，每条都有可执行的证伪条件）\n`);
  process.exit(0);
}
