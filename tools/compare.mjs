#!/usr/bin/env node
// ============================================================================
// 跨运行时等价性比对
//
// 用法：node tools/compare.mjs <AGENT_DIR> [--harnesses pi,dsh] [--json]
//
// ## 它在比什么（以及不比什么）
//
// 比的是**中性定义层面应当一致**的东西：
//   · 技能集合          · 连接器集合          · 模型路由
//   · 每个运行时是否"自证通过"（doctor 的三条硬断言）
//
// **不**比运行时专有的东西：工具名、提示词拼装细节、token 计数、扩展形态。
// 那些本来就不同（机制不同），要求它们相同是错的。
//
// ## 关键判据：**不允许沉默的不等价**
//
// 两侧出现的任何差异，必须能被某个运行时的 `exemptions.yaml` 解释（按 scope 匹配）。
// 解释不了 ⇒ 失败。这条是设计 §4.6 的落地：可以不一样，但不许悄悄不一样。
// ============================================================================

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { EXIT_CODES, parseArgs } from "../core/gates/index.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");

const { values, flags, positionals, errors } = parseArgs(process.argv.slice(2), { valueFlags: ["--harnesses"] });
if (errors.length || !positionals[0]) {
  process.stderr.write("用法: node tools/compare.mjs <AGENT_DIR> [--harnesses pi,dsh] [--json]\n");
  process.exit(EXIT_CODES.usage);
}
const agentDir = path.resolve(positionals[0]);
const asJson = flags.has("--json");

/** 本仓库当前接入的运行时（按目录发现，不写死）。 */
function harnessesPresent() {
  return fs.readdirSync(path.join(REPO, "adapters"), { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(REPO, "adapters", e.name, "adapter.yaml")))
    .map((e) => e.name).sort();
}
const harnesses = (values["--harnesses"] ? values["--harnesses"].split(",") : harnessesPresent()).map((x) => x.trim());

/** 该运行时声明的豁免（用来解释"为什么这里可以不一样"）。 */
function exemptionsOf(h) {
  const f = path.join(REPO, "adapters", h, "exemptions.yaml");
  if (!fs.existsSync(f)) return [];
  const doc = YAML.parse(fs.readFileSync(f, "utf8"));
  // 豁免文件是**顶层列表**（不是 {exemptions: [...]}）—— 两种都容忍，别因为读错格式就以为"没有豁免"
  return Array.isArray(doc) ? doc : (doc?.exemptions ?? []);
}

/** 对某个运行时：渲染 + 自证，取出可比对的量。 */
function survey(h) {
  const out = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", `cmp-${h}-`));
  const r = spawnSync(process.execPath, [path.join(REPO, `adapters/${h}/render.mjs`), agentDir, "--out", out, "--json"], { encoding: "utf8", cwd: REPO });
  if (r.status !== 0) return { harness: h, rendered: false, error: (r.stderr ?? "").slice(-300) };
  const manifest = JSON.parse(fs.readFileSync(path.join(out, "render-manifest.json"), "utf8"));

  const d = spawnSync(process.execPath, [path.join(REPO, `adapters/${h}/doctor.mjs`), out, "--json"], { encoding: "utf8", cwd: REPO });
  let doctor = null;
  try { doctor = JSON.parse(d.stdout); } catch { /* 自证失败时下面是 null，由调用方报出 */ }

  return {
    harness: h,
    rendered: true,
    providerApi: manifest.modelProviderApi ?? null,
    skills: [...(manifest.declaredSkills ?? [])].sort(),
    connectors: (manifest.connectors ?? []).map((c) => c.serverName ?? c.name).filter(Boolean).sort(),
    routes: [...(manifest.modelProviders ?? [])].sort(),
    // 增强（业务级定制）：两侧各自声明了什么。D3 之前它完全不在比对范围内。
    enhancements: [...(manifest.declaredEnhancements ?? [])].sort(),
    doctorOk: d.status === 0,
    doctorError: d.status === 0 ? null : (d.stderr ?? d.stdout ?? "").slice(-200),
    connectorsScope: doctor?.doctor?.connectorsObservationScope ?? null,
  };
}

