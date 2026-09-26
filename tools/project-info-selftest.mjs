// ============================================================================
// 项目自省 + 验证计划自检（路线图 §26 V2 / §30 A1）
//
// 判据是"AI 与人拿到的东西必须**同一份、可解析、可归因**"：
//   · CLI 出口（非交互）与逻辑层同源：同一份事实 ⇒ 同一段文本（不写第二份文案）
//   · 计划**分得清**"本地要跑的"与"只能在容器里成立的"，且后者每条带 `why`
//   · 计划的身份摘要齐全（换了输入就得重算）
//   · **容器断言声明与 C9 实现一致**：声明里的 id 必须真的存在；C9 里写出来的 id 必须都有归属
//     （防"加了检查但没归类" —— 这条是 §30 A4 失败归因的前提）
//   · 读不到产物 ⇒ 非零退出，不给半份报告
//
// 用法：node tools/project-info-selftest.mjs  （或 make project-info-selftest）
// ============================================================================

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { CATEGORIES, collect, render, verifyPlan } from "../core/introspect/project-info.mjs";
import { CONTAINER_ONLY, CONTAINER_CHECKS, IMAGE_CHECK_SOURCES, NOT_DECLARED } from "../core/introspect/_container-only.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const CLI = path.join(HERE, "project-info.mjs");

let failures = 0;
const check = (name, cond, extra = "") => {
  if (!cond) failures++;
  console.log(`${cond ? "✅" : "❌"} ${name}${cond || !extra ? "" : `\n      ${extra}`}`);
};

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

/** 造一个最小定义的临时智能体（自检不依赖仓库里的示例，免得示例一改这里就红）。 */
function makeAgent(name) {
  const agent = path.join(tmp("pi-agent-"), "agent");
  fs.mkdirSync(path.join(agent, "skills", "alpha"), { recursive: true });
  fs.writeFileSync(path.join(agent, "agent.yaml"),
    `apiVersion: agent-base/v1\nname: ${name}\ndescription: 自省自检\npersona: { instructions: 自检。 }\n`
    + `model: { provider: corp-gateway, name: corp-think }\nconnectorsFile: connectors.yaml\n`);
  fs.writeFileSync(path.join(agent, "connectors.yaml"), "apiVersion: agent-base/v1\nmcpServers: []\n");
  fs.writeFileSync(path.join(agent, "skills", "alpha", "SKILL.md"), "---\nname: alpha\ndescription: 一句话\n---\n正文\n");
  return agent;
}

const runCli = (args) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", cwd: REPO, timeout: 180000 });

console.log("── A. CLI 出口：非交互、可解析、与逻辑层同源 ──");
const agent = makeAgent("introspect-selftest");
const renderDir = path.join(tmp("introspect-out-"), "render");

const text = runCli([agent, "--render-dir", renderDir]);
check("CLI 文本出口退出码 0", text.status === 0, `${text.status} ${(text.stderr ?? "").slice(-200)}`);
check("文本里有声明计数（人一眼能看懂）", /声明计数/.test(text.stdout ?? ""), (text.stdout ?? "").slice(0, 120));

const json = runCli([agent, "--render-dir", renderDir, "--json"]);
check("CLI JSON 出口退出码 0", json.status === 0, (json.stderr ?? "").slice(-200));
let doc = null;
try { doc = JSON.parse(json.stdout); } catch { /* 下面报 */ }
check("JSON 可解析", !!doc);
check("JSON 带四个身份摘要", !!doc && ["definitionDigest", "artifactsDigest", "renderInputsDigest", "effectiveConfigDigest"].every((k) => typeof doc.identity?.[k] === "string"),
  JSON.stringify(doc?.identity));
check("JSON 的 sections 覆盖全部分类", !!doc && CATEGORIES.every((c) => typeof doc.sections?.[c.name] === "string"),
  JSON.stringify(Object.keys(doc?.sections ?? {})));

// 同源：CLI 的文本与直接调用逻辑层必须一致（路径无关的分类才可比）
const manifest = JSON.parse(fs.readFileSync(path.join(renderDir, "render-manifest.json"), "utf8"));
const productDir = path.join(renderDir, Object.values(manifest.runtimePlan?.env ?? {})[0] ?? "");
const facts = collect({ productDir, artifactDir: renderDir, gatesDir: REPO });
check("CLI 的 skills 段与逻辑层逐字一致（不写第二份文案）",
  doc?.sections?.skills === render("skills", facts),
  `CLI=${String(doc?.sections?.skills).slice(0, 60)}\n      逻辑=${render("skills", facts).slice(0, 60)}`);

