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
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { computeEffectiveConfigDigest } from "../../core/gates/index.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** 启动期准备脚本：宿主侧与容器内**共用同一份**暂存/渲染实现。 */
const STARTUP = path.join(HERE, "../../core/image/startup.mjs");
const HARNESS = "pi";

/** §2.3 的引用名约定：大写 + 非字母数字 → 下划线。 */
function envPrefixFor(route) {
  return String(route).toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

/**
 * 把渲染产物暂存成可写副本，并在启动期把参数渲染成实际配置。
 *
 * **委托给 `core/image/startup.mjs`**（而不是在这里另写一份）：
 * 容器里跑的正是那个脚本 —— 宿主侧的探针/冒烟/本地运行必须与容器走**同一条**暂存与渲染路径，
 * 否则"测试通过"与"容器里能跑"是两件事（这正是之前踩过的坑：容器里配不了 LLM，而宿主侧全绿）。
 *
 * @returns {{staging: string, placeholders: string[]}}
 */
export function stageRenderDir(renderDir, endpoint, { zeroCredential = false, env: extraEnv = {}, harnessHome = null } = {}) {
  // 登录态目录：订阅型 provider 的凭据在运行时自己的目录里，必须**显式**带进来（产物不动）
  // 登录态目录：显式给了就用；没给而产物用的是**订阅型** provider（auth: native）时，
  // 自动落到本运行时自己的默认目录（"环境里登录一次就能用"——用户的原话）。
  // 容器里 HOME 不是宿主的，自然找不到 ⇒ 会明确报错要求挂载，不会静默失败。
  const manifestAuth = (() => {
    try { return JSON.parse(fs.readFileSync(path.join(renderDir, "render-manifest.json"), "utf8")).modelProviderAuth ?? null; } catch { return null; }
  })();
  const defaultHome = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
  const home = harnessHome ?? extraEnv.AGENT_HARNESS_HOME ?? process.env.AGENT_HARNESS_HOME
    ?? (manifestAuth === "native" ? defaultHome : null);
  const manifest = JSON.parse(fs.readFileSync(path.join(renderDir, "render-manifest.json"), "utf8"));
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-run-"));

  // 端点由调用方给（探针/冒烟指向零凭据假网关）；其余参数走环境变量或清单里的默认值
  const env = { ...process.env, ...extraEnv };
  const endpointParam = (manifest.runtimeParams ?? []).find((p) => p.backs === "model.provider" && !p.secret);
  if (endpoint && endpointParam) env[endpointParam.name] = endpoint;

  // **零凭据模式**（自证 / 探针 / 冒烟）：用假值把必填项补齐，使这些检查不需要任何真密钥。
  // 必须是**显式**的：真实运行（run-local）不许静默用占位凭据 —— 那会跑出一个"看起来正常、
  // 其实连不上"的结果，正是本项目一直在治的那种静默失败。
  if (zeroCredential) {
    for (const p of manifest.runtimeParams ?? []) {
      if (env[p.name]) continue;
      if (p.secret) env[p.name] = "placeholder-not-a-credential";
      else if (p.required && p.backs === "model.provider" && !env[p.name]) env[p.name] = "http://127.0.0.1:9/v1";
    }
  }

  const r = spawnSync(process.execPath, [STARTUP, "prepare", "--artifact", renderDir, "--run-dir", runDir, "--json"],
    { encoding: "utf8", env });
  if (r.status !== 0) throw new Error(`启动期准备失败（退出码 ${r.status}）：\n${(r.stderr ?? "").trim()}`);
  const prep = JSON.parse(r.stdout);

  // staging = 本运行时实际读取配置的那个目录（由产物的运行期布局契约决定，不在这里猜）
  const stagingRel = Object.values(prep.env ?? {})[0];
  const staging = stagingRel ?? runDir;

  // 把登录态文件带进暂存副本（**只在这个显式前提下**：产物是只读的，凭据永远不写进产物）
  if (home) {
    const credentialFile = ADAPTER_CREDENTIAL_FILE;   // 由适配器声明；没有就是不支持带登录态
    const src = credentialFile ? path.join(home, credentialFile) : null;
    if (!src) {
      throw new Error(`${HARNESS_NAME} 未声明 credentialFile，无法从 AGENT_HARNESS_HOME 带登录态`);
    }
    if (!fs.existsSync(src)) {
      throw new Error(`AGENT_HARNESS_HOME=${home} 里没有 ${credentialFile} —— 请先在该目录登录一次`);
    }
    if (staging !== runDir && fs.existsSync(staging)) {
      fs.copyFileSync(src, path.join(staging, credentialFile));
    }
  }
  const placeholders = Object.entries(prep.params ?? {})
    .filter(([, v]) => v.source === "definition-default")
    .map(([k]) => k);

  // 连接器扩展包：产物里写的是**镜像内固定路径**。本地运行时用 AGENT_MCP_ADAPTER_PATH 指向本地安装，
  // 我们把它改写进暂存副本的 settings.json（**只改副本**）。
  // 若产物声明了该包、本地却没给路径 ⇒ **响亮失败**，不静默产出一个"没有 MCP 客户端"的运行
  // （那正是 failures.md F10 要防的静默忽略）。
  const inImage = manifest.mcpAdapterInImage;
  const settingsFile = path.join(staging, "settings.json");
  if (inImage && fs.existsSync(settingsFile)) {
    const text = fs.readFileSync(settingsFile, "utf8");
    if (text.includes(inImage)) {
      // 默认值：开发机上 `make dev-env` 会把预装清单里的包装进 <repo>/.local-packages，
      // 于是本地跑带连接器的智能体**不需要手设任何环境变量**（"快"= 心智负担低）。
      const localDefault = path.join(HERE, "../../.local-packages/node_modules/pi-mcp-adapter");
      const local = process.env.AGENT_MCP_ADAPTER_PATH ?? (fs.existsSync(localDefault) ? localDefault : null);
      if (!local) {
        throw new Error(
          `产物声明了 MCP 客户端扩展（${inImage}），但本地运行未提供 AGENT_MCP_ADAPTER_PATH —— ` +
          "不给的话会跑出一个**没有 MCP 客户端**的智能体而无人察觉。请指向本地安装路径。");
      }
      fs.writeFileSync(settingsFile, text.split(inImage).join(local));
    }
  }

  // 运行期布局契约（`runtimePlan.env`：哪个变量指向运行目录里的哪个相对路径）**原样带出去**，
  // 让调用方用它而不是自己拼 —— 早先这里只取 `Object.values(prep.env)[0]` 找 staging，
  // 其余契约被丢掉，于是 run-local 只能手搓一份，漏了平台变量（见 core/image/platform-env.mjs 的注释）。
  return { staging, placeholders, env: prep.env ?? {}, runDir: prep.runDir ?? null };
}

/** 从渲染清单算出 §6.7 的 effectiveConfigDigest（轨迹每条事件都要带它）。 */
export function digestOfRender(renderDir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(renderDir, "render-manifest.json"), "utf8"));
  const adapter = YAML.parse(fs.readFileSync(path.join(HERE, "adapter.yaml"), "utf8"));
  return computeEffectiveConfigDigest({
    harnessVersion: manifest.harnessVersion,
    adapterVersion: adapter.adapterVersion,
    artifactsDigest: manifest.artifactsDigest,
    // 参数名只从**清单的运行期参数契约**取 —— 早期这里读的是两个零散字段（只有端点与凭据），
    // 加上模型名之后立刻与渲染器算出的摘要不一致：同一个摘要两份实现，必漂移。
    paramNames: (manifest.runtimeParams ?? []).map((p) => p.name),
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
  // 零凭据模式：闸门 3/4（探针/冒烟）用假凭据跑，不需要任何真密钥。
  // 默认 **false**：真实运行不许静默用占位凭据（那会跑出"看起来正常、其实连不上"的结果）。
  zeroCredential = false,
  env: extraEnv = {},
}) {
  const { staging, placeholders } = stageRenderDir(renderDir, endpoint, { zeroCredential, env: extraEnv });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-home-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agent-cwd-"));
  const traceFile = trace ? path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agent-trace-")), "trace.jsonl") : null;

  const manifest = JSON.parse(fs.readFileSync(path.join(renderDir, "render-manifest.json"), "utf8"));
  const env = {
    ...process.env,
    ...extraEnv,          // 调用方注入的运行期参数（本地便利开关等）
    ...localBinPathEnv(),
    HOME: home,
    PI_CODING_AGENT_DIR: staging,
    PI_OFFLINE: "1",
    AGENT_NAME: manifest.agent ?? null,
    AGENT_RUN_MODE: runMode,
    AGENT_TRACE_CONTENT: contentMode,
    AGENT_EFFECTIVE_CONFIG_DIGEST: digestOfRender(renderDir),
    ...(manifest.modelProviders?.[0] ? { AGENT_MODEL_ROUTE: manifest.modelProviders[0] } : {}),
    ...(traceFile ? { AGENT_TRACE_DEST: traceFile } : {}),
  };

  const args = ["--mode", "json", "-p", prompt, "--no-skills"];
  const skills = path.join(staging, "skills");
  if (fs.existsSync(skills)) args.push("--skill", skills);
  // 工具边界：**声明在产物清单里**（runtimePlan.prependArgs），两条启动路径都按同一份执行 ——
  // 容器由 startup 拼装，本地由这里拼装。规则只有一份（清单），
  // 避免"本机生效、容器不生效"（D6 的真问题）或反过来。
  args.push(...(manifest.runtimePlan?.prependArgs ?? []));

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

/**
 * 本地已装的预装包（`make dev-env` 装到 `<repo>/.local-packages`）的 `.bin` 进 PATH。
 *
 * 为什么需要：连接器的 stdio 服务器以 `npx -y <包>@<版本>` 启动。本地装过之后 npx 才能解析到它，
 * 于是本地验证也不需要出网 —— 与镜像内"构建期装齐、运行期断网"是同一个道理。
 */
function localBinPathEnv() {
  const bin = path.join(HERE, "../../.local-packages/node_modules/.bin");
  if (!fs.existsSync(bin)) return {};
  return { PATH: [bin, process.env.PATH].filter(Boolean).join(":") };
}

/** 观测"实际加载了什么"：返回 doctor 与 probe 共用的那组事实。 */
export async function observeLoaded(renderDir, { timeoutMs = 20000 } = {}) {
  const { staging } = stageRenderDir(renderDir, "http://127.0.0.1:9/v1"); // 端点无关紧要：RPC 不发模型请求
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-obshome-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agent-obscwd-"));
  const env = { ...process.env, HOME: home, PI_CODING_AGENT_DIR: staging, PI_OFFLINE: "1", ...localBinPathEnv() };
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

/**
 * 本地交互/一次性调用的启动方式（harness 专有 —— 参数形态归这里，不归基座工具）。
 * 与 probe/smoke 用的 runAgent 共用同一套运行期契约（暂存可写副本 + 中立 HOME/cwd + 关 stdin）。
 */
export function localInvocation({ staging, prompt, prependArgs = [] }) {
  const args = ["--no-skills"];
  const skills = path.join(staging, "skills");
  if (fs.existsSync(skills)) args.push("--skill", skills);
  // 工具边界等"产物声明的运行参数"由**调用方从清单里取**传进来（这里拿不到清单，只有暂存目录）。
  args.push(...prependArgs);
  if (prompt) args.push("-p", prompt);
  return { bin: "pi", args };
}

export const HARNESS_ID = HARNESS;

// 本适配器声明的凭据文件名与运行时名（给"带登录态进暂存副本"用；没有就为 null）
const _adapterYaml = (() => {
  try {
    return YAML.parse(fs.readFileSync(path.join(HERE, "adapter.yaml"), "utf8"));
  } catch { return {}; }
})();
const ADAPTER_CREDENTIAL_FILE = _adapterYaml.credentialFile ?? null;
const HARNESS_NAME = _adapterYaml.harness ?? "pi";
