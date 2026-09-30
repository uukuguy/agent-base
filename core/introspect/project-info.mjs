// ============================================================================
// 项目自省：**纯逻辑**（不依赖任何运行时 API，也不含任何运行时专有名）
//
// 为什么要单独一层（而且在 `core/` 里）：
//   · 会话内的斜杠命令只做"把结果送给用户"，真正的读取与渲染在这里 ⇒ 可以被自检直接 import 断言
//     （不需要交互终端、不需要起运行时）；
//   · 命令行出口（`tools/project-info.mjs`）与各适配器的会话内入口**共用这一份**
//     ⇒ 不存在"两份文案迟早不一致"；
//   · 产物侧由渲染器把本文件拷进 `extensions/_` 开头的位置（助手文件，不登记为扩展）。
//
// ## 唯一的真源是**产物**，不是文档
//
// 读的全是运行期真实存在的东西：
//   · `$AGENT_ARTIFACT_DIR/render-manifest.json` —— 渲染清单（声明了什么、摘要是什么）
//   · 产物配置目录（由运行期布局契约指过来的那个目录）—— settings.json / models.json.tmpl /
//     enhancements.yaml / mcp.json / skills/（这几个文件渲染器写成 JSON，所以**不需要 YAML 解析器**：
//     产物里没有 node_modules 可以 import yaml）
//   · `$AGENT_GATES_DIR/core/trace/schema.json` —— 轨迹事件类型（同样是 JSON）
//
// 读不到就**如实说"读不到/未声明"**，绝不猜、不编 —— 这条命令的用途就是调试，
// 它要是会编，那它就没有价值。
//
// ## 绝不打印凭据
//
// 产物里的端点/凭据都是**引用名**（`${…_API_KEY}` 这种形态），我们只打印引用名。
// 明确**不读**凭据文件（`auth.json`）—— 那是登录态，不属于"项目信息"。
// ============================================================================

export const CATEGORIES = [
  { name: "overview", doc: "这个智能体是什么：harness、摘要、声明计数" },
  { name: "model", doc: "模型路由：provider / 模型名 / 端点与凭据的**引用名**" },
  { name: "skills", doc: "技能清单（含每个技能的一句话与落点）" },
  { name: "bundles", doc: "能力包（L4）：可用包 / 当前激活 / 包里有什么 / 怎么开（切换需重载会话）" },
  { name: "connectors", doc: "连接器（MCP 服务器）与客户端扩展是否就位" },
  { name: "enhancements", doc: "业务级/基座增强：id、kind、接入件" },
  { name: "hooks", doc: "钩子：订阅了哪些事件、这些事件在运行时可订阅集合里是否真的存在" },
  { name: "trace", doc: "轨迹：落点、生效配置摘要、事件类型" },
  { name: "portability", doc: "可移植性等级是怎么算出来的" },
  { name: "plan", doc: "验证计划：本地要跑哪几道闸门、哪些只能在容器里验、为什么（与 `make verify-plan` 同源）" },
];

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import pathMod from "node:path";
const path = pathMod;

import { CONTAINER_ONLY } from "./_container-only.mjs";

const readJson = (file) => {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
};
/** 供**各运行时的布局模块**复用（`adapters/<h>/project-layout.mjs`）——它们读自己的产物形状。 */
export { readJson };

