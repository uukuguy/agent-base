// ============================================================================
// 能力通用桥自检（本运行时侧，D-0013）
//
// 要证的：
//   ① 产物布局：描述 + 实现 + `index.json` + 桥 + 共享模块都在位（**运行期只读 JSON**，不裸导入 yaml）
//   ② **桥是通用的**：桥的源码里**不出现任何具体能力名**（出现一个，它就不是桥了 —— 逐条比对，不是自觉）
//   ③ **真注册**：真跑一次会话，工具数比"没有能力"的基线**多出能力个数**（不是"我们写了注册代码"）
//   ④ **真能调**：从产物里按描述调用，两条通道（进程内 / 进程边界）语义一致
//   ⑤ 坏描述**挡在渲染期**（不等到运行期才发现）
//   ⑥ 闸门 2 的集合断言覆盖这个桥（基座不给自己开后门）
//
// 用法：node adapters/pi/capabilities-selftest.mjs
// ============================================================================

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { invokeCapability, loadCapabilities, sameSemantics } from "../../core/capabilities/registry.mjs";
import { runAgent } from "./run.mjs";
import { startFakeGateway } from "../../tools/fake-gateway/server.mjs";
import YAML from "yaml";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");

let failures = 0;
const check = (name, cond, extra = "") => {
  if (!cond) failures++;
  console.log(`${cond ? "✅" : "❌"} ${name}${cond || !extra ? "" : `\n      ${String(extra).slice(0, 400)}`}`);
};

const PY_CAP = "risk_band";        // 进程边界通道
const JS_CAP = "material_gap";     // 进程内通道