const rows = harnesses.map(survey);
const problems = [];

// ---- 判据 1：每个运行时都必须渲染成功 ----
for (const r of rows) {
  if (!r.rendered) problems.push(`${r.harness}: 渲染失败 —— ${r.error}`);
  else if (!r.doctorOk) problems.push(`${r.harness}: 自证失败 —— ${r.doctorError}`);
}

// ---- 判据 2：中性定义层的三组集合必须一致 ----
const fields = [
  ["skills", "技能集合"],
  ["connectors", "连接器集合"],
  ["routes", "模型路由"],
  // 增强允许单边存在（业务级定制本来就是按运行时做的），但**必须被豁免解释** ——
  // 否则"同一份定义在两个运行时上跑的东西不一样"这件事就没有人知道。
  ["enhancements", "业务级增强"],
];
const compared = [];
for (const [key, label] of fields) {
  const vals = rows.filter((r) => r.rendered).map((r) => [r.harness, r[key]]);
  if (vals.length < 2) break;
  const base = JSON.stringify(vals[0][1]);
  const same = vals.every(([, v]) => JSON.stringify(v) === base);
  compared.push({ key, label, same, values: Object.fromEntries(vals) });
  if (!same) {
    // 不一致时：必须能被某个豁免解释（scope 命中该字段）
    const covered = harnesses.some((h) => exemptionsOf(h).some((e) => String(e.scope ?? "").includes(key === "routes" ? "model" : key)))
      // 增强集合的单边差异：只要**至少有一个运行时**在豁免里声明过增强作用域，就算已知差异。
      || (key === "enhancements" && harnesses.some((h) => exemptionsOf(h).some((e) => /enhance/i.test(`${e.scope ?? ""} ${e.id ?? ""} ${e.note ?? ""}`))));
    if (!covered) problems.push(`${label}两侧不一致且**没有任何运行时声明豁免**：${vals.map(([h, v]) => `${h}=[${v.join(",")}]`).join(" vs ")}`);
  }
}

// ---- 判据 3：路由的协议形状必须一致（否则"同一份定义"其实跑在不同协议上）----
const apis = [...new Set(rows.filter((r) => r.rendered).map((r) => r.providerApi))];
if (apis.length > 1) problems.push(`路由协议形状不一致：${rows.map((r) => `${r.harness}=${r.providerApi}`).join(" vs ")}`);

// ---- 已知不等价（来自豁免声明，供读者对照）----
const asymmetries = harnesses.flatMap((h) => exemptionsOf(h).map((e) => ({ harness: h, id: e.id, scope: e.scope })));

if (asJson) {
  process.stdout.write(JSON.stringify({
    agent: path.basename(agentDir),
    harnesses,
    compared,
    providerApis: apis,
    asymmetries,
    problems,
    equivalent: problems.length === 0,
  }, null, 2) + "\n");
} else {
  process.stdout.write(`\n比对对象：${path.basename(agentDir)}　　运行时：${harnesses.join(" / ")}\n\n`);
  for (const c of compared) {
    process.stdout.write(`${c.same ? "✅" : "⚠️"} ${c.label}\n`);
    for (const [h, v] of Object.entries(c.values)) process.stdout.write(`     ${h.padEnd(5)} ${v.length ? v.join(", ") : "(空)"}\n`);
  }
  process.stdout.write(`\n${apis.length <= 1 ? "✅" : "⚠️"} 路由协议形状：${apis.join(" / ") || "(无)"}\n`);
  process.stdout.write(`\n需要知道的**已声明差异**（不可避免，但都写下来了）：\n`);
  for (const a of asymmetries) process.stdout.write(`  · [${a.harness}] ${a.id}　scope=${a.scope}\n`);
  if (!asymmetries.length) process.stdout.write("  （无）\n");
  process.stdout.write(problems.length
    ? `\n❌ 比对未通过：\n${problems.map((p) => `  · ${p}`).join("\n")}\n`
    : `\n✅ 等价性通过：中性定义层与增强层的集合两侧一致（差异均有声明），差异均有声明。\n`);
}

process.exit(problems.length ? EXIT_CODES.static : EXIT_CODES.ok);
