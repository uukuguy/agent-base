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
import { DEFAULT_EXCLUDES, EXIT_CODES, digestDirectory, parseArgs, sha256 } from "../../core/gates/index.mjs";
import { PREINSTALL_PATH, loadPreinstall, resolveConnectors } from "../../core/image/resolve-preinstall.mjs";

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
function buildExpresses({ agent, declaredEnhancements, skillsInProduct, profileOrSettings, modelFile, enhancementsFile }) {
  const e = {
    "persona.instructions": { at: "agent-dir/AGENTS.md", contains: String(agent.persona?.instructions ?? "").trim().slice(0, 24) },
    "model.route": { at: modelFile, contains: agent.model.route },
    "model.name": { at: modelFile, contains: agent.model.name },
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
  if (!agent.model?.route || !agent.model?.name) {
    log("❌ model.route / model.name 缺失（渲染需要它们推导端点引用名）");
    process.exit(EXIT_CODES.static);
  }
  const prefix = envPrefixFor(agent.model.route);
  const modelsTmpl = {
    providers: {
      [agent.model.route]: {
        baseUrl: `\${${prefix}_BASE_URL}`,
        api: "openai-completions",
        apiKey: `$${prefix}_API_KEY`,
        models: [{ id: agent.model.name }],
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
    defaultProvider: agent.model.route,
    defaultModel: agent.model.name,
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

  copyTree(path.join(SEED, "extensions"), path.join(agentOut, "extensions"));
  copyTree(path.join(agentDir, "harness", HARNESS, "extensions"), path.join(agentOut, "extensions"));
  // 发射契约只有一处定义：把 core 的发射器拷进产物，扩展用相对路径 import 它
  writeFile(path.join(agentOut, "extensions", "_trace-emit.mjs"),
    fs.readFileSync(path.join(REPO, "core/trace/emit.mjs"), "utf8"));

  const declaredEnhancements = [...new Set([...baseEnh, ...agentEnh].map((e) => e.id))].sort();
  writeFile(path.join(agentOut, "enhancements.yaml"), stableJson({
    apiVersion: "agent-base/v1",
    harness: HARNESS,
    note: "由渲染器合并生成：基座不变量声明 ∪ 智能体声明。供闸门 2 的集合断言使用。",
    enhancements: [...baseEnh, ...agentEnh],
  }));

  const extDir = path.join(agentOut, "extensions");
  settings.extensions = fs.existsSync(extDir)
    ? fs.readdirSync(extDir).filter((f) => f !== "_trace-emit.mjs").sort().map((f) => `extensions/${f}`)
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
      settings: { allowInstall: false, hostConfigDiscovery: "off" },
    }));
    // 扩展包在**构建期**装进镜像的固定前缀，这里声明本地路径 ⇒ 运行期不需要网络
    settings.packages = [MCP_ADAPTER_IN_IMAGE];
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
  const manifest = {
    harness: HARNESS,
    harnessVersion: readYaml(path.join(HERE, "adapter.yaml")).version,
    agent: agent.name,
    declaredSkills,
    declaredEnhancements,
    connectors: enabledConnectors.map((c) => ({ serverName: c.name, transport: c.transport })),
    connectorsNote: "pi 原生无 MCP 客户端；连接器经基座种子扩展（pi-mcp-adapter，构建期装好）渲染成 agent-dir/mcp.json",
    mcpAdapterInImage: MCP_ADAPTER_IN_IMAGE,
    paramNames: connParamNames,
    runArgs,
    modelRoutes: [agent.model.route],
    // 技能在**产物内**的相对位置：让上层工具（probe / C3）不必知道某 harness 的目录形状
    skillsInProduct: "agent-dir/skills",
    // **定义字段 → 产物位置的声明**（conformance C3 只验证这份声明，不再认死文件名）。
    // 契约形状：{ at: 产物内相对路径, contains?: 字符串或字符串数组 }，或 { exempt: 非平凡理由 }。
    expresses: buildExpresses({ agent, declaredEnhancements, skillsInProduct: "agent-dir/skills", profileOrSettings: "agent-dir/settings.json", modelFile: "agent-dir/models.json.tmpl", enhancementsFile: "agent-dir/enhancements.yaml" }),
    mcpClient: readYaml(path.join(HERE, "adapter.yaml")).capabilities?.mcpClient ?? "unknown",
    labelsProvided,
    definitionDigest: digestDirectory(agentDir),
  };
  // artifactsDigest 覆盖**除 manifest 自身之外**的全部产物：
  //   · 不覆盖 manifest → 避免自指（先算 digest 再写 manifest，摘要才能被复算验证）
  //   · manifest 里不放路径 → 同一定义渲染到不同目录必须得到同一 digest（N19 可复现）
  const artifactsDigest = digestDirectory(outRoot, {
    excludes: [...DEFAULT_EXCLUDES, "render-manifest.json"],
  });
  manifest.artifactsDigest = artifactsDigest;
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
