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
import { findProvider, loadProviders } from "../core/catalog/routes.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import Ajv2020 from "ajv/dist/2020.js";
import { spawnSync } from "node:child_process";
import { buildLock } from "../core/image/gen-preinstall-lock.mjs";
import { EXIT_CODES, GateReport, digestDirectory } from "../core/gates/index.mjs";
import { PREINSTALL_PATH, loadPreinstall, resolveConnectors } from "../core/image/resolve-preinstall.mjs";

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
function checkBase(report, agentDir = process.cwd()) {
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

  // 手写「跳过旗标值」的索引过滤 —— 这个写法在本项目里错过**三次**（render / probe / labels）：
  //   const pos = args.find((a, i) => !a.startsWith("--") && i !== args.indexOf("--out") + 1);
  // 旗标缺席时 indexOf 返回 -1，-1+1===0 会把**第一个位置参数**吞掉，命令直接报用法错误。
  // 单看这行很难发现，所以这里静态拦住：统一用 core/gates/cli.mjs 的 parseArgs。
  {
    const naive = /i\s*!==\s*[A-Za-z_$][\w$.]*\s*\+\s*1/;
    const offenders = [];
    const scanDir = (d) => {
      if (!fs.existsSync(d)) return;
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { if (!["node_modules", "dist"].includes(e.name)) scanDir(p); continue; }
        if (!/\.mjs$/.test(e.name)) continue;
        if (e.name === "cli.mjs") continue;   // 统一解析器自己的注释里就有这个反例
        if (naive.test(fs.readFileSync(p, "utf8"))) offenders.push(path.relative(REPO, p));
      }
    };
    for (const d of ["core", "tools", "adapters", "conformance"]) scanDir(path.join(REPO, d));
    if (offenders.length) report.fail(GATE, "cli/no-naive-flag-skip", `手写旗标值跳过（会吞掉位置参数，已出错三次）：${offenders.join(", ")} —— 改用 core/gates/cli.mjs 的 parseArgs`);
    else report.pass(GATE, "cli/no-naive-flag-skip", "没有手写「跳过旗标值」的索引过滤（统一用 parseArgs）");
  }

  // A5b 路由目录自洽：引用名必须符合约定，且被参数层允许清单覆盖
  {
    const loaded = loadProviders({ agentDir });
    if (loaded.errors?.length) {
      report.fail(GATE, "providers/present", `${loaded.errors.join("；")} —— model.provider 的合法取值将无人校验`);
    } else {
      report.pass(GATE, "providers/source", `provider 目录来自 ${loaded.sources.join(" + ") || "（无）"}`);
      const list = loaded.providers;
      if (!list.length) report.fail(GATE, "providers/present", "provider 目录里没有声明任何条目");
      else report.pass(GATE, "providers/present", `${list.length} 个 provider 已声明（${list.map((r) => r.id).join(", ")}）`);

      const prefixOf = (id) => String(id).toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
      const badId = list.filter((r) => !/^[a-z][a-z0-9-]{1,30}$/.test(r.id ?? "")).map((r) => r.id ?? "(缺 id)");
      const badNames = [];
      for (const r of list) {
        const want = {
          baseUrlParam: `${prefixOf(r.id)}_BASE_URL`,
          credentialParam: `${prefixOf(r.id)}_API_KEY`,
          modelParam: `${prefixOf(r.id)}_MODEL`,
        };
        for (const [k, expect] of Object.entries(want)) {
          if (r[k] !== expect) badNames.push(`${r.id}.${k}=${r[k] ?? "(缺)"}，按约定应为 ${expect}`);
        }
      }
      // 「引用名必须被参数层允许」不能靠一张手写名单（那张名单不存在 ⇒ 这个检查曾经是**空转**的）。
      // 真正的判据是：名字必须匹配 params.allowed 里某条**支撑模型组字段**的 pattern
      // （端点/凭据 backs model.route；模型名 backs model.name —— 三者都由路由前缀派生）。
      // 空转的检查比没有更糟 —— 它给了一种"已经管住了"的错觉。
      const ROUTE_DERIVED_BACKS = ["model.route", "model.name", "model.reasoningEffort"];
      const routePats = (params.allowed ?? [])
        .filter((a) => (a.backs ?? []).some((b) => ROUTE_DERIVED_BACKS.includes(b)))
        .map((a) => ({ id: a.id, re: new RegExp(a.pattern) }));
      const notAllowed = [];
      for (const r of list) for (const k of ["baseUrlParam", "credentialParam", "modelParam"]) {
        const n = r[k];
        if (!n) continue;
        if (!routePats.some((p) => p.re.test(n))) {
          notAllowed.push(`${r.id}.${k}=${n}（不匹配任何支撑模型组字段的参数项：${routePats.map((p) => p.id).join(", ")}）`);
        }
      }
      if (badId.length) report.fail(GATE, "providers/id", `provider 名不合法（^[a-z][a-z0-9-]{1,30}$）：${badId.join(", ")}`);
      else report.pass(GATE, "providers/id", "provider 名全部合法");
      if (badNames.length) report.fail(GATE, "providers/param-convention", `引用名不符合约定：${badNames.join("；")}`);
      else report.pass(GATE, "providers/param-convention", "端点/凭据/模型名引用名全部符合 <PREFIX>_BASE_URL / _API_KEY / _MODEL 约定");
      if (notAllowed.length) report.fail(GATE, "providers/param-allowed", `引用名未被参数层允许清单覆盖：${notAllowed.join("；")}`);
      else report.pass(GATE, "providers/param-allowed", `路由引用名都匹配支撑模型组字段的参数项（${routePats.map((p) => p.id).join(", ")}）`);
    }
  }

  // A5d 版本纪律：改了 package.json 的版本，就必须有对应的变更条目
  // （否则会出现"版本变了但没人知道变了什么"—— 交付物最忌讳这个）
  {
    const cl = path.join(REPO, "CHANGELOG.md");
    if (!fs.existsSync(cl)) {
      report.fail(GATE, "docs/changelog-version", "缺 CHANGELOG.md —— 版本策略与变更条目无处可查");
    } else {
      const pkgVersion = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8")).version;
      const text = fs.readFileSync(cl, "utf8");
      // 必须是形如 `## <版本>` 的**发布条目**，不是文中随便出现这个字符串
      // （第一版用 includes，结果版本策略里举的例子"从 0.1.0 升到 0.2.0"把检查骗过了）
      const esc = pkgVersion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`^##\\s+.*${esc}(?!\\d)`, "m");
      if (!re.test(text)) {
        report.fail(GATE, "docs/changelog-version", `CHANGELOG.md 里没有形如「## ${pkgVersion}」的发布条目 —— 补条目再发版`);
      } else {
        report.pass(GATE, "docs/changelog-version", `CHANGELOG.md 有 ${pkgVersion} 的发布条目`);
      }
    }
  }

  // A5c 生成的文档必须与真源同步
  // 手写文档不会报错地过期，然后开始骗人；所以凡是"由真源生成"的文档，都用机器拦同步。
  {
    const r = spawnSync(process.execPath, [path.join(REPO, "tools/gen-capability-doc.mjs"), "--check"], { encoding: "utf8" });
    if (r.status === 0) report.pass(GATE, "docs/catalog-sync", "能力目录文档与 core/catalog 真源同步");
    else report.fail(GATE, "docs/catalog-sync", `能力目录文档与真源不同步 —— 跑 make gen-docs 刷新（${(r.stderr ?? "").trim().slice(0, 120)}）`);
  }

  // A6 预装清单
  checkPreinstall(report);

  let preinstall = null;
  if (fs.existsSync(PREINSTALL_PATH)) {
    try { preinstall = loadPreinstall(); } catch { preinstall = null; }
  }

  // Provider 目录：`model.provider` 必须是这里声明过的供应商。
  // **内置常用供应商**（deepseek / openai / corp-gateway …）+ 部署层/智能体自带那份按 id 合并覆盖 ——
  // 于是"换个供应商"通常一行都不用写，"换个内部端点"也只需覆盖同名条目。
  const routeCatalog = loadProviders({ agentDir });

  return { ajv, agentSchema, connectorsSchema, caps, params, preinstall, routeCatalog };
}

