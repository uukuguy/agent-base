#!/usr/bin/env node
// ============================================================================
// 闸门 4：端到端冒烟（统一设计 §6.5）
//
// 断言四件事（§6.5 原文）：**退出码 0 + 输出包含预期标记 + 轨迹符合 schema + 未出现未声明工具**。
// 容器里还要加安全加固参数；本机（macOS）无法实测安全项，那部分归属 conformance/C9。
//
// 输入是**确定性**冒烟任务：默认指向零凭据假网关，因此不依赖任何真实外部系统。
//
// 用法：node tools/smoke.mjs <RENDER_DIR> [--endpoint URL] [--json]
// 退出码：0 通过 / 2 用法错误 / 40 闸门 4 失败
// ============================================================================

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { EXIT_CODES, GateReport, parseArgs, runGates } from "../core/gates/index.mjs";
// 运行器按 harness 分派（与 probe 同法）
async function loadRunner(harness) {
  const p = path.join(REPO, `adapters/${harness}/run.mjs`);
  if (!fs.existsSync(p)) throw new Error(`${harness} 没有运行器（adapters/${harness}/run.mjs）`);
  return import(p);
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const GATE = "smoke";
const log = (m) => process.stderr.write(m + "\n");

/** 假网关响应里带的确定性标记 —— 冒烟断言"输出包含预期标记"就用它。 */
const RESPONSE_MARKER = "FAKE_GATEWAY_OK";
/** 该 harness 的内置工具（上游文档）——"未声明工具"按它减去 tools.deny 判定。 */
const BUILTIN_TOOLS = ["read", "bash", "edit", "write"];

async function startGateway() {
  const { startFakeGateway } = await import(`file://${path.join(REPO, "tools/fake-gateway/server.mjs")}`);
  return startFakeGateway({ port: 0, trace: true });
}

async function main() {
  const { values, flags, positionals } = parseArgs(process.argv.slice(2), { valueFlags: ["--endpoint", "--harness"] });
  const argv = process.argv.slice(2);
  const renderDirArg = positionals[0];
  if (flags.has("--help") || flags.has("-h") || !renderDirArg) {
    process.stderr.write("用法: node tools/smoke.mjs <RENDER_DIR> [--endpoint URL] [--json]\n");
    process.exit(flags.has("--help") || flags.has("-h") ? EXIT_CODES.ok : EXIT_CODES.usage);
  }
  const harness = values["--harness"] ?? "pi";
const renderDir = path.resolve(renderDirArg);
  const manifestFile = path.join(renderDir, "render-manifest.json");
  if (!fs.existsSync(manifestFile)) {
    log(`❌ ${renderDir} 不是渲染产物（缺 render-manifest.json）—— 先跑 render`);
    process.exit(EXIT_CODES.static);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));

  const report = new GateReport({
    agent: manifest.agent, harness: manifest.harness,
    harnessVersion: manifest.harnessVersion, artifactsDigest: manifest.artifactsDigest,
  });

  let gateway = null;
  const endpoint = values["--endpoint"] ?? null;
  if (!endpoint) { gateway = await startGateway(); log(`零凭据假网关：${gateway.url}`); }

  try {
    await runGates({
      report,
      ctx: {},
      gates: [{
        id: GATE,
        handler: async (_c, rep) => {
          const runner = await loadRunner(harness);
          const run = await runner.runAgent({
            renderDir,
            endpoint: endpoint ?? gateway.url,
            prompt: "Reply with the marker so the smoke check can verify output.",  // 确定性任务
            timeoutMs: 30000,
          });

          // 1) 退出码 0
          if (run.exitCode === 0) rep.pass(GATE, "smoke/exit-code", "退出码 0");
          else rep.fail(GATE, "smoke/exit-code", `退出码 ${run.exitCode}（期望 0）。stderr：${(run.stderr || "").slice(-200) || "(空)"}`);

          // 2) 输出包含预期标记
          if (run.stdout.includes(RESPONSE_MARKER)) rep.pass(GATE, "smoke/output-marker", `输出包含预期标记 ${RESPONSE_MARKER}`);
          else rep.fail(GATE, "smoke/output-marker", `输出里没有 ${RESPONSE_MARKER} —— 任务没有真正跑完`);

          // 3) 轨迹符合 schema
          const ajv = new Ajv2020({ allErrors: true, strict: false });
          const validate = ajv.compile(JSON.parse(fs.readFileSync(path.join(REPO, "core/trace/schema.json"), "utf8")));
          const bad = run.events.filter((e) => !validate(e));
          if (!run.events.length) rep.fail(GATE, "smoke/trace-schema", "没有产生任何轨迹事件（看不到它做了什么）");
          else if (bad.length) rep.fail(GATE, "smoke/trace-schema", `${bad.length}/${run.events.length} 条事件不合 schema`);
          else rep.pass(GATE, "smoke/trace-schema", `${run.events.length} 条轨迹全部符合 schema`);

          // 4) 未出现被禁的工具
          // 判据用**中性定义的 deny 名字**做名字级检查（大小写不敏感的子串匹配）。这是一个有意保守的
          // 检查：它抓得住"禁了 bash 却调了 bash"这类明显越界，但不假装等价于 row 级边界
          // （两个 harness 的工具粒度不同，权威断言在闸门 2 的 row/settings 级）。
          const deny = (manifest.runArgs?.excludeTools ?? manifest.denyTools ?? []).map((t) => String(t).toLowerCase());
          const used = [...new Set(run.events.filter((e) => e.type === "tool.call").map((e) => String(e.tool)))];
          const violated = used.filter((t) => deny.some((d) => t.toLowerCase().includes(d)));
          if (violated.length) rep.fail(GATE, "smoke/no-denied-tools", `调用了被禁的工具：${violated.join(", ")}（禁用清单：${deny.join(", ")}）`);
          else rep.pass(GATE, "smoke/no-denied-tools", used.length ? `调用到的工具都未触碰禁用清单：${used.join(", ")}` : "本次未调用工具");
        },
      }],
    });
  } finally {
    if (gateway) await gateway.close();
  }

  if (flags.has("--json")) process.stdout.write(JSON.stringify({ gate: report.toJSON() }, null, 2) + "\n");
  else report.print({ json: false, stderr: process.stderr });
  process.exit(report.crashed ? EXIT_CODES.crash : report.exitCode);
}

await main();
