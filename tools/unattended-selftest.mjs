// ============================================================================
// 无人值守端到端自检（路线图 §30 A5）—— 这条脚本就是"AI 能自己走完"的演示
//
// 判据：
//   ① **一条脚本化链路**：改定义 → 本地闸门 → 验证计划 → 环境预检 → 受控容器验证 → 失败归因
//   ② **每步都非交互且输出可解析**：不依赖交互式终端、不需要人复制粘贴；每步的 stdout 都是 JSON
//   ③ **同一输入重复触发结果一致**（命中缓存、不无效重跑），且缓存可绕过（`--no-cache`）
//
// 用法：node tools/unattended-selftest.mjs  （或 make unattended-selftest）
// ============================================================================

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");

let failures = 0;
const check = (name, cond, extra = "") => {
  if (!cond) failures++;
  console.log(`${cond ? "✅" : "❌"} ${name}${cond || !extra ? "" : `\n      ${extra}`}`);
};
const step = (label) => console.log(`\n── ${label} ──`);

/** 每一步都走这个函数：**stdio 全部管道**（没有 TTY ⇒ 不可能"等人回车"），并强制 stdout 是 JSON。 */
const history = [];
function runJson(tool, args, timeout = 900000) {
  const r = spawnSync(process.execPath, [path.join(HERE, tool), ...args], { encoding: "utf8", cwd: REPO, timeout });
  let doc = null;
  try { doc = JSON.parse(r.stdout); } catch { /* 下面按失败报 */ }
  history.push({ tool, status: r.status, parsed: !!doc });
  return { status: r.status, doc, stderr: r.stderr ?? "" };
}

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
function makeAgent(name, { brokenSkill = false } = {}) {
  const d = path.join(tmp("unattended-agent-"), name);
  fs.mkdirSync(path.join(d, "skills", "alpha"), { recursive: true });
  fs.writeFileSync(path.join(d, "agent.yaml"),
    `apiVersion: agent-base/v1\nname: ${name}\ndescription: 无人值守自检\npersona: { instructions: 自检。 }\n`
    + `model: { provider: corp-gateway, name: corp-think }\nconnectorsFile: connectors.yaml\n`);
  fs.writeFileSync(path.join(d, "connectors.yaml"), "apiVersion: agent-base/v1\nmcpServers: []\n");
  fs.writeFileSync(path.join(d, "skills", "alpha", "SKILL.md"),
    brokenSkill ? "---\nname: alpha\n---\n正文\n" : "---\nname: alpha\ndescription: 一句话\n---\n正文\n");
  return d;
}

console.log("无人值守链路：改定义 → 本地闸门 → 验证计划 → 环境预检 → 受控容器验证 → 失败归因");
const agent = makeAgent("unattended-ok");

step("① 本地闸门 1（非交互，JSON）");
const v = runJson("validate.mjs", [agent, "--json"]);
check("退出码 0 且 stdout 可解析为 JSON", v.status === 0 && !!v.doc, `status=${v.status}`);
check("四道闸门里本地能跑的都跑到了（这里只有闸门 1）",
  (v.doc?.gates ?? []).length === 1 && (v.doc?.gates?.[0]?.checks ?? []).every((c) => c.status === "pass"),
  JSON.stringify((v.doc?.gates ?? []).map((g) => g.id)));

step("② 验证计划：要验什么、哪些只能容器验（非交互，JSON）");
const plan = runJson("project-info.mjs", [agent, "--plan", "--json"]);
check("退出码 0 且 stdout 可解析为 JSON", plan.status === 0 && !!plan.doc, `status=${plan.status}`);
check("计划带四个身份摘要（结论可归因）",
  ["definitionDigest", "artifactsDigest", "renderInputsDigest", "effectiveConfigDigest"].every((k) => typeof plan.doc?.identity?.[k] === "string"),
  JSON.stringify(plan.doc?.identity));
check("本地步骤有命令与期望（照跑即可）",
  (plan.doc?.local ?? []).length >= 4 && plan.doc.local.every((s) => s.cmd && s.expect));
check("容器断言逐条带 why（失败归因要用）",
  (plan.doc?.container ?? []).length >= 4 && plan.doc.container.every((c) => c.why));
check("如实列出本次未覆盖的", (plan.doc?.notCovered ?? []).length >= 4, JSON.stringify(plan.doc?.notCovered));

step("③ 环境预检：本地与容器差在哪（非交互，JSON）");
const env = runJson("env-check.mjs", ["--json"]);
check("退出码与 ok 一致、stdout 可解析", !!env.doc && env.status === (env.doc.ok ? 0 : 10), `status=${env.status}`);
check("未声明差异为空（本机与 pin + 预装锁一致）", (env.doc?.undeclared ?? []).length === 0, JSON.stringify(env.doc?.undeclared));

