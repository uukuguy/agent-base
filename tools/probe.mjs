#!/usr/bin/env node
// ============================================================================
// 闸门 3：集成探针（统一设计 §6.4）
//
// 回答「组成部件真的可达吗」：
//   probe/model      一次最小推理：**必须断言 tools=N>0**（企业网关最常见的故障是吞 tools 或降级流式）
//   probe/skills     每个声明的技能确实进入会话目录
//   probe/connectors 每个启用的连接器可达（该 harness 无原生 MCP 客户端时，声明即失败）
//
// **零凭据**（N14）：默认把端点指向零凭据假网关，因此闸门 3 不依赖任何外部系统。
//
// 观测来源是**回调式轨迹**（`before_provider_request` 的实际请求体），不是 harness 的自我描述 ——
// 「我发了 4 个工具」与「我以为我发了 4 个工具」是两回事。
//
// 用法：node tools/probe.mjs <RENDER_DIR> [--endpoint URL] [--json]
// 退出码：0 通过 / 2 用法错误 / 30 闸门 3 失败 / 50 未预期异常
// ============================================================================

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EXIT_CODES, GateReport, parseArgs, runGates } from "../core/gates/index.mjs";
// 运行器按 harness 分派：probe 不该知道"哪个 harness 怎么跑"（那是适配器的事）
async function loadRunner(harness) {
  const p = path.join(REPO, `adapters/${harness}/run.mjs`);
  if (!fs.existsSync(p)) throw new Error(`${harness} 没有运行器（adapters/${harness}/run.mjs）`);
  return import(p);
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const GATE = "probes";

/**
 * 本产物是否用了"订阅型 provider"（凭据与端点都由运行时自己解析）。
 * 这类产物无法把端点重定向到零凭据假网关：硬跑会真打订阅端点（不封闭、且花用户的钱），
 * 所以闸门 3 对它**显式不适用** —— 不是通过，也不是失败。
 */
function isNativeCredentialProduct(renderDir) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(renderDir, "render-manifest.json"), "utf8"));
    return m.modelProviderAuth === "native";
  } catch { return false; }
}
const log = (m) => process.stderr.write(m + "\n");

/** 零凭据假网关：跑在**本进程**里即可（早前"必须独立进程"的结论是误判，真因是子进程 stdin 没关）。 */
async function startGateway(port = 0) {
  const { startFakeGateway } = await import(`file://${path.join(REPO, "tools/fake-gateway/server.mjs")}`);
  return startFakeGateway({ port, trace: true });
}

const USAGE = "用法: node tools/probe.mjs <RENDER_DIR> [--endpoint URL] [--json]\n";

