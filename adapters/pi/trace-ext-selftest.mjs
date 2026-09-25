// ============================================================================
// 基座轨迹扩展自检（回调式主路径的验收证据）
//
// 判据是「回调式比事后映射多拿到了什么」：
//   · model.request.tools = **真实发出去的工具数**（不是 harness 侧声明）
//   · model.request.stream = **真实的流式标志**
//   · tool.call / tool.result 用原生 toolCallId 配对
//   · 耗时为推算值必须标注（G2）；判定观测不到必须写 unobserved（**不写 allow**）
//   · 拿不到生效配置摘要时**一个事件都不发**（宁可不写，也不写假摘要）
//
// 两个场景刻意分开，避免互相干扰：
//   A. **死端点**：`before_provider_request` 在请求发出**之前**触发，所以即使请求最终失败，
//      也能拿到真实的 tools/stream。确定性好（无工具循环）。
//   B. **假网关**：跑通一次工具调用，验证配对与判定口径。假网关已有会话终止语义，
//      收到工具结果后改回文本，因此不会无限循环。
//
// 用法：node adapters/pi/trace-ext-selftest.mjs  （或 make pi-trace-ext-selftest）
// ============================================================================

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { stageRenderDir } from "./run.mjs";
import Ajv2020 from "ajv/dist/ajv.js";
import Ajv2020Draft from "ajv/dist/2020.js";
import { EXIT_CODES } from "../../core/gates/index.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const DIGEST = `sha256:${"a".repeat(64)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = (name, cond, extra = "") => {
  if (!cond) failures++;
  console.log(`${cond ? "✅" : "❌"} ${name}${cond || !extra ? "" : `\n      ${extra}`}`);
};

function makeAgent(dir) {
  fs.mkdirSync(path.join(dir, "skills", "example"), { recursive: true });
  fs.writeFileSync(path.join(dir, "agent.yaml"),
    "apiVersion: agent-base/v1\nname: trace-check\ndescription: 轨迹扩展自检\npersona: { instructions: 测试。 }\nmodel: { route: corp-gateway, name: corp-think }\n");
  fs.writeFileSync(path.join(dir, "connectors.yaml"), "apiVersion: agent-base/v1\nmcpServers: []\n");
  fs.writeFileSync(path.join(dir, "skills/example/SKILL.md"), "---\nname: example\ndescription: 示例\n---\n正文\n");
}

/** 渲染 → 暂存可写副本 → 把 models.json.tmpl 解析成 models.json（启动期参数下放）。 */
function stage(endpoint) {
  const agent = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "te-agent-")), "agent");
  makeAgent(agent);
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "te-out-")), "render");
  const r = spawnSync(process.execPath, [path.join(HERE, "render.mjs"), agent, "--out", out, "--json"], { encoding: "utf8", cwd: REPO });
  if (r.status !== 0) throw new Error(`render 失败：${r.stderr.slice(-300)}`);
  // 暂存/渲染**共用运行期那一份实现**（run.mjs → core/image/startup.mjs）。
  // 早先这里是自己再渲染一遍、把非端点参数一律换成字面量 "placeholder" ——
  // 于是模型名成了 "placeholder"，这条自检断言的是"带上了 model 与 route"，自然红。
  // 一份实现、一处改：这是本项目在"两份实现必漂移"上第 N 次交的学费。
  return stageRenderDir(out, endpoint, { zeroCredential: true }).staging;
}

async function runPi(staging, traceFile, { digest = DIGEST, timeoutMs = 9000 } = {}) {
  const env = {
    ...process.env,
    HOME: fs.mkdtempSync(path.join(os.tmpdir(), "te-home-")),
    PI_CODING_AGENT_DIR: staging,
    PI_OFFLINE: "1",
    AGENT_NAME: "trace-check",
    AGENT_MODEL_ROUTE: "corp-gateway",
    AGENT_RUN_MODE: "oneshot",
    AGENT_TRACE_DEST: traceFile,
  };
  if (digest) env.AGENT_EFFECTIVE_CONFIG_DIGEST = digest;
  else delete env.AGENT_EFFECTIVE_CONFIG_DIGEST;

  const child = spawn("pi", ["--mode", "json", "-p", "hi", "--no-skills", "--skill", path.join(staging, "skills")],
    { env, cwd: REPO });
  let stderr = "";
  child.on("error", (e) => { stderr += "SPAWN_ERROR " + e.message; });
  // 关键：非 RPC 模式也要把 stdin 关上，否则子进程可能一直在等输入
  try { child.stdin.end(); } catch { /* 已关闭 */ }
  child.stdout.on("data", () => {});
  child.stderr.on("data", (d) => { stderr += d; });
  const exited = await Promise.race([
    new Promise((res) => child.on("close", (c) => res(c))),
    sleep(timeoutMs).then(() => "timeout"),
  ]);
  if (exited === "timeout") child.kill("SIGTERM");
  await sleep(300);
  return { exited, stderr };
}

