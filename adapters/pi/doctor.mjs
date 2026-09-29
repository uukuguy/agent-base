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
//   modelProviders[] · effectiveConfigDigest
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
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
// 暂存/渲染**共用运行期那一份实现**（run.mjs → core/image/startup.mjs），不在这里另写一遍
import { stageRenderDir } from "./run.mjs";
import { BUNDLES_ENV, expectedConnectorNames, expectedSkillNames, loadBundles } from "../../core/bundles/index.mjs";
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
// 注意：这里**不再**自己渲染一遍模板。渲染只有一处实现（core/image/startup.mjs），
// 由 run.mjs 的 stageRenderDir 统一调用 —— 早先这里还有第二份渲染实现，
// 两份立刻漂移：暂存把模型名渲染成真值，这里又把它换成了凭据占位串，
// 于是自证报出"实际生效模型与产物不一致"，而真因是重复实现。

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
  // 参数名只从**清单的运行期参数契约**取 —— 与渲染期算摘要用的是同一份来源。
  // 早期这里读 manifest.paramNames（当时只含连接器参数），加上模型名后立刻与渲染期不一致，
  // 于是摘要交叉核对变红，而"两份来源"这个真因比症状难看出来。
  report.paramNames = [...(manifest.runtimeParams ?? []).map((p) => p.name)].sort();

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
        //
        // **必须走与运行期同一条暂存/渲染路径**（run.mjs 的 stageRenderDir → core/image/startup.mjs）。
        // 早先这里是自己 copyDir 一份、然后在 doctor 内部另做一遍渲染 —— 两份实现立刻漂移：
        // 运行期把模型名渲染成真值，doctor 这边还留着占位符，于是自证报出一个看不懂的结论。
        const home = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-home-"));
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-cwd-"));
        // native 型 provider（订阅免密钥）的凭据在宿主的运行时目录里：只有把它带进来，
        // "实际生效模型"才可能验证 —— 否则必然是 unknown，检查变成假红。
        const nativeAuth = readManifestAuth(renderDir) === "native";
        const hostHome = nativeAuth ? (process.env.AGENT_HARNESS_HOME ?? piAgentDir()) : null;
        const { staging, placeholders } = stageRenderDir(renderDir, "http://127.0.0.1:9/v1", { zeroCredential: true, harnessHome: hostHome });
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

        // 声明需要渲染的运行时：**渲染结果必须真的产出**。
        // 这一条把"配置缺失/未渲染"从"harness 启动崩溃（退出码 50）"拉回**可判定的失败（20）** ——
        // 崩溃码会让人以为基座坏了，而真相是产物缺了东西（F3）。
        if (manifest.rendersParams === true && !fs.existsSync(path.join(staging, "models.json"))) {
          report.fail(GATE, "resolution/param-render",
            `产物声明了启动期渲染（rendersParams: true），但暂存后没有 models.json —— 模板缺失或渲染未发生`);
          return;   // 早退：配置都没渲染出来，后面的 RPC 自证没有意义（会变成看不懂的崩溃）
        }

        // 启动期参数下放：**已由暂存步骤（同一份实现）完成**，这里只报告结果。
        // 零凭据模式下缺的参数由 stageRenderDir 用显式占位值补齐，并在这里如实列出。
        ctx.templatePlaceholders = placeholders;
        if (placeholders.length) {
          report.pass(GATE, "resolution/param-render",
            `运行期参数已在启动期渲染；${placeholders.length} 个用清单里的默认值或零凭据占位（doctor 不发模型请求）：${placeholders.join(", ")}`);
        } else {
          report.pass(GATE, "resolution/param-render", "运行期参数已在启动期渲染（全部来自环境）");
        }

        const version = await probeVersion("pi");
        ctx.harnessVersion = version;
        if (version && manifest.harnessVersion && version !== manifest.harnessVersion) {
          report.fail(GATE, "resolution/harness-version",
            `实际 harness 版本 ${version} 与渲染时记录的 ${manifest.harnessVersion} 不一致——render 产物的可复现性依赖版本 pin`);
        } else {
          // 声明了连接器 ⇒ 产物必须声明 MCP 客户端扩展。
  // 这一条对治的正是 F10 的新形态：pi 原生没有 MCP 客户端，靠基座种子扩展补上；
  // 订阅型（auth: native）provider：基座**不注入密钥**，凭据来自 pi 自己的凭据库（auth.json）。
  // 因此这里必须确认"底层真的认识这家" —— 否则我们声明的是一个不存在的 provider，
  // 而失败会以"运行时说 provider 不认识"这种看不懂的形式出现。
  {
    const providerId = (manifest.modelProviders ?? [])[0];
    const auth = manifest.modelProviderAuth;
    if (auth === "native" && providerId) {
      const piBin = process.env.PI_BIN ?? "pi";
      const probe = spawnSync(piBin, ["auth", "check", "--provider", providerId, "--json", "--no-refresh"], { encoding: "utf8", timeout: 60000 });
      const out = `${probe.stdout ?? ""}${probe.stderr ?? ""}`;
      let parsed = null;
      try { parsed = JSON.parse((probe.stdout ?? "").trim().split("\n").pop()); } catch { /* 非 JSON 输出 */ }
      if (parsed?.reason === "provider_not_found") {
        report.fail(GATE, "resolution/native-credential",
          `provider「${providerId}」声明为 auth: native（免密钥、用运行时凭据库），但本运行时不认识它 —— 声明与实际不符`);
      } else if (parsed?.status === "ready") {
        report.pass(GATE, "resolution/native-credential", `provider「${providerId}」免密钥可用（${parsed.authType ?? "凭据已就绪"}）`);
      } else if (parsed) {
        report.pass(GATE, "resolution/native-credential",
          `provider「${providerId}」本运行时认识，但还没有凭据（${parsed.reason ?? parsed.status}）—— 运行前需先登录一次`);
      } else {
        report.fail(GATE, "resolution/native-credential", `无法确认 provider「${providerId}」是否被本运行时认识：${out.trim().slice(0, 160)}`);
      }
    } else if (providerId) {
      report.pass(GATE, "resolution/native-credential", `provider「${providerId}」的凭据由基座注入（auth: ${auth ?? "env"}），无需运行时凭据库`);
    }
  }

  // 如果产物里有 mcpServers 却没有扩展声明，运行起来就是"连接器被静默忽略"。
  {
    const declared = manifest.connectors ?? [];
    const adapterPath = manifest.mcpAdapterInImage;
    const stagedSettings = path.join(staging, "settings.json");
    const packages = fs.existsSync(stagedSettings) ? (JSON.parse(fs.readFileSync(stagedSettings, "utf8")).packages ?? []) : [];
    if (declared.length && !adapterPath) {
      report.fail(GATE, "resolution/connectors-client", `声明了 ${declared.length} 个连接器，但清单没记录 MCP 客户端扩展路径 —— 会渲染出一个没有客户端的智能体`);
    // 包声明有**字符串**与**对象**两种形式（对象形式用于按资源类型裁剪）——
    // 只按字符串比会漏判对象形式，报出假告警。
    } else if (declared.length && !packages.some((x) => String(typeof x === "string" ? x : x?.source ?? "").includes("pi-mcp-adapter"))) {
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
        // 包声明可能是字符串或对象（对象形式用于按资源裁剪）—— 两种都要认，否则会漏判成"没有客户端"
        const hasClient = pkgList.some((x) => String(typeof x === "string" ? x : x?.source ?? "").includes("pi-mcp-adapter"));
        const mcpServers = fs.existsSync(mcpFile)
          ? Object.keys(JSON.parse(fs.readFileSync(mcpFile, "utf8")).mcpServers ?? {})
          : [];
        ctx.connectorsObservationScope = hasClient
          ? "configured-and-in-place（产物 mcp.json + 已声明客户端扩展）"
          : "no-client-extension";
        ctx.observedConnectors = hasClient ? mcpServers.sort() : [];

        // ---- 连接器**真的起得来**吗（不只是"配置就位"）----
        // 为什么加这条：本轮业务方走查实测到——自研连接器（`mcp-servers/…`）在产物里是**相对路径**，
        // 运行时 cwd 不对 ⇒ 服务器静默起不来、工具不出现，而当时闸门只说"包就位"（自研连接器没有包，
        // 那条断言对它形同虚设）。于是这里**逐个真启动一次**，要一次合法握手（initialize + tools/list）。
        // 起不来 ⇒ 红，并带上该服务器的 stderr 尾巴（否则"为什么起不来"要靠猜）。
        ctx.connectorStarts = fs.existsSync(mcpFile)
          ? await Promise.all(Object.entries(JSON.parse(fs.readFileSync(mcpFile, "utf8")).mcpServers ?? {})
              .filter(([, cfg]) => cfg && typeof cfg.command === "string")
              .map(([name, cfg]) => probeStdioServer(name, cfg)))
          : [];
        // 报告放在**计算之后**（第一版放在前面 ⇒ 读 undefined ⇒ 闸门直接崩成 crash/resolution）。
        // 起不来就红，并带上该服务器的 stderr 尾巴 —— 「为什么起不来」必须能一眼看到。
        {
          const startsBad = ctx.connectorStarts.filter((x) => !x.ok);
          if (!ctx.connectorStarts.length) {
            report.pass(GATE, "resolution/connectors-start", "没有 stdio 连接器，无需启动自证");
          } else if (startsBad.length) {
            report.fail(GATE, "resolution/connectors-start",
              `${startsBad.length}/${ctx.connectorStarts.length} 个连接器起不来：${startsBad.map((x) => `${x.name}（${x.detail}）`).join("；")}`);
          } else {
            report.pass(GATE, "resolution/connectors-start",
              `${ctx.connectorStarts.length} 个 stdio 连接器都真起来了（${ctx.connectorStarts.map((x) => `${x.name}:${x.ms}ms`).join(" · ")}）`);
          }
        }

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
        // 「进入产物」= 声明的 entry 文件确实被打包，并已登记到 settings.extensions。
        //
        // 判据必须是**按声明的 entry 精确匹配**，不能用 `文件名.includes(增强 id)`：
        //   · 假阴：id `corp-risk-score` + `extensions/risk-score.ts` 是合法的，
        //     但子串匹配判它"没进产物"（实测撞到）
        //   · 假阳：id `trace` 会被 `extensions/my-trace-helper.ts` 满足
        // 精确匹配两个方向都对。诚实说明：这仍离设计措辞的「**已加载**扩展 id 集合」差一步 ——
        // 真正的"已加载"要由扩展自己向 harness 登记后才能枚举（见 failures.md F6 的待补项）。
        const entryOf = new Map();
        if (fs.existsSync(enhFile)) {
          for (const e of YAML.parse(fs.readFileSync(enhFile, "utf8")).enhancements ?? []) {
            if (e.id && e.entry) entryOf.set(e.id, String(e.entry));
          }
        }
        const renderedSet = new Set(renderedExtensions.map((p) => String(p)));
        ctx.packagedEnhancements = declaredEnhancements.filter((id) => {
          const entry = entryOf.get(id);
          if (!entry) return false;
          if (missingEntries.some((m) => m.startsWith(`${id}→`))) return false;
          return renderedSet.has(entry) || renderedSet.has(entry.replace(/^\.\//, ""));
        });
        ctx.enhancementEntryMap = Object.fromEntries(entryOf);
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

        // 交叉核对：清单里记录的摘要必须与**本地重算**一致。
        // 记录值由渲染期算好（镜像里直接读它）；重算值来自当前代码与当前产物 ——
        // 两者不一致说明清单过期或被改过，必须报出来，不能只看记录值。
        {
          const recorded = manifest.effectiveConfigDigest ?? null;
          const recomputed = computeEffectiveConfigDigest({
            harnessVersion: version,
            adapterVersion: adapter.adapterVersion,
            artifactsDigest: manifest.artifactsDigest,
            paramNames: report.paramNames,
          });
          if (recorded && recomputed !== recorded) {
            report.fail(GATE, "resolution/digest-crosscheck",
              `清单记录的生效配置摘要与本地重算不一致（记录 ${recorded.slice(0, 23)}… vs 重算 ${recomputed.slice(0, 23)}…）—— 清单过期或被改过`);
          } else {
            report.pass(GATE, "resolution/digest-crosscheck", recorded ? "记录值与本地重算一致" : "清单未记录摘要（旧产物），已按重算值报告");
          }
        }
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
          id: "resolution/model-providers",
          assert: "set-equals",
          actual: "declaredRoutes",
          expectedPath: "expectedRoutes",
          detail: "渲染产物声明的模型路由必须与预期一致",
        },
      ],
    },
  ];

  // 断言上下文：期望技能集合 = **声明 ∩ 当前启用**（L4 能力包：基座技能由包决定是否进产物，
  // 渲染器已把它们写进 manifest.declaredSkills；这里按激活集合过滤——与 startup 的摘除同源）
  // 清单里的字段是 serverName（渲染器与两个 harness 统一用这个名）；早期这里写 c.name，
  // 于是"声明集合"变成了 [undefined] —— 集合断言必错，而且错得看不懂。
  // 期望集合 = **声明 ∩ 当前启用**（L4 能力包）：与 startup 的摘除共用同一份实现，避免两处漂移
  ctx.bundles = expectedConnectorNames({ manifest, bundles: loadBundles().bundles, rawSelection: process.env[BUNDLES_ENV] ?? null });
  ctx.expectedSkills = expectedSkillNames({ manifest, bundles: loadBundles().bundles, rawSelection: process.env[BUNDLES_ENV] ?? null }).expected;
  ctx.declaredSkills = ctx.expectedSkills;
  ctx.enabledConnectors = ctx.bundles.expected;
  ctx.expectedRoutes = [...(manifest.modelProviders ?? [])].sort();

  // （旧逻辑：把"清单里 shipped 且默认启用的基座技能"并进期望集合。
  //  L4 之后基座技能**由能力包决定是否进产物**，渲染器已写进 manifest.declaredSkills，
  //  再由 expectedSkillNames 按激活集合过滤 —— 所以这段并集不再需要，留着会双重计数。）

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
    modelProviders: ctx.declaredRoutes ?? [],
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
    process.stderr.write(`  modelProviders       ${JSON.stringify(doc.modelProviders)}\n`);
    process.stderr.write(`  effectiveConfigDigest ${doc.effectiveConfigDigest}\n`);
  }
  process.exit(report.exitCode);
}

