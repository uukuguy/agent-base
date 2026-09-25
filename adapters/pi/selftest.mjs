// ============================================================================
// pi 适配器自检（包 S2 的验收证据）
//
// 走真实链路：render（真渲染）→ doctor（真跑 harness，零凭据）→ 负向样本必须变红。
// 判据不是"函数返回了值"，而是 S2 的包级验收那几条：
//   ① make render 确定性（同输入两次同 digest）
//   ② doctor 输出 §6.3 七个字段 + 三条硬断言
//   ③ 静默失败必须被抓到（C5 的检测力：泄漏的技能、被钳位的推理强度）
//
// 用法：node adapters/pi/selftest.mjs  （或 make pi-selftest）
// ============================================================================

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { EXIT_CODES } from "../../core/gates/index.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");

let failures = 0;
const check = (name, cond, extra = "") => {
  if (!cond) failures++;
  console.log(`${cond ? "✅" : "❌"} ${name}${cond || !extra ? "" : `\n      ${extra}`}`);
};

const run = (args) => spawnSync(process.execPath, args, { encoding: "utf8", cwd: REPO });

/** 造一个不含连接器的智能体定义（连了连接器时 render 本就该失败，那是另一条负向样本）。 */
function makeAgent(dir, { thinkingLevel } = {}) {
  fs.mkdirSync(path.join(dir, "skills", "example"), { recursive: true });
  fs.writeFileSync(path.join(dir, "agent.yaml"), [
    "apiVersion: agent-base/v1",
    `name: ${path.basename(dir).toLowerCase().replace(/[^a-z0-9-]/g, "-")}`,
    "description: 适配器自检用",
    "persona: { instructions: 只给可验证的结论。 }",
    `model: { route: corp-gateway, name: corp-think${thinkingLevel ? `, reasoningEffort: ${thinkingLevel}` : ""} }`,
    "tools: { deny: [bash] }",
    "",
  ].join("\n"));
  fs.writeFileSync(path.join(dir, "connectors.yaml"), "apiVersion: agent-base/v1\nmcpServers: []\n");
  fs.writeFileSync(path.join(dir, "skills", "example", "SKILL.md"),
    "---\nname: example\ndescription: 示例技能\nwhenToUse: 用户要求演示时\n---\n正文\n");
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-adapter-selftest-"));
const agent = path.join(tmp, "agent");
makeAgent(agent);

// ---------------------------------------------------------------------------
console.log("── ① render：确定性（同输入 → 同 digest，N19 / C2）──");
const r1 = run(["adapters/pi/render.mjs", agent, "--out", path.join(tmp, "out-a"), "--json"]);
const r2 = run(["adapters/pi/render.mjs", agent, "--out", path.join(tmp, "out-b"), "--json"]);
check("render 退出码 0", r1.status === 0, r1.stderr?.slice(-300));
check("render 两次成功", r1.status === 0 && r2.status === 0);
const d1 = JSON.parse(r1.stdout || "{}").artifactsDigest;
const d2 = JSON.parse(r2.stdout || "{}").artifactsDigest;
check("跨输出路径 digest 相同", !!d1 && d1 === d2, `${d1} vs ${d2}`);
check("产物含 agent-dir / settings / models 模板 / manifest",
  ["agent-dir/settings.json", "agent-dir/models.json.tmpl", "agent-dir/AGENTS.md", "render-manifest.json"]
    .every((f) => fs.existsSync(path.join(tmp, "out-a", f))));
check("渲染不做模型配置解析（模板留待启动期，参数下放）",
  fs.readFileSync(path.join(tmp, "out-a", "agent-dir/models.json.tmpl"), "utf8").includes("${CORP_GATEWAY_BASE_URL}"));
check("tools.deny 进 manifest 的运行参数（不烤进 settings）",
  JSON.parse(fs.readFileSync(path.join(tmp, "out-a", "render-manifest.json"), "utf8")).runArgs.excludeTools.join() === "bash");

// ---------------------------------------------------------------------------
console.log("\n── ② doctor：真跑 harness，零凭据，七个字段 + 三条硬断言 ──");
const doc = run(["adapters/pi/doctor.mjs", path.join(tmp, "out-a"), "--json"]);
check("doctor 退出码 0", doc.status === 0, doc.stderr?.slice(-500));
let payload = {};
try { payload = JSON.parse(doc.stdout || "{}"); } catch { /* 下面会报 */ }
const seven = ["harness", "version", "definitionPath", "skills", "connectors", "enhancements", "modelRoutes", "effectiveConfigDigest"];
check("doctor 输出七个必含字段", seven.every((k) => k in (payload.doctor ?? {})), Object.keys(payload.doctor ?? {}).join(","));
check("skills 是实际加载的集合（== 声明）", JSON.stringify(payload.doctor?.skills) === '["example"]', JSON.stringify(payload.doctor?.skills));
check("三条硬断言全部通过",
  ["resolution/skills-set", "resolution/connectors-set", "resolution/enhancements-set"]
    .every((id) => payload.gate?.gates?.[0]?.checks?.some((c) => c.id === id && c.status === "pass")),
  JSON.stringify(payload.gate?.gates?.[0]?.checks?.map((c) => [c.id, c.status])));
check("doctor 在暂存副本上跑（产物保持干净，摘要仍可复算）",
  payload.doctor?.definitionPath !== path.join(tmp, "out-a", "agent-dir"));

// ---------------------------------------------------------------------------
console.log("\n── ③ 静默失败必须被抓到（C5 的检测力）──");
{
  const leak = path.join(tmp, "out-leak");
  fs.cpSync(path.join(tmp, "out-a"), leak, { recursive: true });
  fs.mkdirSync(path.join(leak, "agent-dir", "skills", "leaked"), { recursive: true });
  fs.writeFileSync(path.join(leak, "agent-dir", "skills", "leaked", "SKILL.md"),
    "---\nname: leaked\ndescription: 混进来的技能\n---\n正文\n");
  const r = run(["adapters/pi/doctor.mjs", leak]);
  check("多出来的技能 → doctor 失败（退出码 20）", r.status === EXIT_CODES.resolution, `退出码 ${r.status}`);
  check("失败信息点出「多了一项」", /多 1 项.*leaked|leaked/.test(r.stderr ?? ""), (r.stderr ?? "").slice(-300));
}
{
  const agent2 = path.join(tmp, "agent-th");
  makeAgent(agent2, { thinkingLevel: "high" });
  const out2 = path.join(tmp, "out-th");
  run(["adapters/pi/render.mjs", agent2, "--out", out2]);
  const r = run(["adapters/pi/doctor.mjs", out2]);
  check("推理强度被静默钳位 → doctor 失败（退出码 20）", r.status === EXIT_CODES.resolution, `退出码 ${r.status}`);
  check("失败信息点明「声明了 vs 实际生效」", /声明了 high/.test(r.stderr ?? "") && /实际生效 off/.test(r.stderr ?? ""), (r.stderr ?? "").slice(-300));
}
{
  const agent3 = path.join(tmp, "agent-conn");
  makeAgent(agent3);
  fs.writeFileSync(path.join(agent3, "connectors.yaml"),
    "apiVersion: agent-base/v1\nmcpServers:\n  - ref: filesystem\n    enabled: true\n");
  const r = run(["adapters/pi/render.mjs", agent3, "--out", path.join(tmp, "out-conn")]);
  check("声明了连接器 → render 响亮失败（不产出假的成功）", r.status === EXIT_CODES.static, `退出码 ${r.status}`);
  check("失败信息说明原因并给出后续动作", /MCP/.test(r.stderr ?? "") && /preinstall|research/.test(r.stderr ?? ""), (r.stderr ?? "").slice(-400));
}

console.log(`\n${failures === 0 ? "pi 适配器自检：全绿" : `pi 适配器自检：失败 ${failures} 项`}`);
process.exit(failures === 0 ? EXIT_CODES.ok : 1);
