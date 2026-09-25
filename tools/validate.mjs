#!/usr/bin/env node
// ============================================================================
// 闸门 1：静态校验（统一设计 §6.2）
//
// 报告格式、退出码、摘要都来自 core/gates —— 不在这里另起一套形状（§6.7 要求
// 验证工具与运行时共用同一套语义）。本文件只负责**闸门 1 的检查内容**。
//
// 两类职责，缺一不可：
//
//   A. 基座自洽（不需要智能体目录，每次 `make validate` 都跑）
//      A1 schema 本身可编译
//      A2 能力目录覆盖 schema 的全部字段（防两处真源漂移）
//      A3 params.yaml 的 allowed.backs ↔ capabilities 的 valueRef: parameter 双向一致
//      A4 params.yaml 的 forbidden.definitionPaths 必须被 capabilities 标为 layer: artifact
//      A5 core/ 的代码与 schema 内不得出现 harness 名（附录 B 的每阶段通用闸门）
//
//   B. 智能体定义校验（需要 AGENT_DIR）
//      B1 schema 校验 agent.yaml / connectors.yaml（additionalProperties:false → 未知字段是硬错误）
//      B2 引用完整性：connectorsFile / skillsDir 必须存在
//      B3 凭据引用：每个 urlRef / credentialRef 必须落在参数层允许清单内
//      B4 技能：SKILL.md 必须存在且 frontmatter 含 name / description，且 name 与目录名一致
//      B5 层纪律：中性定义里不得出现被 capabilities 标为 layer: parameter 的字段
//      B6 单一真源：业务级增强不得重复表达中性定义已表达的字段
//      B7 可移植性等级：显式输出「核心 + 哪些 harness 增强（不可移植）」
//
// 用法：
//   node tools/validate.mjs                     # 只跑基座自洽（A）
//   node tools/validate.mjs <AGENT_DIR>         # A + B
//   node tools/validate.mjs --selftest          # A + 注入式负向自检（合法样本必须过、非法样本必须逐条变红）
//   node tools/validate.mjs --json <AGENT_DIR>  # 机器可读报告（§6.7 形状）
//
// 输出约定（§8.2）：**stdout 只放 JSON 结果；人读日志走 stderr**。
// 退出码（§6.7）：0 通过 / 2 用法错误 / 10 闸门 1 失败。
// ============================================================================

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import Ajv2020 from "ajv/dist/2020.js";
import { EXIT_CODES, GateReport, digestDirectory } from "../core/gates/index.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const CORE = path.join(REPO, "core");
const SPEC = path.join(CORE, "spec");
const CATALOG = path.join(CORE, "catalog");
const FIXTURES = path.join(SPEC, "fixtures");

const GATE = "static";
const HARNESS_NAMES = ["pi", "dsh"];
const NEUTRAL_KEYS_FORBIDDEN_IN_ENHANCEMENTS = [
  "persona", "model", "tools", "skills", "connectors", "mcpServers",
  "instructions", "systemPrompt", "instructionsFile",
];

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------
function loadYaml(file) {
  return YAML.parse(fs.readFileSync(file, "utf8"));
}

function globFiles(dir, predicate, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) globFiles(full, predicate, acc);
    else if (predicate(full)) acc.push(full);
  }
  return acc;
}

function stripFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return null;
  try { return YAML.parse(m[1]); } catch { return null; }
}

function pathExists(obj, dotted) {
  let cur = obj;
  for (const p of dotted.split(".")) {
    if (cur == null || typeof cur !== "object" || !(p in cur)) return false;
    cur = cur[p];
  }
  return true;
}

/**
 * 从 JSON Schema 推导出「字段路径」集合，用于与能力目录对账。
 *
 * 路径约定（与 core/catalog/capabilities.yaml 一致）：
 *   · 标量 / 对象字段        → `model.route`、`persona.instructions`
 *   · 标量数组本身就是字段    → `tools.deny`、`mcpServers[].args`
 *   · 对象数组的**元素字段**  → `mcpServers[].name`（容器 `mcpServers` 由元素字段代表）
 */
