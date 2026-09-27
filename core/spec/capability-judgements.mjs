// ============================================================================
// **能力 → 判据**的可执行清单（路线图 §24 O4）
//
// 判据（docs/13 §7）说得很清楚：**凡是声称"已支持"的能力，必须能指向一条真实判据
// （闸门 / 自检 / conformance 用例）；指不出来的，降级为"示例"或"未验证"**。
//
// 这份模块把那条纪律变成**可执行**的：解析 `docs/13` §1（起点）与 §2（保证）两张表，
// 从每行的「证据 / 判据」单元格里抽出引用（`make <目标>`、`node <脚本>`、路径、闸门检查 id），
// 逐个**解析到仓库里真实存在的东西**。解析不到 ⇒ 这一行就是"指不出的能力"。
//
// 为什么值得：文档里的"判据"最容易写成一个不存在或已改名的东西 —— 读起来完全正常，
// 直到有人真去跑才发现没有。机器能一眼看出来的事，不该留给人。
//
// 纯函数（只读文件），`tools/selfcheck.mjs` 与闸门 1 的 `docs/capability-judgements` 共用它。
// ============================================================================

import fs from "node:fs";
import path from "node:path";

/**
 * 解析 `docs/13` 的某张表（`## 1.` 或 `## 2.` 开头的两列/三列表）。
 * @returns {Array<{left: string, middle: string, right: string}>} 缺的列填空串
 */
export function parseTable(md, sectionNo) {
  const start = md.search(new RegExp(`^##\\s*${sectionNo}\\.`, "m"));
  if (start < 0) return [];
  const rest = md.slice(start + 1);
  const end = rest.search(/^##\s/m);
  const section = end < 0 ? rest : rest.slice(0, end);
  const lines = section.split("\n");
  const rows = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim().startsWith("|")) continue;
    const cells = lines[i].split("|").slice(1, -1).map((c) => c.trim());
    if (cells.length < 2) continue;
    if (/^-{2,}/.test(cells[0])) continue;                                  // 分隔行
    // **表头**：下一行是分隔行 ⇒ 这一行是表头，跳过（用结构判断，不靠关键字列表）
    const next = (lines[i + 1] ?? "").trim();
    if (next.startsWith("|") && /^\|[\s:-]+\|/.test(next) && !/[A-Za-z\u4e00-\u9fa5]/.test(next.replace(/\|/g, ""))) continue;
    rows.push({ left: cells[0], middle: cells[1] ?? "", right: cells[2] ?? "" });
  }
  return rows;
}

/** Makefile 里定义的目标名（含 `.PHONY` 之外的普通目标）。 */
export function makefileTargets(makefileText) {
  const names = new Set();
  for (const line of makefileText.split("\n")) {
    const m = /^([A-Za-z0-9_.-]+)\s*:(?!=)/.exec(line);
    if (m) names.add(m[1]);
  }
  return names;
}

