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
import { observeLoaded, runAgent } from "../adapters/pi/run.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const GATE = "probes";
const log = (m) => process.stderr.write(m + "\n");

/** 零凭据假网关：跑在**本进程**里即可（早前"必须独立进程"的结论是误判，真因是子进程 stdin 没关）。 */
async function startGateway(port = 0) {
  const { startFakeGateway } = await import(`file://${path.join(REPO, "tools/fake-gateway/server.mjs")}`);
  return startFakeGateway({ port, trace: true });
}

const USAGE = "用法: node tools/probe.mjs <RENDER_DIR> [--endpoint URL] [--json]\n";

async function main() {
  const { values, flags, positionals, errors } = parseArgs(process.argv.slice(2), { valueFlags: ["--endpoint"] });
  const args = { renderDir: positionals[0], endpoint: values["--endpoint"] ?? null, json: flags.has("--json"), help: flags.has("--help") || flags.has("-h") };
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

  const ctx = { manifest, renderDir };
  let gateway = null;
  if (!args.endpoint) {
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
          const run = await runAgent({ renderDir, endpoint: c.endpoint, prompt: "say hi", timeoutMs: 25000 });
          const reqs = run.events.filter((e) => e.type === "model.request");
          c.modelRequests = reqs;

          if (!reqs.length) {
            rep.fail(GATE, "probe/model.reachable",
              `没有观测到任何模型请求（退出码 ${run.exitCode}）。stderr：${(run.stderr || "").slice(-200) || "(空)"}`);
          } else {
            rep.pass(GATE, "probe/model.reachable", `观测到 ${reqs.length} 次模型请求（端点 ${c.endpoint}）`);
          }

          // §6.4 最关键的一条：必须断言 tools=N>0
          const withTools = reqs.filter((e) => Number(e.tools) > 0);
          if (withTools.length) {
            rep.pass(GATE, "probe/model.tools", `实际发出的工具数 ${withTools[0].tools} > 0（不是"我以为带了"）`);
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

          // 网关动了手脚的可观测信号（响应头回显与发出请求不一致）
          const altered = run.events.filter((e) => e.type === "model.error" && e.code === "GATEWAY_REQUEST_ALTERED");
          if (altered.length) {
            rep.fail(GATE, "probe/model.integrity", `请求在链路上被改动：${altered[0].message}`);
          } else {
            rep.pass(GATE, "probe/model.integrity", "未发现请求被链路改动的迹象");
          }

          // ---- probe/skills ----
          const loaded = await observeLoaded(renderDir);
          const declared = [...(manifest.declaredSkills ?? [])].sort();
          if (!loaded.complete) {
            rep.fail(GATE, "probe/skills.reachable", `自证未完成（RPC 无响应）。stderr：${(loaded.stderr || "").slice(-200)}`);
          } else if (JSON.stringify(loaded.skills) !== JSON.stringify(declared)) {
            rep.fail(GATE, "probe/skills.reachable",
              `技能实际加载 ${JSON.stringify(loaded.skills)} ≠ 声明 ${JSON.stringify(declared)}`);
          } else {
            rep.pass(GATE, "probe/skills.reachable", `${declared.length} 个技能全部进入会话目录`);
          }

          // ---- probe/connectors ----
          const enabled = (manifest.connectors ?? []).filter((s) => s.enabled !== false);
          const mcpClient = c.manifest.mcpClient ?? "unknown";
          if (!enabled.length) {
            rep.pass(GATE, "probe/connectors.reachable", "未声明启用的连接器，无需探针");
          } else if (mcpClient === "unsupported") {
            // 不许静默降级：没有客户端就不能声称连接器可用
            rep.fail(GATE, "probe/connectors.reachable",
              `声明了 ${enabled.length} 个连接器，但该 harness 原生无 MCP 客户端 —— 不可达（不许静默降级）`);
          } else {
            rep.fail(GATE, "probe/connectors.reachable",
              `连接器探针尚未实现对该 harness 的支持（声明了 ${enabled.length} 个）—— 未实现不算通过`);
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