/** 造夹具；`withCaps=false` 时不给 capabilities/（用作"工具数基线"）。 */
function scaffold({ withCaps = true, breakIt = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cap-selftest-"));
  const agent = path.join(root, "agent");
  fs.mkdirSync(agent, { recursive: true });
  fs.writeFileSync(path.join(agent, "agent.yaml"),
    "apiVersion: agent-base/v1\nname: cap-selftest\ndescription: 能力桥自检\n"
    + "persona: { instructions: 自检。 }\nmodel: { provider: corp-gateway, name: corp-think }\nconnectorsFile: connectors.yaml\n");
  fs.writeFileSync(path.join(agent, "connectors.yaml"), "apiVersion: agent-base/v1\nmcpServers: []\n");
  if (withCaps) {
    const caps = path.join(agent, "capabilities");
    fs.mkdirSync(caps, { recursive: true });
    const doc = (name, label, execution) => `apiVersion: agent-base/v1
name: ${name}
label: ${label}
description: ${label}（确定性、可复算）。
parameters:
  type: object
  additionalProperties: false
  properties:
    surfaces: { type: array, items: { type: string } }
  required: [surfaces]
result: { type: object, required: [score] }
execution: ${JSON.stringify(execution)}
declaration: { deterministic: true, sideEffects: none, version: "2026-09-28" }
${breakIt && name === PY_CAP ? "  bad: true\n" : ""}`;
    // 进程边界：Python
    fs.writeFileSync(path.join(caps, `${PY_CAP.replace("_", "-")}.yaml`),
      doc(PY_CAP, "风险档位", { kind: "process", runtime: "python", entry: "risk_band.py", timeoutMs: 5000 }));
    fs.writeFileSync(path.join(caps, "risk_band.py"), `import json, sys
params = json.loads(sys.stdin.read() or "{}")
surfaces = params.get("surfaces") or []
if not surfaces:
    print(json.dumps({"refused": True, "text": "拒答：缺少 surfaces", "details": {"missing": ["surfaces"]}}, ensure_ascii=False)); sys.exit(0)
score = min(100, len(surfaces) * 30)
print(json.dumps({"text": "score=%d" % score, "details": {"score": score}}, ensure_ascii=False))
`);
    // 进程内：JS
    fs.writeFileSync(path.join(caps, `${JS_CAP.replace("_", "-")}.yaml`),
      doc(JS_CAP, "材料缺口", { kind: "module", entry: "material_gap.mjs", timeoutMs: 5000 }));
    fs.writeFileSync(path.join(caps, "material_gap.mjs"), `export function run(params = {}) {
  const surfaces = Array.isArray(params.surfaces) ? params.surfaces : [];
  if (surfaces.length === 0) return { refused: true, text: "拒答：缺少 surfaces", details: { missing: ["surfaces"] } };
  return { text: "score=" + Math.min(100, surfaces.length * 30), details: { score: Math.min(100, surfaces.length * 30) } };
}
`);
  }
  const out = path.join(root, "render");
  const r = spawnSync(process.execPath, [path.join(HERE, "render.mjs"), agent, "--out", out], { encoding: "utf8", cwd: REPO });
  return { root, agent, out, renderStatus: r.status, renderErr: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

/**
 * 取一次运行的**轨迹事件**。取证要读契约规定的落点（轨迹文件），不要去猜它写到哪个流：
 * 本轮先只看 stdout 得到 -1（假结论"工具数没变"），改成 stdout+stderr 仍是 -1。
 */
function traceEvents(run) {
  const file = run.traceFile && fs.existsSync(run.traceFile) ? run.traceFile : null;
  if (!file) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

const s = scaffold();
const product = path.join(s.out, "agent-dir");

console.log("── A. 产物布局（运行期只读 JSON，不裸导入 yaml）──");
check("渲染成功", s.renderStatus === 0, s.renderErr.slice(-400));
for (const f of [`capabilities/index.json`, `capabilities/risk-band.yaml`, `capabilities/risk_band.py`,
  `capabilities/material-gap.yaml`, `capabilities/material_gap.mjs`, `extensions/capabilities.ts`, `extensions/_capabilities.mjs`]) {
  check(`产物里有 ${f}`, fs.existsSync(path.join(product, f)));
}
const index = JSON.parse(fs.readFileSync(path.join(product, "capabilities/index.json"), "utf8"));
check("index.json 里两份能力都在（构建期由 YAML 生成）", index.capabilities.length === 2, JSON.stringify(index.capabilities.map((c) => c.name)));
check("index.json 不含 YAML 源码里的注解字段（纯文档）",
  index.capabilities.every((c) => Object.keys(c).every((k) => !k.startsWith("__"))));
const bridgeSrc = fs.readFileSync(path.join(product, "extensions/capabilities.ts"), "utf8");
check("桥**没有**裸导入 yaml（产物里解析不到）", !/from\s+"yaml"/.test(bridgeSrc));

console.log("── B. **桥是通用的**：源码里不出现任何具体能力名 ──");
for (const name of [PY_CAP, JS_CAP]) {
  check(`桥源码里没有出现能力名 ${name}`, !bridgeSrc.includes(name));
}
check("桥是按清单遍历注册的（不是逐个手写）", /for \(const entry of entries\)/.test(bridgeSrc) && /pi\.registerTool\(/.test(bridgeSrc));

console.log("── C. 闸门 2 覆盖这个桥（基座不给自己开后门）──");
{
  const doc = spawnSync(process.execPath, [path.join(HERE, "doctor.mjs"), s.out, "--json"], { encoding: "utf8", cwd: REPO, timeout: 600000 });
  check("doctor 退出码 0", doc.status === 0, `${doc.status} ${(doc.stderr ?? "").slice(-200)}`);
  check("doctor 的集合断言里含 capabilities（桥已被声明）", /"capabilities"/.test(doc.stdout ?? ""));
}

console.log("── D. **真注册**：真跑一次，工具数比基线多出能力个数 ──");
{
  const gateway = await startFakeGateway({ silent: true });
  // ⚠️ 取证要读**轨迹文件**，不要去猜它写到哪个流：本轮先只看 stdout 得到 -1（假结论
  // "工具数没变"），改成 stdout+stderr 仍是 -1 —— 轨迹实际落在 `run.traceFile`（JSONL）。
  // 教训：观测点要指向**契约规定的落点**（轨迹文件），而不是"顺手能捕获的流"。
  const observe = async (renderDir) => {
    // ⚠️ 同一个网关跑两次时，它的轨迹是**累积**的：必须只取"本次新增的行"，
    // 否则第一次运行的记录会污染第二次的结论（本轮实测踩到：底线里出现了上一次的工具名）。
    const from = gateway.traceLines.length;
    const run = await runAgent({ renderDir, endpoint: gateway.url, prompt: "hi", timeoutMs: 120000, zeroCredential: true });
    const events = traceEvents(run).filter((e) => e?.type === "model.request");
    const tools = events.map((e) => e.tools ?? 0);
    // 端点侧（假网关自己的轨迹）：收到的每次请求里带了哪些工具名
    const endpointNames = new Set(gateway.traceLines.slice(from).map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((e) => e?.type === "model.request").flatMap((e) => e.toolNames ?? []));
    return { exit: run.exitCode, tools: tools.length ? Math.max(...tools) : -1, endpointNames: [...endpointNames] };
  };
  try {
    const withCaps = await observe(s.out);
    const base = scaffold({ withCaps: false });
    const without = await observe(base.out);
    check("两侧真跑都成功", withCaps.exit === 0 && without.exit === 0, `${withCaps.exit}/${without.exit}`);
    check("基线拿到工具数", without.tools > 0, JSON.stringify(without.tools));
    check(`有能力的产物工具数 = 基线 + 2（${without.tools} → ${withCaps.tools}）`,
      withCaps.tools === without.tools + 2, JSON.stringify({ withCaps: withCaps.tools, without: without.tools }));

    // "模型被提供了哪几把工具"是**端点侧**的事实：假网关把收到的请求记在自己的轨迹里
    // （`toolNames`，本轮新加的加法字段）。用它而不是从 agent 侧推 —— 端点看到的才是模型看到的。
    check("有能力的产物里，**端点收到的请求确实提供了这两把工具**（按名字，不只是计数）",
      withCaps.endpointNames.includes(PY_CAP) && withCaps.endpointNames.includes(JS_CAP),
      JSON.stringify(withCaps.endpointNames));
    check("基线的端点请求里**没有**这两个名字",
      !without.endpointNames.includes(PY_CAP) && !without.endpointNames.includes(JS_CAP),
      JSON.stringify(without.endpointNames));
  } finally { await gateway.close?.(); }
}

console.log("── E. **真能调**：从产物按描述调用，两条通道语义一致 ──");
{
  const loaded = loadCapabilities(s.agent, { yamlParse: (t) => YAML.parse(t) });
  const py = loaded.capabilities.find((c) => c.name === PY_CAP);
  const js = loaded.capabilities.find((c) => c.name === JS_CAP);
  const params = { surfaces: ["a", "b"] };
  const rPy = await invokeCapability(py, params, { cwd: path.join(product, "capabilities") });
  const rJs = await invokeCapability(js, params, { cwd: path.join(product, "capabilities") });
  check("进程边界通道调用成功", rPy.ok && rPy.details?.score === 60, JSON.stringify(rPy));
  check("进程内通道调用成功", rJs.ok && rJs.details?.score === 60, JSON.stringify(rJs));
  const sem = sameSemantics(rPy, rJs);
  check("两条通道语义一致", sem.same, sem.reasons.join("；"));
  const refused = await invokeCapability(py, { surfaces: [] }, { cwd: path.join(product, "capabilities") });
  check("拒答语义经产物调用同样成立", refused.ok === true && refused.refused === true, JSON.stringify(refused));
}

console.log("── F. 坏描述挡在**渲染期**（不等到运行期）──");
{
  const bad = scaffold({ breakIt: true });
  check("坏描述 ⇒ 渲染失败", bad.renderStatus !== 0, `status=${bad.renderStatus}`);
  check("失败信息点明是哪个文件/哪条规则", /能力描述有问题/.test(bad.renderErr) && /additionalProperties|bad/.test(bad.renderErr), bad.renderErr.slice(-300));
}

console.log("── G. 真调用：模型请求工具时，桥真的把活干了（能走通就走通）──");
{
  // 假网关会调用**工具表里的第一个**工具（§6.4）。若第一个正好是我们的能力，
  // 就能拿到"真调用"的端到端证据；若不是，**如实说明没验到**（不假装）。
  const gateway = await startFakeGateway({ silent: true });
  try {
    const run = await runAgent({
      renderDir: s.out, endpoint: gateway.url, prompt: "hi", timeoutMs: 120000, zeroCredential: true,
      toolArgs: { [PY_CAP]: { surfaces: ["a", "b"] } },
    });
    const events = traceEvents(run);
    const called = events.filter((e) => e?.type === "tool_call").map((e) => e?.tool ?? e?.name).filter(Boolean);
    const ours = called.filter((n) => n === PY_CAP || n === JS_CAP);
    if (ours.length === 0) {
      console.log(`⏭  本轮没验到"能力被真调用"：模型这一轮调用的是 ${JSON.stringify(called)}（网关只调工具表第一个，与顺序有关）—— **没验 ≠ 通过**`);
    } else {
      const results = events.filter((e) => e?.type === "tool_result" && (e?.tool === ours[0]));
      check(`能力 ${ours[0]} 被模型真的调用了`, ours.length >= 1, JSON.stringify(called));
      check("调用有结果回来（桥真的执行了实现）", results.length >= 1, JSON.stringify(results).slice(0, 300));
      check("退出码 0（没有把能力错误当成会话失败）", run.exitCode === 0, String(run.exitCode));
    }
  } finally { await gateway.close?.(); }
}

console.log("");
if (failures) {
  console.log(`❌ 能力通用桥自检：失败 ${failures} 项`);
  process.exit(1);
}
console.log("✅ 能力通用桥自检：全绿");
