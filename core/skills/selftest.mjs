// ============================================================================
// 基座技能自检（L4 / C4）：落盘的三个编码技能必须**真的是技能**，不是空壳
//
// 判据（来自账本 C4）：
//   ① 每个技能有 `SKILL.md`，frontmatter 含 name 与 description（与智能体技能同一形状）
//   ② 内容不是占位：有实质小节、没有 TODO/待补/占位 之类字样
//   ③ 有一条**可执行的**自检（就是本文件；它自己也检查"被检查的东西存在"）
//   ④ 与 `preinstall.yaml` 的条目一一对应，且 status=shipped（未落盘的必须标 planned —— 反向也查）
//
// 用法：node core/skills/selftest.mjs
// ============================================================================

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");

let failures = 0;
const check = (name, cond, extra = "") => {
  if (!cond) failures++;
  console.log(`${cond ? "✅" : "❌"} ${name}${cond || !extra ? "" : `\n      ${String(extra).slice(0, 300)}`}`);
};

const preinstall = YAML.parse(fs.readFileSync(path.join(REPO, "core/image/preinstall.yaml"), "utf8"));
const skillEntries = (preinstall.entries ?? []).filter((e) => e.kind === "skill");
const shipped = skillEntries.filter((e) => e.status === "shipped");

console.log("── A. 清单与落盘一一对应 ──");
check("清单里有技能条目", skillEntries.length >= 3, JSON.stringify(skillEntries.map((e) => e.id)));
check("落盘的都标了 shipped", shipped.length === skillEntries.length,
  `shipped=${shipped.length}/${skillEntries.length}（未落盘的必须标 planned）`);
for (const e of skillEntries) {
  if (e.status !== "shipped") continue;
  check(`${e.id}: source 指向真实目录`, !!e.source && fs.existsSync(path.join(REPO, e.source)), String(e.source));
}

console.log("── B. 每个技能是**真的技能**（不是空壳）──");
const PLACEHOLDER = /(TODO|FIXME|待补|占位|placeholder|待写)/;
for (const e of shipped) {
  const dir = path.join(REPO, e.source);
  const file = path.join(dir, "SKILL.md");
  if (!fs.existsSync(file)) { check(`${e.id}: 有 SKILL.md`, false, file); continue; }
  const text = fs.readFileSync(file, "utf8");
  const fm = (() => { const m = /^---\n([\s\S]*?)\n---/.exec(text); try { return m ? YAML.parse(m[1]) : null; } catch { return null; } })();
  check(`${e.id}: frontmatter 可解析且含 name/description`,
    !!fm && typeof fm.name === "string" && typeof fm.description === "string" && fm.description.length > 8,
    JSON.stringify(fm));
  check(`${e.id}: frontmatter 的 name 与目录名一致`, fm?.name === path.basename(dir), `${fm?.name} vs ${path.basename(dir)}`);
  const body = text.replace(/^---[\s\S]*?---/, "");
  check(`${e.id}: 正文有实质内容（≥300 字）`, body.trim().length >= 300, `长度 ${body.trim().length}`);
  check(`${e.id}: 有分节（≥2 个二级标题）`, (body.match(/^## /gm) ?? []).length >= 2);
  check(`${e.id}: 没有占位字样（不许拿空骨架充数）`, !PLACEHOLDER.test(text), (text.match(PLACEHOLDER) ?? []).join(","));
}

console.log("── C. 技能进了能力包（L4）：不激活就不进产物 ──");
{
  const bundles = YAML.parse(fs.readFileSync(path.join(REPO, "core/catalog/bundles.yaml"), "utf8")).bundles;
  const codingSkills = bundles.find((b) => b.id === "coding")?.skills ?? [];
  const ids = shipped.map((e) => path.basename(e.source));
  check("三个技能都在 `coding` 包里（设计稿 §8：C1 是 coding 包的组成部分）",
    ids.every((id) => codingSkills.includes(id)), `包内=${JSON.stringify(codingSkills)} 技能=${JSON.stringify(ids)}`);
  const verifySkills = bundles.find((b) => b.id === "verify-baseline")?.skills ?? [];
  check("验证基线包里**不含**编码技能（验证要纯净）", !ids.some((id) => verifySkills.includes(id)), JSON.stringify(verifySkills));
}

console.log("── D. 清单条目的说明仍在（非专家可上手）──");
for (const e of shipped) check(`${e.id}: 写了「开发时拿它做什么」`, typeof e.devUse === "string" && e.devUse.length > 8, e.devUse);

console.log("");
if (failures) {
  console.log(`❌ 基座技能自检：失败 ${failures} 项`);
  process.exit(1);
}
console.log("✅ 基座技能自检：全绿");
