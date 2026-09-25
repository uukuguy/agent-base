#!/usr/bin/env node
// ============================================================================
// 闸门 1：静态校验（统一设计 §6.2）
//
// 本文件是 S0 的「可执行校验入口」。它同时承担两类职责，缺一不可：
//
//   A. 基座自洽（不需要智能体目录，每次 `make validate` 都跑）
//      A1 schema 本身可编译
//      A2 能力目录覆盖 schema 的全部字段（防止 schema 加了字段、目录没跟上 → 两处真源漂移）
//      A3 params.yaml 的 allowed.backs  ↔  capabilities 的 valueRef: parameter 双向一致
//      A4 params.yaml 的 forbidden.definitionPaths 必须被 capabilities 标为 layer: artifact
//      A5 core/ 内不得出现 harness 名字（附录 B 的每阶段通用闸门）
//
//   B. 智能体定义校验（需要 AGENT_DIR）
//      B1 schema 校验 agent.yaml / connectors.yaml（含 additionalProperties:false → 未知字段是硬错误）
//      B2 引用完整性：connectorsFile / skillsDir 必须存在
//      B3 凭据引用：每个 urlRef / credentialRef 必须落在参数层允许清单内
//      B4 技能：SKILL.md 必须存在且 frontmatter 含 name / description
//      B5 层纪律：中性定义里不得出现被 capabilities 标为 layer: parameter 的字段
//      B6 单一真源：业务级增强不得重复表达中性定义已表达的字段
//      B7 可移植性等级：显式输出「核心 + 哪些 harness 增强（不可移植）」
//
// 用法：
//   node tools/validate.mjs                  # 只跑基座自洽（A）
//   node tools/validate.mjs <AGENT_DIR>      # A + B
//   node tools/validate.mjs --selftest       # A + 注入式负向自检（合法样本必须过、非法样本必须逐条变红）
//   node tools/validate.mjs --json ...       # 机器可读报告
//
// 退出码：0 = 全绿；1 = 有失败项；2 = 用法错误。
// ============================================================================

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import Ajv2020 from "ajv/dist/2020.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const CORE = path.join(REPO, "core");
const SPEC = path.join(CORE, "spec");
const CATALOG = path.join(CORE, "catalog");
const FIXTURES = path.join(SPEC, "fixtures");

const HARNESS_NAMES = ["pi", "dsh"];
const NEUTRAL_KEYS_FORBIDDEN_IN_ENHANCEMENTS = [
  "persona", "model", "tools", "skills", "connectors", "mcpServers",
  "instructions", "systemPrompt", "instructionsFile",
];

// ---------------------------------------------------------------------------
// 报告
// ---------------------------------------------------------------------------
class Report {
  constructor() {
    this.checks = [];
  }
  pass(id, detail) { this.checks.push({ id, status: "pass", detail }); }
  fail(id, detail, extra = {}) { this.checks.push({ id, status: "fail", detail, ...extra }); }
  get failures() { return this.checks.filter((c) => c.status === "fail"); }
  get ok() { return this.failures.length === 0; }
}

function loadYaml(file) {
  return YAML.parse(fs.readFileSync(file, "utf8"));
}

