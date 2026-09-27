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
  const rows = [];
  for (const line of section.split("\n")) {
    if (!line.trim().startsWith("|")) continue;
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    if (cells.length < 2) continue;
    if (/^-{2,}/.test(cells[0]) || cells[0] === "保证" || cells[0] === "起点") continue;
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
  for (const text of sources) {
    for (const m of text.matchAll(/(?:report|rep|gate)\.(?:pass|fail)\(\s*GATE\s*,\s*"([^"]+)"/g)) ids.add(m[1]);
    for (const m of text.matchAll(/\badd\(\s*"([a-z0-9][a-z0-9-]*)"/g)) ids.add(m[1]);
  }
  return ids;
}

const CHECK_ID_RE = /^[a-z][a-z0-9-]*\/[a-z0-9][a-z0-9.-]*$/;

/**
 * 从一段"判据"文字里抽出引用并逐个解析。
 * @param {string} text
 * @param {{targets: Set<string>, checkIds: Set<string>, repoDir: string}} ctx
 * @returns {Array<{kind: string, value: string, ok: boolean}>}
 */
export function resolveRefs(text, { targets, checkIds, repoDir }) {
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
export function buildInventory({ repoDir, docs13, makefileText, gateSources }) {
  const targets = makefileTargets(makefileText);
  const checkIds = knownCheckIds(gateSources);
  const ctx = { targets, checkIds, repoDir };

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
  const unresolvable = rows.filter((r) => !r.ok);
  const downgraded = rows.filter((r) => r.downgraded).length;
  return { rows, unresolvable, downgraded, resolved: rows.length - unresolvable.length - downgraded };
}

/** 清单 → 给人看的文本。 */
export function renderInventory(inv) {
  const lines = ["能力 → 判据（可执行清单）", ""];
  for (const section of ["§1", "§2"]) {
    const rows = inv.rows.filter((r) => r.section === section);
    if (!rows.length) continue;
    lines.push(`── ${section === "§1" ? "§1 起点（能力）" : "§2 保证（承诺）"}：${rows.length} 条 ──`);
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

/** 静态扫描用到的源码（闸门检查 id 的定义处）。 */
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

/** 从仓库现场组装清单（`docs/13` + `Makefile` + 源码扫描）。 */
export function inventoryOf(repoDir) {
  return buildInventory({
    repoDir,
    docs13: fs.readFileSync(path.join(repoDir, "docs/13-developer-contract.md"), "utf8"),
    makefileText: fs.readFileSync(path.join(repoDir, "Makefile"), "utf8"),
    gateSources: gateSources(repoDir),
  });
}
