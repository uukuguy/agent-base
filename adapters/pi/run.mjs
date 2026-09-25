// ============================================================================
// 运行器（适配器侧）：把一次"真跑"封装成可复用的函数，供 probe / smoke / verify 与自检共用。
//
// 为什么单独一层：闸门 3/4 都要"把智能体跑起来"，而**跑起来的方式**是 harness 专有的
// （运行期契约、参数渲染、技能隔离、轨迹收集）。把这层收在一处，好处有三：
//   ① 三个消费者拿到的是同一种结果形状，verify 能把四道闸门串起来；
//   ② 运行期契约只有一处实现，改一次全都受益（避免"probe 能跑、smoke 跑不起来"）；
//   ③ 自检可以直接复用，不必再造一份"测试专用启动方式"（那种东西最容易与真实路径漂移）。
//
// 契约全部来自实测（见 adapter.yaml 的 runtime 段）：
//   PI_CODING_AGENT_DIR 指向暂存副本 · HOME 与 cwd 中立化 · --no-skills --skill <声明目录>
//   · PI_OFFLINE=1 · 关掉 stdin（否则子进程会等输入，看起来像"启动了但什么都不做"）
// ============================================================================

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { computeEffectiveConfigDigest } from "../../core/gates/index.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HARNESS = "pi";

/** §2.3 的引用名约定：大写 + 非字母数字 → 下划线。 */
function envPrefixFor(route) {
  return String(route).toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

/**
 * 把渲染产物暂存成可写副本，并在启动期把 models.json.tmpl 渲染成实际配置。
 * 这一步**不是可选的**：该 harness 的 baseUrl 不做环境插值（实测 + 上游文档）。
 * @returns {{staging: string, placeholders: string[]}}
 */
export function stageRenderDir(renderDir, endpoint) {
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "agent-run-"));
  fs.cpSync(path.join(renderDir, "agent-dir"), staging, { recursive: true });

  const tmplFile = path.join(staging, "models.json.tmpl");
  if (!fs.existsSync(tmplFile)) throw new Error("渲染产物里没有 models.json.tmpl");
  const placeholders = [];
  const out = fs.readFileSync(tmplFile, "utf8").replace(/\$\{([A-Z_][A-Z0-9_]*)\}|\$([A-Z_][A-Z0-9_]*)/g, (_m, a, b) => {
    const name = a ?? b;
    const v = process.env[name];
    if (v) return v;
    placeholders.push(name);
    if (name.endsWith("_BASE_URL")) return endpoint;
    return "placeholder-not-a-credential"; // 零凭据：探针不需要真密钥
  });
  fs.writeFileSync(path.join(staging, "models.json"), out);
  return { staging, placeholders };
}

/** 从渲染清单算出 §6.7 的 effectiveConfigDigest（轨迹每条事件都要带它）。 */
export function digestOfRender(renderDir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(renderDir, "render-manifest.json"), "utf8"));
  const adapter = YAML.parse(fs.readFileSync(path.join(HERE, "adapter.yaml"), "utf8"));
  return computeEffectiveConfigDigest({
    harnessVersion: manifest.harnessVersion,
    adapterVersion: adapter.adapterVersion,
    artifactsDigest: manifest.artifactsDigest,
    paramNames: manifest.paramNames ?? [],
  });
}

/**
 * 真跑一次。
 * @param {object} opts
 * @param {string} opts.renderDir   渲染产物目录
 * @param {string} opts.endpoint    模型端点（闸门 3/4 默认指向零凭据假网关）
 * @param {string} [opts.prompt]    一次性任务
 * @param {number} [opts.timeoutMs]
 * @param {string} [opts.runMode]
 * @param {boolean} [opts.trace]    是否收集统一轨迹（默认是）
 * @returns {Promise<{exitCode:number|string, stdout:string, stderr:string, events:object[], staging:string, placeholders:string[]}>}
 */
