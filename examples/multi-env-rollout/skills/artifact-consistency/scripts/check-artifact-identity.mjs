#!/usr/bin/env node
// ============================================================================
// 校验「同一制品跨环境一致性」核对表（技能脚本）
//
// 为什么值得机器校验：这张表最容易以**看起来很干净**的方式失效 ——
//   · 三行用了 `:latest` 这类可变标签，名字相同就当成"同一份"（同名可以被重新推送）
//   · 摘要抄错一位 / 有一行来自另一次构建，肉眼看不出，结论却是错的
//   · 摘要根本没写来源，事后无从复核
//   · 只写了一个环境，却下了"三个环境一致"的结论
// 这些都是"结论是否成立"级别的问题，不是措辞问题。所以由脚本机械判定。
//
// 用法：
//   node check-artifact-identity.mjs <核对表.md>    # 校验文件（或直接给表格文本）
//   node check-artifact-identity.mjs --selftest     # 自检（内置合法/非法样本）
// 退出码：0 通过 / 2 用法错误 / 1 有问题
//
// 表头必须含：环境 | 制品标识 | 来源（可再加"备注"）
// 制品标识必须能归一成 sha256:<64 位十六进制>；可变标签（latest/main/…）判错。
// ============================================================================

import fs from "node:fs";

/** 表格必须有的列。 */
const REQUIRED_COLUMNS = ["环境", "制品标识", "来源"];
/** 可变标签：名字相同不代表内容相同，不能作为"同一份制品"的证据。 */
const MUTABLE_TAG = /:(?:latest|main|master|stable|head|develop)\b/i;
/** 内容寻址摘要：允许可选的 sha256: 前缀，必须是 64 位十六进制。 */
const DIGEST = /^(?:sha256:)?([0-9a-f]{64})$/i;

/**
 * @returns {{rows: number, digests: string[], problems: string[]}}
 */
export function checkIdentity(text) {
  const problems = [];
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("|"));
  if (!lines.length) return { rows: 0, digests: [], problems: ["没有找到 Markdown 表格（行以 | 开头）"] };

  const cells = (l) => l.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
  const header = cells(lines[0]);
  for (const col of REQUIRED_COLUMNS) {
    if (!header.includes(col)) problems.push(`表头缺列「${col}」（现有：${header.join(" / ")}）`);
  }
  const body = lines.slice(1).filter((l) => !/^\|[\s|:-]+\|$/.test(l));   // 去掉分隔行
  if (!body.length) problems.push("表格没有数据行");
  if (body.length < 2) problems.push(`只有 ${body.length} 行数据 —— 至少要有两个环境，才谈得上「跨环境一致」`);

  const rows = [];
  body.forEach((line, i) => {
    const row = cells(line);
    const idx = (name) => header.indexOf(name);
    const rowNo = i + 1;
    const env = idx("环境") >= 0 ? row[idx("环境")] : "";
    const identity = idx("制品标识") >= 0 ? row[idx("制品标识")] : "";
    const source = idx("来源") >= 0 ? row[idx("来源")] : "";

    if (!env) problems.push(`第 ${rowNo} 行：环境为空 —— 不知道这条摘要是谁的`);
    if (!source) problems.push(`第 ${rowNo} 行：没写来源 —— 摘要必须标明从哪里取来，否则事后无法复核`);
    if (!identity) {
      if (idx("制品标识") >= 0) problems.push(`第 ${rowNo} 行：制品标识为空 —— 这一行没有证据`);
      return;
    }
    if (MUTABLE_TAG.test(identity)) {
      problems.push(`第 ${rowNo} 行：「${identity}」是可变标签 —— 同名可以被重新推送，不能用来证明「同一份制品」`);
      return;
    }
    const m = DIGEST.exec(identity);
    if (!m) {
      problems.push(`第 ${rowNo} 行：「${identity}」不是内容寻址摘要（应为 64 位十六进制，可带 sha256: 前缀）`);
      return;
    }
    rows.push({ env, digest: m[1].toLowerCase() });
  });

  const digests = [...new Set(rows.map((r) => r.digest))];
  if (digests.length > 1) {
    problems.push(
      `跨环境制品摘要不一致（${digests.length} 个不同摘要）：` +
      rows.map((r) => `${r.env}=${r.digest.slice(0, 12)}…`).join(" vs ") +
      " —— 这不是同一份制品，后续核对结论作废");
  }

  return { rows: body.length, digests, problems };
}

