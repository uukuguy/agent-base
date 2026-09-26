// ============================================================================
// 会话内项目自省：**纯逻辑**（不依赖任何运行时 API）
//
// 为什么要单独一层：`project-info.ts` 只做"把结果送给用户"，真正的读取与渲染在这里 ——
// 于是它可以被自检直接 import 断言（不需要交互终端，也不需要起 pi），
// 而且将来 dsh 侧要一个等价入口时，**这份逻辑可以原样复用**（差的只是怎么接）。
//
// ## 唯一的真源是**产物**，不是文档
//
// 读的全是运行期真实存在的东西：
//   · `$AGENT_ARTIFACT_DIR/render-manifest.json` —— 渲染清单（声明了什么、摘要是什么）
//   · `<产物配置目录>/`（`PI_CODING_AGENT_DIR`）—— settings.json / models.json.tmpl /
//     enhancements.yaml / mcp.json / skills/（这几个文件渲染器写成 JSON，所以**不需要 YAML 解析器**：
//     扩展在产物里跑，那儿没有 node_modules 可以 import yaml）
//   · `$AGENT_GATES_DIR/core/trace/schema.json` —— 轨迹事件类型（同样是 JSON）
//
// 读不到就**如实说"读不到/未声明"**，绝不猜、不编 —— 这条命令的用途就是调试，
// 它要是会编，那它就没有价值。
//
// ## 绝不打印凭据
//
// 产物里的端点/凭据都是**引用名**（`${DEEPSEEK_API_KEY}`），我们只打印引用名。
// 明确**不读** `auth.json` —— 那是登录态，不属于"项目信息"。
// ============================================================================

export const CATEGORIES = [
  { name: "overview", doc: "这个智能体是什么：harness、摘要、声明计数" },
  { name: "model", doc: "模型路由：provider / 模型名 / 端点与凭据的**引用名**" },
  { name: "skills", doc: "技能清单（含每个技能的一句话与落点）" },
  { name: "connectors", doc: "连接器（MCP 服务器）与客户端扩展是否就位" },
  { name: "enhancements", doc: "业务级/基座增强：id、kind、接入件" },
  { name: "hooks", doc: "钩子：订阅了哪些事件、这些事件在运行时可订阅集合里是否真的存在" },
  { name: "trace", doc: "轨迹：落点、生效配置摘要、事件类型" },
  { name: "portability", doc: "可移植性等级是怎么算出来的" },
];

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const readJson = (file) => {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
};

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
export function collect({ productDir, artifactDir, gatesDir } = {}) {
  const problems = [];
  if (!productDir) return { problems: ["没有产物配置目录（PI_CODING_AGENT_DIR 未设置）—— 这个命令只能在已渲染的产物里跑"] };
  if (!existsSync(productDir)) return { problems: [`产物配置目录不存在：${productDir}`] };

  const artifact = artifactDir && existsSync(artifactDir) ? artifactDir : path.dirname(productDir);
  const manifest = readJson(path.join(artifact, "render-manifest.json"));
  if (!manifest) problems.push(`读不到渲染清单（${path.join(artifact, "render-manifest.json")}）`
    + ` —— 声明类信息只能显示"未知"。原因是本进程不知道**产物根**在哪：`
    + `应设 AGENT_ARTIFACT_DIR=<渲染输出根>（清单在产物根，暂存的运行目录里没有它）`);

  const settings = readJson(path.join(productDir, "settings.json"));
  const models = readJson(path.join(productDir, "models.json.tmpl")) ?? readJson(path.join(productDir, "models.json"));
  const enhancementsDoc = readJson(path.join(productDir, "enhancements.yaml"));
  const mcp = readJson(path.join(productDir, "mcp.json"));

  const skillsDir = path.join(productDir, "skills");
  const skills = existsSync(skillsDir)
    ? readdirSync(skillsDir).filter((n) => statSync(path.join(skillsDir, n)).isDirectory())
        .map((n) => ({ dir: n, ...(skillBlurb(path.join(skillsDir, n)) ?? { description: null }) }))
    : [];

  const enhancements = (enhancementsDoc?.enhancements ?? []).map((e) => ({
    id: e.id, kind: e.kind, target: e.entry ?? e.package ?? null, events: Array.isArray(e.events) ? e.events : null,
  }));

  const servers = Object.entries(mcp?.mcpServers ?? {}).map(([name, cfg]) => ({
    name, transport: cfg.url ? "streamable-http" : "stdio", hasCommand: !!cfg.command, hasUrl: !!cfg.url,
  }));

  return {
    problems, productDir, artifact, manifest, settings, models, enhancements, servers, skills,
    trace: traceFacts({ gatesDir, productDir, manifest }),
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
  for (const base of [gatesDir, path.join(productDir, ".."), process.env.AGENT_BASE_ROOT].filter(Boolean)) {
    const file = path.join(base, "core", "trace", "schema.json");
    const schema = readJson(file);
    if (!schema) continue;
    facts.schemaFrom = file;
    // 事件类型 = `$defs` 里那些声明了 `properties.type.const` 的定义。
    // 这就是"9 类事件"的数法 —— 从 schema 现算，不写死数字（写死就会过期）。
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
      return [...lines, "（来源：settings.json + models.json.tmpl）"].join("\n");
    }

    case "skills":
      return skills.length
        ? [ ...skills.map((s) => `· ${s.name}\n    ${say(s.description)}`),
            "（来源：产物 skills/ 的 SKILL.md；技能同时会自动成为 `skill:<name>` 命令）" ].join("\n")
        : "（未声明任何技能 —— 技能落点是产物 skills/<name>/SKILL.md）（来源：产物 skills/）";

    case "connectors": {
      const clientDeclared = (settings?.extensions ?? []).some((e) => /mcp/i.test(e));
      const lines = servers.length
        ? servers.map((s) => `· ${s.name}  transport=${s.transport}  ${s.hasCommand ? "command✓" : ""}${s.hasUrl ? "url✓" : ""}`)
        : ["（未声明任何连接器）"];
      lines.push(`MCP 客户端扩展  ${clientDeclared ? "已声明" : (servers.length ? "未声明 ← 有连接器却没有客户端，连不上" : "未声明（本项目没有连接器，无需客户端）")}`);
      lines.push("（来源：产物 mcp.json + settings.json.extensions）");
      return lines.join("\n");
    }

    case "enhancements":
      return enhancements.length
        ? [...enhancements.map((e) => `· ${e.id}  kind=${say(e.kind)}  ${say(e.target)}${e.events ? `  events=${e.events.join(",")}` : ""}`),
           "（来源：产物 enhancements.yaml —— 渲染器把基座不变量声明 ∪ 智能体声明合并写在这里）"].join("\n")
        : "（未声明增强；基座不变量增强应至少有一条 trace）（来源：产物 enhancements.yaml）";

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

    default:
      return `未知分类：${category}\n可用分类：${CATEGORIES.map((c) => c.name).join(" / ")}`;
  }
}

/** 整份报告（不给参数时用）—— 顺带就是"这个项目有哪些信息"的目录。 */
export function renderAll(facts) {
  return [`${facts.manifest?.agent ?? "（未知智能体）"} · ${facts.manifest?.harness ?? "?"} 项目信息`,
    ...CATEGORIES.map((c) => `\n── ${c.name} ──\n${render(c.name, facts)}`)].join("\n");
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
    category === "skills" ? (facts.manifest?.declaredSkills ?? facts.skills.map((s) => s.name))
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
