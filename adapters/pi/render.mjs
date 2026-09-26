#!/usr/bin/env node
// ============================================================================
// pi 适配器 · render（统一设计 §5.3 SPI、§10.2 渲染映射）
//
// 职责：把中性定义**确定性**地渲染成 pi 能消费的 agent-dir。
//   · 确定性：同输入 → 逐字节同产物（conformance/C2 会验证）。所以这里不写时间戳、
//     不依赖环境变量取值、文件顺序固定、JSON 键序固定。
//   · 参数下放：`models.json.tmpl` 里的端点占位符留给启动期渲染 —— 因为 pi 的
//     `models.json` **不对 baseUrl 做环境插值**（只有 apiKey/headers 做）【实测 + 上游文档】。
//   · 行为烤：人设、技能、工具边界、模型选择、业务级增强全部进产物。
//   · 适配器薄：连接器解析走基座 core/image/resolve-preinstall.mjs，这里只做翻译。
//
// 用法：
//   node adapters/pi/render.mjs <AGENT_DIR> [--out <DIR>] [--json]
// 默认输出：dist/pi/<agent-name>/
//
// 输出约定（§8.2）：**stdout 只放结果 JSON；人读日志走 stderr**。
// 退出码（§6.7）：0 成功 / 2 用法错误 / 10 输入非法（闸门 1 那类问题）。
// ============================================================================

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { DEFAULT_EXCLUDES, EXIT_CODES, computeEffectiveConfigDigest, digestDirectory, parseArgs, sha256 } from "../../core/gates/index.mjs";
import { PREINSTALL_PATH, loadPreinstall, resolveConnectors } from "../../core/image/resolve-preinstall.mjs";
// Provider 目录的解析（可被部署层覆盖）—— 唯一实现，见 core/catalog/providers.mjs
import { findProvider, loadProviders } from "../../core/catalog/providers.mjs";
import { piRenderInputsDigest } from "./render-inputs.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const SEED = path.join(HERE, "seed");
const HARNESS = "pi";
/**
 * 镜像内 MCP 客户端扩展包的固定路径（构建期装好，运行期不下载）。
 * 用的是 node 基础镜像里 `npm install -g` 的落地位置 —— 于是**复用既有的预装清单机制**，
 * 不需要为扩展包新造一条安装通道。本地运行时由运行器把该路径改写成本地安装路径。
 */
const MCP_ADAPTER_IN_IMAGE = "/usr/local/lib/node_modules/pi-mcp-adapter";

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
const log = (msg) => process.stderr.write(msg + "\n");

function readYaml(file) { return YAML.parse(fs.readFileSync(file, "utf8")); }

/** 确定性 JSON：键排序 + 末尾换行。产物要能 diff、能复算 digest。 */
function stableJson(value) {
  const sort = (v) => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])]));
    }
    return v;
  };
  return JSON.stringify(sort(value), null, 2) + "\n";
}