/** 仓库里真实存在的闸门检查 id（静态扫源码里的 `pass(GATE, "id"` / `add("id"`）。 */
export function knownCheckIds(sources) {
  const ids = new Set();
  // conformance 用例 id（`C9` 这类）也是可指认的判据：它在 conformance/cases 里定义
  for (const text of sources) for (const m of text.matchAll(/^\s*id:\s*"(C\d+[a-z]?)"/gm)) ids.add(m[1]);
  for (const text of sources) {
    for (const m of text.matchAll(/(?:report|rep|gate)\.(?:pass|fail)\(\s*GATE\s*,\s*"([^"]+)"/g)) ids.add(m[1]);
    for (const m of text.matchAll(/\badd\(\s*"([a-z0-9][a-z0-9-]*)"/g)) ids.add(m[1]);
  }
  return ids;
}

const CHECK_ID_RE = /^[a-z][a-z0-9-]*\/[a-z0-9][a-z0-9.-]*$/;


/** 容器入口的子命令表（**单一真源**：`core/image/entrypoint.sh` 的 case 分支）。 */
export function entrypointSubcommands(entrypointText) {
  const names = new Set();
  for (const line of String(entrypointText).split("\n")) {
    const m = /^\s{2}([a-z][a-z0-9-]*)\)/.exec(line);
    if (m) names.add(m[1]);
  }
  return names;
}

/**
 * 从一段"判据"文字里抽出引用并逐个解析。
 * @param {string} text
 * @param {{targets: Set<string>, checkIds: Set<string>, repoDir: string}} ctx
 * @returns {Array<{kind: string, value: string, ok: boolean}>}
 */
export function resolveRefs(text, { targets, checkIds, repoDir, subcommands = new Set() }) {
  const refs = [];
  const seen = new Set();
  const push = (kind, value, ok) => {
    const key = `${kind}:${value}`;
    if (seen.has(key)) return;
    seen.add(key);
    refs.push({ kind, value, ok });
  };

  // `make <目标>`（含 `make x A=1 B=2`）
  for (const m of text.matchAll(/\bmake\s+([A-Za-z0-9_.-]+)/g)) push("make", m[1], targets.has(m[1]));
  // `node <路径>`
  for (const m of text.matchAll(/\bnode\s+([\w./-]+\.mjs)/g)) push("script", m[1], fs.existsSync(path.join(repoDir, m[1])));
  // 反引号里的路径（`core/...`、`tools/...`、`docs/...`、`adapters/...`）
  for (const m of text.matchAll(/`((?:core|tools|docs|adapters|conformance|examples)\/[\w./-]+)`/g)) {
    push("path", m[1], fs.existsSync(path.join(repoDir, m[1])));
  }
  // 反引号里的闸门检查 id（`docs/changelog-version`、`probe/hooks-evidenced`…）
  for (const m of text.matchAll(/`([a-z][a-z0-9-]*\/[a-z0-9][a-z0-9.-]*)`/g)) {
    if (CHECK_ID_RE.test(m[1])) push("check", m[1], checkIds.has(m[1]));
  }
  // conformance 用例 id（`C9`、`C10`…）
  for (const m of text.matchAll(/\b(C\d{1,2}[a-z]?)\b/g)) push("case", m[1], checkIds.has(m[1]));
  // 容器调用形式：`docker run … <镜像> <子命令>` ⇒ 子命令必须在入口脚本的 case 表里
  // （那才是契约的单一真源；凭空写一个不存在的子命令应当被拦住）
  for (const m of text.matchAll(/docker\s+run[^`\n]*?\s([a-z][a-z0-9-]+)\s*`/g)) {
    push("subcommand", m[1], subcommands.has(m[1]));
  }
  for (const m of text.matchAll(/`docker\s+run[^`]*?\s([a-z][a-z0-9-]+)`/g)) {
    push("subcommand", m[1], subcommands.has(m[1]));
  }
  // `LIVE=1` 这类**修饰符**：它不是判据本身，但要求同行另有一个可解析的判据（由调用方判定）
  if (/\bLIVE=1\b/.test(text)) push("modifier", "LIVE=1", true);
  return refs;
}

/**
 * 组装整份清单：§1（起点：能力有没有、证据是什么）与 §2（保证：判据在哪）。
 *
 * @param {{repoDir: string, docs13: string, makefileText: string, gateSources: string[]}} input
 * @returns {{rows: Array<{section: string, what: string, verdict: string, judgement: string,
 *                        refs: Array<{kind: string, value: string, ok: boolean}>, ok: boolean}>,
 *           unresolvable: Array<object>}}
 */
export function buildInventory({ repoDir, docs13, docs14 = null, makefileText, gateSources }) {
  const targets = makefileTargets(makefileText);
  const checkIds = knownCheckIds(gateSources);
  const entrypoint = path.join(repoDir, "core/image/entrypoint.sh");
  const subcommands = entrypointSubcommands(fs.existsSync(entrypoint) ? fs.readFileSync(entrypoint, "utf8") : "");
  const ctx = { targets, checkIds, repoDir, subcommands };

  const rows = [];
  for (const r of parseTable(docs13, 1)) {
    // §1 的列是「起点 | 现在有没有 | 证据」；❌ 行必须指向缺口记录（§4/§14），不要求可执行判据
    const verdict = r.middle;
    const refs = resolveRefs(r.right, ctx);
    const isGap = /❌/.test(verdict) || /缺/.test(verdict);
    const ok = isGap ? /§4|§14|缺口/.test(r.right) : refs.some((x) => x.ok);
    rows.push({ section: "§1", what: r.left, verdict, judgement: r.right, refs, ok });
  }
  for (const r of parseTable(docs13, 2)) {
    const refs = resolveRefs(`${r.middle} ${r.right}`, ctx);
    // `未实测` = **显式的降级状态**（与 docs/14 的"跳过不算通过"同一条纪律）：
    // 它满足"每条能力必须落到「有判据」或「明确降级」两者之一"，所以算 ok，但单独计数 ——
    // 这样"有判据的比例"是个能看的数，而不是被降级项悄悄拉平。
    const downgraded = /未实测/.test(`${r.middle} ${r.right}`);
    rows.push({ section: "§2", what: r.left, verdict: r.middle, judgement: r.right, refs, downgraded, ok: refs.some((x) => x.ok) || downgraded });
  }
  // `docs/14` 的三张表也纳入（能力清单 / 逐条判据 / 负例）—— 判据形式更杂，靠上面的解析器覆盖
  if (docs14) {
    // 缺口表由 `docs/gaps-not-done` 那条判据管（它验"引用的待办是否已完成"），这里不重复计
    const gapFirstCells = new Set(parseMarkedTable(docs14, "记在哪").map((cells) => cells[0]));
    for (const [no, label] of [[1, "§1 能力清单"], [3, "§3 逐条判据"], [4, "§4 负例"]]) {
      for (const r of parseTable(docs14, no)) {
        if (gapFirstCells.has(r.left)) continue;
        const refs = resolveRefs(`${r.middle} ${r.right}`, ctx);
        rows.push({ section: label, what: r.left, verdict: r.middle, judgement: r.right, refs, ok: refs.some((x) => x.ok) });
      }
    }
  }
  const unresolvable = rows.filter((r) => !r.ok);
  const downgraded = rows.filter((r) => r.downgraded).length;
  return { rows, unresolvable, downgraded, resolved: rows.length - unresolvable.length - downgraded };
}

/** 清单 → 给人看的文本。 */
export function renderInventory(inv) {
  const lines = ["能力 → 判据（可执行清单）", ""];
  const sections = [...new Set(inv.rows.map((r) => r.section))];
  for (const section of sections) {
    const rows = inv.rows.filter((r) => r.section === section);
    lines.push(`── ${section}：${rows.length} 条 ──`);
    for (const r of rows) {
      const mark = r.ok ? "✅" : "❌";
      const refs = r.refs.filter((x) => x.ok).map((x) => `${x.kind}:${x.value}`).join(" ");
      lines.push(`${mark} ${r.what.slice(0, 34)}${r.what.length > 34 ? "…" : ""}`);
      const note = r.downgraded ? "（**已显式降级为「未实测」**）"
        : r.ok ? refs || "（缺口记录）"
        : "**解析不到任何真实判据** ⇒ 删除或降级为「示例/未验证」";
      lines.push(`     ${note}`);
    }
    lines.push("");
  }
  lines.push(inv.unresolvable.length
    ? `❌ ${inv.unresolvable.length} 条能力指不出真实判据`
    : `✅ ${inv.rows.length} 条能力都能指向真实判据`);
  return lines.join("\n");
}

/** 静态扫描用到的源码（闸门检查 id 与 conformance 用例 id 的定义处）。 */
export function gateSources(repoDir) {
  const out = [];
  const walk = (dir, depth = 0) => {
    if (depth > 6 || !fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (["node_modules", "dist", ".render", ".git"].includes(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.name.endsWith(".mjs")) out.push(fs.readFileSync(p, "utf8"));
    }
  };
  for (const d of ["tools", "core", "conformance"]) walk(path.join(repoDir, d));
  return out;
}

/** 从仓库现场组装清单（`docs/13` §1/§2 + `docs/14` §1/§3/§4 + `Makefile` + 源码扫描）。 */
export function inventoryOf(repoDir) {
  return buildInventory({
    repoDir,
    docs13: fs.readFileSync(path.join(repoDir, "docs/13-developer-contract.md"), "utf8"),
    docs14: fs.existsSync(path.join(repoDir, "docs/14-how-to-verify.md"))
      ? fs.readFileSync(path.join(repoDir, "docs/14-how-to-verify.md"), "utf8") : null,
    makefileText: fs.readFileSync(path.join(repoDir, "Makefile"), "utf8"),
    gateSources: gateSources(repoDir),
  });
}

// ---------------------------------------------------------------------------
// 缺口清单**不许引用已完成项**（D7 的另一面：缺口写了却已经做完 = 文档在骗人）
// ---------------------------------------------------------------------------

/** 账本里每个条目 id 的状态（`| E5 | … | \`pending\` |` 这类行）。 */
export function ledgerStatus(md) {
  const out = new Map();
  for (const line of md.split("\n")) {
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    if (cells.length < 3) continue;
    const id = cells[0].replace(/[`*]/g, "").trim();
    if (!/^[A-Z][A-Za-z0-9-]{0,6}$/.test(id)) continue;
    const status = /`done`/.test(line) ? "done" : /`pending`|`部分`|`契约待评审`/.test(line) ? "pending" : "other";
    if (!out.has(id) || status === "done") out.set(id, status);   // done 优先
  }
  return out;
}

/** 从一段文字里抽待办 id（`E5`、`E5–E8`、`O5`、`A6b` …）。 */
export function citedIds(text) {
  const ids = new Set();
  for (const m of String(text).matchAll(/\b([A-Z]\d{1,2}[a-z]?)\b/g)) ids.add(m[1]);
  for (const m of String(text).matchAll(/\b([A-Z])(\d{1,2})[–-]([A-Z]?)(\d{1,2})\b/g)) {
    const [, pre, from, pre2, to] = m;
    if (pre2 && pre2 !== pre) continue;
    for (let i = Number(from); i <= Number(to); i++) ids.add(`${pre}${i}`);
  }
  return [...ids];
}

/** 检查一份"缺口清单"：每行都要有出处；引用的 id 必须存在且未完成。 */
export function auditGaps(rows, status) {
  const problems = [];
  const done = [];
  for (const r of rows) {
    const ids = citedIds(r.cites);
    if (!ids.length) { problems.push(`「${r.what.slice(0, 24)}」没有注明记在哪（应给待办 id，如 §23 E5）`); continue; }
    for (const id of ids) {
      if (!status.has(id)) problems.push(`「${r.what.slice(0, 24)}」引用了不存在的待办 id：${id}`);
      else if (status.get(id) === "done") done.push(`${id}（${r.what.slice(0, 18)}）`);
    }
  }
  return { problems, done, ok: problems.length === 0 && done.length === 0 };
}

/**
 * 按**表头关键字**解析一张表（跨文档通用）。用它而不是"按章节号"：
 * 缺口表可能挪章节，但"记在哪"这一列是它的语义标记。
 */
export function parseMarkedTable(md, headerKeyword) {
  const lines = md.split("\n");
  const rows = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim().startsWith("|")) continue;
    const header = lines[i].split("|").slice(1, -1).map((c) => c.trim());
    if (!header.some((c) => c.includes(headerKeyword))) continue;
    for (let j = i + 2; j < lines.length; j++) {
      if (!lines[j].trim().startsWith("|")) break;
      const cells = lines[j].split("|").slice(1, -1).map((c) => c.trim());
      if (cells.length < 2) continue;
      rows.push(cells);
    }
    break;
  }
  return rows;
}