function deriveSchemaPaths(schema) {
  const out = new Set();
  const resolve = (node) => {
    if (!node || typeof node !== "object") return node;
    if (node.$ref) {
      const m = /^#\/\$defs\/(.+)$/.exec(node.$ref);
      if (!m) throw new Error(`不支持的 $ref 形式：${node.$ref}`);
      return schema.$defs[m[1]];
    }
    return node;
  };
  const isObjectLike = (n) => !!n && typeof n === "object" && (n.properties || n.oneOf);
  const walk = (node, prefix) => {
    node = resolve(node);
    if (!node || typeof node !== "object") return;
    for (const branch of node.oneOf ?? []) walk(branch, prefix);
    if (node.type === "array") {
      const items = resolve(node.items);
      if (isObjectLike(items)) walk(items, `${prefix}[]`);
      else if (prefix) out.add(prefix);
      return;
    }
    if (!node.properties) return;
    for (const [key, raw] of Object.entries(node.properties)) {
      const child = resolve(raw);
      const p = prefix ? `${prefix}.${key}` : key;
      if (child?.type === "array") walk(child, p);
      else if (child?.properties) walk(child, p);
      else out.add(p);
    }
  };
  walk(schema, "");
  return [...out].sort();
}

/** 把 forbidden 的 definitionPath（可能含 <h> / ** 通配）展开成匹配函数。 */
function pathMatcher(pattern) {
  const normalized = pattern.replace(/\/\*\*$/, "/");
  if (normalized.endsWith("/")) return (p) => p.startsWith(normalized);
  return (p) => p === pattern;
}

function ajvErrors(errors = []) {
  return errors
    .map((e) => `${e.instancePath || "/"} ${e.message}${e.params?.additionalProperty ? ` ('${e.params.additionalProperty}')` : ""}`)
    .join("; ");
}

// ---------------------------------------------------------------------------
// A. 基座自洽
// ---------------------------------------------------------------------------
function checkBase(report) {
  const agentSchema = JSON.parse(fs.readFileSync(path.join(SPEC, "agent.schema.json"), "utf8"));
  const connectorsSchema = JSON.parse(fs.readFileSync(path.join(SPEC, "connectors.schema.json"), "utf8"));
  const caps = loadYaml(path.join(CATALOG, "capabilities.yaml"));
  const params = loadYaml(path.join(CATALOG, "params.yaml"));

  // A1 schema 可编译
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  for (const [name, schema, file] of [
    ["agent", agentSchema, "agent.schema.json"],
    ["connectors", connectorsSchema, "connectors.schema.json"],
  ]) {
    try {
      ajv.compile(schema);
      report.pass(GATE, `schema/${name}`, `${file} 可编译`);
    } catch (e) {
      report.fail(GATE, `schema/${name}`, `${file} 编译失败：${e.message}`);
    }
  }

  // A2 能力目录覆盖 schema 全部字段
  const capsFields = caps.groups.flatMap((g) => g.fields ?? []);
  const capsPaths = new Set(capsFields.map((f) => f.path));
  const schemaPaths = [
    ...deriveSchemaPaths(agentSchema).map((p) => ({ p, src: "agent.yaml" })),
    ...deriveSchemaPaths(connectorsSchema).filter((p) => p !== "apiVersion").map((p) => ({ p, src: "connectors.yaml" })),
  ];
  const missing = schemaPaths.filter(({ p }) => !capsPaths.has(p));
  if (missing.length) {
    report.fail(GATE, "catalog/missing-field",
      `schema 有字段但能力目录没有（两处真源漂移）：${missing.map((m) => `${m.src}:${m.p}`).join(", ")}`);
  } else {
    report.pass(GATE, "catalog/missing-field", `能力目录覆盖 schema 全部 ${schemaPaths.length} 个字段路径`);
  }
  const stale = capsFields
    .filter((f) => /^(agent|connectors)\.yaml/.test(f.source ?? ""))
    .filter((f) => !schemaPaths.some(({ p }) => p === f.path));
  if (stale.length) {
    report.fail(GATE, "catalog/stale-field", `能力目录有字段但 schema 里不存在：${stale.map((f) => f.path).join(", ")}`);
  } else {
    report.pass(GATE, "catalog/stale-field", "能力目录没有指向已删除字段的残留条目");
  }

  // A3 params.allowed.backs ↔ capabilities.valueRef === parameter（双向）
  const allowed = params.allowed ?? [];
  const backedPaths = new Set(allowed.flatMap((a) => a.backs ?? []));
  const valueRefPaths = new Set(capsFields.filter((f) => f.valueRef === "parameter").map((f) => f.path));
  const backsOrphan = [...backedPaths].filter((p) => !valueRefPaths.has(p));
  const backsMissing = [...valueRefPaths].filter((p) => !backedPaths.has(p));
  if (backsOrphan.length) {
    report.fail(GATE, "params/backs-orphan", `params.allowed 指向了非 valueRef:parameter 的字段：${backsOrphan.join(", ")}`);
  } else if (backsMissing.length) {
    report.fail(GATE, "params/backs-missing", `valueRef:parameter 的字段没有对应的参数层条目：${backsMissing.join(", ")}`);
  } else {
    report.pass(GATE, "params/backs", `参数层引用双向一致（${[...valueRefPaths].join(", ")}）`);
  }

  // A4 forbidden.definitionPaths 必须是 artifact 层
  const layerOf = new Map(capsFields.map((f) => [f.path, f.layer]));
  const bad = [];
  for (const f of params.forbidden ?? []) {
    for (const dp of f.definitionPaths ?? []) {
      const hit = [...layerOf.keys()].filter(pathMatcher(dp));
      if (!hit.length) bad.push(`${f.id}:${dp}（能力目录里没有匹配字段）`);
      else for (const h of hit) {
        if (layerOf.get(h) !== "artifact") bad.push(`${f.id}:${h}（目录标为 ${layerOf.get(h)}）`);
      }
    }
  }
  if (bad.length) {
    report.fail(GATE, "params/forbidden-layer", `禁止清单与能力目录的所属层矛盾：${bad.join(", ")}`);
  } else {
    report.pass(GATE, "params/forbidden-layer", "禁止清单的 definitionPaths 全部被能力目录标为制品层");
  }

  // A5 core/ 的代码与 schema 内不得出现 harness 名
  //    豁免（设计 §12.1 实现期澄清，均在 core/gates/README.md 与设计正文里写明）：
  //      · catalog/*.yaml —— §4.6 要求能力目录记录各 harness 支持度
  //      · Markdown 文档   —— §12.1 的纪律原话本身必须点名
  //      · fixtures        —— 故意非法的负向样本
  const codeOffenders = [];
  for (const file of globFiles(CORE, (f) => /\.(json|mjs)$/.test(f))) {
    if (file.includes(`${path.sep}fixtures${path.sep}`)) continue;
    const text = fs.readFileSync(file, "utf8");
    for (const h of HARNESS_NAMES) {
      if (new RegExp(`\\b${h}\\b`).test(text)) codeOffenders.push(`${path.relative(REPO, file)}:${h}`);
    }
  }
  if (codeOffenders.length) {
    report.fail(GATE, "core/harness-name", `core/ 的代码或 schema 里出现 harness 名：${codeOffenders.join(", ")}`);
  } else {
    report.pass(GATE, "core/harness-name", "core/ 的代码与 schema 内无 harness 名（catalog/ 与文档按 §4.6 / §12.1 豁免）");
  }

  return { ajv, agentSchema, connectorsSchema, caps, params };
}

