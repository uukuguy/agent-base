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
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { computeEffectiveConfigDigest } from "../../core/gates/index.mjs";
import { mapEventStream } from "./trace.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HARNESS = "dsh";

const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));

/** 端点/凭据等参数名（渲染产物里记着它们，运行期就靠这些名字注入真值）。 */
const routeParams = (manifest) => {
  const p = [];
  if (manifest.modelRouteBaseUrlParam) p.push(manifest.modelRouteBaseUrlParam);
  if (manifest.modelRouteCredentialParam) p.push(manifest.modelRouteCredentialParam);
  return p;
};

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
 * 暂存一份可运行副本：拷 dsh-home / workspace / skills，并把**镜像内固定路径**改写成本地路径。
 * @returns {{staging: string, workspace: string, dshHome: string, placeholders: string[]}}
 */
export function stageRenderDir(renderDir) {
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-run-"));
  const dshHome = path.join(staging, "dsh-home");
  const workspace = path.join(staging, "workspace");
  const skills = path.join(staging, "skills");

  fs.cpSync(path.join(renderDir, "dsh-home"), dshHome, { recursive: true });
  fs.cpSync(path.join(renderDir, "workspace"), workspace, { recursive: true });
  if (fs.existsSync(path.join(renderDir, "skills"))) fs.cpSync(path.join(renderDir, "skills"), skills, { recursive: true });

  // 把产物里的镜像内路径改写为暂存路径（只动副本）
  const manifest = readJson(path.join(renderDir, "render-manifest.json"));
  const pairs = [
    [manifest.skillsInImage, skills],
    [manifest.workspaceInImage, workspace],
    [manifest.dshHomeInImage, dshHome],
  ].filter(([from, to]) => from && to);
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) { walk(f); continue; }
      let text = fs.readFileSync(f, "utf8");
      const before = text;
      for (const [from, to] of pairs) text = text.split(from).join(to);
      if (text !== before) fs.writeFileSync(f, text);
    }
  };
  walk(dshHome);

  const placeholders = [];
  if (!process.env[manifest.modelRouteBaseUrlParam]) placeholders.push(manifest.modelRouteBaseUrlParam);
  if (!process.env[manifest.modelRouteCredentialParam]) placeholders.push(manifest.modelRouteCredentialParam);
  return { staging, workspace, dshHome, placeholders };
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
export async function runAgent({ renderDir, endpoint, prompt = "hi", timeoutMs = 60000 }) {
  const manifest = readJson(path.join(renderDir, "render-manifest.json"));
  const { staging, workspace, dshHome, placeholders } = stageRenderDir(renderDir);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-home-"));
  const env = envFor({ manifest, dshHome, endpoint, home });

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
