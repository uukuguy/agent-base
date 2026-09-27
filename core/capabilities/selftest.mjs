// ============================================================================
// 能力描述与双通道自检（D-0012 / D-0018 决定 A2）
//
// 一定要证的三件事：
//   ① 描述能被**按契约调用**：同一份描述，进程内（JS）与进程边界（Python）都能跑出结果
//   ② **两条通道语义一致**：同一入参 ⇒ 同样的 score/level、同样的拒答、同样的键集合
//      （A2 的代价就在这：两套执行机制，一致性必须由自检守，而不是"看起来一样"）
//   ③ **坏描述响亮失败**：名字重复 / entry 不存在 / module 通道塞 .py / deterministic=false 不给复现手段
//
// 用法：node core/capabilities/selftest.mjs
// ============================================================================

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

import { loadCapabilities, checkImplementation, toSchemaDocument, invokeCapability, normalizeResult, sameSemantics, RUNTIMES } from "./registry.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
let failures = 0;
const check = (name, cond, extra = "") => {
  if (!cond) failures++;
  console.log(`${cond ? "✅" : "❌"} ${name}${cond || !extra ? "" : `\n      ${String(extra).slice(0, 400)}`}`);
};

const yamlParse = (s) => YAML.parse(s);

// ---------------------------------------------------------------------------
// 夹具：**同一份规则的两条实现**（JS 进程内 / Python 进程边界）
// 规则故意很小但要覆盖：正常算分、关键事实缺失 ⇒ 拒答、输入非法 ⇒ 退出码 2
// ---------------------------------------------------------------------------
const root = fs.mkdtempSync(path.join(os.tmpdir(), "capability-selftest-"));
const capsDir = path.join(root, "capabilities");
fs.mkdirSync(capsDir, { recursive: true });

const PARAMS = {
  type: "object",
  additionalProperties: false,
  properties: {
    surfaces: { type: "array", items: { type: "string" } },
    dataMigration: { type: "boolean" },
  },
  required: ["surfaces"],
};
const RESULT = { type: "object", required: ["score", "level"] };

const common = (name, execution) => `apiVersion: agent-base/v1
name: ${name}
label: 风险评分（${execution.kind}）
description: 用固定权重给一次变更打分；关键事实缺失时拒答（确定性、可复算）。
parameters:
${JSON.stringify(PARAMS, null, 2).split("\n").map((l) => "  " + l).join("\n")}
result:
${JSON.stringify(RESULT, null, 2).split("\n").map((l) => "  " + l).join("\n")}
execution:
${JSON.stringify(execution, null, 2).split("\n").map((l) => "  " + l).join("\n")}
declaration:
  deterministic: true
  sideEffects: none
  version: "2026-09-28"
`;

fs.writeFileSync(path.join(capsDir, "risk-js.yaml"), common("risk_score_js", { kind: "module", entry: "risk.mjs", timeoutMs: 5000 }));
fs.writeFileSync(path.join(capsDir, "risk-py.yaml"), common("risk_score_py", { kind: "process", runtime: "python", entry: "risk.py", timeoutMs: 5000 }));

// 同一份规则，两种写法：权重、阈值、拒答条件都必须一模一样
fs.writeFileSync(path.join(capsDir, "risk.mjs"), `export function run(params = {}) {
  const surfaces = Array.isArray(params.surfaces) ? params.surfaces : [];
  if (surfaces.length === 0) {
    return { refused: true, text: "拒答：缺少 surfaces（这次变更动了什么）", details: { missing: ["surfaces"] } };
  }
  const score = Math.min(100, surfaces.length * 30 + (params.dataMigration === true ? 20 : 0));
  const level = score >= 60 ? "high" : score >= 30 ? "medium" : "low";
  const details = { score, level };
  return { text: JSON.stringify(details), details };
}
`);

fs.writeFileSync(path.join(capsDir, "risk.py"), `import json, sys

def main():
    raw = sys.stdin.read() or "{}"
    try:
        params = json.loads(raw)
    except Exception:
        print("参数不是合法 JSON", file=sys.stderr)
        return 2
    if not isinstance(params, dict):
        print("参数必须是对象", file=sys.stderr)
        return 2
    surfaces = params.get("surfaces") or []
    if not isinstance(surfaces, list) or len(surfaces) == 0:
        print(json.dumps({"refused": True, "text": "拒答：缺少 surfaces（这次变更动了什么）", "details": {"missing": ["surfaces"]}}, ensure_ascii=False))
        return 0
    score = min(100, len(surfaces) * 30 + (20 if params.get("dataMigration") is True else 0))
    level = "high" if score >= 60 else ("medium" if score >= 30 else "low")
    details = {"score": score, "level": level}
    print(json.dumps({"text": json.dumps(details, ensure_ascii=False), "details": details}, ensure_ascii=False))
    return 0

if __name__ == "__main__":
    sys.exit(main())
`);

