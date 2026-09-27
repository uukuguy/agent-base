#!/usr/bin/env node
// ============================================================================
// **运行时选型的事实材料**生成器（决策门的输入，不是结论）
//
//   node tools/gen-selection-facts.mjs          # 写 docs/design/2026-09-27-runtime-selection-facts.md
//   node tools/gen-selection-facts.mjs --check  # 只比对（给闸门 1 的同步检查用）
//
// 为什么生成而不是手写：选型讨论最怕"我记得那边好像不支持"——手写的对比表会在某次改动后
// 悄悄过期（D7），而**过期的事实比没有事实更坏**（它会以事实的语气误导决策）。
// 所以这里的每一条都从真源现算：
//   · 声明面覆盖  ← core/catalog/capabilities.yaml 的 harnesses.<h>.support/verified
//   · 机制差异    ← adapters/<h>/adapter.yaml 的 capabilities / hookEvents / enhancementShape
//   · 基座不变量  ← adapters/<h>/seed/enhancements.yaml 的声明 id（+ 是否有 seed 目录）
//   · 已声明差异  ← adapters/<h>/exemptions.yaml
//   · 已记录的坑  ← adapters/<h>/failures.md / adapter.yaml 的 failures/failureCases
//
// 纪律：**只陈述可核对的现状，不写建议**（建议属于决策记录，会随决策一起被评审）。
// ============================================================================

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

import { EXIT_CODES, parseArgs } from "../core/gates/index.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const OUT = path.join(REPO, "docs/design/2026-09-27-runtime-selection-facts.md");
const HARNESSES = fs.readdirSync(path.join(REPO, "adapters"), { withFileTypes: true })
  .filter((e) => e.isDirectory()).map((e) => e.name).sort();

const read = (p) => fs.readFileSync(p, "utf8");
const readYaml = (p) => YAML.parse(read(p));

/** 声明面：逐字段的 support/verified 统计。 */
function coverage() {
  const caps = readYaml(path.join(REPO, "core/catalog/capabilities.yaml"));
  const fields = caps.groups.flatMap((g) => g.fields ?? []);
  const per = {};
  for (const h of HARNESSES) {
    const t = { supported: 0, partial: 0, unsupported: 0, unknown: 0, verified: 0, unverified: 0 };
    for (const f of fields) {
      const e = f.harnesses?.[h];
      if (!e) continue;
      t[e.support] = (t[e.support] ?? 0) + 1;
      e.verified ? t.verified++ : t.unverified++;
    }
    per[h] = t;
  }
  return { total: fields.length, fields, per };
}

/** 机制差异：从 adapter.yaml 里取可比较的声明。 */
function mechanisms() {
  const out = {};
  for (const h of HARNESSES) {
    const a = readYaml(path.join(REPO, `adapters/${h}/adapter.yaml`));
    const caps = a.capabilities ?? {};
    const values = Object.fromEntries(Object.entries(caps).filter(([k]) => !k.endsWith("Note")));
    const notes = Object.fromEntries(Object.entries(caps).filter(([k]) => k.endsWith("Note")).map(([k, v]) => [k.replace(/Note$/, ""), String(v)]));
    out[h] = {
      version: a.version,
      isPrerelease: /-/.test(String(a.version)),          // 0.1.7-rc.1 这类
      package: a.package,
      hookEventsEnumerated: a.hookEvents?.enumerated === true,
      hookEventCount: (a.hookEvents?.events ?? []).length,
      enhancementShape: typeof a.enhancementShape === "object" ? JSON.stringify(a.enhancementShape).slice(0, 90) : String(a.enhancementShape ?? "(未声明)"),
      capabilities: values,
      capabilityNotes: notes,
      failures: (a.failures ?? []).length,
      failureCases: (a.failureCases ?? []).length,
      hasSeed: fs.existsSync(path.join(REPO, `adapters/${h}/seed`)),
      exemptions: (readYaml(path.join(REPO, `adapters/${h}/exemptions.yaml`)) ?? []).length,
    };
  }
  return out;
}

/**
 * 基座不变量：每侧**以什么形态**落地。
 *
 * 只看 seed 声明会得出"某侧缺 trace"这种**错误结论** —— 事实上该侧用事后映射
 * （`adapters/<h>/trace.mjs`）落地了同一个能力，只是形态不同。
 * 所以这里把"另一种落地形态"也纳入判定，并且**如实写出形态名**：
 * 选型材料里错一条事实，就会把决策带偏（这正是本文档要避免的）。
 */
const ALT_LANDINGS = {
  trace: { paths: ["trace.mjs"], label: "事后映射（`trace.mjs`，emitter=post-hoc）" },
};