step("④ 受控容器验证（非交互，JSON）");
const probe = runJson("verify-container.mjs", [agent, "--dry-run", "--json"]);
if (!probe.doc?.imageExists) {
  console.log(`⏭  本地没有镜像 ${probe.doc?.image} ⇒ ④⑤⑥ 未验（先 node core/image/build.mjs --arch ${probe.doc?.arch}）—— **不算通过**`);
} else {
  const c1 = runJson("verify-container.mjs", [agent, "--json"]);
  check("容器内验证通过且 stdout 可解析", c1.status === 0 && c1.doc?.usable === true, `status=${c1.status}`);
  check("结论标了出处与镜像摘要（可归因）",
    c1.doc?.where === "container" && String(c1.doc?.imageDigest).startsWith("sha256:"), JSON.stringify({ where: c1.doc?.where, imageDigest: c1.doc?.imageDigest }));
  check("覆盖与未覆盖都写清", (c1.doc?.covered ?? []).length >= 4 && (c1.doc?.notCovered ?? []).length >= 3);

  step("⑤ 同一输入重复触发：结果一致 + 不无效重跑");
  const c2 = runJson("verify-container.mjs", [agent, "--json"]);
  check("第二次命中缓存（没重新跑容器）", c2.doc?.cached === true, JSON.stringify({ cached: c2.doc?.cached }));
  check("两次结论一致（摘要与可用性都相同）",
    c2.doc?.identity?.artifactsDigest === c1.doc?.identity?.artifactsDigest && c2.doc?.usable === c1.doc?.usable,
    JSON.stringify({ a: c1.doc?.identity?.artifactsDigest, b: c2.doc?.identity?.artifactsDigest }));
  const c3 = runJson("verify-container.mjs", [agent, "--no-cache", "--json"]);
  check("缓存可绕过（--no-cache ⇒ 真跑）", c3.doc?.cached === false && typeof c3.doc?.durationMs === "number",
    JSON.stringify({ cached: c3.doc?.cached, durationMs: c3.doc?.durationMs }));

  step("⑥ 失败归因：容器挂 ≠ 代码有 bug（真造一个坏项目）");
  const broken = makeAgent("unattended-broken", { brokenSkill: true });
  const b = runJson("verify-container.mjs", [broken, "--no-cache", "--json"]);
  check("坏项目在容器里**未通过**且退出码非零", b.status !== 0 && b.doc?.usable === false, `status=${b.status}`);
  check("给出了归因（本地可复现 / 本地没跑到）",
    (b.doc?.attribution?.items ?? []).length > 0
    && b.doc.attribution.items.some((i) => i.verdict === "local-reproducible"),
    JSON.stringify(b.doc?.attribution?.items));
  check("没有未声明的差异（unknown 为空 ⇒ 不会去追错的线索）",
    (b.doc?.attribution?.unknown ?? []).length === 0, JSON.stringify(b.doc?.attribution?.unknown));
}

step("⑦ 全程无交互依赖（对整条链路做属性断言，不是恒真）");
{
  // 判据：每一次调用都① 有机器可读输出（说明没人被要求"按回车"或读人工提示）② 退出码落在语义集合里。
  // 这是**属性断言**：把一步写成恒真就等于"因错误原因通过"，本仓库最反对这个。
  const SEMANTIC = new Set([0, 2, 10, 20, 30, 40, 50]);
  check("链路确实跑了足够多步（≥6 次工具调用）", history.length >= 6, `实际 ${history.length} 次`);
  check("每一步的 stdout 都是可解析 JSON（没有靠人读提示才能继续）",
    history.every((h) => h.parsed), JSON.stringify(history.filter((h) => !h.parsed)));
  check("每一步的退出码都在语义集合内（0/2/10/20/30/40/50）",
    history.every((h) => SEMANTIC.has(h.status)), JSON.stringify(history.filter((h) => !SEMANTIC.has(h.status))));
  check("覆盖了全部五个环节（闸门/计划/预检/容器验证/归因）",
    new Set(history.map((h) => h.tool)).size >= 4, JSON.stringify([...new Set(history.map((h) => h.tool))]));
}

console.log("");
if (failures) {
  console.log(`❌ 无人值守端到端自检：失败 ${failures} 项`);
  process.exit(1);
}
console.log("✅ 无人值守端到端自检：全绿 —— 改定义到可归因的容器结论，全程不需要人转述");