// ---------------------------------------------------------------------------
const D1 = "a".repeat(64);
const D2 = "b".repeat(64);
const HEAD = "| 环境 | 制品标识 | 来源 | 备注 |";
const SEP = "|---|---|---|---|";
const row = (env, id, src, note = "") => `| ${env} | ${id} | ${src} | ${note} |`;

const SELFTEST_CASES = [
  {
    name: "三环境同一摘要 → 合法",
    expect: 0,
    text: [HEAD, SEP, row("dev", `sha256:${D1}`, "部署记录"), row("staging", `sha256:${D1}`, "部署记录"), row("prod", D1, "制品库 API")].join("\n"),
  },
  {
    name: "摘要不一致 → 报问题",
    expect: 1,
    text: [HEAD, SEP, row("dev", `sha256:${D1}`, "部署记录"), row("staging", `sha256:${D2}`, "部署记录"), row("prod", D1, "制品库 API")].join("\n"),
  },
  {
    name: "用了可变标签 latest → 报问题",
    expect: 1,
    text: [HEAD, SEP, row("dev", "registry/app:latest", "部署记录"), row("staging", "registry/app:latest", "部署记录"), row("prod", "registry/app:latest", "部署记录")].join("\n"),
  },
  {
    name: "缺「来源」列 → 报问题",
    expect: 1,
    text: ["| 环境 | 制品标识 |", "|---|---|", `| dev | sha256:${D1} |`, `| staging | sha256:${D1} |`].join("\n"),
  },
  {
    name: "环境为空 → 报问题",
    expect: 1,
    text: [HEAD, SEP, row("", `sha256:${D1}`, "部署记录"), row("staging", `sha256:${D1}`, "部署记录")].join("\n"),
  },
  {
    name: "只有一个环境 → 报问题",
    expect: 1,
    text: [HEAD, SEP, row("dev", `sha256:${D1}`, "部署记录")].join("\n"),
  },
  {
    name: "写了摘要但没写来源 → 报问题",
    expect: 1,
    text: [HEAD, SEP, row("dev", `sha256:${D1}`, ""), row("staging", `sha256:${D1}`, "部署记录")].join("\n"),
  },
];

function selftest() {
  let failures = 0;
  for (const c of SELFTEST_CASES) {
    const { problems } = checkIdentity(c.text);
    const got = problems.length ? 1 : 0;
    const ok = got === c.expect;
    if (!ok) failures++;
    console.log(`${ok ? "✅" : "❌"} ${c.name}（期望退出 ${c.expect}，实际 ${got}）${ok || !problems.length ? "" : "  " + problems[0]}`);
  }
  console.log(failures === 0 ? "check-artifact-identity 自检：全绿" : `check-artifact-identity 自检：失败 ${failures} 项`);
  process.exit(failures === 0 ? 0 : 1);
}

const args = process.argv.slice(2);
if (args.includes("--selftest")) selftest();
else if (args.includes("--help") || args.includes("-h") || !args[0]) {
  process.stderr.write("用法: node check-artifact-identity.mjs <核对表.md> | --selftest\n");
  process.exit(args[0] || args.includes("--help") || args.includes("-h") ? 0 : 2);
} else {
  const text = fs.existsSync(args[0]) ? fs.readFileSync(args[0], "utf8") : args[0];
  const { rows, digests, problems } = checkIdentity(text);
  if (problems.length) {
    process.stderr.write(`❌ 制品一致性核对表有问题（${rows} 行，${problems.length} 处）：\n`);
    for (const p of problems) process.stderr.write(`   - ${p}\n`);
    process.exit(1);
  }
  process.stdout.write(`✅ 制品一致性成立（${rows} 行，内容寻址摘要 ${digests[0].slice(0, 12)}…，跨环境一致）\n`);
  process.exit(0);
}
