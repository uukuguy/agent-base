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

/** 订阅型 provider（凭据与端点由运行时自己解析）⇒ 无法重定向到零凭据假网关，本门不适用。 */
function isNativeCredentialProduct(renderDir) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(renderDir, "render-manifest.json"), "utf8"));
    return m.modelProviderAuth === "native";
  } catch { return false; }
}
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
  const live = flags.has("--live") || process.env.AGENT_VERIFY_LIVE === "1";
  const argv = process.argv.slice(2);
  const renderDirArg = positionals[0];

  // 订阅型 provider（auth: native）：凭据与端点由运行时自己解析 ⇒ 无法重定向到零凭据假网关。
  // 本门对这类产物**显式不适用**（硬跑会真打订阅端点：既不封闭，也会花用户的钱）。
  if (renderDirArg && !live) {
    let auth = null;
    try {
      auth = JSON.parse(fs.readFileSync(path.join(path.resolve(renderDirArg), "render-manifest.json"), "utf8")).modelProviderAuth ?? null;
    } catch { /* 清单不存在时走原有报错路径 */ }
    if (auth === "native") {
      const report = new GateReport("smoke");
      report.pass("smoke", "smoke/not-applicable",
        "订阅型 provider（auth: native）：无法重定向到零凭据假网关 —— 闸门 4 对这类产物不适用；"
        + "真实可用性请在真实端点上跑一次确证");
      report.print({ json: flags.has("--json") });
      process.exit(report.exitCode);
    }
  }
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
          // loop 预算里**只有挂钟这一条能真正强制执行**（试点：次数类只能事后数轨迹）：
          // 声明了 `loop.maxWallClockSeconds` 就把它当运行超时用（留一点收尾余量），跑超即中止并判失败。
          const loop = manifest.loop ?? null;
          const wallBudgetMs = loop?.maxWallClockSeconds ? loop.maxWallClockSeconds * 1000 : null;
          const run = await runner.runAgent({
            // 闸门 4 同样是零凭据检查
            zeroCredential: true,
            renderDir,
            endpoint: endpoint ?? gateway.url,
            prompt: "Reply with the marker so the smoke check can verify output.",  // 确定性任务
            timeoutMs: wallBudgetMs ? Math.max(1000, wallBudgetMs) : 30000,
          });

          // 1) 退出码 0
          if (run.exitCode === 0) rep.pass(GATE, "smoke/exit-code", "退出码 0");
          else rep.fail(GATE, "smoke/exit-code", `退出码 ${run.exitCode}（期望 0）。stderr：${(run.stderr || "").slice(-200) || "(空)"}`);

          // 2) 输出包含预期标记
          if (live) {
            // LIVE：真实模型不会回假网关那个标记。判据换成"真实调用确实发生 + 任务正常结束"。
            const answered = (run.events ?? []).some((e) => e?.type === "model.request");
            if (answered && run.exitCode === 0) {
              rep.pass(GATE, "smoke/output-marker", "真实调用发生且任务正常结束（LIVE 模式：不以假网关标记为判据）");
            } else {
              rep.fail(GATE, "smoke/output-marker",
                `LIVE 模式下未完成任务（退出码 ${run.exitCode}，轨迹里${answered ? "有" : "没有"}模型请求）`);
            }
          } else if (run.stdout.includes(RESPONSE_MARKER)) rep.pass(GATE, "smoke/output-marker", `输出包含预期标记 ${RESPONSE_MARKER}`);
          else rep.fail(GATE, "smoke/output-marker", `输出里没有 ${RESPONSE_MARKER} —— 任务没有真正跑完`);

          // 取证源（供钩子失败与 loop 预算共用）：运行器轨迹优先，缺 model.request 时退端点侧。
          // 单一来源的理由见下面 loop 段：合并两个 run 命名空间会把同一 run 拆两半。
          const endpointEventsForHooks = (gateway?.traceLines ?? [])
            .map((l) => { try { return JSON.parse(l); } catch { return null; } })
            .filter((e) => e && e.run);
          const allEventsForHooks = (run.events ?? []).length ? (run.events ?? []) : endpointEventsForHooks;

          // 3) 轨迹符合 schema
          const ajv = new Ajv2020({ allErrors: true, strict: false });
          const validate = ajv.compile(JSON.parse(fs.readFileSync(path.join(REPO, "core/trace/schema.json"), "utf8")));
          const bad = run.events.filter((e) => !validate(e));
          if (!run.events.length) rep.fail(GATE, "smoke/trace-schema", "没有产生任何轨迹事件（看不到它做了什么）");
          else if (bad.length) rep.fail(GATE, "smoke/trace-schema", `${bad.length}/${run.events.length} 条事件不合 schema`);
          else rep.pass(GATE, "smoke/trace-schema", `${run.events.length} 条轨迹全部符合 schema`);

          // 3b) 钩子失败语义（E7）：`hook.error` 必须被看见 —— 尤其 policy=block 的那些
          // 实测：运行时自己**吞掉**钩子异常（不会中止运行），所以"block"由**基座**执行：
          // 轨迹里出现 policy=block 的钩子失败 ⇒ 这次运行**判为失败**（闸门是基座的权威，不是运行时的）。
          {
            const hookErrors = allEventsForHooks.filter((e) => e.type === "hook.error");
            const blocking = hookErrors.filter((e) => e.policy === "block");
            if (blocking.length) {
              rep.fail(GATE, "smoke/hook-failures",
                `${blocking.length} 条钩子失败被声明为 block ⇒ 本次运行判为失败：`
                + blocking.map((e) => `${e.enhancement}（${String(e.message).slice(0, 80)}）`).join("；"));
            } else if (hookErrors.length) {
              rep.pass(GATE, "smoke/hook-failures",
                `${hookErrors.length} 条钩子失败被**如实记录**（policy=record，运行继续）：`
                + [...new Set(hookErrors.map((e) => e.enhancement))].join(", "));
            } else {
              rep.pass(GATE, "smoke/hook-failures", "这次运行没有钩子失败（要么没声明钩子，要么都正常）");
            }
          }

          // 4) loop 预算：**从轨迹数**，越界判红并给出数字（声明不是装饰）
          let c_loopSource = "";
          {
            const { assertLoopBudget } = await import(`file://${path.join(REPO, "core/gates/loop.mjs")}`);
            // 事件源：**只用一处**。先看运行器自己的轨迹里有没有 `model.request`；
            // 没有（某个运行时的轨迹是事后映射、数不出模型调用）才退回端点侧（假网关记录）。
            // ⚠️ **不能把两处合并**：两个来源的 `run` id 命名空间不同，合并会把同一个 run 拆成两半，
            // 于是"实际 4 步"被数成"两半各 2 步"，**越界反而漏判**（本轮先写了合并版，报告里出现两个 run 才发现）。
            const endpointEvents = (gateway?.traceLines ?? [])
              .map((l) => { try { return JSON.parse(l); } catch { return null; } })
              .filter((e) => e && e.run);
            const fromRunner = (run.events ?? []).filter((e) => e.type === "model.request");
            const allEvents = fromRunner.length ? (run.events ?? []) : endpointEvents;
            c_loopSource = fromRunner.length ? "运行器轨迹" : "端点侧（假网关记录）";
            const budget = assertLoopBudget(loop, allEvents);
            if (!loop || !budget.checked.length) {
              rep.pass(GATE, "smoke/loop-budget", "没有声明 loop 预算（无需断言）—— 要约束轮次/时长就在定义里写 `loop:`");
            } else if (budget.violations.length) {
              rep.fail(GATE, "smoke/loop-budget",
                `超出声明的预算：${budget.violations.map((v) => v.message).join("；")}`
                + `（数法：核心事件计数；阈值在 agent.yaml 的 loop 块里）`);
            } else {
              const used = budget.usage.map((u) => `${u.modelCalls} 次模型调用/${u.toolCalls} 次工具调用`).join("，");
              rep.pass(GATE, "smoke/loop-budget",
                `声明了 ${budget.checked.join(" / ")} 上限，实际未越界（${used}；数自${c_loopSource}）`
                + (wallBudgetMs ? "；挂钟上限已作为运行超时强制执行" : ""));
            }
          }

          // 5) 未出现被禁的工具
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
