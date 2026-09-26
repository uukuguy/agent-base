// ============================================================================
// dsh 侧 `/verify-container` 自检（路线图 §30 A6b-2）
//
// 判据与另一个运行时的同名扩展**同一套**（同一条纪律的两个落地形态）：
//   · 拒绝 / 无应答者 ⇒ **不执行**，且轨迹里记下 `approval.decision`（denied / unavailable）
//   · 放行 ⇒ 执行，且**只走受控入口**
//   · `unavailable` 是 fail-closed：没审批服务、没定义目录、干跑失败都算
//   · 静态断言：插件源码里**没有自己拼 docker 的路**
//   · 集成：渲染产物里插件就位（row 指**入口文件**）、闸门 2 的组合树里有它、真跑没有 import 失败
//
// 用法：node adapters/dsh/verify-container-selftest.mjs
// ============================================================================

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");

let failures = 0;
const check = (name, cond, extra = "") => {
  if (!cond) failures++;
  console.log(`${cond ? "✅" : "❌"} ${name}${cond || !extra ? "" : `\n      ${extra}`}`);
};

const ajv = new Ajv2020({ allErrors: true, strict: false });
const validateEvent = ajv.compile(JSON.parse(fs.readFileSync(path.join(REPO, "core/trace/schema.json"), "utf8")));
const DIGEST = `sha256:${"c".repeat(64)}`;
// ⚠️ **必须在导入插件之前**把摘要放进 env：插件在**模块加载**时读它（读不到就整个生命周期不写轨迹，
// 而且模块会被缓存 ⇒ 后面每个用例都跟着哑掉）。真实运行时也是先有 env 再加载插件（本轮踩中）。
process.env.AGENT_EFFECTIVE_CONFIG_DIGEST = DIGEST;

const FAKE_ENTRY = `import fs from "node:fs";
const [dir, ...rest] = process.argv.slice(2);
fs.appendFileSync(process.env.VC_MARKER, JSON.stringify({ dir, rest }) + "\\n");
if (rest.includes("--dry-run")) {
  process.stdout.write(JSON.stringify({ where: "container", image: "agent-base:0.0.0-arm64", arch: "arm64",
    imageDigest: "sha256:" + "d".repeat(64), imageExists: true,
    mounts: [{ src: dir, dst: "/work/agent", mode: "ro", role: "project" },
             { src: "/tmp/art", dst: "/opt/agent-base/artifact", mode: "ro", role: "artifact" }] }) + "\\n");
} else {
  process.stdout.write(JSON.stringify({ where: "container", usable: true, imageDigest: "sha256:" + "d".repeat(64),
    steps: [{ ok: true, label: "闸门 2：解析自证", verdict: "退出码 0" }],
    covered: ["static(agent-only)", "resolution", "probes", "smoke"], notCovered: ["security-floor(C9)"], attribution: null }) + "\\n");
}
`;

