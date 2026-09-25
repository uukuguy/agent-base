#!/usr/bin/env node
// ============================================================================
// 闸门 2：解析自证 doctor（统一设计 §6.3）
//
// ## 它回答什么
//
// 「harness **实际**加载了什么」——而不是「我们渲染了什么」。这两者之间的差距，正是
// 全部静默失败的藏身处（§5.5）。所以 doctor 不是"一个好用的命令"，而是**所有适配器的强制接口**。
//
// ## 必含七个字段（缺一即 conformance 失败）
//
//   harness + version · definitionPath · skills[] · connectors[] · enhancements[]
//   modelRoutes[] · effectiveConfigDigest
//
// ## 三条硬断言（所有 harness 相同）
//
//   1 技能：实际集合 == 基座不变量技能 ∪ 智能体定义技能（**多一个也不行**）
//   2 连接器：实际启用的集合 == 定义声明的启用集合
//   3 扩展：已加载扩展 id 集合 == enhancements.yaml 声明集合
//
// ## 两个刻意的实现选择
//
// ① **在暂存副本上跑**：上游运行时**会写配置目录**（实测：连 --list-models 都写
//    <agent-dir>/{models-store.json,auth.json}）。所以 doctor 先把渲染产物拷到临时目录再跑，
//    既保持产物干净（否则 artifactsDigest 必然对不上），也顺带验证了「启动期暂存为可写副本」这条设计。
// ② **零凭据、零网络**：只用 `--mode rpc` 的 `get_state` / `get_commands`。
//
// 用法：
//   node adapters/pi/doctor.mjs <RENDER_DIR> [--json]
//   RENDER_DIR = adapters/pi/render.mjs 的输出目录（含 agent-dir/ 与 render-manifest.json）
//
// 输出约定（§8.2）：stdout 只放结果 JSON；人读日志走 stderr。
// 退出码（§6.7）：0 通过 / 2 用法错误 / 20 闸门 2 失败 / 50 崩溃。
// ============================================================================

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import {
  DEFAULT_EXCLUDES, EXIT_CODES, GateReport, computeEffectiveConfigDigest,
  digestDirectory, runGates,
} from "../../core/gates/index.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GATE = "resolution";
const log = (m) => process.stderr.write(m + "\n");

// ---------------------------------------------------------------------------
/** 跑一次 `--version`，拿 harness 版本（零凭据）。 */
function probeVersion(bin) {
  return new Promise((resolve) => {
    const p = spawn(bin, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => { out += d; });
    p.on("error", () => resolve(null));
    p.on("close", () => resolve(out.trim().split("\n")[0] || null));
  });
}

/**
 * 跑一次 RPC 会话，收集指定命令的响应。
 * 注意：RPC 模式同时会吐 session 事件，所以只认 `type === "response"` 的记录。
 */
function piRpc({ bin, args, env, cwd, requests, timeoutMs = 20000 }) {
  return new Promise((resolve) => {
    const proc = spawn(bin, args, { env, cwd, stdio: ["pipe", "pipe", "pipe"] });
    const responses = new Map();
    const all = [];
    let stderr = "";
    let buf = "";
    const want = new Set(requests.map((r) => r.type));
    const done = () => {
      try { proc.kill("SIGKILL"); } catch { /* 已退出 */ }
      resolve({ responses, all, stderr, complete: [...want].every((t) => responses.has(t)) });
    };
    const timer = setTimeout(done, timeoutMs);
    proc.stdout.on("data", (d) => {
      buf += d;
      // 严格按 LF 切分（上游明确警告：不要用 readline，它会误认 U+2028/U+2029）
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, "");
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let rec;
        try { rec = JSON.parse(line); } catch { continue; }
        all.push(rec);
        if (rec.type === "response" && rec.command) responses.set(rec.command, rec);
      }
      if ([...want].every((t) => responses.has(t))) { clearTimeout(timer); done(); }
    });
    proc.stderr.on("data", (d) => { stderr += d; });
    proc.on("error", (e) => { clearTimeout(timer); resolve({ responses, all, stderr: String(e), complete: false }); });
    proc.on("close", () => { clearTimeout(timer); resolve({ responses, all, stderr, complete: [...want].every((t) => responses.has(t)) }); });
    for (const r of requests) proc.stdin.write(JSON.stringify(r) + "\n");
  });
}