async function main() {
  const { values, flags, positionals, errors } = parseArgs(process.argv.slice(2), { valueFlags: ["--endpoint", "--harness"] });
  const args = { renderDir: positionals[0], endpoint: values["--endpoint"] ?? null, live: flags.has("--live") || process.env.AGENT_VERIFY_LIVE === "1", harness: values["--harness"] ?? "pi", json: flags.has("--json"), help: flags.has("--help") || flags.has("-h") };

  // native 型 provider：闸门 3 不适用（见上面的说明）—— 如实报告，不伪装成通过
  {
    const rd = args?.renderDir ?? args?.positional?.[0];
    if (rd && isNativeCredentialProduct(rd) && !args.live) {
      const report = new GateReport(GATE);
      report.pass(GATE, "probe/not-applicable",
        "订阅型 provider（auth: native）：端点由运行时自己解析，无法重定向到零凭据假网关"
        + " —— 闸门 3 对这类产物不适用。要**真的确证可用**，加 LIVE=1 打真实端点");
      report.print({ json: flags.has("--json") });
      process.exit(report.exitCode);
    }
  }
  if (errors.length) { process.stderr.write(errors.join("；") + "\n"); process.exit(EXIT_CODES.usage); }
  if (args.help || !args.renderDir) {
    process.stderr.write(USAGE);
    process.exit(args.help ? EXIT_CODES.ok : EXIT_CODES.usage);
  }
  const renderDir = path.resolve(args.renderDir);
  const manifestFile = path.join(renderDir, "render-manifest.json");
  if (!fs.existsSync(manifestFile)) {
    log(`❌ ${renderDir} 不是渲染产物（缺 render-manifest.json）—— 先跑 render`);
    process.exit(EXIT_CODES.static);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));

  const report = new GateReport({
    agent: manifest.agent,
    harness: manifest.harness,
    harnessVersion: manifest.harnessVersion,
    artifactsDigest: manifest.artifactsDigest,
  });
  report.paramNames = [...(manifest.paramNames ?? [])].sort();

  const ctx = { manifest, renderDir, evidenceSource: "端点侧（假网关记录）" };
  let gateway = null;
  if (args.live) {
    // **真实验证**：用产物自己声明的端点与凭据（环境/变量文件/运行时凭据库），不打假网关、不用占位值。
    // 这是"真的能用"的证据 —— 默认不打，是为了让例行检查快且封闭；要证据时一步到位。
    ctx.endpoint = args.endpoint ?? null;
    log(`LIVE：打真实端点${ctx.endpoint ? `（${ctx.endpoint}）` : "（由产物/运行时解析）"} —— 会实际调用模型`);
  } else if (!args.endpoint) {
    gateway = await startGateway();
    ctx.endpoint = gateway.url;
    log(`零凭据假网关：${ctx.endpoint}`);
  } else {
    ctx.endpoint = args.endpoint;
  }

  try {
    await runGates({
      report,
      ctx,
      gates: [{
        id: GATE,
        handler: async (c, rep) => {
          // ---- probe/model ----
          const runner = await loadRunner(args.harness);
          // 闸门 3 是**零凭据**检查：显式声明零凭据模式（缺的必填项用显式占位值补齐）。
          // 真实运行默认 False —— 不许静默用占位凭据跑出"看起来正常"的结果。
          const run = await runner.runAgent({ renderDir, endpoint: c.endpoint, prompt: "say hi", timeoutMs: 120000, zeroCredential: !args.live, harnessHome: args.live ? (process.env.AGENT_HARNESS_HOME ?? null) : null });

          // **端点侧取证**：断言"端点实际收到了什么"，而不是"harness 说自己发了什么"。
          // 这样两条通道都成立：pi 的轨迹里有 model.request（回调式），dsh 的轨迹里没有 ——
          // 但假网关的轨迹里**总是**有它收到的那份请求。判据因此天然跨 harness。
          // live 模式没有假网关可取证，退回到"运行器自己的轨迹里必须有 model.request"这条更强的证据
          // （它不是"端点收到了"而是"模型真的答了"）。两种模式都保留同一组判据名。
          const liveEvents = (run.events ?? []).filter((e) => e?.type === "model.request");
          const gwEvents = (gateway?.traceLines ?? [])
            .map((l) => { try { return JSON.parse(l); } catch { return null; } })
            .filter((e) => e && e.type === "model.request");
          // live 模式的证据来自运行时自己的轨迹（真实模型答了），不是假网关记录
          const evidenceSource = args.live ? "运行时轨迹（真实调用）" : "端点侧（假网关记录）";
          c.evidenceSource = evidenceSource;
          if (args.live && !gwEvents.length) gwEvents.push(...liveEvents);
          // 回退：适配器若能从自己的轨迹里给出 model.request（pi 的回调式），也一并采信
          const fromTrace = run.events.filter((e) => e.type === "model.request");
          const reqs = gwEvents.length ? gwEvents : fromTrace;
          c.evidenceSource = gwEvents.length ? "端点侧（假网关记录）" : "适配器轨迹";
          c.modelRequests = reqs;
          c.run = run;

          if (!reqs.length) {
            rep.fail(GATE, "probe/model.reachable",
              `没有观测到任何模型请求（退出码 ${run.exitCode}）。stderr：${(run.stderr || "").slice(-200) || "(空)"}`);
          } else {
            rep.pass(GATE, "probe/model.reachable", `端点共收到 ${reqs.length} 次模型请求（证据来源：${c.evidenceSource}）`);
          }

          // §6.4 最关键的一条：必须断言 tools=N>0
          const withTools = reqs.filter((e) => Number(e.tools) > 0);
          if (withTools.length) {
            rep.pass(GATE, "probe/model.tools", `端点收到的请求里 tools=${withTools[0].tools} > 0（证据来源：${c.evidenceSource}）`);
          } else {
            rep.fail(GATE, "probe/model.tools",
              `请求里 tools=0 —— 端点或配置吞掉了工具字段（§6.4：这是最常见的故障，且会把网络层问题伪装成配置层问题）`);
          }

          // 流式：断言实际发出的请求是流式
          if (reqs.some((e) => e.stream === true)) {
            rep.pass(GATE, "probe/model.stream", "实际发出的是流式请求");
          } else {
            rep.fail(GATE, "probe/model.stream", "没有观测到流式请求（可能被降级）");
          }

          // ---- probe/hook-fired（P4）----
          // 声明了 kind=hook 的增强 ⇒ 轨迹里必须出现**由钩子当场发出**的事件（emitter=hook）。
          // 此前只验到"声明进了产物"（闸门 2），"配了没生效"无人报错 —— 这是"看起来有"的典型。
          const declaredHooks = manifest.hookEnhancements ?? [];
          const hookEvents = (run.events ?? []).filter((e) => e?.emitter === "hook");
          if (!declaredHooks.length) {
            rep.pass(GATE, "probe/hook-fired",
              "本产物未声明钩子型增强 ⇒ 无可断言（不把它算成通过，也不假装验过）");
          } else if (hookEvents.length) {
            // 证据边界要写清：这证明的是"**钩子发射路径确实在工作**"（基座轨迹本身就是一个钩子）。
            // 业务钩子若要被证明"我这条也跑了"，它得自己留痕（写轨迹/日志）—— 见 docs/13 §2 的说明。
            rep.pass(GATE, "probe/hook-fired",
              `钩子发射路径确实在工作：轨迹里有 ${hookEvents.length} 条钩子当场发出的事件`
              + `（声明含：${declaredHooks.join(", ")}；首个事件类型 ${hookEvents[0].type}）`);
          } else if (!(run.events ?? []).some((e) => e?.emitter === "post-hoc")) {
            rep.fail(GATE, "probe/hook-fired",
              `声明了钩子（${declaredHooks.join(", ")}）却没有任何钩子发出的轨迹事件，`
              + `也无法区分"轨迹不是钩子写的" —— 无法证明它生效`);
          } else {
            rep.pass(GATE, "probe/hook-fired",
              `本运行时的轨迹为**事后映射**（emitter=post-hoc），无法证明钩子当场触发 ⇒ 该断言在此运行时不适用`
              + `（不假装通过；需要各自的验证手段 —— 见路线图 §23 的 E2）`);
          }

          // 网关动了手脚的可观测信号（响应头回显与发出请求不一致）
          const altered = run.events.filter((e) => e.type === "model.error" && e.code === "GATEWAY_REQUEST_ALTERED");
          if (altered.length) {
            rep.fail(GATE, "probe/model.integrity", `请求在链路上被改动：${altered[0].message}`);
          } else {
            rep.pass(GATE, "probe/model.integrity", "未发现请求被链路改动的迹象");
          }

          // ---- probe/skills ----
          // 口径：每个声明的技能在**产物里就位**（文件系统可达）。这是跨 harness 都成立的那一层；
          // "运行时是否被发现"两边的可观测性不同（pi 能问、dsh 只能看配置），差异已进 exemptions.yaml，
          // 因此不在闸门 3 里假装两边一样。
          {
            // 位置由**清单**给出：产物目录形状是 harness 专有的（pi 在 agent-dir/ 下，dsh 在根）
            const skillsDir = path.join(renderDir, manifest.skillsInProduct ?? "skills");
            const declared = [...(manifest.declaredSkills ?? [])].sort();
            const present = declared.filter((n) => fs.existsSync(path.join(skillsDir, n, "SKILL.md")));
            if (!fs.existsSync(skillsDir)) rep.fail(GATE, "probe/skills.reachable", `产物里找不到技能目录（清单声明为 ${manifest.skillsInProduct}）`);
            if (declared.length !== present.length) {
              rep.fail(GATE, "probe/skills.reachable",
                `声明的 ${declared.length} 个技能里只有 ${present.length} 个在产物中就位：缺 ${declared.filter((n) => !present.includes(n)).join(", ")}`);
            } else {
              rep.pass(GATE, "probe/skills.reachable", `${declared.length} 个技能的 SKILL.md 都在产物中就位`);
            }
          }

          // ---- probe/connectors ----
          // 判据：声明的每台服务器都**能在运行期离线启动**（这是无外网环境的真正门槛），
          // 且产物确实把它渲染了出来。做法是查渲染清单里的包坐标在本地/镜像里是否就位 ——
          // 不是"我们写了配置就算数"。
          // 实测佐证由 probe/model 一并给出（假网关记录端点收到的工具数：接上连接器后会显著变大）。
          {
            const declared = manifest.connectors ?? [];
            const pkgs = manifest.connectorPackages ?? [];
            if (!declared.length) {
              rep.pass(GATE, "probe/connectors.reachable", "未声明启用的连接器，无需探针");
            } else {
              // 预装包落在两处之一：开发机本地（make dev-env）或基座镜像里（构建期全局安装）
              const localRoot = path.join(REPO, ".local-packages/node_modules");
              const inImageRoot = "/usr/local/lib/node_modules";
              const missing = [];
              for (const spec of pkgs) {
                const name = spec.replace(/@[^@]*$/, "");          // @scope/pkg@ver → @scope/pkg
                const ok = fs.existsSync(path.join(localRoot, name)) || fs.existsSync(path.join(inImageRoot, name));
                if (!ok) missing.push(spec);
              }
              if (!pkgs.length && declared.length) {
                rep.fail(GATE, "probe/connectors.reachable",
                  `声明了 ${declared.length} 个连接器，但清单里没有包坐标 —— 无法判断它能否离线启动`);
              } else if (missing.length) {
                rep.fail(GATE, "probe/connectors.reachable",
                  `${missing.length} 个连接器的包不在本地/镜像里（运行期会连不上）：${missing.join(", ")} —— 跑 make dev-env 装上，或确认它进了构建锁`);
              } else {
                rep.pass(GATE, "probe/connectors.reachable",
                  `${declared.length} 个连接器已渲染且包就位（可离线启动）：${declared.map((c) => c.serverName).join(", ")}`);
              }
            }
          }
        },
      }],
    });
  } finally {
    if (gateway) await gateway.close();
  }

  if (args.json) process.stdout.write(JSON.stringify({ gate: report.toJSON(), modelRequests: (ctx.modelRequests ?? []).length }, null, 2) + "\n");
  else report.print({ json: false, stderr: process.stderr });
  process.exit(report.crashed ? EXIT_CODES.crash : report.exitCode);
}

await main();
