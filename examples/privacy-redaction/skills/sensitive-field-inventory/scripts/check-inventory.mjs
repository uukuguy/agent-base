#!/usr/bin/env node
// ============================================================================
// 敏感字段清单的机械自检（只读）
//
// 它**不判断定级对不对**（那是数据责任人的事），只钉住三件机械可判定的事：
//   ① 清单表必须具备「字段 / 类别 / 级别 / 依据」四列；
//   ② 类别与级别只能取技能里写死的那几个值；
//   ③ 依据必须真的写了东西，且「直接标识符」不得被定为低级别（技能的硬规则）。
//
// 为什么要脚本化：这三条最容易在"表格好看"的压力下被悄悄破坏 ——
// 依据列填「待定」、级别列填一个不存在的值，人眼扫过去都像没问题。
//
// 用法：
//   node check-inventory.mjs <清单.md>
//   node check-inventory.mjs --selftest
// 退出码：0 全部通过 / 1 有失败项 / 2 用法错误
// ============================================================================

import fs from "node:fs";

const CATEGORIES = ["直接标识符", "准标识符", "敏感属性", "一般属性"];
const LEVELS = ["高", "中", "低"];
const REQUIRED = ["字段", "类别", "级别", "依据"];
const PLACEHOLDER_EVIDENCE = ["待定", "待确认", "无", "-", "—", "n/a", "na", "todo", "tbd", "unknown", "?"];

// ---------------------------------------------------------------------------
function splitRow(line) {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
}

const isSeparator = (cells) => cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/.test(c));

/** 抽出所有 markdown 表格；返回 [{header, rows}]。 */
function parseTables(text) {
  const tables = [];
  let cur = null;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*\|/.test(line)) {
      const cells = splitRow(line);
      if (!cur) cur = { header: cells, rows: [] };
      else if (isSeparator(cells)) { /* 表头下的分隔行，跳过 */ }
      else cur.rows.push(cells);
    } else if (cur) {
      tables.push(cur);
      cur = null;
    }
  }
  if (cur) tables.push(cur);
  return tables;
}

/**
 * 检查一份清单文本。
 * @returns {{errors: {code: string, detail: string}[], rows: number, found: boolean}}
 */
export function checkInventory(text) {
  const errors = [];
  const tables = parseTables(text);
  // 取第一张"列齐"的表；找不到就报缺列，并指出实际见过哪些表头（不猜测意图）
  const table = tables.find((t) => REQUIRED.every((c) => t.header.includes(c)));
  if (!table) {
    const seen = tables.map((t) => t.header.join("/")).join("；") || "（没有解析到任何表格）";
    errors.push({ code: "no-inventory-table", detail: `没有一张表同时具备 ${REQUIRED.join(" / ")} 四列。实际表头：${seen}` });
    return { errors, rows: 0, found: false };
  }

  const at = (row, name) => {
    const i = table.header.indexOf(name);
    return i >= 0 && i < row.length ? row[i] : "";
  };

  for (const [n, row] of table.rows.entries()) {
    const where = `第 ${n + 1} 行（${at(row, "字段") || "字段为空"}）`;
    const category = at(row, "类别");
    const level = at(row, "级别");
    const evidence = at(row, "依据");

    if (!at(row, "字段")) errors.push({ code: "empty-field", detail: `${where}：字段名不能为空` });
    if (!CATEGORIES.includes(category)) {
      errors.push({ code: "unknown-category", detail: `${where}：类别「${category}」不在 ${CATEGORIES.join(" / ")} 内` });
    }
    if (!LEVELS.includes(level)) {
      errors.push({ code: "unknown-level", detail: `${where}：级别「${level}」不在 ${LEVELS.join(" / ")} 内` });
    }
    if (!evidence) {
      errors.push({ code: "empty-evidence", detail: `${where}：依据为空 —— 没依据就只能写「待确认」并说明缺什么` });
    } else if (PLACEHOLDER_EVIDENCE.includes(evidence.toLowerCase())) {
      errors.push({ code: "placeholder-evidence", detail: `${where}：依据是占位词「${evidence}」` });
    } else if (evidence.length < 4) {
      errors.push({ code: "thin-evidence", detail: `${where}：依据太短（${evidence.length} 字），写不出理由就标「待确认」` });
    }
    if (category === "直接标识符" && level !== "高") {
      errors.push({ code: "direct-identifier-not-high", detail: `${where}：直接标识符必须是「高」（技能硬规则），实际是「${level}」` });
    }
  }
  return { errors, rows: table.rows.length, found: true };
}

