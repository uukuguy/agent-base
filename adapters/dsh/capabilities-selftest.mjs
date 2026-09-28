// ============================================================================
// 能力通用桥自检（本运行时侧，D-0013）
//
// 与另一个运行时的同名自检**同一套判据、各自的注册形状**。要证的：
//   ① 产物布局：能力目录在**产物根**、清单是构建期生成的 JSON、插件里有共享调用模块
//   ② **桥是通用的**：桥源码里不出现任何具体能力名（逐条比对，不是自觉）
//   ③ **产物根算对了**：清单读得到（读不到会静默返回空 ⇒ 能力凭空消失，必须有检查盯路径）
//   ④ **假 ctx 真注册**：`apply()` 注册出的工具名集合 == 清单里的名字集合；`execute` 真能调到实现
//   ⑤ **真跑**：端点收到的请求里按名字带着这两把工具（工具数也比基线多）
//   ⑥ 闸门 2 的集合断言覆盖这个桥；坏描述挡在渲染期
//
// 用法：node adapters/dsh/capabilities-selftest.mjs
// ============================================================================

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { loadCapabilities, sameSemantics } from "../../core/capabilities/registry.mjs";
import { startFakeGateway } from "../../tools/fake-gateway/server.mjs";
import YAML from "yaml";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");

let failures = 0;
const check = (name, cond, extra = "") => {
  if (!cond) failures++;
  console.log(`${cond ? "✅" : "❌"} ${name}${cond || !extra ? "" : `\n      ${String(extra).slice(0, 400)}`}`);
};

const PY_CAP = "risk_band";
const JS_CAP = "material_gap";

