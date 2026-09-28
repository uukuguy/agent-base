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
import { EXIT_CODES, digestDirectory, parseArgs } from "../core/gates/index.mjs";
import { localPlatformEnv } from "../core/image/platform-env.mjs";

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
  // 渲染输入判据**与渲染器共用一份实现**（各写一份路径列表 = 迟早漂移，且失败时不报错）
  const { renderInputsDigest } = await import(path.join(REPO, `adapters/${harness}/render-inputs.mjs`));

  // ① 渲染（或复用）
  const renderDir = path.resolve(values["--render-dir"] ?? path.join(REPO, "dist", harness, path.basename(path.resolve(agentDir))));
  const manifestFile = path.join(renderDir, "render-manifest.json");
  // **新鲜度**：产物存在不等于它是当前输入渲出来的。
  // 判据是**渲染输入摘要**（定义 + 基座 seed + 渲染器 + 目录表），不是只比定义摘要：
  //   只比定义 ⇒ "基座变了、定义没动"时旧产物被复用 ⇒ **改了却没生效**。
  //   （本轮真踩中：新增基座扩展后，示例目录里的旧产物照旧复用，交互会话里根本没有那条命令。）
  // 旧产物没有这个字段（旧版本渲的）⇒ 一律按旧产物处理，重新渲染。
  let stale = false;
  // 摘要计算故意放在 try 之外：**代码写错要当场炸**，不许被 catch 伪装成"旧产物清单读不出来"
  // （曾经就是这样：漏了一个 import，结果报"清单坏了" —— 排查成本比直接崩高得多）。
  const currentDigest = digestDirectory(path.resolve(agentDir));
  const currentInputs = renderInputsDigest(path.resolve(agentDir));
  if (fs.existsSync(manifestFile)) {
    try {
      const prev = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
      if (!prev.renderInputsDigest) {
        stale = true;
        process.stderr.write("▶ 旧产物没有记录渲染输入摘要（更早版本渲的）⇒ 重新渲染，不用旧产物\n");
      } else if (prev.renderInputsDigest !== currentInputs) {
        stale = true;
        process.stderr.write(
          prev.definitionDigest && prev.definitionDigest !== currentDigest
            ? `▶ 定义已变（${currentDigest.slice(0, 19)}… ≠ 产物的 ${String(prev.definitionDigest).slice(0, 19)}…）⇒ 重新渲染，不用旧产物\n`
            : "▶ **基座变了、定义没变**（seed 扩展 / 渲染器 / 目录表）⇒ 也重新渲染 —— 否则就是「我改了却没生效」\n");
      }
    } catch (e) {
      stale = true;
      process.stderr.write(`▶ 旧产物清单解析失败（${e.message}）⇒ 重新渲染\n`);
    }
  }
  if (!fs.existsSync(manifestFile) || stale) {
    process.stderr.write(`▶ 先渲染：${path.relative(REPO, renderDir)}\n`);
    // **agentDir 必须绝对化**：子进程的 cwd 是仓库目录，把调用方的 `.` 原样传过去，
    // 渲染器就会把仓库当智能体目录 —— 表现为一句没有上下文的"渲染失败"。
    // （同一类 bug 在本轮出现过两次：相对路径跨 cwd 边界。任何转发出去的路径都先 resolve。）
    const r = spawnSync(process.execPath, [path.join(REPO, `adapters/${harness}/render.mjs`), path.resolve(agentDir), "--out", renderDir], { cwd: REPO });
    if (r.status !== 0) {
      process.stderr.write("❌ 渲染失败\n");
      const detail = `${r.stdout ?? ""}\n${r.stderr ?? ""}`.trim();
      if (detail) process.stderr.write(detail.split("\n").slice(-8).join("\n") + "\n");
      process.exit(EXIT_CODES.crash);
    }
  }

  // ② 暂存可写副本 + 临时 HOME（P-b 文件系统隔离）
  // 产物清单：运行期参数契约与运行期布局契约都从这里读（唯一来源）。
  // **必须在解析端点之前读**：端点的引用名就是从这份契约里取的。
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));

  // 端点来源：`--endpoint` > 环境里的 `<路由前缀>_BASE_URL` > 报错。
  //
  // **不能默默用死端口兜底**：早前默认 `http://127.0.0.1:9/v1`，于是用户明明设了
  // `DEEPSEEK_BASE_URL=https://api.deepseek.com`，run-local 又把它覆盖成死端口 ——
  // 表现为"我配了却连不上"，正是本项目一直在治的那类静默覆盖。
  const endpointParamName = (manifest.runtimeParams ?? []).find((x) => x.backs === "model.provider" && !x.secret)?.name;
  const fromEnvEndpoint = endpointParamName ? process.env[endpointParamName] : null;
  const explicitEndpoint = values["--endpoint"] ?? process.env.AGENT_ENDPOINT ?? null;
  // 产物里可能**自带端点默认值**（例如本地模型 provider: ollama → http://localhost:11434/v1）。
  // 不回退到它，就会出现"产物声明了默认端点、run-local 却说你没给端点"的自相矛盾。
  const fromManifestDefault = (manifest.runtimeParams ?? [])
    .find((x) => x.backs === "model.provider" && !x.secret && typeof x.default === "string")?.default ?? null;
  const endpoint = explicitEndpoint ?? fromEnvEndpoint ?? fromManifestDefault;
  const endpointSource = explicitEndpoint ? "--endpoint"
    : fromEnvEndpoint ? endpointParamName
    : fromManifestDefault ? "产物默认值" : null;
  if (!endpoint) {
    process.stderr.write(
      "❌ 未提供模型端点 —— 本地运行需要它（探针/冒烟才会用自带假网关，真实运行不会替你编一个）。\n" +
      `   给法：① make run-local --endpoint https://your-endpoint/v1\n` +
      `         ② 环境变量 ${endpointParamName ?? "<供应商前缀>_BASE_URL"}=https://your-endpoint/v1\n` +
      `         ③ 或用 --secrets-dir / ${endpointParamName ?? "<供应商前缀>_BASE_URL"}_FILE 指到文件\n` +
      `   （产物里若自带端点默认值，会自动用它 —— 本地模型 provider 就是这样）\n`);
    process.exit(EXIT_CODES.usage);
  }
  // 手工运行的便利开关：直接映射到**产物声明的**运行期参数（不猜名字、不硬编码引用名）。
  // 为什么需要：实际环境很杂 —— 有人在机器上手工跑、有人在 CI 里跑、有人包在编排里。
  // 手工跑的人不该被迫去记 `CORP_GATEWAY_API_KEY` 这种由路由名推导出来的名字。
  const extraEnv = {};
  {
    const params = manifest.runtimeParams ?? [];
    // 模型组字段的 backs 有新旧两个名字（model.provider / model.route），两边都要认
    const isModelGroup = (x) => x.backs === "model.provider" || x.backs === "model.route";
    const endpointParam = params.find((x) => isModelGroup(x) && !x.secret);
    const secretParam = params.find((x) => x.secret === true);
    const modelParam = params.find((x) => x.validate === "in-provider-models");
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
  const { staging, placeholders, env: layoutEnv, runDir: stagedRunDir } = stageRenderDir(renderDir, endpoint,
    { zeroCredential, env: extraEnv, harnessHome: values["--harness-home"] ?? process.env.AGENT_HARNESS_HOME ?? null });
  const home = values["--keep-home"]
    ? fs.mkdtempSync(path.join(os.tmpdir(), "agent-local-home-"))
    : fs.mkdtempSync(path.join(os.tmpdir(), "agent-local-home-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agent-local-cwd-"));
  const traceDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-local-trace-"));
  const traceFile = path.join(traceDir, "trace.jsonl");

  const env = {
    ...process.env,
    // ── 运行期**布局契约**：来自 startup 的 `runtimePlan.env`（哪个变量指向运行目录里的哪个相对路径）。
    //    这里**不再手搓**（曾经手搓 ⇒ 与容器入口漂移 ⇒ "容器里能用、本地不能用"）。
    ...layoutEnv,
    // ── 平台级变量：与容器入口同一套（单一定义在 core/image/platform-env.mjs）。
    //    其中 `AGENT_ARTIFACT_DIR` 是**产物根**：渲染清单在那里，而暂存副本里没有 ——
    //    少了它，会话内 `/project`、任何"读清单"的能力都会失败（实测踩中）。
    ...localPlatformEnv({ renderDir, runDir: stagedRunDir ?? path.dirname(staging), definitionDir: agentDir }),
    // ── 本地的人机工程（只在本机有意义）
    HOME: home,
    AGENT_NAME: manifest.agent ?? null,
    AGENT_RUN_MODE: "local",
    AGENT_TRACE_CONTENT: process.env.AGENT_TRACE_CONTENT ?? "full",   // 本地看细节，默认留全文
    AGENT_EFFECTIVE_CONFIG_DIGEST: digestOfRender(renderDir),
    AGENT_TRACE_DEST: traceFile,
    ...(manifest.modelProviders?.[0] ? { AGENT_MODEL_ROUTE: manifest.modelProviders[0] } : {}),
  };

  const { bin, args } = localInvocation({
    staging,
    prompt: values["--prompt"] ?? null,
    // 工具边界等运行参数：**唯一真源是产物清单**（本地与容器两条路径都按它执行，见 D6）
    prependArgs: JSON.parse(fs.readFileSync(path.join(renderDir, "render-manifest.json"), "utf8")).runtimePlan?.prependArgs ?? [],
  });

  process.stderr.write([
    "── 本地运行 ──",
    `  智能体      ${manifest.agent ?? path.basename(path.resolve(agentDir))}`,
    `  运行时      ${harness}（${bin}）`,
    `  制品        ${path.relative(REPO, renderDir)}`,
    `  暂存副本    ${staging}`,
    `  HOME        ${home}   ← 临时目录，隔离隐式技能源`,
    `  模型端点    ${endpoint}（来源 ${endpointSource}）${placeholders.length ? `（${placeholders.length} 个参数用定义默认值：${placeholders.join(", ")}）` : ""}`,
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
    // ⚠️ 这句话必须是**用户所在目录里真能跑**的命令。早期版本写 `node tools/trace-view/labels.mjs`，
    // 在基座里能跑、在**派生出来的智能体目录**里是 MODULE_NOT_FOUND（业务方按提示照做会撞墙）——
    // 本轮业务方走查抓到的第一个摩擦点。给两个都能用的：基座绝对路径 + 派生目录里的 make 目标。
    // ⚠️ 必须带上 `AGENT_DIR` 参数（这是必填位）。第一版漏了 ⇒ 复走时命令照旧跑不起来：
    // "修一半"比不修更坏，因为它看起来像修好了。
    process.stderr.write(`   看轨迹：node ${path.join(HERE, "trace-view/labels.mjs")} ${path.resolve(agentDir)} --timeline ${traceFile}\n`);
    process.stderr.write(`   （在派生目录里也可以：make trace-view TRACE=${traceFile}）\n`);
  }
  process.exit(code === 0 ? EXIT_CODES.ok : code >= 128 ? EXIT_CODES.crash : code);
};

await main();
