// ============================================================================
// `/verify-container` 命令自检（路线图 §30 A6）
//
// 判据：**让 AI 能请求容器验证，但不能绕过审批、也不能自己拿到 docker**。
// 这里逐条把它变成断言：
//   · 拒绝 ⇒ **不执行**，且轨迹里有 `approval.decision decision=denied`
//   · 放行 ⇒ 执行（且**只**调用受控入口），轨迹里 `decision=granted answerer=human`
//   · **无应答者**（非交互）⇒ fail-closed：不执行 + `decision=unavailable`
//   · 容器会话里没有定义目录 ⇒ fail-closed + 明确让人去宿主侧执行
//   · 写出的每个事件都**过统一轨迹 schema**（不是"看起来像"）
//   · **静态断言**：扩展源码里没有直接拼 docker 的路径（`docker run` / `--privileged` / `-v /`）
//
// 用法：node adapters/pi/verify-container-ext-selftest.mjs
// ============================================================================

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const SRC = path.join(HERE, "seed", "extensions", "verify-container.ts");

let failures = 0;
const check = (name, cond, extra = "") => {
  if (!cond) failures++;
  console.log(`${cond ? "✅" : "❌"} ${name}${cond || !extra ? "" : `\n      ${extra}`}`);
};

const ajv = new Ajv2020({ allErrors: true, strict: false });
const validateEvent = ajv.compile(JSON.parse(fs.readFileSync(path.join(REPO, "core/trace/schema.json"), "utf8")));

const DIGEST = `sha256:${"a".repeat(64)}`;

/** 假"受控入口"：把被调用的事实写进 marker，并给出干跑/结论两种 JSON。 */
const FAKE_ENTRY = `import fs from "node:fs";
const [dir, ...rest] = process.argv.slice(2);
const marker = process.env.VC_MARKER;
fs.appendFileSync(marker, JSON.stringify({ dir, rest }) + "\\n");
if (rest.includes("--dry-run")) {
  process.stdout.write(JSON.stringify({ where: "container", image: "agent-base:0.0.0-arm64", arch: "arm64",
    imageDigest: "sha256:" + "b".repeat(64), imageExists: true,
    mounts: [{ src: dir, dst: "/work/agent", mode: "ro", role: "project" },
             { src: "/tmp/art", dst: "/opt/agent-base/artifact", mode: "ro", role: "artifact" }] }) + "\\n");
} else {
  process.stdout.write(JSON.stringify({ where: "container", usable: true, imageDigest: "sha256:" + "b".repeat(64),
    steps: [{ ok: true, label: "闸门 2：解析自证", verdict: "退出码 0" }],
    covered: ["static(agent-only)", "resolution", "probes", "smoke"], notCovered: ["security-floor(C9)"], attribution: null }) + "\\n");
}
`;

