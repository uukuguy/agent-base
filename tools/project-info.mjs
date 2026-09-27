#!/usr/bin/env node
// ============================================================================
// 项目自省的**命令行出口**（路线图 §26 V2 / §30 A1）
//
// 用法：
//   node tools/project-info.mjs [AGENT_DIR] [--harness pi] [--render-dir DIR]
//                               [--category <名字>] [--plan] [--json]
//
// 与**会话内**的斜杠命令共用同一份逻辑（`core/introspect/project-info.mjs`）——
// 不写第二份文案：改一处，两边同时变。这里只负责"渲染 → 组装 → 打印/序列化"。
//
// 为什么必须有这个出口：AI 驱动的工作流**不能依赖交互式会话**（§30 的判据：每一步都要有
// 非交互入口且输出可解析）。`--json` 是给 AI 读的，默认文本是给人读的，两者同一份数据。
//
// 退出码（core/gates/exit-codes.mjs）：0 正常 / 2 用法错 / 10 产物读不到（清单缺失等）/ 50 渲染失败。
// ============================================================================

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { EXIT_CODES, parseArgs } from "../core/gates/index.mjs";
import { CATEGORIES, collect, render, renderAll, summaryLine, verifyPlan, renderPlan } from "../core/introspect/project-info.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const log = (m) => process.stderr.write(m + "\n");

const { values, flags, positionals, errors } = parseArgs(process.argv.slice(2), {
  valueFlags: ["--harness", "--render-dir", "--category"],
  booleanFlags: ["--json", "--plan", "--help"],
});
// 未知旗标**必须报错**：静默忽略会让调用方（尤其是 AI）以为某个开关生效了。
// （`parseArgs` 的契约是"未声明的 `--x` 一律按开关处理"，所以"哪些是合法旗标"由调用方守住。）
const ALLOWED_FLAGS = new Set(["--json", "--plan", "--help"]);
const unknownFlags = [...flags].filter((f) => !ALLOWED_FLAGS.has(f));
if (unknownFlags.length) {
  log(`❌ 未知旗标：${unknownFlags.join(", ")} —— 可用：${[...ALLOWED_FLAGS].join(" / ")}（取值旗标：--harness / --render-dir / --category）`);
  process.exit(EXIT_CODES.usage);
}
if (errors?.length) { log(`❌ ${errors.join("；")}`); process.exit(EXIT_CODES.usage); }
if (flags.has("--help")) {
  log("用法: node tools/project-info.mjs [AGENT_DIR] [--harness pi] [--render-dir DIR] [--category X] [--plan] [--json]");
  process.exit(EXIT_CODES.ok);
}

const agentDir = path.resolve(positionals[0] ?? values["--agent-dir"] ?? ".");
const harness = values["--harness"] ?? "pi";
const renderDir = path.resolve(values["--render-dir"] ?? path.join(REPO, "dist", harness, path.basename(agentDir)));
const asJson = flags.has("--json");
const planOnly = flags.has("--plan");

// ---- 渲染（始终渲一次：与 tools/verify.mjs 同一策略 —— 不在这里重复实现"要不要复用"的判据）----
if (!fs.existsSync(agentDir)) { log(`❌ 智能体目录不存在：${agentDir}`); process.exit(EXIT_CODES.usage); }
const r = spawnSync(process.execPath, [path.join(REPO, `adapters/${harness}/render.mjs`), agentDir, "--out", renderDir],
  { encoding: "utf8", cwd: REPO });
if (r.status !== 0) {
  log(`❌ 渲染失败（退出码 ${r.status}）：`);
  log(`${(r.stdout ?? "")}\n${(r.stderr ?? "")}`.trim().split("\n").slice(-10).join("\n"));
  process.exit(EXIT_CODES.crash);
}
const manifest = JSON.parse(fs.readFileSync(path.join(renderDir, "render-manifest.json"), "utf8"));

// ---- 产物配置目录：**由本运行时的布局回答**（各运行时的产物形状不同，不猜）----
const layoutEnv = manifest.runtimePlan?.env ?? {};

// ---- 镜像输入摘要（现在按**源码树**算，不再需要构建上下文）----
let imageInputsDigest = null;
try {
  const mod = await import("../core/image/inputs-digest.mjs");
  imageInputsDigest = mod.imageInputsDigest(REPO);
} catch { /* 拿不到就如实写 null */ }

// ---- 本运行时的产物读法（core 不认识运行时，读法由各适配器提供）----
let projectLayout = null;
try {
  ({ projectLayout } = await import(`../adapters/${harness}/project-layout.mjs`));
} catch { projectLayout = null; }   // 该运行时还没有布局模块 ⇒ 退回"只读清单"

// 配置目录：**由布局回答**（各运行时的产物形状不同），布局没提供时才用布局值兜底
const layoutEnvForDir = manifest.runtimePlan?.env ?? {};
const configRel2 = Object.values(layoutEnvForDir)[0];
const fromLayout = projectLayout?.configDir?.({ artifact: renderDir, env: layoutEnvForDir, agent: manifest.agent }) ?? null;
const productDir = fromLayout ?? (configRel2 ? path.join(renderDir, configRel2) : renderDir);

const facts = collect({ productDir, artifactDir: renderDir, gatesDir: REPO, layout: projectLayout });
const plan = verifyPlan(facts, {
  agentDir: path.relative(REPO, agentDir) || agentDir,
  renderDir: path.relative(REPO, renderDir) || renderDir,
  harness,
  where: "host",
  imageInputsDigest,
});

// ---- 产物读不到 ⇒ 非零退出（不静默给半份报告）----
if (facts.problems.length) {
  log("❌ 读不到这个项目的产物，因此无法报告（不猜）：");
  for (const p of facts.problems) log(`   · ${p}`);
  process.exit(EXIT_CODES.static);
}

if (planOnly) {
  process.stdout.write((asJson ? JSON.stringify(plan, null, 2) : renderPlan(plan)) + "\n");
  process.exit(EXIT_CODES.ok);
}

const category = values["--category"] ?? null;
if (category && !CATEGORIES.some((c) => c.name === category)) {
  log(`❌ 未知分类：${category}（可用：${CATEGORIES.map((c) => c.name).join(" / ")}）`);
  process.exit(EXIT_CODES.usage);
}

if (asJson) {
  // 一份 JSON 里同时给"人看的文本"与"计划"：AI 想读哪层都行，且都来自同一份事实
  const sections = Object.fromEntries(CATEGORIES.map((c) => [c.name, render(c.name, facts)]));
  process.stdout.write(JSON.stringify({
    agent: facts.manifest?.agent ?? null,
    harness,
    productDir,
    renderDir,
    identity: plan.identity,
    summary: summaryLine(facts),
    sections: category ? { [category]: sections[category] } : sections,
    plan,
  }, null, 2) + "\n");
} else {
  process.stdout.write((category ? render(category, facts) : renderAll(facts)) + "\n");
}
process.exit(EXIT_CODES.ok);
