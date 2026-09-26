// ============================================================================
// dsh doctor：解析自证（统一设计 §6.3 · 闸门 2）
//
// ## 它回答什么
//
//   「运行时**实际**加载了什么」—— 不是"我们以为它加载了什么"。
//   零凭据：靠 `--dump-config`（组合后打印完整 profile 树后退出，不挂载、不连网）。
//
// ## 为什么这一条对 dsh 特别重要
//
//   failures.md 的 **D1**：patch 的 target id 不存在时，该 harness **只打警告、退出码 0、继续跑**。
//   也就是说"配置写了但没生效"在它这里**完全静默**。所以 doctor 的第一条硬断言就是
//   「patch 里每个 target id 都出现在组合树里」—— 这是 D1 的**唯一防线**，是基座在替上游报它不报的错。
//
// ## 与另一个 harness 的不对称（必须写下来，不许假装一样）
//
//   · 技能集合：pi 侧能问 harness「实际加载了哪些技能」；dsh 侧只能从组合树看到
//     `skill-filesystem.customSkillDirs`（**配置了什么目录**），再核对目录里的 SKILL.md 存在。
//     口径是"已配置且就位"，不是"已被发现"。差异进 exemptions.yaml。
//   · 增强集合：dsh 侧反而更好 —— 组合树列出了全部 row，因此"insert 的增强行在不在、是否被禁用"
//     是**可直接观测**的；pi 侧只能看"是否进了产物"（failures.md F6）。
// ============================================================================

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
// 暂存走运行期那一份实现（run.mjs → core/image/startup.mjs）：自证要验的是"运行时会加载什么"
import { stageRenderDir } from "./run.mjs";
import { EXIT_CODES, GateReport, computeEffectiveConfigDigest, parseArgs } from "../../core/gates/index.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HARNESS = "dsh";
const GATE = "resolution";
const log = (m) => process.stderr.write(m + "\n");

const readYaml = (f) => YAML.parse(fs.readFileSync(f, "utf8"));

/**
 * 组合树 → 条目列表。
 *
 * 用**按行 + 缩进的状态机**，而不是一个正则抓 config 块 —— 试过正则，被 YAML 的折叠值与
 * 数组值坑了（`customSkillDirs:` 后面跟 `- 值`；`policy: !!js >-` 后面跟折行续行）。
 * 这两种在组合树里都会出现，漏掉会让 doctor 误报"配置没进产物"。
 */
export function parseComposedTree(text) {
  const entries = [];
  let cur = null;
  let inConfig = false;
  let configIndent = 0;
  let lastKey = null;
  const unquote = (t) => String(t).trim().replace(/^['"]|['"]$/g, "");

  for (const line of text.split("\n")) {
    if (line.startsWith("- id: ")) {
      cur = { id: line.slice("- id: ".length).trim(), name: null, disabled: false, disabledRaw: null, config: {}, raw: [line] };
      entries.push(cur);
      inConfig = false; lastKey = null;
      continue;
    }
    if (!cur) continue;
    cur.raw.push(line);
    if (!line.trim() || line.startsWith("#")) { if (line && !line.startsWith(" ")) inConfig = false; continue; }

    const indent = line.match(/^ */)[0].length;
    const trimmed = line.trim();

    if (indent <= 2) {
      const kv = trimmed.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
      if (!kv) continue;
      if (kv[1] === "config") { inConfig = true; configIndent = 0; lastKey = null; continue; }
      inConfig = false;
      if (kv[1] === "name") cur.name = unquote(kv[2]);
      if (kv[1] === "disabled") { cur.disabledRaw = kv[2].trim(); cur.disabled = kv[2].trim() === "true"; }
      continue;
    }
    if (!inConfig) continue;

    if (!configIndent) configIndent = indent;
    const kv = trimmed.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (indent === configIndent && kv) {
      lastKey = kv[1];
      const v = kv[2].trim();
      // 空值：可能是数组或嵌套块，先占位，后续行会填
      cur.config[lastKey] = v === "" ? [] : unquote(v);
      continue;
    }
    if (!lastKey) continue;
    // 数组项（`- 值`）或折行续行 → 归到上一个键
    const item = trimmed.replace(/^-\s*/, "");
    const prev = cur.config[lastKey];
    if (Array.isArray(prev)) prev.push(unquote(item));
    else cur.config[lastKey] = [prev, unquote(item)].filter((x) => x !== "").join(" ");
  }
  return entries;
}

/** 从我们自己的 patch 文本里取 target id（我们的格式固定：顶层 `- id: X`）。 */
export function patchTargets(patchText) {
  const ids = [];
  for (const m of patchText.matchAll(/^- id: ([^\s]+)$/gm)) ids.push(m[1]);
  return ids;
}

/** 从 patch 里取被显式禁用的 row id。 */
export function patchDisabled(patchText) {
  const ids = [];
  const lines = patchText.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^- id: ([^\s]+)$/);
    if (m && (lines[i + 1] ?? "").trim() === "disabled: true") ids.push(m[1]);
  }
  return ids;
}