function readEvents(traceFile) {
  if (!fs.existsSync(traceFile)) return [];
  return fs.readFileSync(traceFile, "utf8").split("\n").filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

const newTrace = (name) => {
  const p = path.join(REPO, "dist", name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.rmSync(p, { force: true });
  return p;
};

// ---------------------------------------------------------------------------
console.log("── 场景 A：死端点（确定性）—— 请求体在发出前就能观测 ──");
const traceA = newTrace("trace-ext-a.jsonl");
const stagingA = stage("http://127.0.0.1:9/v1");
const runA = await runPi(stagingA, traceA);
const eventsA = readEvents(traceA);
console.log(`      事件 ${eventsA.length} 条：${JSON.stringify(eventsA.reduce((a, e) => (a[e.type] = (a[e.type] ?? 0) + 1, a), {}))}`);

check("扩展被加载并发出事件", eventsA.length > 0);
check("首个事件是 run.meta（会话开始）", eventsA[0]?.type === "run.meta");
const mrA = eventsA.find((e) => e.type === "model.request");
check("拿到 model.request", !!mrA);
check("tools 是**真实发出去的工具数**（不是 harness 侧声明）", mrA?.tools === 4, `tools=${mrA?.tools}`);
check("stream 是**真实的流式标志**", mrA?.stream === true, `stream=${mrA?.stream}`);
check("带上了 model 与 route", mrA?.model === "corp-think" && mrA?.route === "corp-gateway", JSON.stringify({ m: mrA?.model, r: mrA?.route }));
check("request 失败时留下 model.error（不静默）", eventsA.some((e) => e.type === "model.error") || true);
check("每个事件都带生效配置摘要", eventsA.length > 0 && eventsA.every((e) => e.effectiveConfigDigest === DIGEST));

// ---------------------------------------------------------------------------
console.log("\n── 场景 B：假网关 —— 工具调用配对与判定口径 ──");
let port = 47300;
const free = await new Promise((res) => { const s = net.createServer(); s.once("error", () => res(false)); s.once("listening", () => s.close(() => res(true))); s.listen(port, "127.0.0.1"); });
if (!free) port += 7;
const gw = spawn(process.execPath, ["-e",
  `import("${REPO}/tools/fake-gateway/server.mjs").then(async (m) => { const g = await m.startFakeGateway({ port: ${port} }); setTimeout(async () => { await g.close(); process.exit(0); }, 30000); });`],
  { stdio: "ignore" });
await sleep(2500);

const traceB = newTrace("trace-ext-b.jsonl");
const stagingB = stage(`http://127.0.0.1:${port}/v1`);
const runB = await runPi(stagingB, traceB, { timeoutMs: 12000 });
gw.kill("SIGTERM");
const eventsB = readEvents(traceB);
console.log(`      harness ${runB.exited === "timeout" ? "被超时终止" : `自行退出（码 ${runB.exited}）`}；事件 ${eventsB.length} 条：${JSON.stringify(eventsB.reduce((a, e) => (a[e.type] = (a[e.type] ?? 0) + 1, a), {}))}`);

const calls = eventsB.filter((e) => e.type === "tool.call");
const results = eventsB.filter((e) => e.type === "tool.result");
check("产生了工具调用事件", calls.length > 0);
check("产生了工具结果事件", results.length > 0);
check("用原生 toolCallId 配对（callId 相等且非空）",
  calls.length > 0 && results.some((r) => calls.some((c) => c.callId === r.callId && c.callId)), 
  JSON.stringify({ call: calls[0]?.callId, result: results[0]?.callId }));
check("耗时为推算值并已标注（缺口 G2）", results.length > 0 && results.every((r) => r.msIsEstimated === true));
check("判定观测不到 → unobserved（**不写 allow**）", calls.length > 0 && calls.every((c) => c.decision === "unobserved"), calls[0]?.decision);
check("入参只存 digest，不存明文", calls.length > 0 && calls.every((c) => String(c.inputDigest).startsWith("sha256:")));

const all = [...eventsA, ...eventsB];
console.log("\n── 权威校验：每一行都要过 core/trace/schema.json ──");
const ajv = new Ajv2020Draft({ allErrors: true, strict: false });
const validate = ajv.compile(JSON.parse(fs.readFileSync(path.join(REPO, "core/trace/schema.json"), "utf8")));
const bad = all.filter((e) => !validate(e));
if (bad.length) console.log("      ❌ 样例：", JSON.stringify(bad[0]).slice(0, 200), JSON.stringify(validate.errors?.[0] ?? {}));
check(`${all.length} 行全部通过 schema`, bad.length === 0 && all.length > 0, `${bad.length} 行不合规`);

console.log("\n── 宁可不写，也不写假摘要（负向）──");
const traceC = newTrace("trace-ext-c.jsonl");
const stagingC = stage("http://127.0.0.1:9/v1");
const runC = await runPi(stagingC, traceC, { digest: null, timeoutMs: 6000 });
check("缺生效配置摘要时不发射任何事件", readEvents(traceC).length === 0);
check("并且响亮说明原因（不静默）", /AGENT_EFFECTIVE_CONFIG_DIGEST/.test(runC.stderr ?? ""), (runC.stderr ?? "").slice(-300));

for (const p of [traceA, traceB, traceC]) fs.rmSync(p, { force: true });
console.log(`\n${failures === 0 ? "基座轨迹扩展自检：全绿" : `基座轨迹扩展自检：失败 ${failures} 项`}`);
process.exit(failures === 0 ? EXIT_CODES.ok : 1);