/**
 * 启动期渲染：把 models.json.tmpl 解析成 models.json。
 *
 * 这一步**不是可选的**：该 harness 的 models.json 只对 apiKey/headers 做环境插值，
 * **baseUrl 不插值**（实测 + 上游文档），所以端点必须在启动期由基座渲染进来（设计 §2.2 参数下放）。
 *
 * doctor 做零凭据自证时通常没有真实参数值，此时用**占位值**保证 provider/route 能被 harness 加载
 * （doctor 只调 get_state / get_commands，不发模型请求，因此占位端点不会被访问），并如实报告哪些是占位。
 */
function renderModelsTemplate(staging, env) {
  const tmplFile = path.join(staging, "models.json.tmpl");
  if (!fs.existsSync(tmplFile)) return { resolved: false, placeholders: [], reason: "没有 models.json.tmpl" };
  const tmpl = fs.readFileSync(tmplFile, "utf8");
  const placeholders = [];
  const out = tmpl.replace(/\$\{([A-Z_][A-Z0-9_]*)\}|\$([A-Z_][A-Z0-9_]*)/g, (_m, a, b) => {
    const name = a ?? b;
    const v = env[name];
    if (v !== undefined && v !== "") return v;
    placeholders.push(name);
    return name.endsWith("_BASE_URL") ? "http://127.0.0.1:9/v1" : "placeholder-not-a-credential";
  });
  fs.writeFileSync(path.join(staging, "models.json"), out);
  return { resolved: true, placeholders };
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, e.name);
    const d = path.join(to, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

// ---------------------------------------------------------------------------
async function main() {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const renderDir = args.find((a) => !a.startsWith("--"));

  if (!renderDir || args.includes("--help") || args.includes("-h")) {
    log("用法: node adapters/pi/doctor.mjs <RENDER_DIR> [--json]");
    process.exit(renderDir ? EXIT_CODES.ok : EXIT_CODES.usage);
  }
  const root = path.resolve(renderDir);
  const manifestFile = path.join(root, "render-manifest.json");
  const agentDir = path.join(root, "agent-dir");
  if (!fs.existsSync(manifestFile) || !fs.existsSync(agentDir)) {
    log(`❌ ${root} 不是渲染产物（缺 render-manifest.json 或 agent-dir/）——先跑 render`);
    process.exit(EXIT_CODES.static);
  }

  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  const adapter = YAML.parse(fs.readFileSync(path.join(HERE, "adapter.yaml"), "utf8"));

  const report = new GateReport({
    agent: manifest.agent,
    harness: manifest.harness,
    harnessVersion: manifest.harnessVersion,
    adapterVersion: adapter.adapterVersion,
    artifactsDigest: manifest.artifactsDigest,
  });
  report.paramNames = [...(manifest.paramNames ?? [])].sort();

  const ctx = {};

  const gates = [
    {
      id: GATE,
      handler: async () => {
        // ---- 产物完整性：摘要可复算（第三方拿到产物能自己验证）----
        const recomputed = digestDirectory(root, { excludes: [...DEFAULT_EXCLUDES, "render-manifest.json"] });
        if (recomputed === manifest.artifactsDigest) {
          report.pass(GATE, "resolution/product-digest", `artifactsDigest 可复算：${recomputed}`);
        } else {
          report.fail(GATE, "resolution/product-digest",
            `渲染产物与 manifest 记录的摘要不一致（产物被改动过，或渲染不确定）：记录 ${manifest.artifactsDigest}，实际 ${recomputed}`);
        }

        // ---- 暂存副本：上游会写配置目录，产物必须保持干净（§10.1 约束 2）----
        const staging = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-staging-"));
        const home = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-home-"));
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-cwd-"));
        copyDir(agentDir, staging);
        ctx.staging = staging;

        // ---- 运行期契约（见 adapter.yaml 的 runtime 段；每条都来自实测）----
        const skillsDir = path.join(staging, "skills");
        const runtimeArgs = ["--mode", "rpc", "--no-session"];
        if (fs.existsSync(skillsDir)) runtimeArgs.push("--no-skills", "--skill", skillsDir);
        for (const t of manifest.runArgs?.excludeTools ?? []) runtimeArgs.push("--exclude-tools", t);

        const env = {
          ...process.env,
          HOME: home,
          PI_CODING_AGENT_DIR: staging,
          PI_OFFLINE: "1",
        };

        // 启动期参数下放：模板 → 实际配置（缺失的参数用占位值，并如实记录）
        const template = renderModelsTemplate(staging, env);
        ctx.templatePlaceholders = template.placeholders;
        if (!template.resolved) {
          // 关键：这是**能判定的失败**，不是"没拿到可判定结果"。
          // 若在这里继续往下跑，RPC 会启动失败并被当成崩溃（50），
          // 把闸门 2 的失败误报成"harness 崩溃"——那是误导。
          report.fail(GATE, "resolution/param-render", template.reason ?? "无法渲染模型配置模板");
          return;
        }
        if (template.placeholders.length) {
          report.pass(GATE, "resolution/param-render",
            `models.json.tmpl 已在启动期渲染；${template.placeholders.length} 个参数用占位值（doctor 零凭据，不发模型请求）：${template.placeholders.join(", ")}`);
        } else {
          report.pass(GATE, "resolution/param-render", "models.json.tmpl 已在启动期渲染（参数全部来自环境）");
        }

        const version = await probeVersion("pi");
        ctx.harnessVersion = version;
        if (version && manifest.harnessVersion && version !== manifest.harnessVersion) {
          report.fail(GATE, "resolution/harness-version",
            `实际 harness 版本 ${version} 与渲染时记录的 ${manifest.harnessVersion} 不一致——render 产物的可复现性依赖版本 pin`);
        } else {
          // 声明了连接器 ⇒ 产物必须声明 MCP 客户端扩展。
  // 这一条对治的正是 F10 的新形态：pi 原生没有 MCP 客户端，靠基座种子扩展补上；
  // 如果产物里有 mcpServers 却没有扩展声明，运行起来就是"连接器被静默忽略"。
  {
    const declared = manifest.connectors ?? [];
    const adapterPath = manifest.mcpAdapterInImage;
    const stagedSettings = path.join(staging, "settings.json");
    const packages = fs.existsSync(stagedSettings) ? (JSON.parse(fs.readFileSync(stagedSettings, "utf8")).packages ?? []) : [];
    if (declared.length && !adapterPath) {
      report.fail(GATE, "resolution/connectors-client", `声明了 ${declared.length} 个连接器，但清单没记录 MCP 客户端扩展路径 —— 会渲染出一个没有客户端的智能体`);
    } else if (declared.length && !packages.some((x) => String(x).includes("pi-mcp-adapter"))) {
      report.fail(GATE, "resolution/connectors-client", `声明了 ${declared.length} 个连接器，但产物的 settings.packages 里没有 MCP 客户端扩展 —— 连接器会被静默忽略`);
    } else if (declared.length) {
      report.pass(GATE, "resolution/connectors-client", `${declared.length} 个连接器 + MCP 客户端扩展声明齐备`);
    } else {
      report.pass(GATE, "resolution/connectors-client", "未声明连接器，无需客户端扩展");
    }
  }

  report.pass(GATE, "resolution/harness-version", `harness 版本 ${version}（与渲染时一致）`);
        }

        const rpc = await piRpc({
          bin: "pi",
          args: runtimeArgs,
          env,
          cwd,
          requests: [{ id: "d1", type: "get_state" }, { id: "d2", type: "get_commands" }],
        });
        if (!rpc.complete) {
          throw new Error(`RPC 自证未完成（可能 harness 崩溃）。stderr 摘要：${rpc.stderr.slice(-400) || "(空)"}`);
        }

        const state = rpc.responses.get("get_state")?.data ?? {};
        const commands = rpc.responses.get("get_commands")?.data?.commands ?? [];

        // ---- 字段 3：技能（实际加载的）----
        ctx.observedSkills = commands
          .filter((c) => c.source === "skill")
          .map((c) => String(c.name).replace(/^skill:/, ""))
          .sort();

        // ---- 字段 4：连接器（实际启用的）----
        // 该 harness 的原生 MCP 客户端能力见 adapter.yaml 的 capabilities.mcpClient。
        //
        // **口径（诚实标注）**：pi 原生没有 MCP 客户端，连接器经**基座种子扩展**生效
        // （渲染成 agent-dir 的 `mcp.json`）。该扩展的服务列表**不在 pi 的原生自证里**
        // （`get_state`/`get_commands` 只报技能与命令），所以这里的"已启用"取自**产物**：
        // mcp.json 里声明了哪几台服务器 + 产物是否声明了客户端扩展。
        // 这是"**已配置且就位**"口径，不是"运行时自报已连接"口径 —— 差异写进 exemptions.yaml。
        // 而"连接器真的生效了"由闸门 3 从**端点侧**取证（接上 MCP 后实测工具数 4 → 7）。
        ctx.mcpClient = adapter.capabilities?.mcpClient ?? "unknown";
        const mcpFile = path.join(staging, "mcp.json");
        const settingsFile = path.join(staging, "settings.json");
        const pkgList = fs.existsSync(settingsFile)
          ? (JSON.parse(fs.readFileSync(settingsFile, "utf8")).packages ?? [])
          : [];
        const hasClient = pkgList.some((x) => String(x).includes("pi-mcp-adapter"));
        const mcpServers = fs.existsSync(mcpFile)
          ? Object.keys(JSON.parse(fs.readFileSync(mcpFile, "utf8")).mcpServers ?? {})
          : [];
        ctx.connectorsObservationScope = hasClient
          ? "configured-and-in-place（产物 mcp.json + 已声明客户端扩展）"
          : "no-client-extension";
        ctx.observedConnectors = hasClient ? mcpServers.sort() : [];

        // ---- 字段 5：扩展（已加载的业务级增强 id）----
        // 声明来自渲染产物的 enhancements.yaml；"已加载"目前只能观测到会注册命令/工具的那类扩展，
        // 因此这里同时报告 rendered（产物里确实打包了）与 observable（harness 报出来的）。
        const enhFile = path.join(staging, "enhancements.yaml");
        let declaredEnhancements = [];
        if (fs.existsSync(enhFile)) {
          const enh = YAML.parse(fs.readFileSync(enhFile, "utf8"));
          declaredEnhancements = (enh.enhancements ?? []).map((e) => e.id).filter(Boolean).sort();
        }
        const missingEntries = [];
        if (fs.existsSync(enhFile)) {
          const enh = YAML.parse(fs.readFileSync(enhFile, "utf8"));
          for (const e of enh.enhancements ?? []) {
            if (!e.entry) { missingEntries.push(`${e.id}（未声明 entry）`); continue; }
            if (!fs.existsSync(path.join(staging, e.entry))) missingEntries.push(`${e.id}→${e.entry}`);
          }
        }
        const renderedExtensions = (JSON.parse(fs.readFileSync(path.join(staging, "settings.json"), "utf8")).extensions ?? []);
        ctx.declaredEnhancements = declaredEnhancements;
        // 「进入产物」= 实体文件已打包 且 已登记到 settings.extensions。
        // 诚实说明：这离设计措辞的「**已加载**扩展 id 集合」还差一步 —— 真正的"已加载"要由扩展自己
        // 向 harness 登记后才能被枚举（见 failures.md F6 的待补项）。这里不假装做到了。
        ctx.packagedEnhancements = declaredEnhancements.filter((id) =>
          !missingEntries.some((m) => m.startsWith(`${id}→`)) &&
          renderedExtensions.some((p) => String(p).includes(id)));
        ctx.observedEnhancements = ctx.packagedEnhancements;
        ctx.renderedExtensions = renderedExtensions;
        ctx.observableEnhancements = commands
          .filter((c) => c.source === "extension" || c.source === "prompt")
          .map((c) => c.name);
        if (declaredEnhancements.length && ctx.packagedEnhancements.length !== declaredEnhancements.length) {
          report.fail(GATE, "resolution/enhancement-packaged",
            `声明的增强未全部进入产物：声明 ${JSON.stringify(declaredEnhancements)}，进入产物 ${JSON.stringify(ctx.packagedEnhancements)}`);
        } else {
          report.pass(GATE, "resolution/enhancement-packaged",
            declaredEnhancements.length ? `${declaredEnhancements.length} 个声明的增强都进入了产物` : "未声明业务级增强");
        }

        if (missingEntries.length) {
          report.fail(GATE, "resolution/enhancement-entries",
            `声明的增强缺实体文件（声明了却没打包 = 注定不会加载）：${missingEntries.join("；")}`);
        } else {
          report.pass(GATE, "resolution/enhancement-entries",
            declaredEnhancements.length ? `${declaredEnhancements.length} 个声明的增强都有实体文件` : "未声明业务级增强");
        }

        // ---- 字段 6：模型路由 ----
        const modelsRaw = fs.readFileSync(path.join(staging, "models.json.tmpl"), "utf8");
        ctx.declaredRoutes = Object.keys(JSON.parse(modelsRaw).providers ?? {}).sort();
        ctx.stateProvider = state.model?.provider ?? null;
        ctx.stateModel = state.model?.id ?? null;

        // ---- 字段 2：definitionPath（确认加载的是**这一份**定义）----
        ctx.definitionPath = staging;
        const settings = JSON.parse(fs.readFileSync(path.join(staging, "settings.json"), "utf8"));
        const loadedExpected = settings.defaultProvider === ctx.stateProvider && settings.defaultModel === ctx.stateModel;
        if (loadedExpected) {
          report.pass(GATE, "resolution/definition-path",
            `实际生效的模型来自本次渲染产物（${ctx.stateProvider}/${ctx.stateModel}）—— 不是宿主配置`);
        } else {
          report.fail(GATE, "resolution/definition-path",
            `实际生效模型（${ctx.stateProvider}/${ctx.stateModel}）与渲染产物（${settings.defaultProvider}/${settings.defaultModel}）不一致` +
            `：极可能回落到了宿主配置目录（静默失败 F9）`);
        }

        // ---- F5：声明了推理强度就必须真的生效（不许静默钳位）----
        if (settings.defaultThinkingLevel) {
          ctx.declaredThinking = settings.defaultThinkingLevel;
          ctx.observedThinking = state.thinkingLevel ?? null;
          if (ctx.declaredThinking === ctx.observedThinking) {
            report.pass(GATE, "resolution/thinking-level", `推理强度 ${ctx.declaredThinking} 已生效`);
          } else {
            report.fail(GATE, "resolution/thinking-level",
              `声明了 ${ctx.declaredThinking}，实际生效 ${ctx.observedThinking}：上游会按模型声明的能力**静默钳位**（静默失败 F5）`);
          }
        } else {
          report.pass(GATE, "resolution/thinking-level", "未声明推理强度，跳过该项");
        }

        // ---- 字段 7：effectiveConfigDigest ----
        report.pass(GATE, "resolution/effective-config-digest",
          computeEffectiveConfigDigest({
            harnessVersion: version,
            adapterVersion: adapter.adapterVersion,
            artifactsDigest: manifest.artifactsDigest,
            paramNames: report.paramNames,
          }));
      },
      assertions: [
        {
          id: "resolution/skills-set",
          assert: "set-equals",
          actual: "observedSkills",
          expectedPath: "declaredSkills",
          detail: "硬断言 1：实际加载的技能集合必须**等于**声明集合（多一个也不行——多出来的说明隐式加载源没隔离干净）",
        },
        {
          id: "resolution/connectors-set",
          assert: "set-equals",
          actual: "observedConnectors",
          expectedPath: "enabledConnectors",
          detail: "硬断言 2：实际启用的连接器集合必须等于定义声明的启用集合",
        },
        {
          id: "resolution/enhancements-set",
          assert: "set-equals",
          actual: "observedEnhancements",
          expectedPath: "declaredEnhancements",
          detail: "硬断言 3：已加载扩展 id 集合必须等于 enhancements.yaml 声明集合",
        },
        {
          id: "resolution/model-routes",
          assert: "set-equals",
          actual: "declaredRoutes",
          expectedPath: "expectedRoutes",
          detail: "渲染产物声明的模型路由必须与预期一致",
        },
      ],
    },
  ];

  // 断言上下文：把 manifest 的声明与"基座不变量技能"合并成期望集合
  ctx.declaredSkills = [...(manifest.declaredSkills ?? [])].sort();
  // 清单里的字段是 serverName（渲染器与两个 harness 统一用这个名）；早期这里写 c.name，
  // 于是"声明集合"变成了 [undefined] —— 集合断言必错，而且错得看不懂。
  ctx.enabledConnectors = (manifest.connectors ?? []).map((c) => c.serverName ?? c.name).filter(Boolean).sort();
  ctx.expectedRoutes = [...(manifest.modelRoutes ?? [])].sort();

  // 基座不变量技能（清单里声明为 shipped 且默认启用）也要进期望集合
  try {
    const { loadPreinstall } = await import("../../core/image/resolve-preinstall.mjs");
    const pre = loadPreinstall();
    const baseSkills = (pre.list.entries ?? [])
      .filter((e) => e.kind === "skill" && e.status === "shipped" && e.enabledByDefault)
      .map((e) => e.id.replace(/^skill-/, ""));
    if (baseSkills.length) ctx.declaredSkills = [...new Set([...ctx.declaredSkills, ...baseSkills])].sort();
  } catch { /* 清单缺失时不影响主流程 */ }

  await runGates({ gates, ctx, report });

  if (ctx.mcpClient === "absent" && (manifest.connectors?.length ?? 0) > 0) {
    report.fail(GATE, "resolution/mcp-client",
      `该 harness 原生没有 MCP 客户端（capabilities.mcpClient=absent），却有 ${manifest.connectors.length} 个启用的连接器被声明`);
  }

  const doc = {
    harness: report.harness,
    version: report.harnessVersion,
    definitionPath: ctx.definitionPath ?? null,
    skills: ctx.observedSkills ?? [],
    connectors: ctx.observedConnectors ?? [],
    enhancements: ctx.observedEnhancements ?? [],
    modelRoutes: ctx.declaredRoutes ?? [],
    effectiveConfigDigest: report.effectiveConfigDigest,
    adapterVersion: report.adapterVersion,
    // 额外证据（供排障；不属七个必含字段）
    evidence: {
      renderedExtensions: ctx.renderedExtensions ?? [],
      observableFromHarness: ctx.observableEnhancements ?? [],
      enhancementsScopeNote: "enhancements[] 目前的口径是「已进入产物」（实体文件已打包 + 已登记 settings.extensions）；真正意义的「已加载」需扩展自我登记后才能枚举，待补（failures.md F6）",
      harnessCwdIsolated: true,
      harnessHomeIsolated: true,
      stagedWritableCopy: true,
      paramPlaceholders: ctx.templatePlaceholders ?? [],
    },
  };

  if (json) {
    process.stdout.write(JSON.stringify({ doctor: doc, gate: report.toJSON() }, null, 2) + "\n");
  } else {
    report.print({ json: false, stderr: process.stderr });
    process.stderr.write("\ndoctor 七字段：\n");
    process.stderr.write(`  harness/version   ${doc.harness} ${doc.version}\n`);
    process.stderr.write(`  definitionPath    ${doc.definitionPath}\n`);
    process.stderr.write(`  skills            ${JSON.stringify(doc.skills)}\n`);
    process.stderr.write(`  connectors        ${JSON.stringify(doc.connectors)}\n`);
    process.stderr.write(`  enhancements      ${JSON.stringify(doc.enhancements)}\n`);
    process.stderr.write(`  modelRoutes       ${JSON.stringify(doc.modelRoutes)}\n`);
    process.stderr.write(`  effectiveConfigDigest ${doc.effectiveConfigDigest}\n`);
  }
  process.exit(report.exitCode);
}

await main();
