// ============================================================================
// dsh 运行器：把一次"真跑"封装成可复用的函数（probe / smoke / run-local / 自检共用）
//
// 与 pi 的 run.mjs 同形（同一组导出），这样上层的 probe/smoke/run-local 不必知道是哪个 harness。
//
// ## 三条实测确定的运行期契约
//
// ① **端点靠环境变量注入**（`<PREFIX>_BASE_URL` / `<PREFIX>_API_KEY`）—— 参数下放。
//    渲染出的 profile 里只写 `!!js process.env.<引用名>`，真值由这里给。
// ② **cwd 必须在工作区**：人设走 `agent-instructions` 的"工作区指令文件发现"，cwd 不对就读不到 AGENTS.md。
// ③ **非交互运行必须显式给放行策略**：审批在无应答者时 **fail closed**（不是报错，是等人）。
//    所以探针/冒烟这类无人值守运行要显式设 `AGENT_PERMISSION_MODE`，否则会"卡住"而不是失败 ——
//    failures.md D4 记的就是这个。
//
// ## 镜像内固定路径 → 暂存路径的改写
//
// 产物里写的是**镜像内**固定路径（`/opt/agent-base/skills`、`/workspace`）。本地运行没有那些路径，
// 所以在**暂存副本**上改写成暂存路径 —— 这是"渲染期路径与运行期路径解耦"的落地方式（Q2）。
// 改的只是副本，产物本身不动。
// ============================================================================

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { computeEffectiveConfigDigest } from "../../core/gates/index.mjs";
import { mapEventStream } from "./trace.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HARNESS = "dsh";
/** 启动期准备脚本：宿主侧与容器内**共用同一份**暂存实现。 */
const STARTUP = path.join(HERE, "../../core/image/startup.mjs");

const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));

/**
 * 端点/凭据/模型名等参数名 —— 只从**清单的运行期参数契约**取（唯一来源）。
 * 早期这里读的是两个零散字段（只有端点与凭据），加上模型名后立刻与渲染器算出的摘要不一致：
 * 同一个摘要两份实现，必漂移。
 */
const routeParams = (manifest) => (manifest.runtimeParams ?? []).map((p) => p.name);

/**
 * 本地已装的预装包（`make dev-env` 装到 `<repo>/.local-packages`）的 `.bin` 进 PATH。
 * 连接器的 stdio 服务器以 `npx -y <包>@<版本>` 启动；本地装过之后才能离线解析到它。
 */
function localBinPathEnv() {
  const bin = path.join(HERE, "../../.local-packages/node_modules/.bin");
  if (!fs.existsSync(bin)) return {};
  return { PATH: [bin, process.env.PATH].filter(Boolean).join(":") };
}

/** 从渲染清单算出 §6.7 的 effectiveConfigDigest。 */
export function digestOfRender(renderDir) {
  const manifest = readJson(path.join(renderDir, "render-manifest.json"));
  const adapter = YAML.parse(fs.readFileSync(path.join(HERE, "adapter.yaml"), "utf8"));
  return computeEffectiveConfigDigest({
    harnessVersion: manifest.harnessVersion,
    adapterVersion: adapter.adapterVersion,
    artifactsDigest: manifest.artifactsDigest,
    paramNames: routeParams(manifest),
  });
}

/**
 * 暂存一份可运行副本（并把产物里的**镜像内固定路径**改写成暂存路径）。
 *
 * **委托给 `core/image/startup.mjs`**（与另一个适配器同法）：容器里跑的正是那个脚本，
 * 宿主侧的探针/自检/本地运行必须与容器走**同一条**暂存路径，否则"测试通过"与"容器里能跑"是两件事。
 * 本适配器的 `rendersParams: false`（原生 `!!js` 求值）由启动脚本按清单声明自行判断，这里不必区分。
 *
 * @returns {{staging: string, workspace: string, dshHome: string, placeholders: string[]}}
 */
export function stageRenderDir(renderDir, endpoint, { zeroCredential = false, env: extraEnv = {}, harnessHome = null } = {}) {
  // 登录态目录：本适配器未声明 credentialFile（凭据不在单文件里）⇒ 给了就明确拒绝，不静默忽略
  const home = harnessHome ?? extraEnv.AGENT_HARNESS_HOME ?? process.env.AGENT_HARNESS_HOME ?? null;
  if (home && !ADAPTER_CREDENTIAL_FILE) {
    throw new Error(BaseUnsupportedHome);
  }
  const manifest = readJson(path.join(renderDir, "render-manifest.json"));
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-run-"));

  const env = { ...process.env, ...extraEnv };
  const endpointParam = (manifest.runtimeParams ?? []).find((x) => x.backs === "model.provider" && !x.secret);
  if (endpoint && endpointParam) env[endpointParam.name] = endpoint;
  // 零凭据模式（**显式开启**）：自证/探针/冒烟用假值补齐必填项；真实运行不允许
  if (zeroCredential) {
    for (const p of manifest.runtimeParams ?? []) {
      if (env[p.name]) continue;
      if (p.secret) env[p.name] = "placeholder-not-a-credential";
      else if (p.required && p.backs === "model.provider") env[p.name] = "http://127.0.0.1:9/v1";
    }
  }

  const r = spawnSync(process.execPath, [STARTUP, "prepare", "--artifact", renderDir, "--run-dir", runDir, "--json"],
    { encoding: "utf8", env });
  if (r.status !== 0) throw new Error(`启动期准备失败（退出码 ${r.status}）：\n${(r.stderr ?? "").trim()}`);
  const prep = JSON.parse(r.stdout);
  const placeholders = Object.entries(prep.params ?? [])
    .filter(([, v]) => v.source === "definition-default")
    .map(([k]) => k);

  return {
    staging: prep.runDir,
    dshHome: prep.env?.DSH_HOME ?? path.join(prep.runDir, "dsh-home"),
    workspace: prep.cwd ?? prep.runDir,
    placeholders,
    // 运行期布局契约原样带出去（调用方不该自己拼），见 core/image/platform-env.mjs
    env: prep.env ?? {},
    runDir: prep.runDir ?? null,
  };
}

