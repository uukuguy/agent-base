#!/usr/bin/env node
// ============================================================================
// 环境一致性检查：**动手前先查本机到底具不具备这次要验的东西**（路线图 §28 Q1 + Q2）
//
// 用法：
//   node tools/env-check.mjs [--json]
//
// 它回答三件事：
//   ① **未声明的差异** ⇒ 红（退出码 10）。已知差异在 `core/env/parity.mjs` 里声明过，
//      没声明就说明"本地与容器会不一致而没人知道" —— 那正是要拦的。
//   ② **本地缺项**（预装 npm 包不在本机镜像里、宿主缺某个工具）⇒ 如实列出，**不算失败**
//      （属已声明的环境差异），但必须在动手前说出来，别等容器里才发现。
//   ③ **容器才能验的那些**（安全下限 / 双架构 / 同源）⇒ 列出来，提醒"本地结论不含这些"。
//
// "期望"的来源只有两处，**不另写一份**：`adapters/*/adapter.yaml`（运行时 pin，经
// `core/catalog/adapter-pins.mjs`）与 `core/image/preinstall.lock.txt`（预装内容）。
// ============================================================================

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import YAML from "yaml";
import { EXIT_CODES, parseArgs } from "../core/gates/index.mjs";
import { readAdapterPins } from "../core/catalog/adapter-pins.mjs";
import { DIFFERENCE_CLASSES, classify } from "../core/env/parity.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const { flags, errors } = parseArgs(process.argv.slice(2), { booleanFlags: ["--json", "--help"] });
if (errors?.length) { process.stderr.write(`❌ ${errors.join("；")}\n`); process.exit(EXIT_CODES.usage); }
if (flags.has("--help")) { process.stderr.write("用法: node tools/env-check.mjs [--json]\n"); process.exit(EXIT_CODES.ok); }
const asJson = flags.has("--json");

/** 本机全局安装的 npm 包 → 版本。 */
function installedGlobal() {
  const r = spawnSync("npm", ["ls", "-g", "--depth=0", "--json"], { encoding: "utf8", timeout: 120000 });
  try {
    return Object.fromEntries(Object.entries(JSON.parse(r.stdout || "{}").dependencies ?? {}).map(([k, v]) => [k, v.version]));
  } catch { return {}; }
}

const has = (bin) => spawnSync("sh", ["-c", `command -v ${bin}`], { encoding: "utf8" }).status === 0;


/** 预装清单里声明的"本地查哪个命令"（apt 包名 ≠ 命令名）。真源是 core/image/preinstall.yaml。 */
function readLocalCommands() {
  const f = path.join(REPO, "core/image/preinstall.yaml");
  if (!fs.existsSync(f)) return {};
  const doc = YAML.parse(fs.readFileSync(f, "utf8"));
  const entry = (doc.entries ?? []).find((e) => e.localCommands);
  return entry?.localCommands ?? {};
}

/** 预装锁里的三类条目。 */function readLock() {
  const f = path.join(REPO, "core/image/preinstall.lock.txt");
  if (!fs.existsSync(f)) return { npm: [], apt: [], skill: [] };
  const out = { npm: [], apt: [], skill: [] };
  for (const line of fs.readFileSync(f, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const [kind, ...rest] = t.split(/\s+/);
    if (!(kind in out)) continue;
    if (kind === "apt") out.apt.push(...rest);
    else if (kind === "npm") out.npm.push(rest[0]);           // <pkg>@<ver>
    else out.skill.push(rest[0]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 采集事实（"期望"来自 pin 与锁；"实际"来自本机）
// ---------------------------------------------------------------------------
const findings = [];
const pins = readAdapterPins(REPO);
const installed = installedGlobal();
for (const p of pins) {
  const have = installed[p.pkg];
  if (have && have !== p.version) {
    // 版本漂移**不是可接受的差异** ⇒ 未声明 ⇒ 红（否则本地结论对不上镜像里的运行时）
    findings.push({ id: `harness:${p.adapter}`, classId: "harness-pin-drift", detail: `${p.pkg}：期望 ${p.version}，本机 ${have}` });
  } else if (!have) {
    findings.push({ id: `harness:${p.adapter}`, classId: "harness-pin-drift", detail: `${p.pkg}：期望 ${p.version}，本机未安装` });
  }
}

const lock = readLock();
const mirror = path.join(REPO, ".local-packages/node_modules");
const missingNpm = lock.npm.filter((spec) => {
  const name = spec.replace(/@[^@]+$/, "");
  return !fs.existsSync(path.join(mirror, name));
});
if (missingNpm.length) {
  findings.push({ id: "preinstall-npm", classId: "preinstall-npm-local", detail: `本机镜像里缺 ${missingNpm.length} 项：${missingNpm.map((s) => s.replace(/@[^@]+$/, "")).join(", ")}` });
}

// 宿主工具链：**apt 包名 ≠ 命令名**，所以查什么命令来自预装清单里的 `localCommands`（单一真源），
// 清单里没声明的（如 ca-certificates：它是数据不是命令）如实标"无法本地预检"，不假装查过。
const localCommands = readLocalCommands();
const missingTools = [];
const unprecheckable = [];
for (const pkg of lock.apt) {
  const cmd = localCommands[pkg];
  if (!cmd) { unprecheckable.push(pkg); continue; }
  if (!has(cmd)) missingTools.push(`${pkg}（命令 ${cmd}）`);
}
if (missingTools.length) {
  findings.push({ id: "host-toolchain", classId: "host-toolchain", detail: `宿主缺 ${missingTools.length} 个工具：${missingTools.join(", ")}` });
}

const { declared, undeclared, ok } = classify(findings);
const containerOnly = DIFFERENCE_CLASSES.filter((c) => c.id.startsWith("container-only:"));

const report = {
  where: "host",
  ok,
  declared,
  undeclared,
  // 本地**查不了**的项（清单里没声明的命令名等）—— 如实列出，不假装查过
  unprecheckable,
  // 本地**做不到**的那些（如实列出；本地结论里不含它们）
  notCoveredHere: containerOnly.map((c) => ({ id: c.id, label: c.label, why: c.why })),
  expectationSources: ["adapters/*/adapter.yaml（运行时 pin）", "core/image/preinstall.lock.txt（预装内容）", "core/image/preinstall.yaml（本地查哪个命令）"],
  checkOnly: true,
};

if (asJson) {
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
} else {
  const w = (s) => process.stderr.write(s + "\n");
  w("── 环境一致性（本地 vs 容器）──");
  w(`  期望来源：${report.expectationSources.join(" · ")}`);
  if (!findings.length) w("  ✅ 本机与 pin + 预装锁一致，没有发现差异");
  for (const f of declared) w(`  · 已声明差异 [${f.classId}] ${f.detail ?? f.id}`);
  for (const f of undeclared) w(`  ❌ 未声明的差异 [${f.classId}] ${f.detail ?? f.id}`);
  w(`  （本地做不到、容器才能验的 ${containerOnly.length} 类：${containerOnly.map((c) => c.id.replace("container-only:", "")).join(" / ")}）`);
  if (unprecheckable.length) w(`  （无法本地预检的 ${unprecheckable.length} 项：${unprecheckable.join(", ")} —— 不是命令，只能靠容器）`);
  w(ok ? "  ⇒ 可以做本地验证；注意上面的「容器才能验」这几类本地结论里没有" : "  ⇒ 先消掉未声明的差异，否则本地结论不可比");
}
process.exit(ok ? EXIT_CODES.ok : EXIT_CODES.static);