function writeFile(abs, content) {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function copyTree(from, to) {
  if (!fs.existsSync(from)) return [];
  const copied = [];
  const walk = (src, dst) => {
    fs.mkdirSync(dst, { recursive: true });
    for (const e of fs.readdirSync(src, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const s = path.join(src, e.name);
      const d = path.join(dst, e.name);
      if (e.isDirectory()) walk(s, d);
      else { fs.copyFileSync(s, d); copied.push(path.relative(to, d).split(path.sep).join("/")); }
    }
  };
  walk(from, to);
  return copied;
}

/** §2.3 的引用名约定：大写 + 非字母数字 → 下划线。 */
export function envPrefixFor(route) {
  return String(route).toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

// ---------------------------------------------------------------------------
/**
 * 生成「定义字段 → 产物位置」的声明（conformance C3 的输入）。
 *
 * 为什么要有这份声明：C3 早先认死 `AGENTS.md` / `settings.json` / `extensions` 这些**文件名**，
 * 于是第二个 harness 必然误判 —— 那等于把第一个 harness 的产物形状当成了契约。
 * 现在由**渲染器**声明"我把每个定义字段放到了哪里"，检查只验证声明（位置在不在、内容对不对）。
 *
 * @returns {Record<string, {at: string, contains?: string|string[]} | {exempt: string}>}
 */
function buildExpresses({ agent, declaredEnhancements, modelParamName, providerName, skillsInProduct, profileOrSettings, modelFile, enhancementsFile }) {
  const e = {
    "persona.instructions": { at: "agent-dir/AGENTS.md", contains: String(agent.persona?.instructions ?? "").trim().slice(0, 24) },
    // provider 名 —— 落点仍是模型配置模板
    "model.route": { at: modelFile, contains: providerName },
    // model.name 现在是**默认值**（环境属性、运行期可覆盖）⇒ 它的落点是**清单**：
    // 默认值记在 runtimeParams[].default，产物里则是 `${…_MODEL}` 占位。
    // 不能继续声明成"值出现在 models.json.tmpl 里" —— 那里现在是占位符。
    "model.name": { at: "render-manifest.json", contains: [agent.model.name, modelParamName] },
    skills: { at: skillsInProduct },
  };
  if (agent.model?.reasoningEffort) e["model.reasoningEffort"] = { at: profileOrSettings, contains: "defaultThinkingLevel" };
  if (agent.tools?.deny?.length) e["tools.deny"] = { at: "render-manifest.json", contains: "excludeTools" };
  // 有声明才需要落点：判据是"已声明的增强 id"，不是"某文件在不在"（用文件存在性判过，路径基准错了）
  if (declaredEnhancements?.length) e.enhancements = { at: enhancementsFile, contains: declaredEnhancements };
  return e;
}

function main() {
  // 统一解析器：手写"跳过旗标值"的索引过滤在本项目里错过三次（旗标缺席时会把第一个
  // 位置参数吞掉）。这里曾经用 `outIdx < 0 ||` 打过补丁 —— 能跑，但等于留下第二种写法。
  const { values, flags, positionals, errors } = parseArgs(process.argv.slice(2), { valueFlags: ["--out"] });
  const json = flags.has("--json");
  const outArg = values["--out"] ?? null;
  const positional = positionals;
  if (errors.length) { log(errors.join("；")); process.exit(EXIT_CODES.usage); }

  if (!positional.length || flags.has("--help") || flags.has("-h")) {
    log("用法: node adapters/pi/render.mjs <AGENT_DIR> [--out <DIR>] [--json]");
    process.exit(positional.length ? EXIT_CODES.ok : EXIT_CODES.usage);
  }
  const agentDir = path.resolve(positional[0]);
  const agentFile = path.join(agentDir, "agent.yaml");
  if (!fs.existsSync(agentFile)) {
    log(`❌ 找不到 ${agentFile}`);
    process.exit(EXIT_CODES.static);
  }

  let agent;
  try { agent = readYaml(agentFile); } catch (e) {
    log(`❌ agent.yaml 不是合法 YAML：${e.message}`);
    process.exit(EXIT_CODES.static);
  }

  const outRoot = path.resolve(outArg ?? path.join("dist", HARNESS, agent.name));
  const agentOut = path.join(outRoot, "agent-dir");
  fs.rmSync(outRoot, { recursive: true, force: true });
  fs.mkdirSync(agentOut, { recursive: true });

  // ---- 1. 人设 → AGENTS.md（§10.2）----
  let persona;
  if (agent.persona?.instructionsFile) {
    const p = path.join(agentDir, agent.persona.instructionsFile);
    if (!fs.existsSync(p)) {
      log(`❌ persona.instructionsFile 指向的文件不存在：${agent.persona.instructionsFile}`);
      process.exit(EXIT_CODES.static);
    }
    persona = fs.readFileSync(p, "utf8");
    if (!persona.endsWith("\n")) persona += "\n";
  } else {
    persona = String(agent.persona?.instructions ?? "").trimEnd() + "\n";
  }
  writeFile(path.join(agentOut, "AGENTS.md"), persona);

  // ---- 2. 技能 → agent-dir/skills/（§4.4 / §10.2）----
  const skillsRel = agent.skillsDir ?? "skills";
  const skillsAbs = path.join(agentDir, skillsRel);
  const declaredSkills = [];
  if (fs.existsSync(skillsAbs)) {
    for (const e of fs.readdirSync(skillsAbs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.isDirectory() && fs.existsSync(path.join(skillsAbs, e.name, "SKILL.md"))) declaredSkills.push(e.name);
    }
  }
  copyTree(skillsAbs, path.join(agentOut, "skills"));

  // ---- 3. 自研连接器代码 → agent-dir/mcp-servers/（§4.3 设计点 3）----
  const mcpServersCopied = copyTree(path.join(agentDir, "mcp-servers"), path.join(agentOut, "mcp-servers"));

  // ---- 4. 模型 → models.json.tmpl（参数下放）----
  if (!agent.model?.provider || !agent.model?.name) {
    log("❌ model.provider / model.name 缺失（渲染需要它们推导端点引用名）");
    process.exit(EXIT_CODES.static);
  }
  const prefix = envPrefixFor(agent.model.provider);
  // 路由必须由基座声明（闸门 1 已校验）；渲染器据此取协议形状并记录到清单
  // 选供应商：`model.provider`
  const catalog = loadProviders({ agentDir });
  const providerId = agent.model?.provider;
  const activeRoute = findProvider(catalog, providerId);
  // 作用域：这家供应商可能只在某些运行时可用（如订阅型/原生 provider 只有 pi 有）
  if (activeRoute && activeRoute.harnesses && !activeRoute.harnesses.includes(HARNESS)) {
    log(`❌ 供应商「${activeRoute.id}」只支持 ${activeRoute.harnesses.join("/")}，当前运行时是 ${HARNESS}。`);
    log(`   可选：① 改用两个运行时都支持的供应商（model.provider 换一个）② 只在这个运行时上跑该智能体。`);
    process.exit(EXIT_CODES.static);
  }
  if (!activeRoute) {
    log(`❌ model.provider「${providerId}」不在 provider 目录里（来源：${(catalog.sources ?? []).join(" + ") || "无"}）。`);
    log(`   可用 provider：${(catalog.providers ?? []).map((r) => r.id).join(", ") || "(空)"} —— 用 AGENT_PROVIDERS_FILE 指到你自己的那份，或改这里列出的名字。`);
    process.exit(EXIT_CODES.static);
  }
  const providerApi = activeRoute.api;

  // 运行期参数写成 `${NAME}` 占位：**入口脚本在启动期解析**（本 harness 的 models.json 不做 baseUrl 插值）。
  // 模型名同样是占位 —— 它是环境属性（同一份制品在不同环境常要指向不同模型名）；
  // 没被覆盖时用定义里的默认值，默认值记在清单的 params 里，启动期据此兜底。
  // 模型列表：**把 provider 声明的都带出来**（默认用的那个排第一）——
  // 这样两个运行时里都能切换模型，而不是只认一个名字。
  const declaredModels = [...new Set([agent.model.name, ...(activeRoute.models ?? [])])];
  const modelsTmpl = {
    providers: {
      [providerId]: {
        ...(activeRoute.endpointNative ? {} : { baseUrl: `\${${activeRoute.baseUrlParam}}` }),
        api: providerApi,   // 协议形状取自 provider 目录，不硬编码
        // 凭据：native（订阅登录）由运行时自己的凭据库提供 ⇒ 不写这个字段；
        // env / none 都写引用名占位（none 的占位值由参数层默认值给出，用户不必提供）
        ...(activeRoute.credentialParam ? { apiKey: `\${${activeRoute.credentialParam}}` } : {}),
        models: declaredModels.map((m) => ({ id: m === agent.model.name ? `\${${activeRoute.modelParam}}` : m })),
      },
    },
  };
  writeFile(path.join(agentOut, "models.json.tmpl"), stableJson(modelsTmpl));

  // ---- 5. settings.json（行为烤：模型选择 + 基座不变量 + 业务级增强声明）----
  const seedSettings = fs.existsSync(path.join(SEED, "settings.json"))
    ? JSON.parse(fs.readFileSync(path.join(SEED, "settings.json"), "utf8"))
    : {};
  const settings = {
    ...seedSettings,
    defaultProvider: providerId,
    // 同样是占位：启动期解析成 <PREFIX>_MODEL（未覆盖时回落到定义里的默认值）
    defaultModel: `\${${prefix}_MODEL}`,
  };
  if (agent.model.reasoningEffort) settings.defaultThinkingLevel = agent.model.reasoningEffort;

  // ---- 增强：基座不变量（seed）∪ 智能体声明（§4.5），合并后登记 ----
  // 基座的轨迹扩展必须与业务扩展处在**同一个注册表**里（同一批回调、按注册顺序执行），
  // 所以两边都进 settings.extensions；合并后的声明写进产物，供闸门 2 做集合断言。
  const collectEnhancements = (file) => {
    if (!fs.existsSync(file)) return [];
    return (readYaml(file).enhancements ?? []).filter((e) => e.id);
  };
  const baseEnh = collectEnhancements(path.join(SEED, "enhancements.yaml"));
  const agentEnh = collectEnhancements(path.join(agentDir, "harness", HARNESS, "enhancements.yaml"));

  // 可共享的业务代码：放 harness/shared/，两个运行时共用这一份；
  // 各运行时的接入件（扩展/插件）按相对路径 import 它 —— 差别只在接入方式。
  copyTree(path.join(agentDir, "harness", "shared"), path.join(agentOut, "business"));
  copyTree(path.join(SEED, "extensions"), path.join(agentOut, "extensions"));
  copyTree(path.join(agentDir, "harness", HARNESS, "extensions"), path.join(agentOut, "extensions"));
  // 发射契约只有一处定义：把 core 的发射器拷进产物，扩展用相对路径 import 它
  writeFile(path.join(agentOut, "extensions", "_trace-emit.mjs"),
    fs.readFileSync(path.join(REPO, "core/trace/emit.mjs"), "utf8"));
  // 项目自省的**纯逻辑**同样只有一份（在 core/introspect/ 里），渲染器把它拷进产物：
  // 会话内的入口（`project-info.ts`）与命令行出口（`tools/project-info.mjs`）共用它。
  writeFile(path.join(agentOut, "extensions", "_project-info.mjs"),
    fs.readFileSync(path.join(REPO, "core/introspect/project-info.mjs"), "utf8"));
  writeFile(path.join(agentOut, "extensions", "_container-only.mjs"),
    fs.readFileSync(path.join(REPO, "core/introspect/_container-only.mjs"), "utf8"));

  const declaredEnhancements = [...new Set([...baseEnh, ...agentEnh].map((e) => e.id))].sort();
  // 哪些声明是**钩子**：闸门 3 的 probe/hooks-evidenced 靠它判断"要不要断言钩子真的触发了"
  const hookEnhancements = [...new Set([...baseEnh, ...agentEnh]
    .filter((e) => e.kind === "hook").map((e) => e.id))].sort();
  writeFile(path.join(agentOut, "enhancements.yaml"), stableJson({
    apiVersion: "agent-base/v1",
    harness: HARNESS,
    note: "由渲染器合并生成：基座不变量声明 ∪ 智能体声明。供闸门 2 的集合断言使用。",
    enhancements: [...baseEnh, ...agentEnh],
  }));

  const extDir = path.join(agentOut, "extensions");
  // 缺陷 D2：本运行时把 `extensions/` 下的**每个文件**都登记为扩展 ⇒ 往目录里丢一个未声明的文件，
  // 它会被**真的加载**，而闸门 2 的"声明 == 进产物"只看声明过的 —— 查不出来。
  // 在渲染期把这条堵上：登记的每个文件（助手文件除外）都必须被某条 declared entry 认领。
  //
  // **下划线开头 = 助手文件**（被扩展 import，自身不是扩展）：`_trace-emit.mjs`（基座发射器）、
  // `_project-info.mjs`（自省命令的纯逻辑）。这条约定是必要的 —— 一个导出不是工厂函数的文件
  // 被登记成扩展，会让运行时**整体加载失败**。
  const isHelper = (f) => f.startsWith("_");
  const declaredEntries = new Set([...baseEnh, ...agentEnh]
    .map((e) => String(e.entry ?? "").replace(/^extensions\//, ""))
    .filter(Boolean));
  if (fs.existsSync(extDir)) {
    // 声明指向助手文件 = 声明了却永远不会被登记 ⇒ 响亮失败（否则又是"配了没生效"）
    const declaredHelper = [...declaredEntries].filter(isHelper);
    if (declaredHelper.length) {
      throw new Error(`增强声明指向了下划线开头的助手文件：${declaredHelper.join(", ")}`
        + ` —— 下划线开头表示"被 import 的助手，不是扩展"，它不会被登记进运行时。`
        + ` 要加载的扩展请改名（不以 _ 开头）。`);
    }
    const orphans = fs.readdirSync(extDir)
      .filter((f) => !isHelper(f))
      .filter((f) => !declaredEntries.has(f));
    if (orphans.length) {
      throw new Error(`extensions/ 里有未声明的接入件：${orphans.join(", ")}`
        + ` —— 本运行时会加载它们，但没有任何增强声明认领（等价于"偷偷加载"）。`
        + ` 修法：在 harness/${HARNESS}/enhancements.yaml（或基座 seed 的清单）里声明 entry，或把文件移出该目录。`);
    }
  }
  settings.extensions = fs.existsSync(extDir)
    ? fs.readdirSync(extDir).filter((f) => !isHelper(f)).sort().map((f) => `extensions/${f}`)
    : [];
  log(`  增强：基座 ${baseEnh.length} + 智能体 ${agentEnh.length} → 产物登记 ${settings.extensions.length} 个`);
  writeFile(path.join(agentOut, "settings.json"), stableJson(settings));

  // ---- 6. 连接器：渲染成 pi 的 MCP 配置文件 ----
  //
  // 背景：pi **原生没有 MCP 客户端**（`capabilities.mcpClient` 曾为 `unsupported`）。
  // 调研结论是**不自研**，而是采用并精确 pin 一个第三方扩展。选定的扩展
  // （`pi-mcp-adapter`）读的配置形状与设计 §10.2 的预测一致：agent-dir 下的 `mcp.json`，
  // 结构 `{ mcpServers: { <名字>: {command,args,env} | {url,headers} }, settings: {...} }`。
  //
  // 两条纪律：
  //   ① **不许静默跳过**：声明了连接器就必须真的渲染出来（静默跳过 = 你会得到一个没有连接器的智能体）
  //   ② **运行期无外网**：扩展包在**镜像构建期**就装好（固定路径），运行期不下载 ⇒ 声明用本地路径
  const connectorsRel = agent.connectorsFile ?? "connectors.yaml";
  const connectorsAbs = path.join(agentDir, connectorsRel);
  const connectorsDoc = fs.existsSync(connectorsAbs) ? readYaml(connectorsAbs) : { mcpServers: [] };
  const preinstall = loadPreinstall(PREINSTALL_PATH);
  const { servers: resolved, problems: connProblems, paramNames: connParamNames } = resolveConnectors(connectorsDoc, preinstall);
  if (connProblems.length) {
    log("❌ 连接器解析失败：");
    for (const cp of connProblems) log(`     - ${cp.server ?? ""} ${cp.code}: ${cp.detail}`);
    process.exit(EXIT_CODES.static);
  }
  const enabledConnectors = resolved.filter((c) => c.enabled !== false);

  let mcpServers = {};
  for (const c of enabledConnectors) {
    if (c.transport === "stdio") {
      mcpServers[c.name] = { command: c.command, args: c.args ?? [] };
      // 凭据按参数层引用注入（运行期真值；定义里只有引用名）
      if (c.credentialRef) mcpServers[c.name].env = { [c.credentialRef]: `\${${c.credentialRef}}` };
    } else {
      mcpServers[c.name] = {
        url: `\${${c.urlRef}}`,
        ...(c.credentialRef ? { headers: { Authorization: `Bearer \${${c.credentialRef}}` } } : {}),
      };
    }
  }

  if (enabledConnectors.length) {
    // `settings` 由**基座**显式声明姿态，不吃扩展的默认值：
    //   allowInstall=false      运行期不允许安装新服务器（无外网，且行为要可复现）
    //   hostConfigDiscovery=off 不去发现宿主机上的 MCP 配置（P-b：隔离，不靠配置）
    writeFile(path.join(agentOut, "mcp.json"), stableJson({
      mcpServers,
      // scriptMode=false：**同时**关掉两件事 ——
      //   ① 该扩展自带的技能（它会在 resources_discover 里把自己那个 `mcp-scripting` 塞进技能集合，
      //      于是"实际加载的技能集合"多一项，闸门 2 的硬断言与跨运行时等价性双双告警）；
      //   ② 那个技能背后的能力（"跑可信 JavaScript、一次发起多个 MCP 调用"）——
      //      运行任意 JS 属于我们**没有声明**的能力，默认必须是关的。
      settings: { allowInstall: false, hostConfigDiscovery: "off", scriptMode: false },
    }));
    // 扩展包在**构建期**装进镜像的固定前缀，这里声明本地路径 ⇒ 运行期不需要网络
    // **对象形式**：只从这个包加载扩展，不带它的 skills / prompts。
    // 字符串形式会把这个包的**全部资源**都加载进来 —— 实测该包含有自己的技能（多出 `mcp-scripting`），
    // 于是"实际加载的技能集合"多一项、闸门 2 的硬断言与跨运行时等价性双双告警。
    // 一个第三方包不该往我们的技能集合里塞东西：不是我们声明的，就不该出现。
    settings.packages = [{ source: MCP_ADAPTER_IN_IMAGE, skills: [], prompts: [] }];
    // 注意：settings.json 在上一节已落盘，这里改了内存对象必须**再写一次**
    //       （第一版漏了这步：mcp.json 里连接器有、settings 里却没有包声明 ⇒ 静默不生效）
    writeFile(path.join(agentOut, "settings.json"), stableJson(settings));
    log(`  连接器：${enabledConnectors.length} 个 → agent-dir/mcp.json（MCP 客户端走基座种子扩展）`);
  }

  // ---- 7. 清单与摘要 ----
  // 业务附加协议：业务若提供了 trace-labels.yaml，**原样带出**，基座不解析其语义。
  // 轨迹侧按 definitionDigest join 它 —— 基座不懂业务语言，只负责把它带到证据包里。
  const labelsSrc = path.join(agentDir, "trace-labels.yaml");
  const labelsProvided = fs.existsSync(labelsSrc);
  if (labelsProvided) fs.copyFileSync(labelsSrc, path.join(outRoot, "trace-labels.yaml"));

  const runArgs = { excludeTools: agent.tools?.deny ?? [], skills: declaredSkills.map((s) => `skills/${s}`) };
  // 运行期参数契约（只声明一次，清单与生效配置摘要共用 —— 两处各写一份就会漂移）
  const runtimeParams = [
    // 端点：运行时原生解析时不产生参数；给了字面 baseUrl 就**不强制**从环境给（覆盖仍然可以）
    ...(activeRoute.endpointNative ? [] : [{ name: activeRoute.baseUrlParam, secret: false, required: !activeRoute.baseUrl, ...(activeRoute.baseUrl ? { default: activeRoute.baseUrl } : {}), backs: "model.provider" }]),
    // 凭据参数：native（订阅登录）不产生；none（本地服务）带占位默认值且不必填；env 必填
    ...(activeRoute.credentialParam
      ? [activeRoute.credentialDefault
          ? { name: activeRoute.credentialParam, secret: false, required: false, default: activeRoute.credentialDefault, backs: "model.provider" }
          : { name: activeRoute.credentialParam, secret: true, required: true, backs: "model.provider" }]
      : []),
    {
      name: activeRoute.modelParam, secret: false, required: false,
      default: agent.model.name, backs: "model.name", validate: "in-provider-models",
    },
  ];
  // 适配器自身的声明读一次就够（此前同一份文件被 readYaml 读了四遍）
  const adapterDoc = readYaml(path.join(HERE, "adapter.yaml"));
  const manifest = {
    harness: HARNESS,
    harnessVersion: adapterDoc.version,
    agent: agent.name,
    declaredSkills,
    declaredEnhancements,
    hookEnhancements,
    connectors: enabledConnectors.map((c) => ({ serverName: c.name, transport: c.transport })),
    // 连接器的包坐标：闸门 3 据此断言"运行期能离线启动它"（不是"我们写了配置"）
    connectorPackages: enabledConnectors.filter((c) => c.pin).map((c) => `${c.pin.package}@${c.pin.version}`),
    connectorsNote: "pi 原生无 MCP 客户端；连接器经基座种子扩展（pi-mcp-adapter，构建期装好）渲染成 agent-dir/mcp.json",
    mcpAdapterInImage: MCP_ADAPTER_IN_IMAGE,
    paramNames: connParamNames,
    runArgs,
    modelProviders: [providerId],
    // 凭据模式：env（基座从环境注入）/ none（本地服务免密钥）/ native（运行时自己的凭据库，如订阅登录）
    modelProviderAuth: activeRoute.auth,
    modelProviderApi: providerApi,   // 两个运行时都记录：比对时要求协议形状一致
    // 该路由声明的模型名单：启动期校验运行期覆盖的模型名用
    modelProviderModels: activeRoute.models ?? [],
    /**
     * **运行期参数契约**：入口脚本按这份声明解析并注入（不猜名字、不硬编码）。
     *   name      引用名（环境变量名；同名 + `_FILE` 表示"从文件读"，K8s/Docker secret 的标准接法）
     *   secret    true = 日志里必须掩码，且永不写进产物
     *   required  缺了就直接失败（退出码 2），不静默降级、不用别的模型顶替
     *   default   没被注入时的兜底（= 定义里的默认值）
     *   validate  额外校验：in-provider-models = 取值须在 modelProviderModels 内
     */
    rendersParams: true,   // 本 harness 的 models.json 不做环境插值 ⇒ 由启动期渲染
    runtimeParams,
    /**
     * **运行期布局契约**：入口脚本按它暂存可写副本、设环境变量、定 cwd。
     * 放在清单里（而不是写死在 core/ 的启动脚本里）是刻意的：
     * "运行时长什么样"是运行时专有知识，归适配器；启动脚本只做执行 ⇒ 加第三个运行时不必改它。
     */
    runtimePlan: {
      argvPrefix: [],   // 本 harness 的调用形态不含位置参数（只有选项）
      // 工具边界必须由**产物声明**、由启动期拼装：否则本地运行器传了、交付入口没传，
      // 就成了"文档说边界生效、容器里其实没生效"（实测踩过 —— 见路线图 D6）。
      prependArgs: runArgs.excludeTools.length ? ["--exclude-tools", runArgs.excludeTools.join(",")] : [],
      copy: ["agent-dir"],
      env: { PI_CODING_AGENT_DIR: "agent-dir" },
      cwd: null,
      pathRewrites: [],
    },
    // 技能在**产物内**的相对位置：让上层工具（probe / C3）不必知道某 harness 的目录形状
    skillsInProduct: "agent-dir/skills",
    // **定义字段 → 产物位置的声明**（conformance C3 只验证这份声明，不再认死文件名）。
    // 契约形状：{ at: 产物内相对路径, contains?: 字符串或字符串数组 }，或 { exempt: 非平凡理由 }。
    expresses: buildExpresses({ agent, declaredEnhancements, modelParamName: `${prefix}_MODEL`, providerName: providerId, skillsInProduct: "agent-dir/skills", profileOrSettings: "agent-dir/settings.json", modelFile: "agent-dir/models.json.tmpl", enhancementsFile: "agent-dir/enhancements.yaml" }),
    mcpClient: adapterDoc.capabilities?.mcpClient ?? "unknown",
    // **运行时可订阅的事件集合**（E1 的契约面）带进产物：
    // 这样"某个钩子订阅的事件名到底存不存在"在产物里就能判（会话内 `/project hooks`、
    // 以及将来的接入缝校验），而不必让产物去猜基座的 `adapters/` 目录在哪。
    hookEvents: adapterDoc.hookEvents ?? null,
    // 只属于**这个智能体**的增强（**不含**基座不变量）：可移植性等级按它算 ——
    // 判据与闸门 1 的 portability/report 相同（看智能体自己的 harness/<h>/ 有没有东西）。
    // 合并后的 declarations 里分不出"基座给的"和"业务写的"，所以这里单独记一份。
    agentEnhancements: agentEnh.map((e) => e.id).sort(),
    labelsProvided,
    definitionDigest: digestDirectory(agentDir),
    // **渲染输入摘要**（定义 + 基座 seed + 渲染器 + 目录表）：复用旧产物前要比它。
    // 只比定义摘要会在"基座变了、定义没变"时错误地复用旧产物 —— 本轮真踩中（新增基座扩展后
    // 交互会话里没有那条命令）。判据在 adapters/pi/render-inputs.mjs，与 run-local 共用一份。
    renderInputsDigest: piRenderInputsDigest(agentDir),
  };
  // artifactsDigest 覆盖**除 manifest 自身之外**的全部产物：
  //   · 不覆盖 manifest → 避免自指（先算 digest 再写 manifest，摘要才能被复算验证）
  //   · manifest 里不放路径 → 同一定义渲染到不同目录必须得到同一 digest（N19 可复现）
  const artifactsDigest = digestDirectory(outRoot, {
    excludes: [...DEFAULT_EXCLUDES, "render-manifest.json"],
  });
  manifest.artifactsDigest = artifactsDigest;
  // 生效配置摘要 = 运行时版本 + 适配器版本 + 产物摘要 + **参数名集合**（只名字，不含值）。
  // 渲染期就能算全 ⇒ 记进清单，运行期直接读（镜像里不需要摘要实现，避免两份实现漂移）。
  manifest.effectiveConfigDigest = computeEffectiveConfigDigest({
    harnessVersion: manifest.harnessVersion,
    adapterVersion: adapterDoc.adapterVersion,
    artifactsDigest,
    paramNames: runtimeParams.map((p) => p.name),
  });
  writeFile(path.join(outRoot, "render-manifest.json"), stableJson(manifest));

  const result = {
    harness: HARNESS,
    agent: agent.name,
    out: outRoot,
    definitionDigest: manifest.definitionDigest,
    artifactsDigest,
    declaredSkills,
    declaredEnhancements,
    excludeTools: runArgs.excludeTools,
    paramNames: [],
  };
  if (json) process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  else process.stdout.write(sha256(JSON.stringify(result)) + "\n");
  log(`✅ 渲染完成：${outRoot}`);
  log(`   artifactsDigest = ${artifactsDigest}`);
  process.exit(EXIT_CODES.ok);
}

main();