/** 极简 frontmatter：只取 `name` / `description` 的第一行，够展示用（不引入 YAML 依赖）。 */
function skillBlurb(dir) {
  const f = path.join(dir, "SKILL.md");
  if (!existsSync(f)) return null;
  const text = readFileSync(f, "utf8");
  if (!text.startsWith("---")) return { name: path.basename(dir), description: null };
  const end = text.indexOf("\n---", 3);
  const head = text.slice(3, end < 0 ? undefined : end);
  const pick = (key) => {
    const re = new RegExp(`^\\s*${key}\\s*:\\s*(.*)$`, "m");
    const m = head.match(re);
    if (!m) return null;
    let v = m[1].trim().replace(/^["']|["']$/g, "");
    if (v === ">" || v === "|" || v === "") {
      // 折叠/字面量块：取块内第一行有内容的
      const idx = head.indexOf(m[0]) + m[0].length;
      const first = head.slice(idx).split("\n").map((l) => l.trim()).find(Boolean);
      v = first ?? "";
    }
    return v || null;
  };
  return { name: pick("name") ?? path.basename(dir), description: pick("description") };
}

/**
 * 采集一份"当前项目"的事实。返回 `{ problems, ... }`：
 * **problems 非空时调用方必须响亮失败**，而不是拿半份数据编一份好看报告。
 */
export function collect({ productDir, artifactDir, gatesDir, layout } = {}) {
  const problems = [];
  // **清单是硬要求**（它才是"这是一个已渲染产物"的证据）；产物配置目录**可选** ——
  // 各运行时的产物形状不同（有的把配置摊在一个目录里，有的没有独立配置目录），
  // 读法由调用方通过 `layout` 传进来（`adapters/<h>/project-layout.mjs`），core 不认识任何运行时。
  const artifact = artifactDir && existsSync(artifactDir) ? artifactDir
    : productDir && existsSync(productDir) ? path.dirname(productDir) : null;
  const manifest = artifact ? readJson(path.join(artifact, "render-manifest.json")) : null;
  if (!manifest) {
    problems.push("读不到渲染清单（render-manifest.json）"
      + " —— 声明类信息只能显示「未知」。原因是本进程不知道**产物根**在哪："
      + "应设 AGENT_ARTIFACT_DIR=<渲染输出根>（清单在产物根，暂存的运行目录里没有它）");
  }
  if (productDir && !existsSync(productDir)) problems.push(`产物配置目录不存在：${productDir}`);

  // 运行期专有的产物读法（可选）：没有 layout 时，一切以清单为准。
  const reads = (productDir && existsSync(productDir) && typeof layout?.read === "function")
    ? (layout.read({ productDir, artifact, readJson, path: pathMod }) ?? {})
    : {};

  // 技能：配置目录下优先，其次产物根（两种形态都被实测过：一个在配置目录，一个在产物根）
  const skillsDir = [productDir && path.join(productDir, "skills"), artifact && path.join(artifact, "skills")]
    .filter((d) => d && existsSync(d))
    .map((d) => d)
    .find((d) => readdirSync(d).some((n) => statSync(path.join(d, n)).isDirectory())) ?? null;
  const skills = skillsDir
    ? readdirSync(skillsDir).filter((n) => statSync(path.join(skillsDir, n)).isDirectory())
        .map((n) => ({ dir: n, ...(skillBlurb(path.join(skillsDir, n)) ?? { description: null }) }))
    : [];

  return {
    problems,
    productDir: productDir ?? null,
    artifact,
    layoutId: layout?.id ?? null,
    manifest,
    // 能力包（L4）：激活集合来自**运行期**（基座解析后放在平台变量里），可用集合/成员表来自**清单**。
    // 技能与连接器的"实际加载"= 定义声明 ∪ 激活包带来的（未激活包的**不进**，如实标注）。
    bundles: (() => {
      const m = manifest?.bundles ?? null;
      if (!m) return null;
      // 激活集合：显式给了就用它；**没给就用清单里的默认组合**（那才是这次运行的生效集合——
      // 显示成"空"会让人以为什么都没开，而实际上默认包是开的）。
      const explicitRaw = process.env.AGENT_BUNDLES_ACTIVE;
      const active = (explicitRaw !== undefined && explicitRaw !== null)
        ? String(explicitRaw).split(",").map((x) => x.trim()).filter(Boolean)
        : [...(m.defaults ?? [])];
      const members = m.members ?? {};
      const fromActive = active.flatMap((id) => members[id]?.skills ?? []);
      const declared = (manifest?.declaredSkills ?? []).filter((n) => !Object.values(members).some((b) => (b.skills ?? []).includes(n)));
      return {
        available: m.available ?? [],
        defaults: m.defaults ?? [],
        baseSkills: m.baseSkills ?? [],
        members,
        active,
        explicit: explicitRaw !== undefined && explicitRaw !== null,
        effectiveSkills: [...new Set([...declared, ...fromActive])].sort(),
        inactiveOwnedSkills: Object.entries(members)
          .filter(([id]) => !active.includes(id))
          .flatMap(([, b]) => b.skills ?? [])
          .filter((n) => !active.flatMap((id) => members[id]?.skills ?? []).includes(n))
          .sort(),
      };
    })(),
    settings: reads.settings ?? null,
    models: reads.models ?? null,
    enhancements: reads.enhancements ?? [],
    servers: reads.servers ?? [],
    skills,
    skillsDir,
    trace: traceFacts({ gatesDir, productDir: productDir ?? artifact, manifest }),
  };
}

/** 轨迹事实：落点与摘要取自运行期环境变量（**是运行期注入的，所以只有跑起来才看得到**）。 */
function traceFacts({ gatesDir, productDir, manifest }) {
  const facts = {
    dest: process.env.AGENT_TRACE_DEST ?? null,
    digest: process.env.AGENT_EFFECTIVE_CONFIG_DIGEST ?? null,
    modelRoute: process.env.AGENT_MODEL_ROUTE ?? null,
    runMode: process.env.AGENT_RUN_MODE ?? null,
    eventTypes: null, schemaFrom: null,
  };
  // ⚠️ 逐个算、**先过滤再 join**：没有产物目录时 `path.join(null, "..")` 会**抛异常**，
  // 而这条命令的纪律是"绝不抛异常，最坏只是响亮地说读不到"（本轮自检抓到过）。
  const bases = [gatesDir, process.env.AGENT_BASE_ROOT, productDir ? path.join(productDir, "..") : null].filter(Boolean);
  for (const base of bases) {
    const file = path.join(base, "core", "trace", "schema.json");
    const schema = readJson(file);
    if (!schema) continue;
    facts.schemaFrom = file;
    // 事件类型 = `$defs` 里那些声明了 `properties.type.const` 的定义。
    // 这就是"多少类事件"的数法 —— 从 schema 现算，不写死数字（写死就会过期）。
    const types = Object.values(schema.$defs ?? {})
      .map((d) => d?.properties?.type?.const)
      .filter((c) => typeof c === "string");
    facts.eventTypes = types.length ? [...new Set(types)].sort() : null;
    break;
  }
  return facts;
}

const say = (v) => (v === null || v === undefined || v === "" ? "（未声明）" : String(v));

/** 一个分类 → 一段给人看的文本。每一项都带"来源"，因为**来源就是可信度**。 */
export function render(category, facts) {
  const { manifest, settings, models, enhancements, servers, skills, trace } = facts;
  const providerId = settings?.defaultProvider ?? manifest?.modelProviders?.[0]?.id ?? null;
  const provider = providerId ? models?.providers?.[providerId] : null;

  switch (category) {
    case "overview":
      return [
        `智能体        ${say(manifest?.agent)}`,
        `运行时        ${say(manifest?.harness)} ${say(manifest?.harnessVersion)}`,
        `定义摘要      ${say(manifest?.definitionDigest)}`,
        `产物摘要      ${say(manifest?.artifactsDigest)}`,
        `声明计数      技能 ${manifest?.declaredSkills?.length ?? skills.length} · 连接器 ${manifest?.connectors?.length ?? servers.length} · 增强 ${manifest?.declaredEnhancements?.length ?? enhancements.length} · 钩子 ${manifest?.hookEnhancements?.length ?? 0}`,
        `产物配置目录  ${facts.productDir}`,
        `（来源：render-manifest.json + 产物目录）`,
      ].join("\n");

    case "model": {
      const lines = [`provider      ${say(providerId)}`];
      if (provider) {
        lines.push(`协议形状      ${say(provider.api)}`);
        lines.push(`模型          ${(provider.models ?? []).map((m) => m.id).join(", ") || "（未声明）"}`);
        lines.push(`端点引用名    ${say(provider.baseUrl)}   ← 只显示引用名，**不打印值**`);
        lines.push(`凭据引用名    ${say(provider.apiKey)}   ← 同上；本命令不读 auth.json`);
      } else {
        lines.push("（产物里找不到该 provider 的条目）");
      }
      if (provider?.unevaluated) {
        lines.push("⚠️ 上面带 `process.env` 的值是**未求值的表达式原文**（该运行时原生支持运行期插值）——"
          + "要看到生效值就在会话里问（那时这份报告是运行期视角）。");
      }
      return [...lines, `（来源：render-manifest.json + 本运行时的产物读法${facts.layoutId ? `（${facts.layoutId}）` : ""}）`].join("\n");
    }

    case "skills": {
      // **本组合实际加载的技能**：定义声明的 ∪ 激活包带来的。未激活包带来的**明确列出来**，
      // 免得"为什么调不到那个技能"要靠猜（设计稿 §5：期望集合 = 声明 ∩ 当前启用）。
      const b = facts.bundles;
      const listed = b ? skills.filter((s) => b.effectiveSkills.includes(s.name)) : skills;
      const lines = listed.length
        ? [ ...listed.map((s) => `· ${s.name}\n    ${say(s.description)}`),
            "（来源：产物 skills/ 的 SKILL.md；技能同时会自动成为 `skill:<name>` 命令）" ]
        : ["（本组合没有加载任何技能 —— 技能落点是产物 skills/<name>/SKILL.md）"];
      if (b && b.inactiveOwnedSkills.length) {
        lines.push("");
        lines.push(`未加载（属于**未激活**的能力包）：${b.inactiveOwnedSkills.join(", ")}`);
        lines.push(`    要它们就带上包重启：\`AGENT_BUNDLES=${[...b.active, ...b.available.filter((x) => (b.members[x]?.skills ?? []).some((n) => b.inactiveOwnedSkills.includes(n)))].join(",")}\``);
      }
      return lines.join("\n");
    }

    case "bundles": {
      const b = facts.bundles;
      if (!b) return "（这份产物没有能力包信息 —— 清单里没有 `bundles` 节）";
      const lines = [];
      lines.push(`当前组合      ${b.active.length ? b.active.join(" + ") : "（空）"}${b.explicit ? "" : "  ← 未显式指定，用的是默认组合"}`);
      lines.push(`默认组合      ${b.defaults.join(" + ") || "（无）"}`);
      lines.push("");
      lines.push("可用包：");
      for (const id of b.available) {
        const m = b.members[id] ?? {};
        const on = b.active.includes(id);
        const marks = [
          on ? "**已激活**" : "未激活",
          b.defaults.includes(id) ? "默认开" : null,
          m.planned ? "尚未成形（登记在案）" : null,
        ].filter(Boolean).join(" · ");
        lines.push(`· ${id}（${m.label ?? "?"}）  ${marks}`);
        if (m.purpose) lines.push(`    ${m.purpose}`);
        const owns = [
          (m.skills ?? []).length ? `技能 ${m.skills.join(", ")}` : null,
          (m.refs ?? []).length ? `连接器 ${m.refs.join(", ")}` : null,
          (m.plugins ?? []).length ? `插件 ${m.plugins.join(", ")}` : null,
        ].filter(Boolean);
        lines.push(`    含：${owns.length ? owns.join(" · ") : "（只含基座不变量）"}`);
      }
      lines.push("");
      lines.push(`怎么开        在起会话前设 \`AGENT_BUNDLES=${b.available.filter((x) => x !== "verify-baseline").join(",") || "…"}\``
        + "（逗号分隔；不设 = 默认组合）");
      lines.push("               ⚠️ 切换**需要重载/重启会话**（技能与连接器的加载点在启动期；两侧实测都做不到无感热插拔）");
      lines.push("               ⚠️ 写一个**不存在的包名** ⇒ 启动直接失败并列出允许的包名（不静默忽略）");
      lines.push("（来源：render-manifest.json 的 bundles + 运行期平台变量 AGENT_BUNDLES_ACTIVE）");
      return lines.join("\n");
    }

    case "connectors": {
      // **清单优先**：`mcpClient` / `connectorsNote` 是产物自己写的（各运行时形态不同：
      // 一个靠扩展补客户端，一个原生支持）。没有这两个字段时才退回"看配置里有没有 mcp 扩展"。
      const declared = (settings?.extensions ?? []).some((e) => /mcp/i.test(e));
      const client = manifest?.mcpClient ?? null;
      const lines = servers.length
        ? servers.map((s) => `· ${s.name}  transport=${s.transport}  ${s.hasCommand ? "command✓" : ""}${s.hasUrl ? "url✓" : ""}`)
        : ["（未声明任何连接器）"];
      const clientLine = client
        ? `MCP 客户端      ${client}${manifest?.connectorsNote ? ` —— ${manifest.connectorsNote}` : ""}`
        : `MCP 客户端扩展  ${declared ? "已声明" : (servers.length ? "未声明 ← 有连接器却没有客户端，连不上" : "未声明（本项目没有连接器，无需客户端）")}`;
      lines.push(clientLine);
      lines.push("（来源：render-manifest.json 的 connectors/mcpClient + 该运行时的产物配置）");
      return lines.join("\n");
    }

    case "enhancements": {
      const unverified = manifest?.unverifiedDeclarations ?? [];
      const lines = enhancements.length
        ? [...enhancements.map((e) => `· ${e.id}  kind=${say(e.kind)}  ${say(e.target)}${e.events ? `  events=${e.events.join(",")}` : ""}`),
           "（来源：产物 enhancements.yaml —— 渲染器把基座不变量声明 ∪ 智能体声明合并写在这里）"]
        : ["（未声明增强；基座不变量增强应至少有一条 trace）（来源：产物 enhancements.yaml）"];
      // 未验证声明（§25 O1/O3）：基座不解释、原样透传的字段 —— 不列出来就是"悄悄多出来的东西"
      lines.push(unverified.length
        ? `\n未验证声明（基座不解释、原样透传；不在保证范围内）：\n` + unverified.map((d) => `· ${d.split("：")[0]}`).join("\n")
        : "未验证声明：无（基座声明的字段之外没有别的）");
      return lines.join("\n");
    }

    case "hooks": {
      const hooks = enhancements.filter((e) => e.kind === "hook");
      const known = manifest?.hookEvents;
      const lines = hooks.length
        ? hooks.map((h) => `· ${h.id} → ${h.events?.join(", ") ?? "（未声明事件）"}`)
        : ["（没有 kind=hook 的增强）"];
      if (known?.enumerated === true) {
        const set = new Set(known.events ?? []);
        const declared = hooks.flatMap((h) => h.events ?? []);
        const bad = declared.filter((n) => !set.has(n));
        lines.push(`运行时可订阅集合  ${known.events.length} 个（${say(manifest?.harnessVersion)}；来源 ${say(known.source)}）`);
        lines.push(bad.length
          ? `❌ 有 ${bad.length} 个订阅的事件在集合里不存在：${bad.join(", ")} —— 这些钩子永远不会触发`
          : `✅ 订阅的 ${declared.length} 个事件都在集合内`);
      } else if (known?.enumerated === false) {
        lines.push(`运行时可订阅集合  **未穷举** ⇒ 事件名不做校验，上面的声明按「未验证」处理（来源 ${say(known.source)}）`);
      } else {
        lines.push("运行时可订阅集合  产物清单里没有（enumerated 信息缺失）⇒ 无法核对事件名是否真的存在");
      }
      lines.push("（来源：产物 enhancements.yaml + render-manifest.json 的 hookEvents）");
      return lines.join("\n");
    }

    case "trace":
      return [
        `轨迹落点      ${say(trace.dest)}`,
        `生效配置摘要  ${say(trace.digest)}`,
        `模型路由      ${say(trace.modelRoute)}`,
        `运行模式      ${say(trace.runMode)}`,
        `事件类型      ${trace.eventTypes === null ? "（读不到 schema，或 schema 形状变了数不出类型）" : `${trace.eventTypes.length} 类：${trace.eventTypes.join(" / ")}`}`,
        trace.schemaFrom ? `（schema 来源 ${trace.schemaFrom}）` : "（找不到 core/trace/schema.json —— 设了 AGENT_GATES_DIR 就能读）",
        "（落点/摘要这类是**运行期**注入的：显示「未声明」说明这次不是在基座入口里跑的）",
      ].join("\n");

    case "portability": {
      // **与闸门 1 的 portability/report 同一个判据**：只看智能体自己声明的 harness 专有增强，
      // 基座不变量（轨迹、自省命令）不算 —— 它们是基座给的，不是这个智能体引入的不可移植性。
      const enh = manifest?.agentEnhancements ?? [];
      const harness = manifest?.harness ?? "该";
      return [
        enh.length
          ? `核心 + ${harness} 增强（**不可移植**）：这个智能体自己声明了 ${enh.length} 个 ${harness} 专有增强（${enh.join(", ")}）`
          : `核心（可移植到所有受支持 harness）：未声明任何 harness 专有增强`,
        `技能 ${manifest?.declaredSkills?.length ?? "?"} 个与连接器 ${manifest?.connectors?.length ?? "?"} 个属于可移植核心`,
        "（来源：render-manifest.json 的 agentEnhancements —— 与闸门 1 的 portability/report 同一判据：智能体自己的 harness/<h>/ 里有没有东西）",
      ].join("\n");
    }

    case "plan":
      // 验证计划：与 `make verify-plan` 同一份实现（那里能知道定义目录，这里只知道产物根，
      // 所以命令里的路径是产物内的相对形态 —— 如实展示，不编一个不存在的项目路径）
      return renderPlan(verifyPlan(facts, { renderDir: facts.artifact, harness: manifest?.harness }));

    default:
      return `未知分类：${category}\n可用分类：${CATEGORIES.map((c) => c.name).join(" / ")}`;
  }
}

/** 整份报告（CLI 默认出口或显式 `all`）—— 会展开所有分类正文。 */
export function renderAll(facts) {
  return [`${facts.manifest?.agent ?? "（未知智能体）"} · ${facts.manifest?.harness ?? "?"} 项目信息`,
    ...CATEGORIES.map((c) => `\n── ${c.name} ──\n${render(c.name, facts)}`)].join("\n");
}

/** 无参数的会话入口只展示目录；详细正文由 `/project <分类>` 按需展开。 */
export function renderIndex(facts) {
  return [
    summaryLine(facts),
    "",
    "可用分类（查看详情：`/project <分类>`）：",
    ...CATEGORIES.map((c) => `/project ${c.name}  — ${c.doc}`),
    "",
    "查看完整报告：`/project all`。",
  ].join("\n");
}

/**
 * 参数补全。**两级都从产物现算**：
 *   ① 一级 = 分类（这就是"一个项目应该有哪些信息"的目录）
 *   ② 二级 = 该项目里真实存在的值（技能名/连接器名/增强 id/钩子 id）
 */
export function complete(prefix, facts) {
  const text = String(prefix ?? "");
  const parts = text.split(/\s+/);
  // 一级：还没选分类
  if (parts.length <= 1) {
    const partial = parts[0] ?? "";
    return CATEGORIES.filter((c) => c.name.startsWith(partial))
      .map((c) => ({ value: c.name, label: c.name, description: c.doc }));
  }
  // 二级：已经选了分类，补它真实存在的值
  const [category, partial = ""] = parts;
  const values =
    category === "bundles" ? (facts.bundles?.available ?? [])
    : category === "skills" ? (facts.bundles?.effectiveSkills ?? facts.manifest?.declaredSkills ?? facts.skills.map((s) => s.name))
    : category === "connectors" ? (facts.manifest?.connectors ?? facts.servers.map((s) => s.name))
    : category === "enhancements" ? (facts.manifest?.declaredEnhancements ?? facts.enhancements.map((e) => e.id))
    : category === "hooks" ? (facts.manifest?.hookEnhancements ?? facts.enhancements.filter((e) => e.kind === "hook").map((e) => e.id))
    : [];
  return values.filter((v) => String(v).startsWith(partial)).map((v) => ({ value: String(v), label: String(v) }));
}

/** 给调用方的一句话摘要（会话里第一眼看到的）。 */
export function summaryLine(facts) {
  const m = facts.manifest;
  return `agent-base · ${m?.agent ?? "?"} · ${m?.harness ?? "?"} ${m?.harnessVersion ?? ""}`
    + ` · 技能 ${m?.declaredSkills?.length ?? facts.skills.length}`
    + ` · 连接器 ${m?.connectors?.length ?? facts.servers.length}`
    + ` · 增强 ${m?.declaredEnhancements?.length ?? facts.enhancements.length}`;
}

// ---------------------------------------------------------------------------
// 验证计划（路线图 §30 A1）
//
// 用途：**AI 或人一条命令就知道"要验什么、哪些只能在容器里验、为什么、绑定哪几个摘要"**，
// 而不必去翻文档。所以这里给的必须是**可执行的计划**（命令 + 期望 + 出处），不是说明文字。
//
// 设计纪律：
//   · "只能在容器里成立"的清单来自 `container-only.mjs` 的**声明**，不是在本函数里再列一遍
//     —— 加一条 C9 断言时，自检会提醒你去归类（见该文件顶部对判据强度的诚实标注）。
//   · 四个摘要 = 这次计划**绑定的身份**：换任何一处输入，摘要就变，计划与结论都能被归因。
// ---------------------------------------------------------------------------


/** 四道闸门在**宿主**上的执行步骤（命令与期望都写出来，AI 直接照跑）。 */
export function localSteps({ agentDir = ".", renderDir = ".render/<harness>", harness = "<harness>" } = {}) {
  return [
    { id: "static", gate: 1, cmd: `make validate AGENT_DIR=${agentDir}`, expect: "闸门 1 全绿（基座自洽 29 项 + 定义检查）" },
    { id: "resolution", gate: 2, cmd: `make doctor HARNESS=${harness} RENDER_DIR=${renderDir}`, expect: "已加载的扩展/技能/连接器集合 == 声明集合" },
    { id: "probes", gate: 3, cmd: `make probe RENDER_DIR=${renderDir}`, expect: "端点收到带工具的流式请求；声明了钩子就必须有钩子当场发出的事件" },
    { id: "smoke", gate: 4, cmd: `make smoke RENDER_DIR=${renderDir}`, expect: "端到端跑完一次；被禁工具未被触碰" },
    { id: "usable", gate: null, cmd: `make verify AGENT_DIR=${agentDir}`, expect: "四道全过 ⇒ ok 且 usable" },
  ];
}

/**
 * 组装验证计划。
 * @param {object} facts `collect()` 的结果
 * @param {{agentDir?: string, renderDir?: string, harness?: string, where?: "host"|"container"}} [opts]
 */
export function verifyPlan(facts, opts = {}) {
  const harness = opts.harness ?? facts.manifest?.harness ?? "<harness>";
  const agentDir = opts.agentDir ?? "<AGENT_DIR>";
  const renderDir = opts.renderDir ?? "<RENDER_DIR>";
  const where = opts.where ?? "host";

  return {
    agent: facts.manifest?.agent ?? null,
    harness,
    where,
    // 这次计划绑定的身份：四处摘要，缺哪处就如实 null（不编）
    identity: {
      definitionDigest: facts.manifest?.definitionDigest ?? null,
      artifactsDigest: facts.manifest?.artifactsDigest ?? null,
      renderInputsDigest: facts.manifest?.renderInputsDigest ?? null,
      effectiveConfigDigest: facts.manifest?.effectiveConfigDigest ?? null,
      imageInputsDigest: facts.imageInputsDigest ?? null,
    },
    // 宿主上要跑的（不区分 where —— 宿主与容器都要过这四道）
    local: localSteps({ agentDir, renderDir, harness }),
    // **只能在容器里成立**的那些：逐条带 why（失败归因的依据）
    container: CONTAINER_ONLY.map((c) => ({
      id: c.id,
      label: c.label,
      why: c.why,
      checks: c.checks,
      // 受控入口（§30 A2）：绑定面由基座生成 —— 计划里指向它，而不是让人手敲 docker
      cmd: c.id === "in-image-verify"
        ? `make verify-container AGENT_DIR=${agentDir} HARNESS=${harness}（或先看参数：DRY=1）`
        : `make conformance HARNESS=${harness}`,
    })),
    // 本次**没覆盖**的：在宿主上跑时，上面那些就是没覆盖的（如实列出，不假装通过）
    notCovered: where === "host" ? CONTAINER_ONLY.map((c) => c.id) : [],
    notes: [
      "宿主上的结论**不含**容器安全下限与双架构（见 notCovered）——交付口径以此为准时要用容器内自证。",
      "绑定的摘要变化 ⇒ 本计划与结论都必须重算（`renderInputsDigest` 覆盖定义 + 基座 seed + 渲染器 + 目录表）。",
    ],
  };
}

/** 验证计划 → 给人看的文本（与 JSON 同一份数据）。 */
export function renderPlan(plan) {
  const line = (s) => `  ${s}`;
  return [
    `验证计划 · ${plan.agent ?? "?"} · ${plan.harness} · 结论出处=${plan.where}`,
    "",
    "身份（换了任何一处摘要，计划与结论都要重算）",
    line(`定义摘要        ${plan.identity.definitionDigest ?? "（未知）"}`),
    line(`产物摘要        ${plan.identity.artifactsDigest ?? "（未知）"}`),
    line(`渲染输入摘要    ${plan.identity.renderInputsDigest ?? "（未知）"}`),
    line(`生效配置摘要    ${plan.identity.effectiveConfigDigest ?? "（未知）"}`),
    line(`镜像输入摘要    ${plan.identity.imageInputsDigest ?? "（未计算：需要构建上下文）"}`),
    "",
    "本地要跑的四道闸门",
    ...plan.local.map((s) => line(`[${s.id}] ${s.expect}\n      ${s.cmd}`)),
    "",
    "只能在容器里成立的（宿主做不到 —— 失败时先判定是不是这几条）",
    ...plan.container.map((c) => line(`[${c.id}] ${c.label}\n      为什么：${c.why}\n      ${c.cmd}`)),
    ...(plan.notCovered.length ? ["", `本次未覆盖：${plan.notCovered.join(" · ")}`] : []),
    ...plan.notes.map((n) => `\n※ ${n}`),
  ].join("\n");
}