/**
 * 从 JSON Schema 推导出「字段路径」集合，用于与能力目录对账。
 *
 * 路径约定（与 core/catalog/capabilities.yaml 保持一致）：
 *   · 标量 / 对象字段            → `model.route`、`persona.instructions`
 *   · 标量数组本身就是字段       → `tools.deny`、`mcpServers[].args`
 *   · 对象数组的**元素字段**     → `mcpServers[].name`（容器 `mcpServers` 本身不单列一行：
 *                                  它在能力目录里由元素字段代表，故不要求有独立条目）
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
      if (child?.type === "array") {
        // 无条件下钻：items 可能只是一个 $ref（其目标用 oneOf 分型，本身没有 properties）
        walk(child, p);
      } else if (child?.properties) {
        walk(child, p);
      } else {
        out.add(p);
      }
    }
  };
  walk(schema, "");
  return [...out].sort();
}

/** 把 forbidden 的 definitionPath（可能含 <h> / ** 通配）展开成匹配函数。 */
function pathMatcher(pattern) {
  const normalized = pattern.replace(/\/\*\*$/, "/");
  const isGlob = normalized.endsWith("/");
  if (isGlob) return (p) => p.startsWith(normalized);
  return (p) => p === pattern;
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

// ---------------------------------------------------------------------------
// A. 基座自洽
// ---------------------------------------------------------------------------
function checkBase(r) {
  const agentSchema = JSON.parse(fs.readFileSync(path.join(SPEC, "agent.schema.json"), "utf8"));
  const connectorsSchema = JSON.parse(fs.readFileSync(path.join(SPEC, "connectors.schema.json"), "utf8"));
  const caps = loadYaml(path.join(CATALOG, "capabilities.yaml"));
  const params = loadYaml(path.join(CATALOG, "params.yaml"));

  // A1 schema 可编译
  let ajv;
  try {
    ajv = new Ajv2020({ allErrors: true, strict: false });
    ajv.compile(agentSchema);
    r.pass("schema/agent", "agent.schema.json 可编译");
  } catch (e) {
    r.fail("schema/agent", `agent.schema.json 编译失败：${e.message}`);
  }
  try {
    ajv.compile(connectorsSchema);
    r.pass("schema/connectors", "connectors.schema.json 可编译");
  } catch (e) {
    r.fail("schema/connectors", `connectors.schema.json 编译失败：${e.message}`);
  }

  // A2 能力目录覆盖 schema 全部字段
  const capsFields = caps.groups.flatMap((g) => g.fields ?? []);
  const capsPaths = new Set(capsFields.map((f) => f.path));
  const schemaPaths = [
    ...deriveSchemaPaths(agentSchema).map((p) => ({ p, src: "agent.yaml" })),
    ...deriveSchemaPaths(connectorsSchema)
      .filter((p) => p !== "apiVersion")
      .map((p) => ({ p, src: "connectors.yaml" })),
  ];
  const missing = schemaPaths.filter(({ p }) => !capsPaths.has(p));
  if (missing.length) {
    r.fail("catalog/missing-field",
      `schema 有字段但能力目录没有（两处真源漂移）：${missing.map((m) => `${m.src}:${m.p}`).join(", ")}`);
  } else {
    r.pass("catalog/missing-field", `能力目录覆盖 schema 全部 ${schemaPaths.length} 个字段路径`);
  }
  const stale = capsFields
    .filter((f) => /^(agent|connectors)\.yaml/.test(f.source ?? ""))
    .filter((f) => !schemaPaths.some(({ p }) => p === f.path));
  if (stale.length) {
    r.fail("catalog/stale-field", `能力目录有字段但 schema 里不存在：${stale.map((f) => f.path).join(", ")}`);
  } else {
    r.pass("catalog/stale-field", "能力目录没有指向已删除字段的残留条目");
  }

  // A3 params.allowed.backs ↔ capabilities.valueRef === parameter（双向）
  const allowed = params.allowed ?? [];
  const backedPaths = new Set(allowed.flatMap((a) => a.backs ?? []));
  const valueRefPaths = new Set(capsFields.filter((f) => f.valueRef === "parameter").map((f) => f.path));
  const backsOrphan = [...backedPaths].filter((p) => !valueRefPaths.has(p));
  const backsMissing = [...valueRefPaths].filter((p) => !backedPaths.has(p));
  if (backsOrphan.length) {
    r.fail("params/backs-orphan", `params.allowed 指向了非 valueRef:parameter 的字段：${backsOrphan.join(", ")}`);
  } else if (backsMissing.length) {
    r.fail("params/backs-missing", `valueRef:parameter 的字段没有对应的参数层条目：${backsMissing.join(", ")}`);
  } else {
    r.pass("params/backs", `参数层引用双向一致（${[...valueRefPaths].join(", ")}）`);
  }

  // A4 forbidden.definitionPaths 必须是 artifact 层
  const layerOf = new Map(capsFields.map((f) => [f.path, f.layer]));
  const bad = [];
  for (const f of params.forbidden ?? []) {
    for (const dp of f.definitionPaths ?? []) {
      const match = pathMatcher(dp);
      const hit = [...layerOf.keys()].filter(match);
      if (!hit.length) {
        bad.push(`${f.id}:${dp}（能力目录里没有匹配字段）`);
      } else {
        for (const h of hit) {
          if (layerOf.get(h) !== "artifact") bad.push(`${f.id}:${h}（目录标为 ${layerOf.get(h)}）`);
        }
      }
    }
  }
  if (bad.length) {
    r.fail("params/forbidden-layer", `禁止清单与能力目录的所属层矛盾：${bad.join(", ")}`);
  } else {
    r.pass("params/forbidden-layer", "禁止清单的 definitionPaths 全部被能力目录标为制品层");
  }

  // A5 core/ 内不得出现 harness 名字（附录 B 的每阶段通用闸门）
  //     判定范围：core/ 的**代码与 schema**（.mjs / .json）。
  //     两处刻意的豁免，理由都是设计原文要求它们必须提到具体 harness：
  //       · catalog/*.yaml —— §4.6 明确要求能力目录记录「支持该字段的 harness 及降级行为」
  //       · Markdown 文档 —— §12.1 的纪律原话本身必须点名，否则说不清「不放什么」
  //       · fixtures       —— 故意非法的负向样本，不参与 core 自洽检查
  //     反之，schema 里出现 harness 名意味着把某个 harness 的约束当成了中性契约的一部分：
  //     那属于 adapters/ 或设计文档，不属于 core/。
  const codeOffenders = [];
  for (const file of globFiles(CORE, (f) => /\.(json|mjs)$/.test(f))) {
    if (file.includes(`${path.sep}fixtures${path.sep}`)) continue;
    const text = fs.readFileSync(file, "utf8");
    for (const h of HARNESS_NAMES) {
      if (new RegExp(`\\b${h}\\b`).test(text)) codeOffenders.push(`${path.relative(REPO, file)}:${h}`);
    }
  }
  if (codeOffenders.length) {
    r.fail("core/harness-name", `core/ 的代码或 schema 里出现 harness 名：${codeOffenders.join(", ")}`);
  } else {
    r.pass("core/harness-name", "core/ 的代码与 schema 内无 harness 名（catalog/ 与文档按 §4.6 / §12.1 豁免）");
  }

  return { ajv, agentSchema, connectorsSchema, caps, params };
}

// ---------------------------------------------------------------------------
// B. 智能体定义校验
// ---------------------------------------------------------------------------
function checkAgent(r, ctx, agentDir) {
  const { ajv, agentSchema, connectorsSchema, caps, params } = ctx;
  const agentFile = path.join(agentDir, "agent.yaml");
  if (!fs.existsSync(agentFile)) {
    r.fail("ref/agent-yaml", `找不到 ${path.join(path.relative(REPO, agentDir), "agent.yaml")}`);
    return;
  }
  let agent;
  try { agent = loadYaml(agentFile); } catch (e) {
    r.fail("schema/agent", `agent.yaml 不是合法 YAML：${e.message}`);
    return;
  }

  // B1 schema 校验
  const vAgent = ajv.compile(agentSchema);
  if (vAgent(agent)) {
    r.pass("schema/agent", "agent.yaml 通过 schema");
  } else {
    const msg = vAgent.errors
      .map((e) => `${e.instancePath || "/"} ${e.message}${e.params?.additionalProperty ? ` ('${e.params.additionalProperty}')` : ""}`)
      .join("; ");
    r.fail("schema/agent", `agent.yaml schema 校验失败：${msg}`);
  }

  // B5 层纪律（能力目录标为 parameter 的字段不得出现在定义里）
  const parameterFields = caps.groups.flatMap((g) => g.fields ?? []).filter((f) => f.layer === "parameter");
  const present = parameterFields.filter((f) => pathExists(agent, f.path));
  if (present.length) {
    r.fail("layer/forbidden-field", `定义里出现参数层字段：${present.map((f) => f.path).join(", ")}`);
  } else {
    r.pass("layer/forbidden-field", "定义里没有参数层字段");
  }

  // B2 引用完整性
  const connectorsRel = agent.connectorsFile ?? "connectors.yaml";
  const skillsRel = agent.skillsDir ?? "skills";
  const connectorsAbs = path.join(agentDir, connectorsRel);
  const skillsAbs = path.join(agentDir, skillsRel);
  let connectors = null;
  if (!fs.existsSync(connectorsAbs)) {
    r.fail("ref/connectorsFile", `connectorsFile 指向的文件不存在：${connectorsRel}`);
  } else {
    r.pass("ref/connectorsFile", `${connectorsRel} 存在`);
    try { connectors = loadYaml(connectorsAbs); } catch (e) {
      r.fail("schema/connectors", `connectors.yaml 不是合法 YAML：${e.message}`);
    }
  }
  if (!fs.existsSync(skillsAbs)) {
    r.fail("ref/skillsDir", `skillsDir 指向的目录不存在：${skillsRel}`);
  } else {
    r.pass("ref/skillsDir", `${skillsRel}/ 存在`);
  }

  // B1' connectors schema 校验
  if (connectors) {
    const vConn = ajv.compile(connectorsSchema);
    if (vConn(connectors)) {
      r.pass("schema/connectors", "connectors.yaml 通过 schema");
    } else {
      const msg = vConn.errors
        .map((e) => `${e.instancePath || "/"} ${e.message}`)
        .join("; ");
      r.fail("schema/connectors", `connectors.yaml schema 校验失败：${msg}`);
    }

    // B3 凭据/端点引用必须落在参数层允许清单内
    const allowed = params.allowed ?? [];
    const matchesAllowed = (name, kinds) =>
      allowed.some((a) => kinds.includes(a.kind) && new RegExp(a.pattern).test(name));
    const unknown = [];
    for (const s of connectors.mcpServers ?? []) {
      if (s.urlRef && !matchesAllowed(s.urlRef, ["connector-endpoint"])) unknown.push(`urlRef=${s.urlRef}`);
      if (s.credentialRef && !matchesAllowed(s.credentialRef, ["connector-credential"])) unknown.push(`credentialRef=${s.credentialRef}`);
    }
    if (unknown.length) {
      r.fail("cred/not-in-params",
        `引用名不在参数层允许清单内：${unknown.join(", ")}（应写进 core/catalog/params.yaml 或更正引用名）`);
    } else {
      r.pass("cred/not-in-params", "全部 urlRef / credentialRef 都在参数层允许清单内");
    }
  }

  // B4 技能 frontmatter
  if (fs.existsSync(skillsAbs)) {
    const skillFiles = globFiles(skillsAbs, (f) => path.basename(f) === "SKILL.md");
    if (!skillFiles.length) {
      r.fail("skill/none-found", `${skillsRel}/ 下没有任何 <name>/SKILL.md`);
    }
    const badSkills = [];
    for (const f of skillFiles) {
      const fm = stripFrontmatter(fs.readFileSync(f, "utf8"));
      if (!fm || !fm.name || !fm.description) {
        badSkills.push(path.relative(agentDir, f));
      } else if (fm.name !== path.basename(path.dirname(f))) {
        badSkills.push(`${path.relative(agentDir, f)}（frontmatter name 与目录名不一致：${fm.name}）`);
      }
    }
    if (badSkills.length) r.fail("skill/frontmatter", `SKILL.md frontmatter 缺失或不一致：${badSkills.join(", ")}`);
    else if (skillFiles.length) r.pass("skill/frontmatter", `${skillFiles.length} 个技能的 frontmatter 合法`);
  }

  // B6 单一真源：业务级增强不得重复表达中性定义已表达的字段
  const dupes = [];
  for (const h of HARNESS_NAMES) {
    const enhFile = path.join(agentDir, "harness", h, "enhancements.yaml");
    if (!fs.existsSync(enhFile)) continue;
    let enh;
    try { enh = loadYaml(enhFile); } catch (e) {
      r.fail("enhance/yaml", `harness/${h}/enhancements.yaml 不是合法 YAML：${e.message}`);
      continue;
    }
    for (const key of Object.keys(enh ?? {})) {
      if (NEUTRAL_KEYS_FORBIDDEN_IN_ENHANCEMENTS.includes(key)) dupes.push(`harness/${h}/enhancements.yaml:${key}`);
    }
  }
  if (dupes.length) {
    r.fail("enhance/single-source", `增强重复表达了中性定义字段（两个真源）：${dupes.join(", ")}`);
  } else {
    r.pass("enhance/single-source", "业务级增强没有重复表达中性定义字段");
  }

  // B7 可移植性等级（显式输出，不阻断）
  const usedHarnesses = HARNESS_NAMES.filter((h) =>
    fs.existsSync(path.join(agentDir, "harness", h)) &&
    fs.readdirSync(path.join(agentDir, "harness", h)).length > 0);
  const portability = usedHarnesses.length
    ? `核心 + ${usedHarnesses.join(" / ")} 增强（不可移植）`
    : "核心（可移植到两个 harness）";
  r.pass("portability/report", `本智能体可移植性：${portability}`);
}

function pathExists(obj, dotted) {
  const parts = dotted.split(".");
  let cur = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== "object") return false;
    if (!(p in cur)) return false;
    cur = cur[p];
  }
  return true;
}