console.log("\n── B. 验证计划：分区、why、身份 ──");
const plan = doc?.plan;
check("计划里有 local（本地要跑的四道闸门）", Array.isArray(plan?.local) && plan.local.length >= 4,
  JSON.stringify((plan?.local ?? []).map((s) => s.id)));
check("本地步骤带可执行命令与期望", (plan?.local ?? []).every((s) => s.cmd && s.expect));
check("计划里有 container（只能在容器成立的）", Array.isArray(plan?.container) && plan.container.length === CONTAINER_ONLY.length,
  JSON.stringify((plan?.container ?? []).map((c) => c.id)));
check("container 每条都写了 why（失败归因要用）", (plan?.container ?? []).every((c) => c.why && c.why.length > 8));
check("宿主上的计划如实列出 notCovered", JSON.stringify(plan?.notCovered) === JSON.stringify(CONTAINER_ONLY.map((c) => c.id)),
  JSON.stringify(plan?.notCovered));

const planJson = runCli([agent, "--render-dir", renderDir, "--plan", "--json"]);
let planOnly = null;
try { planOnly = JSON.parse(planJson.stdout); } catch { /* 下面报 */ }
check("`--plan --json` 直接给计划对象", !!planOnly?.identity && !!planOnly?.local, (planJson.stdout ?? "").slice(0, 120));

// 没有清单时**不许编**：身份摘要应为 null 而不是假值
const bare = verifyPlan({ manifest: null }, {});
check("读不到清单时身份摘要为 null（不编）",
  Object.values(bare.identity).every((v) => v === null), JSON.stringify(bare.identity));
check("读不到清单时仍给出 container 清单（这部分不依赖产物）", bare.container.length === CONTAINER_ONLY.length);

console.log("\n── C. 容器断言声明 ↔ C9 实现必须一致 ──");
{
  // C9 的检查是命令式写的（add("…")），这里做**静态**比对：
  //   正向：声明里的 id 必须真的存在于实现文件（防改名/删除后声明过期）
  //   反向：实现文件里写成字面量的 id 必须都有归属（防"加了检查没归类"）
  const sources = IMAGE_CHECK_SOURCES.map((rel) => {
    const f = path.join(REPO, rel);
    return fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "";
  }).join("\n");
  const implemented = new Set([...sources.matchAll(/\badd\("([a-z0-9-]+)"/g)].map((m) => m[1]));

  const missingInCode = CONTAINER_CHECKS.filter((id) => !implemented.has(id));
  check("声明里的每条容器断言都能在 C9 实现里找到", missingInCode.length === 0, `实现里没有：${missingInCode.join(", ")}`);

  const unclassified = [...implemented].filter((id) => !CONTAINER_CHECKS.includes(id) && !NOT_DECLARED.includes(id));
  check("C9 里的字面量断言 id 都有归属（未归类的列出来）", unclassified.length === 0,
    `未归类：${unclassified.join(", ")}（去 core/introspect/_container-only.mjs 归类，或写进 NOT_DECLARED 并说明理由）`);

  check("声明本身没有重复的 id", new Set(CONTAINER_CHECKS).size === CONTAINER_CHECKS.length);
}

console.log("\n── D. 负例：错的东西要响 ──");
const badCat = runCli([agent, "--render-dir", renderDir, "--category", "nope"]);
check("未知分类 ⇒ 退出码 2（用法错）", badCat.status === 2, String(badCat.status));
const badDir = runCli([path.join(os.tmpdir(), "introspect-does-not-exist"), "--render-dir", renderDir]);
check("智能体目录不存在 ⇒ 退出码 2", badDir.status === 2, String(badDir.status));
const badFlag = runCli([agent, "--nope"]);
check("未知旗标 ⇒ 非零退出并说明", badFlag.status !== 0 && /❌/.test(badFlag.stderr ?? ""), (badFlag.stderr ?? "").slice(0, 120));

console.log("");
if (failures) {
  console.log(`❌ 自省与验证计划自检：失败 ${failures} 项`);
  process.exit(1);
}
console.log("✅ 自省与验证计划自检：全绿");