function invariants() {
  const declared = {};
  for (const h of HARNESSES) {
    const f = path.join(REPO, `adapters/${h}/seed/enhancements.yaml`);
    declared[h] = fs.existsSync(f) ? (readYaml(f).enhancements ?? []).map((e) => e.id).sort() : [];
  }
  const all = [...new Set([...Object.values(declared).flat(), ...Object.keys(ALT_LANDINGS)])].sort();
  const shape = {};
  const missing = {};
  for (const h of HARNESSES) {
    shape[h] = {};
    for (const id of all) {
      if (declared[h].includes(id)) { shape[h][id] = `产物内声明（seed 的 \`${id}\`）`; continue; }
      const alt = ALT_LANDINGS[id];
      const hit = alt?.paths.find((p) => fs.existsSync(path.join(REPO, `adapters/${h}/${p}`)));
      shape[h][id] = hit ? alt.label : null;
    }
    missing[h] = all.filter((id) => !shape[h][id]);
  }
  return { declared, all, shape, missing };
}

/** 轨迹通道：进程内钩子写 vs 事后映射（从代码现象派生，不靠记忆）。 */
function traceChannel(h) {
  const seed = path.join(REPO, `adapters/${h}/seed/extensions/trace.ts`);
  const mapper = path.join(REPO, `adapters/${h}/trace.mjs`);
  const notes = [];
  if (fs.existsSync(seed)) notes.push("进程内钩子（`seed/extensions/trace.ts`，emitter=hook）");
  if (fs.existsSync(mapper)) notes.push("事后映射（`trace.mjs`，emitter=post-hoc）");
  return notes.join(" + ") || "(无)";
}