// ---------------------------------------------------------------------------
const VALID_SAMPLE = `
| 字段 | 所在材料 | 类别 | 级别 | 依据 | 处置建议 |
|---|---|---|---|---|---|
| id_card | 用户表 | 直接标识符 | 高 | 单独即可唯一定位到自然人 | 删除或不可逆替换 |
| birth_date | 用户表 | 准标识符 | 中 | 与邮编、性别组合可缩小范围，本样本内未验证唯一性 | 只保留到年龄段 |
`;

const INVALID_SAMPLE = `
| 字段 | 类别 | 级别 | 依据 |
|---|---|---|---|
| phone | 直接标识符 | 低 | 号码已加密 |
| age | 未知类别 | 中 |  |
| note | 一般属性 | 中 | 待定 |
`;

const MISSING_COLUMNS_SAMPLE = `
| 字段 | 类别 |
|---|---|
| email | 直接标识符 |
`;

function selftest() {
  const cases = [];
  const valid = checkInventory(VALID_SAMPLE);
  cases.push(["合法清单必须全绿", valid.errors.length === 0, JSON.stringify(valid.errors)]);

  const invalid = checkInventory(INVALID_SAMPLE);
  const codes = invalid.errors.map((e) => e.code);
  const want = ["direct-identifier-not-high", "unknown-category", "empty-evidence", "placeholder-evidence"];
  for (const w of want) cases.push([`非法清单必须报 ${w}`, codes.includes(w), `实际错误码：${codes.join(", ") || "（无）"}`]);

  const missing = checkInventory(MISSING_COLUMNS_SAMPLE);
  cases.push(["缺列必须报 no-inventory-table", missing.errors.some((e) => e.code === "no-inventory-table"), `实际：${missing.errors.map((e) => e.code).join(", ")}`]);

  let failed = 0;
  for (const [name, ok, detail] of cases) {
    if (!ok) failed++;
    process.stdout.write(`${ok ? "✅" : "❌"} ${name}${ok ? "" : ` —— ${detail}`}\n`);
  }
  process.stdout.write(`\n自检：${failed === 0 ? "全绿" : `失败 ${failed} 项`}（${cases.length} 项）\n`);
  return failed === 0 ? 0 : 1;
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write("用法: node check-inventory.mjs <清单.md> | --selftest\n");
    return 0;
  }
  if (args.includes("--selftest")) return selftest();
  const file = args.find((a) => !a.startsWith("-"));
  if (!file) {
    process.stderr.write("用法: node check-inventory.mjs <清单.md> | --selftest\n");
    return 2;
  }
  if (!fs.existsSync(file)) {
    process.stderr.write(`❌ 找不到文件：${file}\n`);
    return 2;
  }
  const { errors, rows, found } = checkInventory(fs.readFileSync(file, "utf8"));
  if (!found) {
    process.stderr.write(`❌ ${errors.map((e) => e.detail).join("\n")}\n`);
    return 1;
  }
  if (errors.length) {
    process.stderr.write(`❌ 清单自检失败 ${errors.length} 项（${rows} 行）：\n`);
    for (const e of errors) process.stderr.write(`   · [${e.code}] ${e.detail}\n`);
    return 1;
  }
  process.stdout.write(`✅ 清单结构合法（${rows} 行，四列齐备，枚举与依据规则都通过）\n`);
  return 0;
}

if (process.argv[1] && /check-inventory\.mjs$/.test(process.argv[1])) process.exit(main());