// ---------------------------------------------------------------------------
// --selftest：注入式负向自检（§6.2「必须做到注入式负向全绿」）
// ---------------------------------------------------------------------------
function checkSelftest() {
  const results = [];
  const runCase = (dir) => {
    const expectFile = path.join(dir, "expect.yaml");
    const expect = fs.existsSync(expectFile) ? loadYaml(expectFile) : null;
    const r = new Report();
    const ctx = checkBase(new Report());
    checkAgent(r, ctx, dir);
    return { expect, r };
  };

  // 1) 合法样本必须全绿
  {
    const { expect, r } = runCase(path.join(FIXTURES, "valid"));
    const wantOk = expect?.expectFailure == null;
    results.push({
      name: "valid",
      passed: wantOk ? r.ok : r.failures.some((f) => f.id === expect.expectFailure),
      want: wantOk ? "全绿" : expect.expectFailure,
      got: r.failures.map((f) => f.id),
    });
  }

  // 2) 每个非法样本必须撞上它自己声明的失败项
  const negRoot = path.join(FIXTURES, "negative");
  const dirs = fs.existsSync(negRoot)
    ? fs.readdirSync(negRoot, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort()
    : [];
  for (const name of dirs) {
    const { expect, r } = runCase(path.join(negRoot, name));
    const want = expect?.expectFailure;
    const got = r.failures.map((f) => f.id);
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
  const positional = args.filter((a) => !a.startsWith("--"));
  if (args.includes("--help") || args.includes("-h")) {
    console.log("用法: node tools/validate.mjs [AGENT_DIR] [--selftest] [--json]");
    process.exit(0);
  }

  const base = new Report();
  const ctx = checkBase(base);

  let agentReport = null;
  if (positional.length) {
    agentReport = new Report();
    checkAgent(agentReport, ctx, path.resolve(positional[0]));
  }

  let selftestResults = null;
  if (selftest) selftestResults = checkSelftest();

  const failures = [
    ...base.failures,
    ...(agentReport?.failures ?? []),
    ...(selftestResults ?? []).filter((t) => !t.passed).map((t) => ({ id: `selftest/${t.name}`, detail: `期望 ${t.want}，实际 ${JSON.stringify(t.got)}` })),
  ];
  const ok = failures.length === 0;

  if (json) {
    console.log(JSON.stringify({
      gate: 1,
      ok,
      agentDir: positional[0] ?? null,
      checks: [...base.checks, ...(agentReport?.checks ?? [])],
      selftest: selftestResults,
      failures,
    }, null, 2));
  } else {
    const all = [...base.checks, ...(agentReport?.checks ?? [])];
    for (const c of all) {
      console.log(`${c.status === "pass" ? "✅" : "❌"} [${c.id}] ${c.detail}`);
    }
    if (selftestResults) {
      console.log("");
      console.log("注入式负向自检（非法样本必须变红）：");
      for (const t of selftestResults) {
        console.log(`${t.passed ? "✅" : "❌"} ${t.name}  期望=${t.want ?? "全绿"}  实际=${JSON.stringify(t.got)}`);
      }
    }
    console.log("");
    console.log(ok
      ? `闸门 1：全绿（${all.length} 项检查${selftestResults ? ` + ${selftestResults.length} 个自检样本` : ""}）`
      : `闸门 1：失败 ${failures.length} 项`);
  }
  process.exit(ok ? 0 : 1);
}

main();