/** 每个用例一套独立目录：扩展每次**重新导入**（读当时的 env），避免模块缓存串味。 */
function scaffold({ withDefinition = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vc-ext-"));
  const product = path.join(root, "product");
  fs.mkdirSync(product, { recursive: true });
  fs.copyFileSync(SRC, path.join(product, "verify-container.mjs"));
  fs.copyFileSync(path.join(REPO, "core/trace/emit.mjs"), path.join(product, "_trace-emit.mjs"));

  const gates = path.join(root, "gates", "tools");
  fs.mkdirSync(gates, { recursive: true });
  fs.writeFileSync(path.join(gates, "verify-container.mjs"), FAKE_ENTRY);

  const marker = path.join(root, "calls.jsonl");
  fs.writeFileSync(marker, "");
  const trace = path.join(root, "trace.jsonl");
  const definition = path.join(root, "agent");
  fs.mkdirSync(definition, { recursive: true });
  fs.writeFileSync(path.join(definition, "agent.yaml"), "apiVersion: agent-base/v1\nname: ext-selftest\n");

  const env = {
    ...process.env,
    VC_MARKER: marker,
    AGENT_GATES_DIR: path.join(root, "gates"),
    AGENT_TRACE_DEST: trace,
    AGENT_EFFECTIVE_CONFIG_DIGEST: DIGEST,
    AGENT_NAME: "ext-selftest",
    AGENT_RUN_ID: "run-ext-selftest",
  };
  if (withDefinition) env.AGENT_DEFINITION_DIR = definition;

  // 每个用例**一套 env、用完不还原**（还原会让 handler 里读到的 marker 消失 —— 本轮踩中过）：
  // 反正是逐用例独立目录，串味的风险由"每次重新导入"挡住。
  return { root, product, marker, trace, env, definition, unset: withDefinition ? [] : ["AGENT_DEFINITION_DIR"] };
}

/** 在给定 env 下加载扩展，捕获它注册的命令（每个用例独立导入）。 */
async function load(product, env, unset = []) {
  Object.assign(process.env, env);
  for (const k of unset) delete process.env[k];
  const mod = await import(new URL(`file://${path.join(product, "verify-container.mjs")}?t=${Math.random()}`).href);
  const registered = {};
  const sent = [];
  const fakePi = {
    registerCommand: (name, spec) => { registered[name] = spec; },
    sendMessage: (msg) => { sent.push(msg); },
  };
  mod.default(fakePi);
  return { spec: registered["verify-container"], sent };
}

const calls = (marker) => fs.readFileSync(marker, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
const events = (trace) => fs.existsSync(trace) ? fs.readFileSync(trace, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];

const ctxWith = (confirmImpl) => ({
  ui: { confirm: confirmImpl, notify: () => {} },
  notify: () => {},
});

console.log("── A. 注册与来源 ──");
{
  const s = scaffold();
  const { spec } = await load(s.product, s.env);
  check("命令 `verify-container` 真的注册了", !!spec);
  check("带 description（补全列表里能看出这是干什么的）", typeof spec?.description === "string" && spec.description.length > 8);
}

console.log("\n── B. 明确拒绝 ⇒ 不执行，且决定进轨迹 ──");
{
  const s = scaffold();
  const { spec } = await load(s.product, s.env);
  await spec.handler("", ctxWith(async () => false));
  const c = calls(s.marker);
  check("只调用了干跑（没有真跑）", c.length === 1 && c[0].rest.includes("--dry-run"), JSON.stringify(c));
  const ev = events(s.trace).filter((e) => e.type === "approval.decision");
  check("轨迹里记了 denied", ev.length === 1 && ev[0].decision === "denied", JSON.stringify(ev));
  check("事件过统一轨迹 schema", ev.length === 1 && validateEvent(ev[0]), ajv.errorsText(validateEvent.errors));
}

console.log("\n── C. 放行 ⇒ 执行（且只走受控入口）──");
{
  const s = scaffold();
  const { spec, sent } = await load(s.product, s.env);
  await spec.handler("", ctxWith(async () => true));
  const c = calls(s.marker);
  check("先干跑再真跑（两次调用，第二次不带 --dry-run）",
    c.length === 2 && c[0].rest.includes("--dry-run") && !c[1].rest.includes("--dry-run"), JSON.stringify(c));
  check("两次调用的第一个位置参数都是**定义目录**（不是任意路径）",
    c.every((x) => x.dir === s.definition), JSON.stringify(c.map((x) => x.dir)));
  const ev = events(s.trace).filter((e) => e.type === "approval.decision");
  check("轨迹里记了 granted 且 answerer=human",
    ev.length === 1 && ev[0].decision === "granted" && ev[0].answerer === "human", JSON.stringify(ev));
  const text = sent.map((m) => m.content).join("\n");
  check("结论进了会话（AI/人能看到）", /可用/.test(text) && /闸门 2/.test(text), text.slice(0, 200));
}

console.log("\n── D. 无应答者 ⇒ fail-closed（不执行）──");
{
  const s = scaffold();
  const { spec } = await load(s.product, s.env);
  await spec.handler("", { ui: { notify: () => {} } });
  check("没有 confirm ⇒ 不执行", calls(s.marker).length === 1, JSON.stringify(calls(s.marker)));
  const ev = events(s.trace).filter((e) => e.type === "approval.decision");
  check("轨迹里记了 unavailable（不是 granted/denied）",
    ev.length === 1 && ev[0].decision === "unavailable" && ev[0].answerer === "none", JSON.stringify(ev));
  check("事件过 schema", ev.length === 1 && validateEvent(ev[0]), ajv.errorsText(validateEvent.errors));
}

console.log("\n── E. 容器会话（没有定义目录）⇒ fail-closed ──");
{
  const s = scaffold({ withDefinition: false });
  const { spec, sent } = await load(s.product, s.env, s.unset);
  await spec.handler("", ctxWith(async () => true));
  check("压根没调用受控入口", calls(s.marker).length === 0, JSON.stringify(calls(s.marker)));
  const ev = events(s.trace).filter((e) => e.type === "approval.decision");
  check("轨迹里记了 unavailable，且说明缺定义目录",
    ev.length === 1 && ev[0].decision === "unavailable" && /定义目录/.test(ev[0].detail ?? ""), JSON.stringify(ev));
  const text = sent.map((m) => m.content).join("\n");
  check("会话里明确指出「容器会话属正常、去宿主侧跑」",
    /宿主/.test(text) && /没有跑/.test(text), text.slice(0, 200));
}

console.log("\n── F. 静态断言：扩展没有「自己拼 docker」的路 ──");
{
  const src = fs.readFileSync(SRC, "utf8");
  check("源码里没有 `docker run`", !/docker\s+run/.test(src));
  check("源码里没有 --privileged / --cap-add", !/--privileged|--cap-add/.test(src));
  check("源码里没有把宿主根挂进去的写法", !/["'`]\/["'`]\s*:/.test(src));
  check("源码里只调用受控入口（tools/verify-container.mjs）", /verify-container\.mjs/.test(src));
}

console.log("");
if (failures) {
  console.log(`❌ /verify-container 命令自检：失败 ${failures} 项`);
  process.exit(1);
}
console.log("✅ /verify-container 命令自检：全绿");
process.exit(0);
