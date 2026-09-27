#!/usr/bin/env node
// ============================================================================
// **能力 → 判据**清单的可执行出口（路线图 §24 O4）
//
//   node tools/selfcheck.mjs [--json]
//
// 它读 `docs/13` §1（起点：能力）与 §2（保证：承诺），把每行的「证据 / 判据」解析到
// **仓库里真实存在的东西**（`make <目标>` / `node <脚本>` / 路径 / 闸门检查 id）：
//
//   · 解析得到 ⇒ ✅（列出解析到的引用）
//   · 解析不到 ⇒ ❌ **"指不出的能力"** —— 按 docs/13 §7 的纪律：删除，或降级为"示例/未验证"
//   · 该行显式写了「未实测」⇒ 记为**降级态**（满足"有判据 or 明确降级"两者之一，单独计数）
//
// 退出码：0 全部落地 · 10 有"指不出的能力"（闸门 1 的 `docs/capability-judgements` 同一条判据）。
// ============================================================================

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { EXIT_CODES, parseArgs } from "../core/gates/index.mjs";
import { inventoryOf, renderInventory } from "../core/spec/capability-judgements.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");

const { flags, errors } = parseArgs(process.argv.slice(2), { booleanFlags: ["--json", "--help"] });
if (errors?.length) { process.stderr.write(`❌ ${errors.join("；")}\n`); process.exit(EXIT_CODES.usage); }
if (flags.has("--help")) { process.stderr.write("用法: node tools/selfcheck.mjs [--json]\n"); process.exit(EXIT_CODES.ok); }

const main = () => {
  const inv = inventoryOf(REPO);
  if (flags.has("--json")) {
    process.stdout.write(JSON.stringify({
      total: inv.rows.length,
      resolved: inv.resolved ?? inv.rows.length - inv.unresolvable.length,
      downgraded: inv.downgraded ?? 0,
      unresolvable: inv.unresolvable.map((r) => ({ section: r.section, what: r.what, judgement: r.judgement })),
      rows: inv.rows.map((r) => ({ section: r.section, what: r.what, ok: r.ok, downgraded: !!r.downgraded,
        refs: r.refs.filter((x) => x.ok).map((x) => `${x.kind}:${x.value}`) })),
    }, null, 2) + "\n");
  } else {
    process.stdout.write(renderInventory(inv) + "\n");
  }
  process.exit(inv.unresolvable.length ? EXIT_CODES.static : EXIT_CODES.ok);
};

// 被 import 时只导出函数（供闸门 1 与自检复用），直接运行时才执行 CLI
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) main();
