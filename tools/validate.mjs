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
import { findProvider, loadProviders } from "../core/catalog/providers.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import Ajv2020 from "ajv/dist/2020.js";
import { spawnSync } from "node:child_process";
import { buildLock } from "../core/image/gen-preinstall-lock.mjs";
import { collectOpenNamespace } from "../core/spec/open-namespace.mjs";
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
 *   · 标量 / 对象字段        → `model.provider`、`persona.instructions`
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
  // 增强 schema 也在覆盖范围内：它的条目以前没人对，于是 `event` 改名 `events` 后，
  // 目录里那份会**留下来**（"文档说有、实现没有"的同一类：两处真源漂移）。
  const enhSchemaRaw = JSON.parse(fs.readFileSync(path.join(SPEC, "enhancements.schema.json"), "utf8"));
  const ENH_SOURCE = "harness/<h>/enhancements.yaml";
  const enhFieldPaths = Object.keys(enhSchemaRaw.properties.enhancements.items.properties)
    .map((f) => `${ENH_SOURCE}#enhancements[].${f}`);
  const capsFields = caps.groups.flatMap((g) => g.fields ?? []);
  const capsPaths = new Set(capsFields.map((f) => f.path));
  const schemaPaths = [
    ...deriveSchemaPaths(agentSchema).map((p) => ({ p, src: "agent.yaml" })),
    ...deriveSchemaPaths(connectorsSchema).filter((p) => p !== "apiVersion").map((p) => ({ p, src: "connectors.yaml" })),
    ...enhFieldPaths.map((p) => ({ p, src: ENH_SOURCE })),
  ];
  const missing = schemaPaths.filter(({ p }) => !capsPaths.has(p));
  if (missing.length) {
    report.fail(GATE, "catalog/missing-field",
      `schema 有字段但能力目录没有（两处真源漂移）：${missing.map((m) => `${m.src}:${m.p}`).join(", ")}`);
  } else {
    report.pass(GATE, "catalog/missing-field", `能力目录覆盖 schema 全部 ${schemaPaths.length} 个字段路径`);
  }
  const stale = capsFields
    .filter((f) => /^(agent|connectors)\.yaml/.test(f.source ?? "") || f.source === ENH_SOURCE)
    .filter((f) => !schemaPaths.some(({ p }) => p === f.path));
  if (stale.length) {
    report.fail(GATE, "catalog/stale-field", `能力目录有字段但 schema 里不存在：${stale.map((f) => f.path).join(", ")}`);
  } else {
    report.pass(GATE, "catalog/stale-field", "能力目录没有指向已删除字段的残留条目");
  }

  // A2b 枚举值也必须与 schema 一致：目录里留着 `plugin`、schema 里没有 ⇒
  // 文档正在教人写一个**必红**的 kind（比字段名拼错更难发现，因为两边都"看起来对"）。
  {
    // kind 现在可以是「已知枚举」**或** `x-*` 自定义种类（§25 O1）⇒ 从 anyOf 形态里取枚举部分；
    // 老形态（直接 enum）继续支持，免得这个检查本身变成"只认一种写法"的脆弱点。
    const kindSchema = enhSchemaRaw.properties.enhancements.items.properties.kind;
    const schemaKind = kindSchema.enum ?? kindSchema.anyOf?.find((x) => Array.isArray(x.enum))?.enum ?? [];
    const hasCustomKind = (kindSchema.anyOf ?? []).some((x) => typeof x.pattern === "string" && x.pattern.includes("x-"));
    const capKind = capsFields.find((f) => f.path === `${ENH_SOURCE}#enhancements[].kind`)?.values?.enum ?? [];
    const same = schemaKind.length === capKind.length && schemaKind.every((v) => capKind.includes(v));
    if (!same) {
      report.fail(GATE, "catalog/enum-sync",
        `增强 kind 的枚举与 enhancements.schema.json 不一致（两处真源）：`
        + `catalog=[${capKind.join(", ")}] schema=[${schemaKind.join(", ")}]`);
    } else if (!hasCustomKind) {
      report.fail(GATE, "catalog/enum-sync",
        `增强 kind 的 schema 里没有自定义种类通道（缺 \`x-*\` 分支）—— 对外开放命名空间是 §25 O1 的要求`);
    } else {
      report.pass(GATE, "catalog/enum-sync",
        `增强 kind 枚举与 schema 一致（${schemaKind.length} 个取值）+ 自定义种类通道（\`x-*\`）`);
    }
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

  // A4c 钩子事件集合的**声明自洽**（E1 的一半；另一半是拿它对增强声明里的名字）
  // 事件名是从运行时包里手抄的（类型定义的 on() 重载），手抄就会漏 ——
  // 所以要求一个见证值 count：它与 events 长度不符 ⇒ 当场红，而不是等写错名字的人来踩。
  {
    const problems = [];
    const summary = [];
    for (const h of HARNESS_NAMES) {
      let a;
      try { a = loadYaml(path.join(REPO, "adapters", h, "adapter.yaml")); }
      catch (e) { problems.push(`adapters/${h}/adapter.yaml 读不出来：${e.message}`); continue; }
      const he = a.hookEvents;
      if (!he) { problems.push(`adapters/${h}/adapter.yaml 未声明 hookEvents ⇒ 该运行时的钩子事件名无处校验`); continue; }
      const events = he.events ?? [];
      if (he.enumerated === true) {
        if (!events.length) problems.push(`adapters/${h}: enumerated=true 但 events 为空`);
        else if (new Set(events).size !== events.length) problems.push(`adapters/${h}: events 有重复项`);
        if (he.count !== events.length) problems.push(`adapters/${h}: count=${he.count} 与 events 长度 ${events.length} 不符（手抄漏项？）`);
        if (!he.source) problems.push(`adapters/${h}: 没写 source（这个集合是从哪儿数出来的）`);
        summary.push(`${h}: ${events.length} 个已穷举`);
      } else if (he.enumerated === false) {
        if (events.length) problems.push(`adapters/${h}: enumerated=false 却给了 ${events.length} 个名字 —— 要么穷举并置 true，要么别给`);
        else if (!he.note) problems.push(`adapters/${h}: enumerated=false 必须写 note 说明为什么没穷举`);
        else summary.push(`${h}: 未穷举（如实标注 ⇒ 声明按「未验证」处理）`);
      } else {
        problems.push(`adapters/${h}: hookEvents.enumerated 必须是 true 或 false（不许含糊）`);
      }
    }
    if (problems.length) report.fail(GATE, "hook/events-decl", `钩子事件集合声明不自洽：${problems.join("；")}`);
    else report.pass(GATE, "hook/events-decl", `各运行时可订阅事件集合已声明（${summary.join(" · ")}）`);
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
      // **协议形状**必须被两个运行时同时支持（可移植核心的一部分）：
      // 写错或用了只有某一个运行时认的形状，会在运行时表现为看不懂的报错 —— 这里当场拦。
      // 各适配器支持的形状来自 adapters/<h>/adapter.yaml 的 capabilities.modelApis（实测得出）。
      const apiSupport = {};
      for (const h of HARNESS_NAMES) {
        try {
          const a = loadYaml(path.join(REPO, "adapters", h, "adapter.yaml"));
          apiSupport[h] = new Set(a.modelApis ?? []);
        } catch { apiSupport[h] = new Set(); }
      }
      // 校验**该 provider 自己声明的运行时作用域**：没写 harnesses 就是"两个都要"，写了 [pi] 就只查 pi。
      // （用户明确说过：pi 能多几个 provider 是可选项 —— 不是处处必须相同。）
      const unsupported = [];
      for (const r of list) {
        if (!r.api) { unsupported.push(`${r.id}.api 缺失`); continue; }
        const scope = r.harnesses ?? Object.keys(apiSupport);
        for (const h of scope) {
          const set = apiSupport[h];
          if (!set) { unsupported.push(`${r.id}.harnesses 里的 ${h} 不是已知运行时`); continue; }
          if (set.size && !set.has(r.api)) unsupported.push(`${r.id}.api=${r.api} 不被 ${h} 支持`);
        }
      }
      const badId = list.filter((r) => !/^[a-z][a-z0-9-]{1,30}$/.test(r.id ?? "")).map((r) => r.id ?? "(缺 id)");
      // 约定名是**默认**，不是强制：显式声明了就用声明的（各家通行写法不同，如 ZAI_API_KEY /
      // MOONSHOT_API_KEY）；`null` 表示这家不产生该引用名（本地服务免密钥 / 订阅型走运行时凭据库）。
      // 显式声明的名字本身是否合规，由 providers/param-allowed 按参数层 pattern 判。
      const badNames = [];
      for (const r of list) {
        const want = {
          baseUrlParam: { derived: `${prefixOf(r.id)}_BASE_URL`, declared: r.declared?.baseUrlParam },
          credentialParam: { derived: `${prefixOf(r.id)}_API_KEY`, declared: r.declared?.credentialEnv },
          modelParam: { derived: `${prefixOf(r.id)}_MODEL`, declared: r.declared?.modelParam },
        };
        for (const [k, { derived, declared }] of Object.entries(want)) {
          if (r[k] === null) continue;                       // 不产生该引用名：合法
          if (declared) continue;                            // 显式声明：以声明为准
          if (r[k] !== derived) badNames.push(`${r.id}.${k}=${r[k] ?? "(缺)"}，未显式声明时按约定应为 ${derived}`);
        }
      }
      // 「引用名必须被参数层允许」不能靠一张手写名单（那张名单不存在 ⇒ 这个检查曾经是**空转**的）。
      // 真正的判据是：名字必须匹配 params.allowed 里某条**支撑模型组字段**的 pattern
      // （端点/凭据 backs model.provider；模型名 backs model.name —— 三者都由供应商名前缀派生）。
      // 空转的检查比没有更糟 —— 它给了一种"已经管住了"的错觉。
      // 模型组字段：provider（新）与 route（旧名）都算 —— 引用名由供应商名派生
      const MODEL_GROUP_BACKS = ["model.provider", "model.name", "model.reasoningEffort"];
      const routePats = (params.allowed ?? [])
        .filter((a) => (a.backs ?? []).some((b) => MODEL_GROUP_BACKS.includes(b)))
        .map((a) => ({ id: a.id, re: new RegExp(a.pattern) }));
      const notAllowed = [];
      for (const r of list) for (const k of ["baseUrlParam", "credentialParam", "modelParam"]) {
        const n = r[k];
        if (!n) continue;
        if (!routePats.some((p) => p.re.test(n))) {
          notAllowed.push(`${r.id}.${k}=${n}（不匹配任何支撑模型组字段的参数项：${routePats.map((p) => p.id).join(", ")}）`);
        }
      }
      if (unsupported.length) {
        const known = [...new Set(Object.values(apiSupport).flatMap((x) => [...x]))].sort().join(", ");
        report.fail(GATE, "providers/model-api", `协议形状不被支持（按各 provider 的 harnesses 作用域判定）：${unsupported.join("；")}。可用形状：${known || "(适配器未声明)"}`);
      } else {
        {
        const scoped = list.filter((r) => r.harnesses).map((r) => `${r.id}[${r.harnesses.join(",")}]`);
        report.pass(GATE, "providers/model-api",
          `provider 的 api 形状都在各自作用域内可用${scoped.length ? `（限定作用域的：${scoped.join("、")}）` : ""}`);
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

  const enhSchemaPath = path.join(REPO, "core/spec/enhancements.schema.json");

  const enhSchema = fs.existsSync(enhSchemaPath)

    ? ajv.compile(JSON.parse(fs.readFileSync(enhSchemaPath, "utf8")))

    : null;
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
    if (agent.model?.provider) report.paramNames.push(agent.model.provider);
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

  // B6 单一真源 + **schema 校验** + **钩子事件名逐个对名字**（缺陷 D1 + 路线图 §23 E1）
  // 两个来源都要查：智能体自己的声明，以及**基座自己的**声明（`adapters/<h>/seed/`）。
  // 基座不给自己开后门：seed 的 enhancements.yaml 以前根本没人校验 —— 它自己那份 kind=hook
  // 连事件名都没写，却一直是"全绿"。要验的规矩，基座第一个先过。
  const dupes = [];
  const schemaPassed = [];
  const eventProblems = [];
  const eventVerified = [];
  const eventUnverified = [];
  for (const h of HARNESS_NAMES) {
    let adapter = null;
    try { adapter = loadYaml(path.join(REPO, "adapters", h, "adapter.yaml")); } catch { /* 基座自洽那一段会报 */ }
    const hookSet = adapter?.hookEvents;
    const sources = [
      { label: `harness/${h}/enhancements.yaml`, file: path.join(agentDir, "harness", h, "enhancements.yaml") },
      { label: `adapters/${h}/seed/enhancements.yaml`, file: path.join(REPO, "adapters", h, "seed", "enhancements.yaml") },
    ];
    for (const src of sources) {
      if (!fs.existsSync(src.file)) continue;
      let enh;
      try { enh = loadYaml(src.file); } catch (e) {
        report.fail(GATE, "enhance/yaml", `${src.label} 不是合法 YAML：${e.message}`);
        continue;
      }
      // schema：kind 枚举、hook 必填 events、entry/package 至少一个、id 形状
      if (enhSchema) {
        if (enhSchema(enh)) schemaPassed.push(src.label);
        else {
          const first = (enhSchema.errors ?? [])[0] ?? {};
          const at = (first.instancePath || "(根)").replace(/^\//, "");
          report.fail(GATE, "enhance/schema",
            `${src.label} 不符合 core/spec/enhancements.schema.json：`
            + `${at} ${first.message ?? "校验失败"}`
            + `（kind 必须合法；kind=hook 必须给 events **数组**；entry 与 package 至少给一个）`);
        }
      }
      for (const key of Object.keys(enh ?? {})) {
        if (NEUTRAL_KEYS_FORBIDDEN_IN_ENHANCEMENTS.includes(key)) dupes.push(`${src.label}:${key}`);
      }
      // 钩子事件名：逐个对适配器声明的"该运行时能订阅哪些事件"
      for (const e of (enh?.enhancements ?? []).filter((x) => x?.kind === "hook")) {
        const names = Array.isArray(e.events) ? e.events : [];
        if (!hookSet) {
          eventProblems.push(`${src.label}:${e.id} 声明了钩子，但 adapters/${h}/adapter.yaml 没有 hookEvents ⇒ 事件名无从核对`);
          continue;
        }
        if (hookSet.enumerated === true) {
          const known = hookSet.events ?? [];
          const bad = names.filter((n) => !known.includes(n));
          if (bad.length) {
            eventProblems.push(`${src.label}:${e.id} 订阅了该运行时不存在的 ${bad.length} 个事件：${bad.join(", ")}`
              + `（adapters/${h}/adapter.yaml 声明的 ${known.length} 个可订阅事件里没有；复算命令见该文件的 hookEvents.reproduce）`);
          } else {
            eventVerified.push(`${src.label}:${e.id}（${names.length} 个事件）`);
          }
        } else {
          eventUnverified.push(`${src.label}:${e.id} → ${names.join(", ") || "（未给）"}`);
        }
      }
    }
  }
  if (dupes.length) report.fail(GATE, "enhance/single-source", `增强重复表达了中性定义字段（两个真源）：${dupes.join(", ")}`);
  else report.pass(GATE, "enhance/single-source", "业务级增强没有重复表达中性定义字段");

  // ---- 未验证声明（§25 O1/O3）----
  // 开放命名空间（`x-*` / `customizations:` / `kind: x-*`）**允许存在**，但必须被**列出来**：
  // 不列出来的扩展就是"悄悄多出来的东西"，而这条检查的全部价值就是让它可见（口径见 O2：
  // 基座保证自己声明的字段；之外允许，但不在保证范围内 ⇒ 标成「未验证声明」）。
  {
    const allEnh = [];
    for (const h of HARNESS_NAMES) {
      const f = path.join(agentDir, "harness", h, "enhancements.yaml");
      if (fs.existsSync(f)) {
        try {
          const doc = loadYaml(f);
          for (const e of doc.enhancements ?? []) allEnh.push(e);
        } catch { /* schema 那条已经在别处报过了 */ }
      }
    }
    const connFile = agent.connectorsFile ? path.join(agentDir, agent.connectorsFile) : null;
    const connDoc = connFile && fs.existsSync(connFile) ? (() => { try { return loadYaml(connFile); } catch { return null; } })() : null;
    const open = collectOpenNamespace({ agent, connectors: connDoc, enhancements: allEnh });
    report.pass(GATE, "open/unverified-declarations", open.length
      ? `${open.length} 条**未验证声明**（基座不解释、原样透传；不在保证范围内）：\n`
        + open.map((o) => `      · ${o.path} —— ${o.note.split("——")[0].trim()}`).join("\n")
      : "本定义没有使用自定义字段/自定义 kind（基座声明的字段之外没有别的）");
  }
  if (schemaPassed.length) report.pass(GATE, "enhance/schema", `${schemaPassed.join(" · ")} 符合增强 schema`);
  if (eventProblems.length) {
    report.fail(GATE, "enhance/events", `钩子订阅了不存在的生命周期事件：${eventProblems.join("；")}`);
  } else {
    report.pass(GATE, "enhance/events",
      `钩子事件名与适配器声明的可订阅集合一致（${eventVerified.join(" · ") || "无已穷举运行时的钩子声明"}）`
      + (eventUnverified.length
        ? `；另有 ${eventUnverified.length} 条按「未验证」处理（该运行时未穷举事件集合）：${eventUnverified.join(" · ")}`
        : ""));
  }

  // B6b 共享业务代码必须与运行时无关
  {
    const sharedDir = path.join(agentDir, "harness", "shared");
    if (fs.existsSync(sharedDir)) {
      // 运行时专属包/名字：出现在共享代码里 ⇒ 它已经不可共享了
      const FORBIDDEN = [
        /@earendil-works\//, /@deepseek-ai\//, /@anthropic-ai\//, // 运行时 SDK
        /from\s+["']pi["']/, /from\s+["']dsh["']/,                    // 运行时自身
        /\bpi\.register\w+/, /ctx\.tools\b/,                        // 运行时 API
      ];
      const offenders = [];
      const walk = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, e.name);
          if (e.isDirectory()) { walk(full); continue; }
          if (!/\.(mjs|js|ts|json)$/.test(e.name)) continue;
          // **先剥注释再扫**：共享文件里用注释说明"两边接入方式不同"是正常且有益的，
          // 那不是依赖。判据要盯的是**代码**（import / 调用），不是文档。
          // （早先直接扫全文 ⇒ 把自己的注释判成违规=假阴/假阳同一类问题。）
          const text = fs.readFileSync(full, "utf8")
            .replace(/\/\*[\s\S]*?\*\//g, "")
            .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
          for (const re of FORBIDDEN) {
            const m = re.exec(text);
            if (m) { offenders.push(`${path.relative(agentDir, full)} 出现 ${JSON.stringify(m[0])}`); break; }
          }
        }
      };
      walk(sharedDir);
      if (offenders.length) {
        report.fail(GATE, "enhance/shared-agnostic",
          `harness/shared/ 是**共享业务代码**，不许依赖任何运行时：${offenders.join("；")}`
          + "（把接入相关的东西移到 harness/<运行时>/ 里，共享文件只留业务逻辑）");
      } else {
        report.pass(GATE, "enhance/shared-agnostic", "harness/shared/ 里的业务代码与运行时无关（可共享）");
      }
    }
  }

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
    // `model.route` 已废除（不留旧名）。schema 会因 additionalProperties 拦下，
    // 但那条报错看不懂 —— 这里给一句能直接照做的迁移提示。
    if (agent.model?.route !== undefined) {
      report.fail(GATE, "provider/renamed", "`model.route` 已废除 → 请改写 `model.provider`（同一个值，不必改别处）");
    }
    const providerId = agent.model?.provider;
    const fieldName = "model.provider";
    if (!routes.length) report.fail(GATE, "provider/declared", `${cat.errors?.join("；") ?? "provider 目录为空"} —— 无法校验 ${fieldName}`);
    else if (!providerId) report.fail(GATE, "provider/declared", "缺 model.provider");
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

  // 正例样本（`positive/*`）：断言"必须通过，**且**某条检查里点到了某些名字"。
  // 有些判据不是"红了就对"（比如"未验证声明必须被列出来"），必须能验"绿且可见"。
  const posRoot = path.join(FIXTURES, "positive");
  const posDirs = fs.existsSync(posRoot)
    ? fs.readdirSync(posRoot, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()
    : [];
  for (const name of posDirs) {
    const dir = path.join(posRoot, name);
    const ef = path.join(dir, "expect.yaml");
    const spec = fs.existsSync(ef) ? loadYaml(ef) : {};
    const rep = runFixture(dir);
    const check = rep.checks?.find?.((c) => c.id === spec.expectCheck) ?? rep.toJSON().gates.flatMap((g) => g.checks).find((c) => c.id === spec.expectCheck);
    const misses = (spec.expectDetailContains ?? []).filter((s) => !String(check?.detail ?? "").includes(s));
    results.push({
      name: `positive/${name}`,
      passed: rep.ok && !!check && misses.length === 0,
      want: `${rep.ok ? "" : "必须全绿；"}${spec.expectCheck} 点到 ${(spec.expectDetailContains ?? []).join(", ")}`,
      got: rep.ok ? (misses.length ? `未点到：${misses.join(", ")}` : "全绿且已列出") : rep.failures.map((f) => f.id),
    });
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
  // 只校验智能体定义、跳过"基座自洽"那部分：镜像内自证用 ——
  // 镜像里没有基座的 docs/ 与仓库布局，跑基座自洽只会得到假红。
  const agentOnly = args.includes("--agent-only");
  const positional = args.filter((a) => !a.startsWith("-"));

  if (args.includes("--help") || args.includes("-h")) {
    process.stderr.write("用法: node tools/validate.mjs [AGENT_DIR] [--selftest] [--json] [--agent-only]\n");
    process.exit(EXIT_CODES.ok);
  }
  const known = ["--json", "--selftest", "--agent-only", "--help", "-h"];
  if (args.some((a) => a.startsWith("-") && !known.includes(a))) {
    process.stderr.write(`未知参数：${args.filter((a) => a.startsWith("-") && !known.includes(a)).join(" ")}\n`);
    process.exit(EXIT_CODES.usage);
  }
  if (positional.length > 1) {
    process.stderr.write(`只接受一个 AGENT_DIR，收到 ${positional.length} 个\n`);
    process.exit(EXIT_CODES.usage);
  }

  const report = new GateReport();
  const agentDirArg = positional.length ? path.resolve(positional[0]) : process.cwd();
  // --agent-only：镜像内自证用 —— 镜像里没有基座的 docs/ 与仓库布局，跑基座自洽只会假红。
  // 注意：**不能跳过 checkBase 的加载**（它给出 schema/ajv/目录等上下文，checkAgent 依赖它们），
  // 只能把基座自洽的**报告**写进一个被丢弃的 report，然后把它加载出的 ctx 交给 checkAgent。
  const baseCtx = checkBase(agentOnly ? new GateReport(GATE) : report, agentDirArg);
  const ctx = baseCtx;
  if (agentOnly) report.pass(GATE, "cli/agent-only", "只校验智能体定义（跳过基座自洽：镜像内自证用）");
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
