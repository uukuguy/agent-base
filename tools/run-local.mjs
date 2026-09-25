#!/usr/bin/env node
// ============================================================================
// 本地运行入口（统一设计 §9.3 / §12.4）
//
// ## 它要解决什么
//
// 「在我机器上跑一下」与「在容器里跑」必须是**同一套口径**，否则本地验过的东西到容器里
// 复现不出来。所以本命令：
//
//   ① 先渲染（或复用已有产物）—— 跑的是**制品**，不是源码目录，与容器一致
//   ② 把产物暂存成**可写副本**，并把 HOME 指到临时目录 —— P-b：隔离靠文件系统
//      （该 harness 有两个隐式技能源，其中一个沿 cwd 祖先发现；不隔离干净就会"多出技能"）
//   ③ 用与 probe/smoke/自检**同一个**运行器契约起 harness
//
// 于是 `make doctor`（闸门 2）在本地与容器里得到同样的结论。
//
// ## 与容器里那条路的关系
//
//   · 本地：本命令（改完立刻跑，改一次几秒）
//   · 容器：`make debug RENDER_DIR=...`（复现"只在容器里出现"的问题——第 ④ 道调试手段）
//   两者共用同一份渲染产物与同一套环境变量契约。
//
// 用法：
//   node tools/run-local.mjs <AGENT_DIR> [--harness pi] [--prompt "..."] [--endpoint URL]
//                            [--render-dir DIR] [--keep-home]
// 退出码：0 正常结束 / 2 用法错误 / 50 启动或运行失败
// ============================================================================

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { EXIT_CODES, parseArgs } from "../core/gates/index.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");