// ---------------------------------------------------------------------------
// B. 智能体定义校验
// ---------------------------------------------------------------------------
function checkAgent(report, ctx, agentDir) {
  const { ajv, agentSchema, connectorsSchema, caps, params } = ctx;
  const agentFile = path.join(agentDir, "agent.yaml");
  if (!fs.existsSync(agentFile)) {
    report.fail(GATE, "ref/agent-yaml", `找不到 ${path.join(path.relative(REPO, agentDir), "agent.yaml")}`);
    return;
  }
  let agent;
  try {
    agent = loadYaml(agentFile);
  } catch (e) {
    report.fail(GATE, "schema/agent", `agent.yaml 不是合法 YAML：${e.message}`);
    return;
  }

  // B1 schema
  const vAgent = ajv.compile(agentSchema);
  if (vAgent(agent)) report.pass(GATE, "schema/agent", "agent.yaml 通过 schema");
  else report.fail(GATE, "schema/agent", `agent.yaml schema 校验失败：${ajvErrors(vAgent.errors)}`);

  // B5 层纪律
  const parameterFields = caps.groups.flatMap((g) => g.fields ?? []).filter((f) => f.layer === "parameter");
  const present = parameterFields.filter((f) => pathExists(agent, f.path));
  if (present.length) report.fail(GATE, "layer/forbidden-field", `定义里出现参数层字段：${present.map((f) => f.path).join(", ")}`);
  else report.pass(GATE, "layer/forbidden-field", "定义里没有参数层字段");

  // B2 引用完整性
  const connectorsRel = agent.connectorsFile ?? "connectors.yaml";
  const skillsRel = agent.skillsDir ?? "skills";
  const connectorsAbs = path.join(agentDir, connectorsRel);
  const skillsAbs = path.join(agentDir, skillsRel);
  let connectors = null;
  if (!fs.existsSync(connectorsAbs)) {
    report.fail(GATE, "ref/connectorsFile", `connectorsFile 指向的文件不存在：${connectorsRel}`);
  } else {
    report.pass(GATE, "ref/connectorsFile", `${connectorsRel} 存在`);
    try { connectors = loadYaml(connectorsAbs); } catch (e) {
      report.fail(GATE, "schema/connectors", `connectors.yaml 不是合法 YAML：${e.message}`);
    }
  }
  if (!fs.existsSync(skillsAbs)) report.fail(GATE, "ref/skillsDir", `skillsDir 指向的目录不存在：${skillsRel}`);
  else report.pass(GATE, "ref/skillsDir", `${skillsRel}/ 存在`);

  // B1' connectors schema + B3 凭据引用
  if (connectors) {
    const vConn = ajv.compile(connectorsSchema);
    if (vConn(connectors)) report.pass(GATE, "schema/connectors", "connectors.yaml 通过 schema");
    else report.fail(GATE, "schema/connectors", `connectors.yaml schema 校验失败：${ajvErrors(vConn.errors)}`);

    const allowed = params.allowed ?? [];
    const matchesAllowed = (name, kinds) =>
      allowed.some((a) => kinds.includes(a.kind) && new RegExp(a.pattern).test(name));
    const unknown = [];
    for (const s of connectors.mcpServers ?? []) {
      if (s.urlRef && !matchesAllowed(s.urlRef, ["connector-endpoint"])) unknown.push(`urlRef=${s.urlRef}`);
      if (s.credentialRef && !matchesAllowed(s.credentialRef, ["connector-credential"])) unknown.push(`credentialRef=${s.credentialRef}`);
    }
    if (unknown.length) {
      report.fail(GATE, "cred/not-in-params",
        `引用名不在参数层允许清单内：${unknown.join(", ")}（应写进 core/catalog/params.yaml 或更正引用名）`);
    } else {
      report.pass(GATE, "cred/not-in-params", "全部 urlRef / credentialRef 都在参数层允许清单内");
    }

    // 报告需要的参数层引用名（**只放名字，不放值**，§6.7）
    for (const s of connectors.mcpServers ?? []) {
      for (const k of ["urlRef", "credentialRef"]) if (s[k]) report.paramNames.push(s[k]);
    }
    if (agent.model?.route) report.paramNames.push(agent.model.route);
    report.paramNames = [...new Set(report.paramNames)].sort();
  }

  // B4 技能 frontmatter
  if (fs.existsSync(skillsAbs)) {
    const skillFiles = globFiles(skillsAbs, (f) => path.basename(f) === "SKILL.md");
    if (!skillFiles.length) report.fail(GATE, "skill/none-found", `${skillsRel}/ 下没有任何 <name>/SKILL.md`);
    const badSkills = [];
    for (const f of skillFiles) {
      const fm = stripFrontmatter(fs.readFileSync(f, "utf8"));
      if (!fm || !fm.name || !fm.description) badSkills.push(path.relative(agentDir, f));
      else if (fm.name !== path.basename(path.dirname(f))) {
        badSkills.push(`${path.relative(agentDir, f)}（frontmatter name 与目录名不一致：${fm.name}）`);
      }
    }
    if (badSkills.length) report.fail(GATE, "skill/frontmatter", `SKILL.md frontmatter 缺失或不一致：${badSkills.join(", ")}`);
    else if (skillFiles.length) report.pass(GATE, "skill/frontmatter", `${skillFiles.length} 个技能的 frontmatter 合法`);
  }

  // B6 单一真源
  const dupes = [];
  for (const h of HARNESS_NAMES) {
    const enhFile = path.join(agentDir, "harness", h, "enhancements.yaml");
    if (!fs.existsSync(enhFile)) continue;
    let enh;
    try { enh = loadYaml(enhFile); } catch (e) {
      report.fail(GATE, "enhance/yaml", `harness/${h}/enhancements.yaml 不是合法 YAML：${e.message}`);
      continue;
    }
    for (const key of Object.keys(enh ?? {})) {
      if (NEUTRAL_KEYS_FORBIDDEN_IN_ENHANCEMENTS.includes(key)) dupes.push(`harness/${h}/enhancements.yaml:${key}`);
    }
  }
  if (dupes.length) report.fail(GATE, "enhance/single-source", `增强重复表达了中性定义字段（两个真源）：${dupes.join(", ")}`);
  else report.pass(GATE, "enhance/single-source", "业务级增强没有重复表达中性定义字段");

  // B7 可移植性等级（显式输出，不阻断）
  const used = HARNESS_NAMES.filter((h) => {
    const d = path.join(agentDir, "harness", h);
    return fs.existsSync(d) && fs.readdirSync(d).length > 0;
  });
  report.pass(GATE, "portability/report",
    `本智能体可移植性：${used.length ? `核心 + ${used.join(" / ")} 增强（不可移植）` : "核心（可移植到所有受支持 harness）"}`);

  // 定义目录摘要（§6.7）
  report.definitionDigest = digestDirectory(agentDir);
  if (agent.name) report.agent = agent.name;
}