/** 组合树里的连接器（mcp-* 行）→ serverName 列表。 */
export const composedConnectors = (entries) =>
  entries
    // 只认 mcp-**client** 插件行：组合树里还有 base 自带的 `mcp-resources`，它不是业务连接器
    .filter((e) => e.name === "@deepseek-ai/dsh-mcp-client")
    .map((e) => e.config.serverName ?? e.id.replace(/^mcp-/, ""))
    .sort();

function main() {
  const { values, flags, positionals, errors } = parseArgs(process.argv.slice(2));
  const json = flags.has("--json");
  if (flags.has("--help") || flags.has("-h") || !positionals.length) {
    log("用法: node adapters/dsh/doctor.mjs <RENDER_DIR> [--json]");
    process.exit(positionals.length || flags.has("--help") || flags.has("-h") ? EXIT_CODES.ok : EXIT_CODES.usage);
  }
  if (errors.length) { log(errors.join("；")); process.exit(EXIT_CODES.usage); }

  const renderDir = path.resolve(positionals[0]);
  const manifestFile = path.join(renderDir, "render-manifest.json");
  if (!fs.existsSync(manifestFile)) {
    log(`❌ ${renderDir} 不是渲染产物（缺 render-manifest.json）—— 先跑 render`);
    process.exit(EXIT_CODES.static);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  const adapter = readYaml(path.join(HERE, "adapter.yaml"));

  const report = new GateReport({
    agent: manifest.agent, harness: HARNESS,
    harnessVersion: manifest.harnessVersion, artifactsDigest: manifest.artifactsDigest,
  });

  // ---- 暂存一份可写副本：绝不碰宿主机的 ~/.dsh（P-b 文件系统隔离）----
  // 走与运行期同一条暂存路径（run.mjs 的 stageRenderDir → core/image/startup.mjs）：
  // 自证要验的正是"运行时会加载什么"，自己另写一份就验不到真实路径。
  const staged = stageRenderDir(renderDir, "http://127.0.0.1:9/v1", { zeroCredential: true });
  const staging = staged.staging;
  const dshHome = staged.dshHome;
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-doctor-cwd-"));
  const profileDir = path.join(dshHome, "profiles", manifest.agent);

  // ---- 零凭据自证：组合后的 profile 树 ----
  const r = spawnSync("dsh", [manifest.agent, "--dump-config"], {
    encoding: "utf8", cwd, timeout: 300000,
    env: { ...process.env, DSH_HOME: dshHome },
  });
  if (r.status !== 0) {
    report.fail(GATE, "resolution/dump-config", `dsh --dump-config 失败（退出码 ${r.status}）：${(r.stderr || "").slice(-300)}`);
    finish();
  }
  report.pass(GATE, "resolution/dump-config", "harness 自行组合并打印了完整 profile 树（零凭据，不挂载不连网）");
  const entries = parseComposedTree(r.stdout);
  const byId = new Map(entries.map((e) => [e.id, e]));

  // ---- 硬断言 0（D1 唯一防线）：patch 的每个 target id 都必须出现在组合树里 ----
  const patchText = fs.readFileSync(path.join(profileDir, "cordis.patch.yml"), "utf8");
  const targets = patchTargets(patchText);
  const dangling = targets.filter((t) => !byId.has(t));
  if (dangling.length) {
    report.fail(GATE, "resolution/patch-targets",
      `patch 指向了组合树里不存在的 row：${dangling.join(", ")} —— 该 harness 对此**只打警告、退出码 0**（failures.md D1），所以这条断言是它唯一的防线`);
  } else {
    report.pass(GATE, "resolution/patch-targets", `${targets.length} 个 patch target 全部命中组合树里的 row`);
  }

  // ---- 模型路由：实际生效的 provider/model ----
  const am = byId.get("agent-default-model");
  const routes = manifest.modelProviders ?? [];
  const composedRoute = am?.config?.provider ?? null;
  if (routes.length && composedRoute === routes[0]) {
    report.pass(GATE, "resolution/model-providers", `实际生效的模型来自本次渲染产物（${composedRoute}/${am.config.model}）—— 不是宿主配置`);
  } else {
    report.fail(GATE, "resolution/model-providers", `组合树里的 provider 是「${composedRoute}」，声明的是「${routes[0] ?? "（无）"}」`);
  }

  // ---- 硬断言 1：技能集合 ----
  // 口径差异（进 exemptions）：这边只能验"已配置 + 已就位"，拿不到"已被发现"。
  const sf = byId.get("skill-filesystem");
  const dirs = sf ? [sf.config.customSkillDirs].flat().filter(Boolean) : [];   // 组合树里是数组
  const declaredSkills = [...(manifest.declaredSkills ?? [])].sort();
  const present = declaredSkills.filter((s) => fs.existsSync(path.join(renderDir, "skills", s, "SKILL.md")));
  const wantDir = manifest.skillsInImage;
  // 暂存会把**镜像内固定路径**改写成本地实际路径（`runtimePlan.pathRewrites`），
  // 所以这里要与**暂存后的**路径比 —— 与镜像内路径比会在"统一暂存"之后立刻变成假失败。
  const expectedStagedSkills = path.join(staged.staging, "skills");
  if (!dirs.length) report.fail(GATE, "resolution/skills-set", `skill-filesystem 未启用或未配置 customSkillDirs（技能不会进会话目录）`);
  else if (dirs[0] !== expectedStagedSkills && dirs[0] !== wantDir) report.fail(GATE, "resolution/skills-set", `customSkillDirs 是 ${JSON.stringify(dirs)}，期望是暂存后的 ${expectedStagedSkills}（镜像内声明为 ${wantDir}）`);
  else if (present.length !== declaredSkills.length) report.fail(GATE, "resolution/skills-set", `声明的 ${declaredSkills.length} 个技能里只有 ${present.length} 个就位：缺 ${declaredSkills.filter((s) => !present.includes(s)).join(", ")}`);
  else report.pass(GATE, "resolution/skills-set", `硬断言 1：${declaredSkills.length} 个技能均已配置到 ${wantDir} 且 SKILL.md 就位（口径：已配置且就位，非"已被发现"—— 见 exemptions）`);

  // ---- 硬断言 2：连接器集合 ----
  const composed = composedConnectors(entries);
  const declaredConn = (manifest.connectors ?? []).map((c) => c.serverName).sort();
  if (JSON.stringify(composed) === JSON.stringify(declaredConn)) {
    report.pass(GATE, "resolution/connectors-set", `硬断言 2：实际启用的连接器集合等于声明集合（${composed.length} 项）`);
  } else {
    report.fail(GATE, "resolution/connectors-set", `组合树里 ${JSON.stringify(composed)} ≠ 声明 ${JSON.stringify(declaredConn)}`);
  }

  // ---- 硬断言 3：业务级增强集合（这边能真观测：组合树列出了全部 row）----
  const declaredEnh = [...(manifest.declaredEnhancements ?? [])].sort();
  const missingEnh = declaredEnh.filter((id) => !byId.has(id));
  if (missingEnh.length) {
    report.fail(GATE, "resolution/enhancements-set", `硬断言 3：声明的增强没有出现在组合树里：${missingEnh.join(", ")}`);
  } else {
    report.pass(GATE, "resolution/enhancements-set", `硬断言 3：已加载扩展 id 集合等于声明集合（${declaredEnh.length} 项）`);
  }

  // ---- 姿态：我们显式声明的安全与工具边界，必须在组合树里真的生效 ----
  const denies = patchDisabled(patchText);
  const notDisabled = denies.filter((id) => !byId.get(id)?.disabled);
  const sp = byId.get("sandbox-policy");
  const ap = byId.get("approval");
  const problems = [];
  if (notDisabled.length) problems.push(`声明的工具边界没生效（未被禁用）：${notDisabled.join(", ")}`);
  // 注意：组合树里**没有** disabled 行 = 默认启用（不是"不在树里"）—— 判存在要看 byId
  if (!sp) problems.push("sandbox-policy 不在组合树里（安全姿态没进产物）");
  else if (sp.disabled) problems.push("sandbox-policy 被禁用了（安全姿态没生效）");
  if (!ap) problems.push("approval 不在组合树里（审批姿态没进产物）");
  else if (ap.disabled) problems.push("approval 被禁用了（审批姿态没生效）");
  else if (!/ask|never/.test(ap.raw)) problems.push("approval.policy 看不出取值（可能被格式问题吃掉了）");
  if (problems.length) report.fail(GATE, "resolution/posture", problems.join("；"));
  else report.pass(GATE, "resolution/posture", `安全姿态与工具边界均在组合树中生效（禁 ${denies.length} 个 row；approval 默认 ask = fail closed）`);

  // ---- 版本与生效摘要 ----
  report.pass(GATE, "resolution/harness-version", `harness 版本 ${manifest.harnessVersion}（与渲染时一致）`);
  // effectiveConfigDigest 由 GateReport 依元信息算出（只读 getter）—— 只设参数名，不要直接赋值
  report.paramNames = [...(manifest.runtimeParams ?? []).map((p) => p.name)].sort();
  const recomputedDigest = computeEffectiveConfigDigest({
    harnessVersion: manifest.harnessVersion,
    adapterVersion: readYaml(path.join(HERE, "adapter.yaml")).adapterVersion,
    artifactsDigest: manifest.artifactsDigest,
    paramNames: report.paramNames,
  });
  report.pass(GATE, "resolution/effective-config-digest", recomputedDigest);

  // 交叉核对：清单记录的摘要必须与**本地重算**一致（不一致 = 清单过期或被改过）
  {
    const recorded = manifest.effectiveConfigDigest ?? null;
    if (recorded && recomputedDigest !== recorded) {
      report.fail(GATE, "resolution/digest-crosscheck",
        `清单记录的生效配置摘要与本地重算不一致（记录 ${recorded.slice(0, 23)}… vs 重算 ${recomputedDigest.slice(0, 23)}…）—— 清单过期或被改过`);
    } else {
      report.pass(GATE, "resolution/digest-crosscheck", recorded ? "记录值与本地重算一致" : "清单未记录摘要（旧产物），已按重算值报告");
    }
  }

  const doc = {
    harness: HARNESS,
    version: manifest.harnessVersion,
    definitionPath: `dsh-home/profiles/${manifest.agent}`,
    skills: declaredSkills,
    connectors: composed,
    enhancements: declaredEnh,
    modelProviders: routes,
    effectiveConfigDigest: report.effectiveConfigDigest,
    adapterVersion: adapter.adapterVersion,
    evidence: {
      composedEntries: entries.length,
      patchTargets: targets,
      disabledRows: denies,
      skillsScopeNote: "skills[] 的口径是「已在 customSkillDirs 配置且 SKILL.md 就位」；该 harness 没有「列出已发现技能」的零凭据原语（与 pi 侧不同，见 exemptions.yaml）",
      enhancementsScopeNote: "enhancements[] 这边是**真观测**：组合树列出全部 row，「insert 的增强行在不在、是否被禁用」可直接判定",
      harnessHomeIsolated: true,
      stagedWritableCopy: true,
    },
  };

  if (json) process.stdout.write(JSON.stringify({ doctor: doc, gate: report.toJSON() }, null, 2) + "\n");
  else {
    report.print({ json: false, stderr: process.stderr });
    log("\ndoctor 七字段：");
    log(`  harness/version   ${doc.harness} ${doc.version}`);
    log(`  definitionPath    ${doc.definitionPath}`);
    log(`  skills            ${JSON.stringify(doc.skills)}`);
    log(`  connectors        ${JSON.stringify(doc.connectors)}`);
    log(`  enhancements      ${JSON.stringify(doc.enhancements)}`);
    log(`  modelProviders       ${JSON.stringify(doc.modelProviders)}`);
    log(`  effectiveConfigDigest ${doc.effectiveConfigDigest}`);
  }
  process.exit(report.exitCode);

  function finish() {
    if (json) process.stdout.write(JSON.stringify({ gate: report.toJSON() }, null, 2) + "\n");
    else report.print({ json: false, stderr: process.stderr });
    process.exit(report.exitCode);
  }
}

// 入口守卫：被 import（测试/复用解析器）时不要执行 main
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) main();