/** 运行期环境：端点/凭据 + 隔离的 HOME + 显式放行策略。 */
export function envFor({ manifest, dshHome, endpoint, home, traceDest }) {
  const env = {
    ...process.env,
    ...localBinPathEnv(),
    HOME: home,
    DSH_HOME: dshHome,
    AGENT_RUN_MODE: process.env.AGENT_RUN_MODE ?? "oneshot",
    // 非交互放行策略（见文件头 ③）：不给的话审批会 fail closed 等人，表现为"卡住"
    AGENT_PERMISSION_MODE: process.env.AGENT_PERMISSION_MODE ?? "danger-full-access",
  };
  if (endpoint && manifest.modelRouteBaseUrlParam) env[manifest.modelRouteBaseUrlParam] = endpoint;
  if (manifest.modelRouteCredentialParam && !env[manifest.modelRouteCredentialParam]) {
    env[manifest.modelRouteCredentialParam] = "placeholder-not-a-credential";   // 零凭据
  }
  if (traceDest) env.AGENT_TRACE_DEST = traceDest;
  return env;
}

/** 本地交互/一次性调用的启动方式（harness 专有参数形态归这里）。 */
export function localInvocation({ profile, prompt }) {
  return { bin: "dsh", args: prompt ? [profile, "--json", prompt] : [profile] };
}

/**
 * 真跑一次。
 * @returns {Promise<{exitCode:number|string, stdout:string, stderr:string, events:object[], native:object[], staging:string, placeholders:string[]}>}
 */
export async function runAgent({ renderDir, endpoint, prompt = "hi", timeoutMs = 60000, zeroCredential = false, env: extraEnv = {}, harnessHome = null }) {
  const manifest = readJson(path.join(renderDir, "render-manifest.json"));
  const { staging, workspace, dshHome, placeholders } = stageRenderDir(renderDir, endpoint, { zeroCredential, env: extraEnv });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-home-"));
  const env = { ...envFor({ manifest, dshHome, endpoint, home }), ...extraEnv };

  const { bin, args } = localInvocation({ profile: manifest.agent, prompt });
  const child = spawn(bin, args, { env, cwd: workspace });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => { stdout += d; });
  child.stderr.on("data", (d) => { stderr += d; });
  try { child.stdin.end(); } catch { /* 已关闭 */ }

  const exited = await Promise.race([
    new Promise((res) => child.on("close", (c) => res(c))),
    new Promise((res) => child.on("error", (e) => res(`spawn-error:${e.message}`))),
    new Promise((res) => setTimeout(() => res("timeout"), timeoutMs)),
  ]);
  if (exited === "timeout") { child.kill("SIGTERM"); await new Promise((r) => setTimeout(r, 400)); }

  const native = stdout.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const { events } = mapEventStream(native, {
    run: process.env.AGENT_RUN_ID ?? `run-${Date.now()}`,
    agent: manifest.agent,
    harness: HARNESS,
    harnessVersion: manifest.harnessVersion,
    effectiveConfigDigest: digestOfRender(renderDir),
    mode: "oneshot",
    contentMode: "digest",
  });
  return { exitCode: exited, stdout, stderr, events, native, staging, workspace, placeholders };
}

export const HARNESS_ID = HARNESS;

// 本适配器声明的凭据文件名（没有 ⇒ 不支持把登录态带进暂存副本）
const _adapterYaml = (() => {
  try { return YAML.parse(fs.readFileSync(path.join(HERE, "adapter.yaml"), "utf8")); } catch { return {}; }
})();
const ADAPTER_CREDENTIAL_FILE = _adapterYaml.credentialFile ?? null;
const BaseUnsupportedHome = "本运行时未声明 credentialFile（凭据不落在单个文件里），"
  + "无法用 AGENT_HARNESS_HOME 带登录态 —— 订阅型 provider 请改用声明了它的运行时，"
  + "或把凭据以该运行时自己的方式注入。";