// ---------------------------------------------------------------------------
// --selftest：注入式负向自检（§6.2「必须做到注入式负向全绿」）
// ---------------------------------------------------------------------------
function runFixture(dir) {
  const report = new GateReport();
  const ctx = checkBase(report);
  checkAgent(report, ctx, dir);
  return report;
}

function checkSelftest() {
  const results = [];
  const expectFile = path.join(FIXTURES, "valid", "expect.yaml");
  const validReport = runFixture(path.join(FIXTURES, "valid"));
  const validExpect = fs.existsSync(expectFile) ? loadYaml(expectFile) : null;
  results.push({
    name: "valid",
    passed: validExpect?.expectFailure == null ? validReport.ok : validReport.failures.some((f) => f.id === validExpect.expectFailure),
    want: validExpect?.expectFailure ?? "全绿",
    got: validReport.failures.map((f) => f.id),
  });

  const negRoot = path.join(FIXTURES, "negative");
  const dirs = fs.existsSync(negRoot)
    ? fs.readdirSync(negRoot, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()
    : [];
  for (const name of dirs) {
    const dir = path.join(negRoot, name);
    const ef = path.join(dir, "expect.yaml");
    const want = fs.existsSync(ef) ? loadYaml(ef).expectFailure : null;
    const got = runFixture(dir).failures.map((f) => f.id);
    results.push({ name, passed: !!want && got.includes(want), want, got });
  }
  return results;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function main() {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const selftest = args.includes("--selftest");
  const positional = args.filter((a) => !a.startsWith("-"));

  if (args.includes("--help") || args.includes("-h")) {
    process.stderr.write("用法: node tools/validate.mjs [AGENT_DIR] [--selftest] [--json]\n");
    process.exit(EXIT_CODES.ok);
  }
  if (args.some((a) => a.startsWith("-") && !["--json", "--selftest", "--help", "-h"].includes(a))) {
    process.stderr.write(`未知参数：${args.filter((a) => a.startsWith("-") && !["--json", "--selftest", "--help", "-h"].includes(a)).join(" ")}\n`);
    process.exit(EXIT_CODES.usage);
  }
  if (positional.length > 1) {
    process.stderr.write(`只接受一个 AGENT_DIR，收到 ${positional.length} 个\n`);
    process.exit(EXIT_CODES.usage);
  }

  const report = new GateReport();
  const ctx = checkBase(report);
  if (positional.length) checkAgent(report, ctx, path.resolve(positional[0]));

  const selftestResults = selftest ? checkSelftest() : null;
  const selftestFailed = (selftestResults ?? []).filter((t) => !t.passed);

  if (json) {
    const out = report.toJSON();
    if (selftestResults) out.selftest = selftestResults;
    process.stdout.write(JSON.stringify(out, null, 2) + "\n");
  } else {
    report.print({ json: false, stderr: process.stderr });
    if (selftestResults) {
      process.stderr.write("注入式负向自检（非法样本必须变红）：\n");
      for (const t of selftestResults) {
        process.stderr.write(`${t.passed ? "✅" : "❌"} ${t.name}  期望=${t.want ?? "全绿"}  实际=${JSON.stringify(t.got)}\n`);
      }
      process.stderr.write("\n");
    }
    const total = report.checks.length;
    process.stderr.write(
      `${report.ok ? "闸门 1：全绿" : `闸门 1：失败 ${report.failures.length} 项`}（${total} 项检查` +
      `${selftestResults ? ` + ${selftestResults.length} 个自检样本` : ""}）\n`);
  }

  process.exit(selftestFailed.length ? 1 : report.exitCode);
}

main();
