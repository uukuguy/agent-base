// ============================================================================
// 环境一致性自检（路线图 §28 Q1/Q2）
//
// 判据是"差异必须**可见**、且**未声明的差异会红**"：
//   · 声明分类本身自洽（不重复、容器断言那部分确实来自 C9 的声明）
//   · 归类函数：命中已声明分类 ⇒ 不算失败；命中未声明分类 ⇒ 红
//   · CLI JSON 的字段齐全（AI 要读），退出码与 `ok` 一致
//   · **每个 apt 包要么可查、要么明确列进 unprecheckable**（不许有包被静默跳过 —— 那会让
//     "本地缺项"变成看不见的东西，正是这条线要消灭的）
//
// 用法：node tools/env-check-selftest.mjs  （或 make env-check-selftest）
// ============================================================================

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

import { DECLARED_IDS, DIFFERENCE_CLASSES, classify, precheckableClasses } from "../core/env/parity.mjs";
import { CONTAINER_ONLY } from "../core/introspect/_container-only.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");

let failures = 0;
const check = (name, cond, extra = "") => {
  if (!cond) failures++;
  console.log(`${cond ? "✅" : "❌"} ${name}${cond || !extra ? "" : `\n      ${extra}`}`);
};

console.log("── A. 声明本身 ──");
check("分类 id 不重复", new Set(DECLARED_IDS).size === DECLARED_IDS.length, DECLARED_IDS.join(", "));
check("容器断言那部分来自 C9 的声明（不另列一份）",
  CONTAINER_ONLY.every((c) => DECLARED_IDS.includes(`container-only:${c.id}`)),
  DECLARED_IDS.join(", "));
check("每条差异都写了 why（失败归因要用）", DIFFERENCE_CLASSES.every((c) => c.why && c.why.length > 8));
check("标了 precheckable 的分类有名字可查", precheckableClasses().length >= 2, precheckableClasses().map((c) => c.id).join(", "));

console.log("\n── B. 归类：未声明的差异必须红 ──");
const declaredOnly = classify([{ id: "x", classId: "host-toolchain", detail: "缺 rg" }]);
check("命中已声明分类 ⇒ 不算失败", declaredOnly.ok && declaredOnly.declared.length === 1 && declaredOnly.undeclared.length === 0);
const withUndeclared = classify([{ id: "y", classId: "harness-pin-drift", detail: "pi 期望 1.0 本机 0.9" }]);
check("命中未声明分类 ⇒ 红（ok=false 且列在 undeclared）", !withUndeclared.ok && withUndeclared.undeclared.length === 1);
const mixed = classify([
  { id: "a", classId: "preinstall-npm-local" },
  { id: "b", classId: "harness-pin-drift" },
  { id: "c", classId: "host-toolchain" },
]);
check("混合时按类分开（declared 2 / undeclared 1）", mixed.declared.length === 2 && mixed.undeclared.length === 1 && !mixed.ok);
check("空输入 ⇒ 通过", classify([]).ok);

console.log("\n── C. CLI 出口 ──");
const r = spawnSync(process.execPath, [path.join(HERE, "env-check.mjs"), "--json"], { encoding: "utf8", cwd: REPO, timeout: 180000 });
let doc = null;
try { doc = JSON.parse(r.stdout); } catch { /* 下面报 */ }
check("--json 可解析", !!doc, (r.stdout ?? "").slice(0, 120));
check("字段齐全（AI 要读这些）",
  !!doc && ["where", "ok", "declared", "undeclared", "unprecheckable", "notCoveredHere", "expectationSources"].every((k) => k in doc),
  JSON.stringify(Object.keys(doc ?? {})));
check("声明了结论出处（where=host）", doc?.where === "host");
check("期望来源写清（pin 与预装锁）", (doc?.expectationSources ?? []).some((s) => /adapter\.yaml/.test(s)) && (doc?.expectationSources ?? []).some((s) => /preinstall\.lock/.test(s)));
check("退出码与 ok 一致（0 / 10）", r.status === (doc?.ok ? 0 : 10), `status=${r.status} ok=${doc?.ok}`);

console.log("\n── D. 不变量：apt 包不许被静默跳过 ──");
{
  const manifest = YAML.parse(fs.readFileSync(path.join(REPO, "core/image/preinstall.yaml"), "utf8"));
  const declaredCommands = Object.keys(manifest.entries?.find((e) => e.localCommands)?.localCommands ?? {});
  const lockText = fs.readFileSync(path.join(REPO, "core/image/preinstall.lock.txt"), "utf8");
  const aptLine = lockText.split("\n").find((l) => l.startsWith("apt ")) ?? "";
  const aptPackages = aptLine.replace(/^apt\s+/, "").trim().split(/\s+/).filter(Boolean);
  const unpre = new Set(doc?.unprecheckable ?? []);
  const skipped = aptPackages.filter((p) => !declaredCommands.includes(p) && !unpre.has(p));
  check("每个 apt 包：要么声明了本地命令、要么明确列进 unprecheckable", skipped.length === 0,
    `被静默跳过：${skipped.join(", ")}（在 core/image/preinstall.yaml 的 localCommands 里补命令，或由 env-check 列入 unprecheckable）`);
  check("锁里确实有 apt 条目（否则这条不变量是空转）", aptPackages.length > 0, aptLine);
}

console.log("");
if (failures) {
  console.log(`❌ 环境一致性自检：失败 ${failures} 项`);
  process.exit(1);
}
console.log("✅ 环境一致性自检：全绿");