// ---------------------------------------------------------------------------
console.log("── A. 装载与形状校验 ──");
const loaded = loadCapabilities(root, { yamlParse });
check("两份描述都被装载", loaded.capabilities.length === 2, JSON.stringify(loaded.problems));
check("装载无问题", loaded.problems.length === 0, loaded.problems.join("；"));
check("两份实现都就位（entry 存在、扩展名与通道相符）",
  loaded.capabilities.every((c) => checkImplementation(c).length === 0),
  JSON.stringify(loaded.capabilities.map((c) => checkImplementation(c))));

const js = loaded.capabilities.find((c) => c.name === "risk_score_js");
const py = loaded.capabilities.find((c) => c.name === "risk_score_py");

console.log("── B. 两条通道各自能跑 ──");
const NORMAL = { surfaces: ["a", "b"], dataMigration: false };
const rJs = await invokeCapability(js, NORMAL);
const rPy = await invokeCapability(py, NORMAL);
check("进程内（JS）跑出结果", rJs.ok && rJs.details?.score === 60, JSON.stringify(rJs));
check("进程边界（Python）跑出结果", rPy.ok && rPy.details?.score === 60, JSON.stringify(rPy));
check("通道被如实标出（没有被当成同一条）", rJs.channel === "module" && rPy.channel === "process", `${rJs.channel}/${rPy.channel}`);

console.log("── C. **两条通道语义一致**（A2 的代价就靠这条守）──");
{
  const sem = sameSemantics(rJs, rPy);
  check("语义一致（details 深比较 + refused + 两边都有 text）", sem.same, sem.reasons.join("；"));
  // 反过来验：details 不同必须被判为不一致（否则这条判据是空的）
  const fake = sameSemantics(rJs, { ...rPy, details: { score: 999, level: "low" } });
  check("details 不同 ⇒ 判为不一致（判据本身有效）", fake.same === false && /details 不同/.test(fake.reasons.join("；")));
  const fake2 = sameSemantics(rJs, { ...rPy, refused: true });
  check("refused 不同 ⇒ 判为不一致", fake2.same === false && /refused 不同/.test(fake2.reasons.join("；")));
}
for (const params of [{ surfaces: ["a"] }, { surfaces: ["a", "b", "c"], dataMigration: true }]) {
  const a = await invokeCapability(js, params);
  const b = await invokeCapability(py, params);
  check(`同一入参（${JSON.stringify(params)}）两通道结果一致`, JSON.stringify(a.details) === JSON.stringify(b.details), `${JSON.stringify(a.details)} vs ${JSON.stringify(b.details)}`);
}

console.log("── D. 拒答语义两条通道一致 ──");
const refJs = await invokeCapability(js, { surfaces: [] });
const refPy = await invokeCapability(py, { surfaces: [] });
check("进程内拒答 ⇒ refused=true 且不猜", refJs.ok === true && refJs.refused === true && /拒答/.test(refJs.text), JSON.stringify(refJs));
check("进程边界拒答 ⇒ 同样成立", refPy.ok === true && refPy.refused === true && /拒答/.test(refPy.text), JSON.stringify(refPy));
check("两条通道的拒答文本一致", refJs.text === refPy.text, `${refJs.text} vs ${refPy.text}`);

console.log("── E. 实现出错 ⇒ 响亮失败（不静默吞）──");
fs.writeFileSync(path.join(capsDir, "boom.py"), "import sys\nprint('内部炸了', file=sys.stderr)\nsys.exit(3)\n");
const boomCap = { ...py, name: "boom", execution: { kind: "process", runtime: "python", entry: "boom.py", timeoutMs: 5000 }, __file: path.join(capsDir, "boom.yaml") };
const boom = await invokeCapability(boomCap, NORMAL);
check("非零退出 ⇒ ok=false 且带退出码", boom.ok === false && /退出码 3/.test(boom.error ?? ""), JSON.stringify(boom));
check("stderr 被原样带回", /内部炸了/.test(boom.stderr ?? ""), boom.stderr);

// 坏输入（退出码 2 是"输入不合契约"的专用码）
fs.writeFileSync(path.join(capsDir, "exit2.py"), "import sys\nprint('参数不对', file=sys.stderr)\nsys.exit(2)\n");
const bad2 = await invokeCapability({ ...boomCap, name: "bad2", execution: { kind: "process", runtime: "python", entry: "exit2.py" } }, NORMAL);
check("退出码 2 ⇒ 明确说「输入不合契约」", bad2.ok === false && /输入不合契约/.test(bad2.error ?? ""), JSON.stringify(bad2));