const main = async () => {
  const { values, flags, positionals, errors } = parseArgs(process.argv.slice(2), {
    valueFlags: ["--harness", "--prompt", "--endpoint", "--render-dir", "--zero-credential", "--api-key", "--model", "--secrets-dir", "--param"],
  });
  const agentDir = positionals[0];
  if (flags.has("--help") || flags.has("-h") || !agentDir) {
    process.stderr.write("用法: node tools/run-local.mjs <AGENT_DIR> [--harness pi] [--prompt \"...\"] [--endpoint URL] [--render-dir DIR]\n");
    process.exit(flags.has("--help") || flags.has("-h") ? EXIT_CODES.ok : EXIT_CODES.usage);
  }
  if (errors.length) { process.stderr.write(errors.join("；") + "\n"); process.exit(EXIT_CODES.usage); }

  const harness = values["--harness"] ?? "pi";
  const adapterRun = path.join(REPO, `adapters/${harness}/run.mjs`);
  if (!fs.existsSync(adapterRun)) {
    process.stderr.write(`❌ ${harness} 的本地运行入口尚未实现（adapters/${harness}/run.mjs 不存在）—— 不静默改用别的 harness\n`);
    process.exit(EXIT_CODES.usage);
  }
  const { stageRenderDir, digestOfRender, localInvocation } = await import(adapterRun);

  // ① 渲染（或复用）
  const renderDir = path.resolve(values["--render-dir"] ?? path.join(REPO, "dist", harness, path.basename(path.resolve(agentDir))));
  const manifestFile = path.join(renderDir, "render-manifest.json");
  if (!fs.existsSync(manifestFile)) {
    process.stderr.write(`▶ 先渲染：${path.relative(REPO, renderDir)}\n`);
    const r = spawnSync(process.execPath, [path.join(REPO, `adapters/${harness}/render.mjs`), agentDir, "--out", renderDir], { cwd: REPO });
    if (r.status !== 0) { process.stderr.write("❌ 渲染失败\n"); process.exit(EXIT_CODES.crash); }
  }

  // ② 暂存可写副本 + 临时 HOME（P-b 文件系统隔离）
  const endpoint = values["--endpoint"] ?? process.env.AGENT_ENDPOINT ?? "http://127.0.0.1:9/v1";
  // 产物清单：运行期参数契约与运行期布局契约都从这里读（唯一来源）
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));

  // 手工运行的便利开关：直接映射到**产物声明的**运行期参数（不猜名字、不硬编码引用名）。
  // 为什么需要：实际环境很杂 —— 有人在机器上手工跑、有人在 CI 里跑、有人包在编排里。
  // 手工跑的人不该被迫去记 `CORP_GATEWAY_API_KEY` 这种由路由名推导出来的名字。
  const extraEnv = {};
  {
    const params = manifest.runtimeParams ?? [];
    const byBacks = (b, secret) => params.find((x) => x.backs === b && (secret === undefined || x.secret === secret));
    const endpointParam = byBacks("model.route", false);
    const secretParam = params.find((x) => x.secret === true);
    const modelParam = params.find((x) => x.validate === "in-route-models");
    const map = [
      ["--endpoint", endpointParam, "模型端点"],
      ["--api-key", secretParam, "凭据"],
      ["--model", modelParam, "模型名"],
    ];
    for (const [flag, param, label] of map) {
      const v = values[flag];
      if (v === undefined || v === "") continue;
      if (!param) { process.stderr.write(`❌ 该产物没有「${label}」这类运行期参数，${flag} 不适用\n`); process.exit(EXIT_CODES.usage); }
      extraEnv[param.name] = v;
    }
    if (values["--secrets-dir"]) extraEnv.AGENT_SECRETS_DIR = values["--secrets-dir"];
    // `--param NAME=VALUE`：给上面三个之外的参数用（例如某个连接器的凭据）
    if (values["--param"]) {
      const i = values["--param"].indexOf("=");
      if (i <= 0) { process.stderr.write("❌ --param 需要 NAME=VALUE 形式\n"); process.exit(EXIT_CODES.usage); }
      extraEnv[values["--param"].slice(0, i)] = values["--param"].slice(i + 1);
    }
  }

  // 零凭据：把必填项用显式占位值补齐（本地自检、或只想确认链路通的时候用）。
  // **必须是显式的**：真实运行不给这个开关 —— 免得跑出一个"看起来正常、其实连不上"的结果。
  const zeroCredential = values["--zero-credential"] === "true" || values["--zero-credential"] === "";
  const { staging, placeholders } = stageRenderDir(renderDir, endpoint, { zeroCredential, env: extraEnv });
  const home = values["--keep-home"]
    ? fs.mkdtempSync(path.join(os.tmpdir(), "agent-local-home-"))
    : fs.mkdtempSync(path.join(os.tmpdir(), "agent-local-home-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agent-local-cwd-"));
  const traceDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-local-trace-"));
  const traceFile = path.join(traceDir, "trace.jsonl");

  const env = {
    ...process.env,
    HOME: home,
    PI_CODING_AGENT_DIR: staging,
    AGENT_NAME: manifest.agent ?? null,
    AGENT_RUN_MODE: "local",
    AGENT_TRACE_CONTENT: process.env.AGENT_TRACE_CONTENT ?? "full",   // 本地看细节，默认留全文
    AGENT_EFFECTIVE_CONFIG_DIGEST: digestOfRender(renderDir),
    AGENT_TRACE_DEST: traceFile,
    ...(manifest.modelRoutes?.[0] ? { AGENT_MODEL_ROUTE: manifest.modelRoutes[0] } : {}),
  };

  const { bin, args } = localInvocation({ staging, prompt: values["--prompt"] ?? null });

  process.stderr.write([
    "── 本地运行 ──",
    `  智能体      ${manifest.agent ?? path.basename(path.resolve(agentDir))}`,
    `  运行时      ${harness}（${bin}）`,
    `  制品        ${path.relative(REPO, renderDir)}`,
    `  暂存副本    ${staging}`,
    `  HOME        ${home}   ← 临时目录，隔离隐式技能源`,
    `  模型端点    ${endpoint}${placeholders.length ? `（${placeholders.length} 个参数用占位值：${placeholders.join(", ")}）` : ""}`,
    `  轨迹        ${traceFile}`,
    `  模式        ${values["--prompt"] ? "一次性（--prompt）" : "交互（stdin 直连，退出即结束）"}`,
    "",
  ].join("\n"));

  // ③ 起 harness。交互时 stdio 直连，保持真实 TTY 行为。
  const interactive = !values["--prompt"];
  const child = spawn(bin, args, { env, cwd, stdio: interactive ? "inherit" : ["ignore", "inherit", "inherit"] });
  const code = await new Promise((res) => child.on("close", (c) => res(c)).on("error", () => res(50)));

  const events = fs.existsSync(traceFile)
    ? fs.readFileSync(traceFile, "utf8").split("\n").filter(Boolean).length
    : 0;
  process.stderr.write(`\n── 结束（退出码 ${code}）—— 轨迹 ${events} 条：${traceFile}\n`);
  if (events) {
    process.stderr.write("   看轨迹：node tools/trace-view/labels.mjs 或直接读上面的文件\n");
  }
  process.exit(code === 0 ? EXIT_CODES.ok : code >= 128 ? EXIT_CODES.crash : code);
};

await main();