/** 造夹具：定义 + 渲染产物（插件由渲染器从 seed 拷进 profile）。 */
function scaffold({ withGatesEntry = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vc-dsh-"));
  const agent = path.join(root, "agent");
  fs.mkdirSync(path.join(agent, "skills", "alpha"), { recursive: true });
  fs.writeFileSync(path.join(agent, "agent.yaml"),
    "apiVersion: agent-base/v1\nname: vc-dsh-selftest\ndescription: dsh 审批门自检\n"
    + "persona: { instructions: 自检。 }\nmodel: { provider: corp-gateway, name: corp-think }\nconnectorsFile: connectors.yaml\n");
  fs.writeFileSync(path.join(agent, "connectors.yaml"), "apiVersion: agent-base/v1\nmcpServers: []\n");
  fs.writeFileSync(path.join(agent, "skills", "alpha", "SKILL.md"), "---\nname: alpha\ndescription: 一句话\n---\n正文\n");

  const renderDir = path.join(root, "render");
  const r = spawnSync(process.execPath, [path.join(HERE, "render.mjs"), agent, "--out", renderDir], { encoding: "utf8", cwd: REPO });
  if (r.status !== 0) throw new Error(`渲染失败：${(r.stderr ?? "").slice(-400)}`);

  // 假受控入口放在**独立的 gates 目录**里（插件只认 AGENT_GATES_DIR）
  const gates = path.join(root, "gates", "tools");
  fs.mkdirSync(gates, { recursive: true });
  if (withGatesEntry) fs.writeFileSync(path.join(gates, "verify-container.mjs"), FAKE_ENTRY);

  return { root, agent, renderDir, gatesDir: path.join(root, "gates"), marker: path.join(root, "calls.jsonl"),
    trace: path.join(root, "trace.jsonl"), profileDir: path.join(renderDir, "dsh-home", "profiles", "vc-dsh-selftest") };
}

const calls = (f) => fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const events = (f) => fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const decisions = (f) => events(f).filter((e) => e.type === "approval.decision");

/** 加载**产物里**的插件（顺带验证渲染器把事件写入器注入到位）。 */
let plugin = null;
async function loadPlugin(s) {
  const mod = await import(new URL(`file://${path.join(s.profileDir, "plugins", "verify-container", "index.js")}`).href);
  return mod;
}

/** 用一个假 ctx 调一次命令 handler。 */
async function invoke(s, { approval, definitionDir = null, fresh = false } = {}) {
  const mod = fresh || !plugin ? await loadPlugin(s) : plugin;
  plugin = mod;
  fs.writeFileSync(s.marker, "");
  fs.writeFileSync(s.trace, "");
  let registered = null;
  const ctx = {
    commands: { register: (def) => { registered = def; } },
    get: (key) => (key === "approval" ? approval : undefined),
  };
  const saved = { ...process.env };
  process.env.AGENT_TRACE_DEST = s.trace;
  process.env.AGENT_EFFECTIVE_CONFIG_DIGEST = DIGEST;
  process.env.AGENT_GATES_DIR = s.gatesDir;
  process.env.AGENT_NAME = "vc-dsh-selftest";
  process.env.VC_MARKER = s.marker;
  if (definitionDir) process.env.AGENT_DEFINITION_DIR = definitionDir; else delete process.env.AGENT_DEFINITION_DIR;
  mod.apply(ctx);
  const result = await registered.handler({ agent: { id: "agent-1" }, rawInput: "", attachments: [], signal: undefined });
  Object.assign(process.env, saved);
  return { def: registered, result };
}

console.log("── A. 渲染产物：基座种子插件就位 ──");
const s = scaffold();
check("产物里有插件入口", fs.existsSync(path.join(s.profileDir, "plugins", "verify-container", "index.js")));
check("渲染器把**事件写入器**注入了插件同目录（否则插件 import 会失败）",
  fs.existsSync(path.join(s.profileDir, "plugins", "verify-container", "_trace-emit.mjs")));
{
  const patch = fs.readFileSync(path.join(s.profileDir, "cordis.patch.yml"), "utf8");
  check("patch 里有 insert row，且 `name` 指向**入口文件**（指目录会 failed to import）",
    /name: \.\/plugins\/verify-container\/index\.js/.test(patch), patch.split("\n").slice(-4).join(" | "));
}

console.log("\n── B. 审批结果映射（纯函数）──");
{
  const mod = await loadPlugin(s);
  check("allowed-once ⇒ granted", mod.mapOutcome("allowed-once") === "granted");
  check("rejected ⇒ denied", mod.mapOutcome("rejected") === "denied");
  check("cancelled ⇒ denied", mod.mapOutcome("cancelled") === "denied");
  check("unavailable ⇒ unavailable（fail-closed）", mod.mapOutcome("unavailable") === "unavailable");
  check("未知取值 ⇒ unavailable（不猜成放行）", mod.mapOutcome("whatever") === "unavailable");
}

console.log("\n── C. 四种走向 ──");
{
  // 拒绝
  const a = await invoke(s, { approval: { request: async () => "rejected" }, definitionDir: s.agent });
  check("拒绝 ⇒ 不执行（只干跑一次）", calls(s.marker).length === 1 && a.result.kind === "error", JSON.stringify(calls(s.marker)));
  check("拒绝 ⇒ 轨迹记 denied", decisions(s.trace)[0]?.decision === "denied", JSON.stringify(decisions(s.trace)));
  check("事件过统一轨迹 schema", validateEvent(decisions(s.trace)[0] ?? {}), ajv.errorsText(validateEvent.errors));

  // 放行
  const b = await invoke(s, { approval: { request: async () => "allowed-once" }, definitionDir: s.agent });
  const cb = calls(s.marker);
  check("放行 ⇒ 先干跑再真跑", cb.length === 2 && cb[0].rest.includes("--dry-run") && !cb[1].rest.includes("--dry-run"), JSON.stringify(cb));
  check("两次调用第一个位置参数都是**定义目录**", cb.every((x) => x.dir === s.agent), JSON.stringify(cb.map((x) => x.dir)));
  check("放行 ⇒ 轨迹记 granted/answerer=human",
    decisions(s.trace)[0]?.decision === "granted" && decisions(s.trace)[0]?.answerer === "human", JSON.stringify(decisions(s.trace)));
  check("放行 ⇒ 结论文本里有可用与未覆盖", b.result.kind === "success" && /可用/.test(b.result.text) && /未覆盖/.test(b.result.text), String(b.result.text).slice(0, 200));

  // 无审批服务
  const c = await invoke(s, { approval: null, definitionDir: s.agent });
  check("没有审批服务 ⇒ 不执行 + unavailable", calls(s.marker).length === 1 && decisions(s.trace)[0]?.decision === "unavailable",
    JSON.stringify({ calls: calls(s.marker).length, ev: decisions(s.trace) }));

  // 审批 throw
  const d = await invoke(s, { approval: { request: async () => { throw new Error("answerer 崩了"); } }, definitionDir: s.agent });
  check("审批报错 ⇒ 不执行 + unavailable（不是 granted）",
    calls(s.marker).length === 1 && decisions(s.trace)[0]?.decision === "unavailable", JSON.stringify(decisions(s.trace)));
  check("报错原因写进 detail（可归因）", /answerer/.test(decisions(s.trace)[0]?.detail ?? ""), String(decisions(s.trace)[0]?.detail));

  // 缺定义目录（容器会话）
  const e = await invoke(s, { approval: { request: async () => "allowed-once" }, definitionDir: null });
  check("没有定义目录 ⇒ 压根不调受控入口", calls(s.marker).length === 0, JSON.stringify(calls(s.marker)));
  check("并且如实说是容器会话、让去宿主侧", /宿主/.test(e.result.text ?? "") && decisions(s.trace)[0]?.decision === "unavailable", String(e.result.text).slice(0, 160));
}

console.log("\n── D. 干跑失败（受控入口不可用）⇒ fail-closed ──");
{
  const s2 = scaffold({ withGatesEntry: false });
  const f = await invoke(s2, { approval: { request: async () => "allowed-once" }, definitionDir: s2.agent, fresh: true });
  check("受控入口不在 ⇒ 不执行 + unavailable", decisions(s2.trace)[0]?.decision === "unavailable", JSON.stringify(decisions(s2.trace)));
  check("结论里让去宿主侧看原因", /DRY=1|干跑/.test(f.result.text ?? ""), String(f.result.text).slice(0, 160));
}

console.log("\n── E. 静态断言：插件没有「自己拼 docker」的路 ──");
{
  const src = fs.readFileSync(path.join(HERE, "seed", "plugins", "verify-container", "index.js"), "utf8");
  check("源码里没有 `docker run`", !/docker\s+run/.test(src));
  check("源码里没有 --privileged / --cap-add", !/--privileged|--cap-add/.test(src));
  check("源码里没有把宿主根挂进去的写法", !/["'`]\/["'`]\s*:/.test(src));
  check("源码里只调用受控入口（tools/verify-container.mjs）", /verify-container\.mjs/.test(src));
  check("插件声明了 inject: [\"commands\"]（硬依赖声明，不靠运气）", /inject\s*=\s*\["commands"\]/.test(src));
}

console.log("\n── F. 集成：闸门 2 认得这个 row + 真跑没有 import 失败 ──");
{
  const doc = spawnSync(process.execPath, [path.join(HERE, "doctor.mjs"), s.renderDir, "--json"], { encoding: "utf8", cwd: REPO, timeout: 600000 });
  let dj = null;
  try { dj = JSON.parse(doc.stdout); } catch { dj = null; }
  check("闸门 2（doctor）退出码 0", doc.status === 0, `${doc.status} ${(doc.stderr ?? "").slice(-200)}`);
  check("doctor 报告的已加载增强集合含 verify-container",
    JSON.stringify(dj ?? {}).includes("verify-container"), JSON.stringify(dj?.enhancements ?? dj).slice(0, 200));

  const { startFakeGateway } = await import(`file://${path.join(REPO, "tools/fake-gateway/server.mjs")}`);
  const runner = await import(`file://${path.join(HERE, "run.mjs")}`);
  const gateway = await startFakeGateway({ silent: true });
  try {
    const run = await runner.runAgent({ renderDir: s.renderDir, endpoint: gateway.url, prompt: "hi", timeoutMs: 120000, zeroCredential: true });
    check("真跑退出码 0", run.exitCode === 0, String(run.exitCode));
    check("stderr 里没有我们这条插件的 import 失败",
      !/verify-container.*failed to import/.test(String(run.stderr ?? "")),
      String(run.stderr ?? "").split("\n").filter((l) => /verify-container/.test(l)).slice(0, 3).join(" | ").slice(0, 300));
  } finally { await gateway.close?.(); }
}

console.log("");
if (failures) {
  console.log(`❌ dsh 侧 /verify-container 自检：失败 ${failures} 项`);
  process.exit(1);
}
console.log("✅ dsh 侧 /verify-container 自检：全绿");