function scaffold({ withCaps = true, breakIt = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-cap-selftest-"));
  const agent = path.join(root, "agent");
  fs.mkdirSync(agent, { recursive: true });
  fs.writeFileSync(path.join(agent, "agent.yaml"),
    "apiVersion: agent-base/v1\nname: cap-selftest\ndescription: 能力桥自检\n"
    + "persona: { instructions: 自检。 }\nmodel: { provider: corp-gateway, name: corp-think }\nconnectorsFile: connectors.yaml\n");
  fs.writeFileSync(path.join(agent, "connectors.yaml"), "apiVersion: agent-base/v1\nmcpServers: []\n");
  // 本运行时的暂存要求产物**完整**（清单的 runtimePlan.copy 声明了 skills）：
  // 夹具不放技能 ⇒ 暂存期就响亮失败"产物里缺 skills"（这条失败是对的，是夹具不完整）。
  const skill = path.join(agent, "skills", "alpha");
  fs.mkdirSync(skill, { recursive: true });
  fs.writeFileSync(path.join(skill, "SKILL.md"), "---\nname: alpha\ndescription: 夹具技能\n---\n正文\n");
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

const s = scaffold();
const profile = path.join(s.out, "dsh-home", "profiles", "cap-selftest");
const pluginDir = path.join(profile, "plugins", "capabilities");

console.log("── A. 产物布局（能力在产物根，插件在 profile 里）──");
check("渲染成功", s.renderStatus === 0, s.renderErr.slice(-400));
for (const f of ["capabilities/index.json", "capabilities/risk-band.yaml", "capabilities/risk_band.py",
  "capabilities/material-gap.yaml", "capabilities/material_gap.mjs",
  "dsh-home/profiles/cap-selftest/plugins/capabilities/index.js",
  "dsh-home/profiles/cap-selftest/plugins/capabilities/_capabilities.mjs"]) {
  check(`产物里有 ${f}`, fs.existsSync(path.join(s.out, f)));
}
const index = JSON.parse(fs.readFileSync(path.join(s.out, "capabilities/index.json"), "utf8"));
check("index.json 里两份能力都在", index.capabilities.length === 2, JSON.stringify(index.capabilities.map((c) => c.name)));
check("patch 里的 row 指向**入口文件**（不是目录）",
  /name: \.\/plugins\/capabilities\/index\.js/.test(fs.readFileSync(path.join(profile, "cordis.patch.yml"), "utf8")));

console.log("── B. **桥是通用的** + 产物根算对了 ──");
const bridgeSrc = fs.readFileSync(path.join(pluginDir, "index.js"), "utf8");
for (const name of [PY_CAP, JS_CAP]) check(`桥源码里没有出现能力名 ${name}`, !bridgeSrc.includes(name));
check("桥没有裸导入 yaml（产物里解析不到）", !/from\s+"yaml"/.test(bridgeSrc));

const bridge = await import(`file://${pluginDir}/index.js?t=${Math.random()}`);
check("**产物根算对了**：直接读清单能读到（不是空）", bridge.readCapabilityIndex().length === 2,
  JSON.stringify(bridge.readCapabilityIndex().map((c) => c.name)));
check("清单路径就是产物根下的 capabilities/index.json",
  path.resolve(pluginDir, "../../../../..") === s.out, path.resolve(pluginDir, "../../../../.."));

console.log("── C. 假 ctx 真注册：注册出的名字 == 清单里的名字 ──");
{
  const registered = new Map();
  const ctx = { tools: { register: (def) => registered.set(def.name, def) } };
  bridge.apply(ctx, { capsDir: path.join(s.out, "capabilities") });
  const names = [...registered.keys()].sort();
  check("注册出的工具名集合 == 清单里的名字集合", JSON.stringify(names) === JSON.stringify([JS_CAP, PY_CAP].sort()), JSON.stringify(names));
  const def = registered.get(PY_CAP);
  check("注册项带 description（模型看得到它干什么）", typeof def?.description === "string" && def.description.length > 8);
  check("参数转成了本运行时的 DSL：required 标记在（不是原样塞 JSON Schema）",
    def?.parameters?.surfaces?.required === true, JSON.stringify(def?.parameters));
  check("output.render 是函数（注册接口要求，缺了会抛 TypeError）", typeof def?.output?.render === "function");
  const out = await def.execute({ surfaces: ["a", "b"] });
  check("execute 真调到实现（进程边界）", out?.text === "score=60", JSON.stringify(out));
  check("output.render 能把结果渲染成模型可读文本",
    JSON.stringify(def.output.render({}, out)) === JSON.stringify([{ type: "text", text: "score=60" }]));
  const jsDef = registered.get(JS_CAP);
  const jsOut = await jsDef.execute({ surfaces: ["a", "b"] });
  const pyOut = await def.execute({ surfaces: ["a", "b"] });
  const sem = sameSemantics({ ...pyOut, refused: false, details: { score: 60 } }, { ...jsOut, refused: false, details: { score: 60 } });
  check("两条通道经本运行时的注册项调用，语义一致", sem.same, sem.reasons.join("；"));
  const refused = await def.execute({ surfaces: [] });
  check("拒答经注册项也如实传出去（refused=true）", refused?.refused === true && /拒答/.test(refused.text ?? ""), JSON.stringify(refused));
}

console.log("── D. 闸门 2 覆盖这个桥 ──");
{
  const doc = spawnSync(process.execPath, [path.join(HERE, "doctor.mjs"), s.out, "--json"], { encoding: "utf8", cwd: REPO, timeout: 600000 });
  check("doctor 退出码 0", doc.status === 0, `${doc.status} ${(doc.stderr ?? "").slice(-200)}`);
  check("doctor 的集合断言里含 capabilities", /"capabilities"/.test(doc.stdout ?? ""));
}

console.log("── E. **真跑**：端点收到的请求里带着这两把工具 ──");
{
  const gateway = await startFakeGateway({ silent: true });
  const namesFrom = (from) => new Set(gateway.traceLines.slice(from)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((e) => e?.type === "model.request").flatMap((e) => e.toolNames ?? []));
  try {
    const fromWith = gateway.traceLines.length;
    const runner = await import(`file://${path.join(HERE, "run.mjs")}`);
    const withCaps = await runner.runAgent({ renderDir: s.out, endpoint: gateway.url, prompt: "hi", timeoutMs: 120000, zeroCredential: true });
    const namesWith = namesFrom(fromWith);
    check("有能力的产物真跑退出码 0", withCaps.exitCode === 0, String(withCaps.exitCode));
    check("端点收到的请求里带这两把工具（按名字）",
      namesWith.has(PY_CAP) && namesWith.has(JS_CAP), JSON.stringify([...namesWith]));

    const base = scaffold({ withCaps: false });
    const fromBase = gateway.traceLines.length;
    const without = await runner.runAgent({ renderDir: base.out, endpoint: gateway.url, prompt: "hi", timeoutMs: 120000, zeroCredential: true });
    const namesBase = namesFrom(fromBase);
    check("基线真跑退出码 0", without.exitCode === 0, String(without.exitCode));
    check("基线端点请求里**没有**这两个名字（增量才算证据）",
      !namesBase.has(PY_CAP) && !namesBase.has(JS_CAP), JSON.stringify([...namesBase]));
  } finally { await gateway.close?.(); }
}

console.log("── F. 坏描述挡在渲染期 ──");
{
  const bad = scaffold({ breakIt: true });
  check("坏描述 ⇒ 渲染失败", bad.renderStatus !== 0, `status=${bad.renderStatus}`);
  check("失败信息点明哪份描述/哪条规则", /能力描述有问题/.test(bad.renderErr) && /bad/.test(bad.renderErr), bad.renderErr.slice(-300));
}

console.log("");
if (failures) {
  console.log(`❌ 能力通用桥自检（本运行时）：失败 ${failures} 项`);
  process.exit(1);
}
console.log("✅ 能力通用桥自检（本运行时）：全绿");