const main = () => {
  const { flags } = parseArgs(process.argv.slice(2), { booleanFlags: ["--check", "--help"] });
  if (flags.has("--help")) { process.stderr.write("用法: node tools/gen-selection-facts.mjs [--check]\n"); process.exit(EXIT_CODES.ok); }

  const cov = coverage();
  const mech = mechanisms();
  const inv = invariants();
  const L = [];
  L.push("<!-- 由 `make gen-selection-facts` 生成 —— 不要手改（闸门 1 的 `docs/selection-facts-sync` 会拦） -->");
  L.push("");
  L.push("# 运行时选型：事实材料（决策输入，不是结论）");
  L.push("");
  L.push("> 这是**决策门的输入**。每条都从真源现算，命令在文末给全 —— 事实过期比没有事实更坏，");
  L.push("> 所以它由 `tools/gen-selection-facts.mjs` 生成、由闸门 1 守同步，**不手写**。");
  L.push("> 结论与取舍写在 `docs/status/DECISIONS.md` 与路线图的决策门里，不在这份文件里。");
  L.push("");
  L.push(`生成时间不写进文件（那会让每次生成都不同、同步检查失去意义）；真源：\`core/catalog/capabilities.yaml\` · \`adapters/*/adapter.yaml\` · \`adapters/*/seed/\` · \`adapters/*/exemptions.yaml\`。`);
  L.push("");
  L.push("## 1. 声明面覆盖（中性定义的每个字段，两侧各支持到什么程度）");
  L.push("");
  L.push(`字段总数 **${cov.total}**（真源：能力目录）。`);
  L.push("");
  L.push("| 运行时 | supported | partial | unsupported | unknown | 已实测(verified) | 未实测 |");
  L.push("|---|---|---|---|---|---|---|");
  for (const h of HARNESSES) {
    const t = cov.per[h];
    L.push(`| \`${h}\` | ${t.supported} | ${t.partial} | ${t.unsupported} | ${t.unknown} | ${t.verified} | ${t.unverified} |`);
  }
  L.push("");
  L.push("## 2. 机制差异（两侧**必然不同**的地方，来自各自的 adapter.yaml）");
  L.push("");
  // 能力维度**从两侧声明的键的并集现算** —— 新增一个能力声明，这里自动出现（不会像手写清单那样漏）
  const capKeys = [...new Set(HARNESSES.flatMap((h) => Object.keys(mech[h].capabilities)))].sort();
  L.push(`能力维度（两侧 adapter.yaml 声明的键的并集，共 ${capKeys.length} 个）：`);
  L.push("");
  L.push(`| 能力 | ${HARNESSES.map((h) => `\`${h}\``).join(" | ")} |`);
  L.push(`|---|${HARNESSES.map(() => "---").join("|")}|`);
  for (const k of capKeys) {
    const cell = (h) => {
      const v = mech[h].capabilities[k];
      if (v === undefined) return "**（未声明）**";
      return `\`${Array.isArray(v) ? v.join("/") : v}\``;
    };
    L.push(`| \`${k}\` | ${HARNESSES.map(cell).join(" | ")} |`);
  }
  L.push("");
  const rows = [
    ["版本 pin", (h) => `\`${mech[h].version}\`${mech[h].isPrerelease ? "（**预发布**）" : ""}`],
    ["包", (h) => `\`${mech[h].package}\``],
    ["生命周期事件是否**穷举**", (h) => mech[h].hookEventsEnumerated ? `是（${mech[h].hookEventCount} 个）` : "**否** ⇒ 该侧钩子事件名只能标「未验证」"],
    ["增强形态", (h) => `\`${mech[h].enhancementShape}\``],
    ["轨迹通道", (h) => traceChannel(h)],
    ["有 seed（基座不变量落地处）", (h) => mech[h].hasSeed ? "有" : "无"],
    ["已记录的坑（adapter 声明）", (h) => `${mech[h].failures} 条 failures${mech[h].failureCases ? ` + ${mech[h].failureCases} 条 failureCases` : ""}`],
    ["已声明的等价性豁免", (h) => `${mech[h].exemptions} 条`],
  ];
  L.push("形态与工程事实：");
  L.push("");
  L.push(`| 维度 | ${HARNESSES.map((h) => `\`${h}\``).join(" | ")} |`);
  L.push(`|---|${HARNESSES.map(() => "---").join("|")}|`);
  for (const [label, fn] of rows) L.push(`| ${label} | ${HARNESSES.map(fn).join(" | ")} |`);
  L.push("");
  L.push("各能力维度的**实测备注**（真源里就写在 `*Note` 字段，这里只截首段；要全文看 adapter.yaml）：");
  L.push("");
  for (const k of capKeys) {
    for (const h of HARNESSES) {
      const note = mech[h].capabilityNotes[k];
      if (!note) continue;
      L.push(`- \`${h}\` / \`${k}\`：${note.replace(/\s+/g, " ").slice(0, 150)}${note.length > 150 ? "…" : ""}`);
    }
  }
  L.push("");
  L.push("## 3. 基座不变量（同一份能力，两侧各自的落地形态）");
  L.push("");
  L.push(`基座不变量的声明 id 全集（两侧 seed 的并集）：${inv.all.map((x) => `\`${x}\``).join(" · ")}`);
  L.push("");
  L.push(`| 不变量 | ${HARNESSES.map((h) => `\`${h}\``).join(" | ")} |`);
  L.push(`|---|${HARNESSES.map(() => "---").join("|")}|`);
  for (const id of inv.all) {
    const cell = (h) => inv.shape[h][id] ?? "**缺**";
    L.push(`| \`${id}\` | ${HARNESSES.map(cell).join(" | ")} |`);
  }
  L.push("");
  L.push("## 4. 与选型相关、且**目前没有答案**的点（机器能判的都在这儿了，剩下的要人拍板）");
  L.push("");
  const open = [];
  for (const h of HARNESSES) {
    if (!mech[h].hookEventsEnumerated) open.push(`\`${h}\` 的生命周期事件集合**未穷举** ⇒ 该侧钩子声明只能标「未验证」（要穷举得先量清运行时的可订阅集合）。`);
    if (!mech[h].hasSeed) open.push(`\`${h}\` 没有 seed ⇒ 基座不变量在该侧没有落地处。`);
    if (mech[h].isPrerelease) open.push(`\`${h}\` 当前 pin 是**预发布版本**（\`${mech[h].version}\`）⇒ 升级抖动风险需要单独评估。`);
    if (inv.missing[h].length) open.push(`\`${h}\` 的基座不变量**没有任何落地形态**：${inv.missing[h].map((x) => `\`${x}\``).join(" · ")}（选它当主运行时就得先补，见 §26 V3）。`);
    for (const k of [...new Set(HARNESSES.flatMap((x) => Object.keys(mech[x].capabilities)))]) {
      if (mech[h].capabilities[k] === undefined) {
        open.push(`\`${h}\` **没有声明** \`capabilities.${k}\`（另一侧有）⇒ 该维度无法比较：量它，或在 adapter.yaml 里如实写「未知」。`);
      }
    }
  }
  L.push(...(open.length ? open.map((x) => `- ${x}`) : ["- （机器能判的都清楚了）"]));
  L.push("");
  L.push("## 5. 怎么复核这份文件");
  L.push("");
  L.push("```bash");
  L.push("make gen-selection-facts        # 重新生成（内容不变就说明事实没漂）");
  L.push("make validate                   # 闸门 1 的 docs/selection-facts-sync 会拦不同步");
  L.push("make compare AGENT_DIR=<你的智能体目录>          # 两侧**等价性**（差异必须有声明）");
  L.push("node conformance/run.mjs --harness pi && node conformance/run.mjs --harness dsh  # 两侧同一套 C1–C10");
  L.push("```");
  L.push("");

  const text = L.join("\n");
  if (flags.has("--check")) {
    const cur = fs.existsSync(OUT) ? read(OUT) : null;
    if (cur === text) { process.stderr.write("✅ 选型事实材料与真源同步\n"); process.exit(EXIT_CODES.ok); }
    process.stderr.write("❌ 选型事实材料与真源不同步 —— 跑 `make gen-selection-facts`\n");
    process.exit(EXIT_CODES.static);
  }
  fs.writeFileSync(OUT, text);
  process.stderr.write(`✅ 已生成 ${path.relative(REPO, OUT)}（${text.split("\n").length} 行）\n`);
  process.exit(EXIT_CODES.ok);
};

export { coverage, mechanisms, invariants };
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) main();