export async function runAgent({
  renderDir,
  endpoint,
  prompt = "hi",
  timeoutMs = 20000,
  runMode = "oneshot",
  contentMode = "digest",
  trace = true,
}) {
  const { staging, placeholders } = stageRenderDir(renderDir, endpoint);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-home-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agent-cwd-"));
  const traceFile = trace ? path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agent-trace-")), "trace.jsonl") : null;

  const manifest = JSON.parse(fs.readFileSync(path.join(renderDir, "render-manifest.json"), "utf8"));
  const env = {
    ...process.env,
    HOME: home,
    PI_CODING_AGENT_DIR: staging,
    PI_OFFLINE: "1",
    AGENT_NAME: manifest.agent ?? null,
    AGENT_RUN_MODE: runMode,
    AGENT_TRACE_CONTENT: contentMode,
    AGENT_EFFECTIVE_CONFIG_DIGEST: digestOfRender(renderDir),
    ...(manifest.modelRoutes?.[0] ? { AGENT_MODEL_ROUTE: manifest.modelRoutes[0] } : {}),
    ...(traceFile ? { AGENT_TRACE_DEST: traceFile } : {}),
  };

  const args = ["--mode", "json", "-p", prompt, "--no-skills"];
  const skills = path.join(staging, "skills");
  if (fs.existsSync(skills)) args.push("--skill", skills);
  for (const t of manifest.runArgs?.excludeTools ?? []) args.push("--exclude-tools", t);

  const child = spawn("pi", args, { env, cwd });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => { stdout += d; });
  child.stderr.on("data", (d) => { stderr += d; });
  try { child.stdin.end(); } catch { /* 已关闭 */ }

  const exited = await Promise.race([
    new Promise((res) => child.on("close", (code) => res(code))),
    new Promise((res) => child.on("error", (e) => res(`spawn-error:${e.message}`))),
    new Promise((res) => setTimeout(() => res("timeout"), timeoutMs)),
  ]);
  if (exited === "timeout") {
    child.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 400));
  }

  let events = [];
  if (traceFile && fs.existsSync(traceFile)) {
    events = fs.readFileSync(traceFile, "utf8").split("\n").filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  }
  return { exitCode: exited, stdout, stderr, events, staging, placeholders };
}

/**
 * 零凭据自证：跑一次 RPC 会话，收指定命令的响应。
 * 注意：RPC 模式也会吐 session 事件，所以只认 `type === "response"` 的记录。
 * 放在这里而不是各个消费者里，是为了**probe 与 doctor 用同一种观测方式** ——
 * 两处各写一份 RPC 客户端，迟早会出现"doctor 说加载了、probe 说没加载"的分裂。
 */
export function piRpc({ env, cwd, staging, requests, timeoutMs = 20000 }) {
  return new Promise((resolve) => {
    const args = ["--mode", "rpc", "--no-session", "--no-skills"];
    const skills = path.join(staging, "skills");
    if (fs.existsSync(skills)) args.push("--skill", skills);

    const proc = spawn("pi", args, { env, cwd, stdio: ["pipe", "pipe", "pipe"] });
    const responses = new Map();
    let stderr = "";
    let buf = "";
    const want = new Set(requests.map((r) => r.type));
    const done = () => {
      try { proc.kill("SIGKILL"); } catch { /* 已退出 */ }
      resolve({ responses, stderr, complete: [...want].every((t) => responses.has(t)) });
    };
    const timer = setTimeout(done, timeoutMs);
    proc.stdout.on("data", (d) => {
      buf += d;
      let i;
      // 严格按 LF 切分：不要用 readline（它会误认 U+2028/U+2029，上游明确警告）
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, "");
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        try {
          const rec = JSON.parse(line);
          if (rec.type === "response" && rec.command) responses.set(rec.command, rec);
        } catch { /* 非 JSON 行忽略 */ }
      }
      if ([...want].every((t) => responses.has(t))) { clearTimeout(timer); done(); }
    });
    proc.stderr.on("data", (d) => { stderr += d; });
    proc.on("error", (e) => { clearTimeout(timer); resolve({ responses, stderr: String(e), complete: false }); });
    proc.on("close", () => { clearTimeout(timer); resolve({ responses, stderr, complete: [...want].every((t) => responses.has(t)) }); });
    for (const r of requests) proc.stdin.write(JSON.stringify(r) + "\n");
  });
}

/** 取一次 `--version`（零凭据）。 */
export function probeVersion(bin = "pi") {
  return new Promise((resolve) => {
    const p = spawn(bin, ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    p.stdout.on("data", (d) => { out += d; });
    p.on("error", () => resolve(null));
    p.on("close", () => resolve(out.trim().split("\n")[0] || null));
  });
}

/** 观测"实际加载了什么"：返回 doctor 与 probe 共用的那组事实。 */
export async function observeLoaded(renderDir, { timeoutMs = 20000 } = {}) {
  const { staging } = stageRenderDir(renderDir, "http://127.0.0.1:9/v1"); // 端点无关紧要：RPC 不发模型请求
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-obshome-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agent-obscwd-"));
  const env = { ...process.env, HOME: home, PI_CODING_AGENT_DIR: staging, PI_OFFLINE: "1" };
  const rpc = await piRpc({ env, cwd, staging, requests: [{ id: "o1", type: "get_state" }, { id: "o2", type: "get_commands" }], timeoutMs });
  const commands = rpc.responses.get("get_commands")?.data?.commands ?? [];
  return {
    complete: rpc.complete,
    stderr: rpc.stderr,
    staging,
    state: rpc.responses.get("get_state")?.data ?? {},
    skills: commands.filter((c) => c.source === "skill").map((c) => String(c.name).replace(/^skill:/, "")).sort(),
    commands,
  };
}

export const HARNESS_ID = HARNESS;