// ---------------------------------------------------------------------------
// A6. 预装清单自洽（core/image/preinstall.yaml）
//
// 预装清单是「有意升级基座镜像」的账本，它的失效方式很安静：pin 漂了、包废弃了、
// 技能声明了却没落盘 —— 镜像照样能建出来，只是能力悄悄没了。所以这里做机器校验。
// ---------------------------------------------------------------------------
const CREDENTIAL_KINDS = ["none", "optional", "required"];
const EXACT_VERSION_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function checkPreinstall(report) {
  const file = path.join(CORE, "image", "preinstall.yaml");
  if (!fs.existsSync(file)) {
    report.fail(GATE, "preinstall/parse", `缺少 ${path.relative(REPO, file)}`);
    return;
  }
  let list;
  try {
    list = loadYaml(file);
  } catch (e) {
    report.fail(GATE, "preinstall/parse", `preinstall.yaml 不是合法 YAML：${e.message}`);
    return;
  }
  report.pass(GATE, "preinstall/parse", "preinstall.yaml 可解析");

  const entries = list.entries ?? [];
  const categoryIds = new Set((list.categories ?? []).map((c) => c.id));

  // 每条必须有：id / kind / category / rationale / credentials
  // verifiedAlive 只对「从 registry 安装的条目」有意义（mcp / system）——
  // 技能是我们自己写的文件，没有包生命周期可查，靠 status 字段自洽。
  const incomplete = [];
  for (const [i, e] of entries.entries()) {
    const where = e.id ?? `#${i}`;
    if (!e.id) incomplete.push(`${where}: 缺 id`);
    if (!e.kind) incomplete.push(`${where}: 缺 kind`);
    if (!e.category) incomplete.push(`${where}: 缺 category`);
    if (!e.rationale) incomplete.push(`${where}: 缺 rationale（这份清单是账本，不是堆放处）`);
    if (!CREDENTIAL_KINDS.includes(e.credentials)) incomplete.push(`${where}: credentials 必须是 ${CREDENTIAL_KINDS.join(" | ")}`);
    if (e.kind !== "skill" && (!e.verifiedAlive || !DATE_RE.test(String(e.verifiedAlive)))) {
      incomplete.push(`${where}: verifiedAlive 缺失或不是 YYYY-MM-DD`);
    }
  }
  if (incomplete.length) report.fail(GATE, "preinstall/entry-required", `条目字段不全：${incomplete.join("；")}`);
  else report.pass(GATE, "preinstall/entry-required", `${entries.length} 条预装条目的必填字段齐全`);

  // 版本必须精确 pin：范围/标签一律算错 —— 范围会让镜像随上游漂移
  const loosePins = [];
  for (const e of entries) {
    if (e.kind !== "mcp") continue;
    const v = e.install?.version;
    if (v === undefined) continue;
    if (!EXACT_VERSION_RE.test(String(v))) loosePins.push(`${e.id}: ${v}`);
  }
  if (loosePins.length) {
    report.fail(GATE, "preinstall/pin", `版本不是精确 pin（不许范围/latest）：${loosePins.join("；")}`);
  } else {
    report.pass(GATE, "preinstall/pin", "所有 npm 条目都精确 pin 到具体版本");
  }

  // 分类必须已声明
  const badCat = entries.filter((e) => e.category && !categoryIds.has(e.category)).map((e) => `${e.id}:${e.category}`);
  if (badCat.length) report.fail(GATE, "preinstall/category", `引用了未声明的分类：${badCat.join("；")}`);
  else report.pass(GATE, "preinstall/category", "所有条目的分类都已在 categories 中声明");

  // id 唯一
  const ids = entries.map((e) => e.id);
  const dupes = ids.filter((x, i) => ids.indexOf(x) !== i);
  if (dupes.length) report.fail(GATE, "preinstall/unique", `重复 id：${[...new Set(dupes)].join(", ")}`);
  else report.pass(GATE, "preinstall/unique", "条目 id 唯一");

  // 技能条目：planned 必须写明 targetPackage；shipped 必须有落盘的 source
  const skillProblems = [];
  for (const e of entries.filter((x) => x.kind === "skill")) {
    if (e.status === "planned") {
      if (!e.targetPackage) skillProblems.push(`${e.id}: status=planned 但没写 targetPackage`);
    } else if (e.status === "shipped") {
      if (!e.source) skillProblems.push(`${e.id}: status=shipped 但没写 source`);
      else if (!fs.existsSync(path.join(REPO, e.source))) skillProblems.push(`${e.id}: status=shipped 但 ${e.source} 不存在`);
    } else {
      skillProblems.push(`${e.id}: status 必须显式写 planned 或 shipped`);
    }
  }
  if (skillProblems.length) report.fail(GATE, "preinstall/planned-skill", `技能条目不自洽：${skillProblems.join("；")}`);
  else report.pass(GATE, "preinstall/planned-skill", "技能条目的 status 与落盘情况一致（未落盘的都标了 planned）");

  // 排除项必须写明理由
  const noReason = (list.excluded ?? []).filter((x) => !x.reason).map((x) => x.id);
  if (noReason.length) report.fail(GATE, "preinstall/excluded-reason", `排除项缺 reason：${noReason.join(", ")}`);
  else report.pass(GATE, "preinstall/excluded-reason", `排除项都写明了理由（${(list.excluded ?? []).length} 条）`);

  // 「非专家可上手」不能只靠文档承诺：每条都要写清开发时拿它做什么
  const noDevUse = entries.filter((e) => !e.devUse).map((e) => e.id);
  if (noDevUse.length) {
    report.fail(GATE, "preinstall/dev-use", `缺 devUse（开发智能体时拿它做什么）：${noDevUse.join(", ")}`);
  } else {
    report.pass(GATE, "preinstall/dev-use", `${entries.length} 条都写明了「开发时拿它做什么」`);
  }

  // namedReferences ↔ entries.refName 双向一致 —— 这是「开发者只写一个名字」的契约本身
  const named = list.namedReferences ?? {};
  const byId = new Map(entries.map((e) => [e.id, e]));
  const refProblems = [];
  for (const [name, entryId] of Object.entries(named)) {
    const e = byId.get(entryId);
    if (!e) refProblems.push(`namedReferences.${name} 指向不存在的条目 ${entryId}`);
    else if (e.refName !== name) refProblems.push(`namedReferences.${name} 与条目 ${entryId} 的 refName（${e.refName}）不一致`);
  }
  for (const e of entries) {
    if (e.refName && named[e.refName] !== e.id) refProblems.push(`条目 ${e.id} 的 refName「${e.refName}」没有出现在 namedReferences 里`);
  }
  const dupRef = Object.keys(named).length !== new Set(Object.values(named)).size;
  if (dupRef) refProblems.push("namedReferences 里有多个名字指向同一条目");
  if (refProblems.length) {
    report.fail(GATE, "preinstall/ref-name", `引用名契约不自洽：${refProblems.join("；")}`);
  } else {
      // 镜像构建锁必须与清单同步：不同步意味着「镜像里装的包」与「清单里写的」不是一回事，
  // 而两边都不会报错 —— 这类失效只有到某个智能体在运行时连不上才发现。
  {
    const lockFile = path.join(CORE, "image", "preinstall.lock.txt");
    if (!fs.existsSync(lockFile)) {
      report.fail(GATE, "preinstall/lock-sync", "缺 preinstall.lock.txt —— 跑 `make image-lock` 生成");
    } else {
      const expected = buildLock({ list, named: list.namedReferences ?? {}, byId, byRefName: new Map() });
      const actual = fs.readFileSync(lockFile, "utf8");
      if (actual !== expected.lines) {
        report.fail(GATE, "preinstall/lock-sync", "preinstall.lock.txt 与清单不同步 —— 跑 `make image-lock` 刷新");
      } else {
        report.pass(GATE, "preinstall/lock-sync", `镜像构建锁与清单同步（npm ${expected.counts.npm} · apt ${expected.counts.apt} · 技能 ${expected.counts.skill}）`);
      }
    }
  }

report.pass(GATE, "preinstall/ref-name", `引用名契约双向一致（${Object.keys(named).length} 个开发者可见名字）`);
  }

  // needsExternalCredential 的条目必须能对上参数层允许清单的命名约定
  const params = loadYaml(path.join(CATALOG, "params.yaml"));
  const patterns = (params.allowed ?? []).map((a) => new RegExp(a.pattern));
  const unmatched = [];
  for (const e of entries) {
    if (e.credentials !== "required" || !e.credentialRef) continue;
    if (!patterns.some((re) => re.test(e.credentialRef))) unmatched.push(`${e.id}: ${e.credentialRef}`);
  }
  if (unmatched.length) {
    report.fail(GATE, "preinstall/credential-ref", `凭据引用名不落在参数层允许清单内：${unmatched.join("；")}`);
  } else {
    report.pass(GATE, "preinstall/credential-ref", "需要凭据的条目引用了合法的参数层名");
  }
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

    // 参数层引用名由解析器统一给出（完整形态取字段、ref 形态取预装条目）—— 见下方 B3'
  }

  // B3' 连接器解析：ref 形态必须能解析到，且解析结果里的凭据引用名进 §6.7 报告的 paramNames。
  //     未知 ref 必须**显式失败** —— 否则开发者会以为连接器生效了（§4.3 设计点 4）。
  //     解析逻辑在 core/image/resolve-preinstall.mjs（harness 无关），这里只消费结果。
  if (connectors) {
    const resolved = resolveConnectors(connectors, ctx.preinstall);
    if (agent.model?.route) report.paramNames.push(agent.model.route);
    report.paramNames.push(...resolved.paramNames);
    report.paramNames = [...new Set(report.paramNames)].sort();

    if (resolved.problems.length) {
      report.fail(GATE, "ref/unknown-ref",
        resolved.problems.map((p) => `${p.server}: ${p.detail}`).join("；"));
    } else {
      const refCount = resolved.servers.filter((s) => s.origin === "ref").length;
      report.pass(GATE, "ref/unknown-ref",
        refCount
          ? `${refCount} 个 ref 都能在预装清单里解析到`
          : "没有使用 ref 形态（全部为完整形态）");
    }
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
  // route 必须由基座声明（P-a：能力在基座、选择在智能体）。此前不校验 ⇒ 写错路由名渲染照样成功，
  // 等到运行时才炸，且报错看不懂。这里当场拦住并给出可用取值。
  {
    const cat = ctx.routeCatalog ?? { providers: [], errors: ["未加载 provider 目录"] };
    const routes = cat.providers ?? [];
    const declared = new Set(routes.map((r) => r.id));
    const providerId = agent.model?.provider ?? agent.model?.route;
    const fieldName = agent.model?.provider ? "model.provider" : "model.route";
    if (!routes.length) report.fail(GATE, "provider/declared", `${cat.errors?.join("；") ?? "provider 目录为空"} —— 无法校验 ${fieldName}`);
    else if (!providerId) report.fail(GATE, "provider/declared", "缺 model.provider（或旧名 model.route）");
    else if (!declared.has(providerId)) report.fail(GATE, "provider/declared", `${fieldName}「${providerId}」不在 provider 目录里。可用：${[...declared].sort().join(", ")}`);
    else {
      const p = routes.find((r) => r.id === providerId);
      report.pass(GATE, "provider/declared", `${fieldName}「${providerId}」已声明（${p.api}${p.baseUrl ? `，端点 ${p.baseUrl}` : `，端点由 ${p.baseUrlParam} 给`}）`);
    }

    // 默认模型名必须在该路由声明的模型名单内（名单为空 = 该路由不声明目录，跳过）。
    // 这条把"写错模型名"从"运行时端点返回一句看不懂的错"提前到"定义校验期"。
    const r = providerId ? routes.find((x) => x.id === providerId) : null;
    const allowedModels = r?.models ?? [];
    if (r && allowedModels.length) {
      if (allowedModels.includes(agent.model?.name)) {
        report.pass(GATE, "model/declared-in-provider", `model.name「${agent.model.name}」在 provider ${providerId} 的模型名单内`);
      } else {
        report.fail(GATE, "model/declared-in-provider",
          `model.name「${agent.model?.name}」不在 provider ${providerId} 的模型名单内。它提供：${allowedModels.join(", ")}`);
      }
    } else if (r) {
      report.pass(GATE, "model/declared-in-provider", `provider ${providerId} 未声明模型名单，跳过成员资格校验（名字非空由 schema 保证）`);
    }
  }

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
  const ctx = checkBase(report, dir);
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
  const agentDirArg = positional.length ? path.resolve(positional[0]) : process.cwd();
  const ctx = checkBase(report, agentDirArg);
  if (positional.length) checkAgent(report, ctx, agentDirArg);

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