await main();

/** 从产物清单读 provider 的凭据模式（native 表示凭据来自运行时自己的目录）。 */
function readManifestAuth(renderDir) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(renderDir, "render-manifest.json"), "utf8"));
    return m.modelProviderAuth ?? null;
  } catch { return null; }
}

/** 本机运行时的 agent 目录（订阅登录就落在它里面的 auth.json）。 */
function piAgentDir() {
  const explicit = process.env.PI_CODING_AGENT_DIR;
  if (explicit) return explicit;
  return path.join(os.homedir(), ".pi", "agent");
}

/**
 * 真启动一次 stdio 连接器，要一次合法握手。**只用于闸门 2 的自证**，不影响运行期。
 * @returns {Promise<{name: string, ok: boolean, ms: number, detail: string}>}
 */
async function probeStdioServer(name, cfg) {
  const started = Date.now();
  return await new Promise((resolve) => {
    let child;
    try {
      child = spawn(cfg.command, cfg.args ?? [], { stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      return resolve({ name, ok: false, ms: 0, detail: `无法启动：${String(e?.message ?? e)}` });
    }
    let out = "";
    let err = "";
    let settle = null;
    const done = (ok, detail) => { if (!settle) { settle = true; try { child.kill("SIGTERM"); } catch { /* 已退出 */ } resolve({ name, ok, ms: Date.now() - started, detail }); } };
    const timer = setTimeout(() => done(false, `20s 内没有完成握手（stderr 尾：${err.trim().slice(-200) || "（空）"}）`), 20000);
    child.on("error", (e) => { clearTimeout(timer); done(false, `启动失败：${String(e?.message ?? e)}`); });
    child.on("exit", (code) => { clearTimeout(timer); done(false, `握手前退出（退出码 ${code}；stderr 尾：${err.trim().slice(-200) || "（空）"}）`); });
    child.stderr.on("data", (d) => { err += String(d); });
    child.stdout.on("data", (d) => {
      out += String(d);
      for (const line of out.split("\n")) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id === 1 && msg.result) {
            // 握手成功（initialize 有回）⇒ 再问一次 tools/list，确认它真能列工具
            child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
          }
          if (msg.id === 2 && msg.result) { clearTimeout(timer); done(true, `握手成功，列出 ${(msg.result.tools ?? []).length} 个工具`); }
          if (msg.error) { clearTimeout(timer); done(false, `协议错误：${JSON.stringify(msg.error).slice(0, 160)}`); }
        } catch { /* 非 JSON 行（日志等）忽略 */ }
      }
    });
    try {
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "agent-base-doctor", version: "0" } } }) + "\n");
    } catch (e) { clearTimeout(timer); done(false, `写入握手请求失败：${String(e?.message ?? e)}`); }
  });
}