// 超时
fs.writeFileSync(path.join(capsDir, "slow.py"), "import time\ntime.sleep(30)\n");
const slow = await invokeCapability({ ...boomCap, name: "slow", execution: { kind: "process", runtime: "python", entry: "slow.py", timeoutMs: 400 } }, NORMAL);
check("超时 ⇒ 杀掉并按失败处理", slow.ok === false && /超时/.test(slow.error ?? ""), JSON.stringify(slow));

// stdout 不是 JSON
fs.writeFileSync(path.join(capsDir, "noise.py"), "print('不是 JSON')\n");
const noise = await invokeCapability({ ...boomCap, name: "noise", execution: { kind: "process", runtime: "python", entry: "noise.py" } }, NORMAL);
check("stdout 不是 JSON ⇒ 明确报错", noise.ok === false && /不是合法 JSON/.test(noise.error ?? ""), JSON.stringify(noise));

console.log("── F. 坏描述要被拦住（闸门 1 用的同一条规则）──");
const badDir = fs.mkdtempSync(path.join(os.tmpdir(), "capability-bad-"));
const badCaps = path.join(badDir, "capabilities");
fs.mkdirSync(badCaps, { recursive: true });
const write = (f, body) => fs.writeFileSync(path.join(badCaps, f), body);
write("dup.yaml", common("same_name", { kind: "module", entry: "risk.mjs" }));
write("dup2.yaml", common("same_name", { kind: "module", entry: "risk.mjs" }));
write("noentry.yaml", common("no_entry", { kind: "module", entry: "missing.mjs" }));
fs.writeFileSync(path.join(badCaps, "risk.mjs"), "export function run() { return { text: 'x' }; }\n");
fs.writeFileSync(path.join(badCaps, "risk.py"), "print('{}')\n");
write("wrongchan.yaml", common("wrong_channel", { kind: "module", entry: "risk.py" }));
write("nondet.yaml", common("non_deterministic", { kind: "module", entry: "risk.mjs" }).replace("deterministic: true", "deterministic: false"));
const bad = loadCapabilities(badDir, { yamlParse });
const allProblems = [...bad.problems, ...bad.capabilities.flatMap((c) => checkImplementation(c).map((p) => `${c.name}: ${p}`))];
check("同名两份描述被拦住", allProblems.some((p) => /重复/.test(p)), allProblems.join(" | "));
check("entry 不存在被拦住", allProblems.some((p) => /不存在/.test(p)), allProblems.join(" | "));
check("module 通道塞 .py 被拦住（其他语言必须走 process）", allProblems.some((p) => /kind=module/.test(p)), allProblems.join(" | "));
check("deterministic=false 不给复现手段被拦住", allProblems.some((p) => /reproducibility/.test(p)), allProblems.join(" | "));

console.log("── G. 内部注解不进 schema 校验（否则正例会被自己绊倒）──");
{
  const raw = loaded.capabilities[0];
  check("装载会挂内部注解（file/rel）", raw.__file !== undefined && raw.__rel !== undefined);
  const clean = toSchemaDocument(raw);
  check("纯文档里没有任何 `__` 注解", Object.keys(clean).every((k) => !k.startsWith("__")), Object.keys(clean).join(","));
  check("纯文档保留了真字段（name/execution 还在）", clean.name === raw.name && !!clean.execution);
}

console.log("── H. 解释器表是单一真源（协议只认这几个）──");
check("runtime 表至少含 node/python/shell", ["node", "python", "shell"].every((k) => RUNTIMES[k]), Object.keys(RUNTIMES).join(","));
check("未声明的 runtime 被拒绝", (await invokeCapability({ ...boomCap, execution: { kind: "process", runtime: "ruby", entry: "x.rb" } }, {})).ok === false);

console.log("── I. 归一化：字符串/空返回不会炸 ──");
check("实现返回字符串 ⇒ 当成 text", normalizeResult("hello").text === "hello" && normalizeResult("hello").refused === false);
check("实现返回 null ⇒ 标为 declined（调用方据此响亮失败）", normalizeResult(null).declined === true);
check("没有 text 的返回不会伪造文案", normalizeResult({ details: { a: 1 } }).text.length > 0 && normalizeResult({ details: { a: 1 } }).details.a === 1);

console.log("");
if (failures) {
  console.log(`❌ 能力描述自检：失败 ${failures} 项`);
  process.exit(1);
}
console.log("✅ 能力描述自检：全绿");
