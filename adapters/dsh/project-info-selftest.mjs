// ============================================================================
// 本运行时侧 `/project` 自检（路线图 §26 V3）
//
// 判据与另一个运行时的同名命令**同一套**，外加 V3 特有的那条：
//   · 用**同一份自省逻辑**（core）+ **本运行时的布局**产出真报告（几个分类各看一次）
//   · 读不到产物 ⇒ **响亮失败**、不给半份报告（不猜）
//   · 未知分类 ⇒ 明确拒绝并列可用分类（不静默当成"全部"）
//   · **补全**：本运行时的接口没有动态补全 ⇒ 分类清单必须写进 `input.hint`，
//     且这条不对称在 `exemptions.yaml` 里有声明（V3 的要求：做不到就显式声明）
//   · 集成：真渲染产物 + 闸门 2 认得这个 row + 真跑没有 import 失败
//
// 用法：node adapters/dsh/project-info-selftest.mjs
// ============================================================================

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");

let failures = 0;
const check = (name, cond, extra = "") => {
  if (!cond) failures++;
  console.log(`${cond ? "✅" : "❌"} ${name}${cond || !extra ? "" : `\n      ${extra}`}`);
};

/** 造夹具并渲染出**真产物**（自检不依赖仓库里的示例）。 */
function scaffold() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-pi-selftest-"));
  const agent = path.join(root, "agent");
  fs.mkdirSync(path.join(agent, "skills", "alpha"), { recursive: true });
  fs.writeFileSync(path.join(agent, "agent.yaml"),
    "apiVersion: agent-base/v1\nname: pi-selftest-agent\ndescription: 自省自检\n"
    + "persona: { instructions: 自检。 }\nmodel: { provider: corp-gateway, name: corp-think }\nconnectorsFile: connectors.yaml\n");
  fs.writeFileSync(path.join(agent, "connectors.yaml"), "apiVersion: agent-base/v1\nmcpServers: []\n");
  fs.writeFileSync(path.join(agent, "skills", "alpha", "SKILL.md"), "---\nname: alpha\ndescription: 一句话\n---\n正文\n");
  const renderDir = path.join(root, "render");
  const r = spawnSync(process.execPath, [path.join(HERE, "render.mjs"), agent, "--out", renderDir], { encoding: "utf8", cwd: REPO });
  if (r.status !== 0) throw new Error(`渲染失败：${(r.stderr ?? "").slice(-300)}`);
  return { root, agent, renderDir, profileDir: path.join(renderDir, "dsh-home", "profiles", "pi-selftest-agent") };
}

const s = scaffold();
const PLUGIN = path.join(s.profileDir, "plugins", "project-info", "index.js");

/**
 * 用假 ctx 调一次命令。**每次都重新导入**插件：它的依赖在模块加载期读 env，
 * 模块缓存会让后续用例读到旧值（本轮在另一个自检里踩过这个坑）。
 */
async function invoke(rawInput = "", env = {}) {
  const saved = {};
  for (const [k, v] of Object.entries({ AGENT_ARTIFACT_DIR: s.renderDir, AGENT_GATES_DIR: REPO, ...env })) {
    saved[k] = process.env[k];
    if (v === null) delete process.env[k]; else process.env[k] = v;
  }
  try {
    const mod = await import(`file://${PLUGIN}?t=${Math.random()}`);
    let registered = null;
    mod.apply({ commands: { register: (d) => { registered = d; } } });
    const result = registered.handler({ rawInput, agent: { id: "session-1" } });
    return { def: registered, result };
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

console.log("── A. 命令注册与「补全清单的等价物」 ──");
{
  const { def } = await invoke("");
  check("命令 `project` 已注册", !!def);
  check("带 description（会话里能看出这是干什么的）", typeof def?.description === "string" && def.description.length > 8);
  const hint = def?.input?.hint ?? "";
  check("`input.hint` 里列出了全部分类（没有动态补全时的等价物）",
    /overview/.test(hint) && /skills/.test(hint) && /plan/.test(hint), hint);
  check("没有假装支持动态补全（不声明 getArgumentCompletions）", def?.getArgumentCompletions === undefined);
}

console.log("── B. 真报告（同一份自省逻辑 + 本运行时布局）──");
{
  const all = (await invoke("")).result;
  check("整份报告成功返回", all.kind === "success", String(all.text).slice(0, 160));
  check("报告里带智能体名与运行时", /pi-selftest-agent/.test(all.text) && /dsh/.test(all.text));
  const skills = (await invoke("skills")).result;
  check("单分类可用（skills）", skills.kind === "success" && /· alpha/.test(skills.text), String(skills.text).slice(0, 120));
  const plan = (await invoke("plan")).result;
  check("验证计划分类可用（与 `make verify-plan` 同源）", plan.kind === "success" && /验证计划/.test(plan.text), String(plan.text).slice(0, 120));
  const bad = (await invoke("nope")).result;
  check("未知分类 ⇒ 明确拒绝并列可用分类（不静默当全部）",
    bad.kind === "error" && /未知分类/.test(bad.text) && /overview/.test(bad.text), String(bad.text).slice(0, 120));
}

console.log("── C. 读不到产物 ⇒ 响亮失败、不给半份报告 ──");
{
  const missing = (await invoke("", { AGENT_ARTIFACT_DIR: null })).result;
  check("缺产物根 ⇒ 失败并说清缺什么", missing.kind === "error" && /读不到/.test(missing.text), String(missing.text).slice(0, 160));
}

console.log("── D. 不对称已声明（V3 的要求：做不到就说出来）──");
{
  const ex = fs.readFileSync(path.join(HERE, "exemptions.yaml"), "utf8");
  check("`exemptions.yaml` 里有「命令补全做不到」的声明", /command-completions-unavailable/.test(ex));
  check("声明里点名了本侧缺的是什么（hint vs 动态补全）", /hint/.test(ex) && /补全/.test(ex));
}

console.log("── E. 集成：产物就位 + 闸门 2 认得 + 真跑无 import 失败 ──");
{
  for (const f of ["index.js", "package.json", "_project-info.mjs", "_project-layout.mjs", "_container-only.mjs", "_trace-emit.mjs"]) {
    check(`产物里有 ${f}`, fs.existsSync(path.join(s.profileDir, "plugins", "project-info", f)));
  }
  const patch = fs.readFileSync(path.join(s.profileDir, "cordis.patch.yml"), "utf8");
  check("patch 里有该 row 且指向**入口文件**", /name: \.\/plugins\/project-info\/index\.js/.test(patch));

  const doc = spawnSync(process.execPath, [path.join(HERE, "doctor.mjs"), s.renderDir, "--json"], { encoding: "utf8", cwd: REPO, timeout: 600000 });
  check("闸门 2（doctor）退出码 0", doc.status === 0, `${doc.status} ${(doc.stderr ?? "").slice(-200)}`);
  check("doctor 报告的集合里含 project-info", /project-info/.test(doc.stdout ?? ""));

  const { startFakeGateway } = await import(`file://${path.join(REPO, "tools/fake-gateway/server.mjs")}`);
  const runner = await import(`file://${path.join(HERE, "run.mjs")}`);
  const gateway = await startFakeGateway({ silent: true });
  try {
    const run = await runner.runAgent({ renderDir: s.renderDir, endpoint: gateway.url, prompt: "hi", timeoutMs: 120000, zeroCredential: true });
    check("真跑退出码 0", run.exitCode === 0, String(run.exitCode));
    check("stderr 里没有 project-info 的 import 失败",
      !/project-info.*failed to import/.test(String(run.stderr ?? "")),
      String(run.stderr ?? "").split("\n").filter((l) => /project-info/.test(l)).slice(0, 2).join(" | ").slice(0, 240));

    // ---- 交互面：**本运行时的无头模式不派发斜杠命令**（实测边界，不是回归）----
    // 另一个运行时的同名命令能通过 RPC 真敲一次（那边有正向端到端检查）；
    // 这里把斜杠命令当提示词送进去，观察它**没有**被当命令派发 —— 于是交互面只能由 UI 宿主（tui/ACP）验。
    // 把这条写成检查而不是散文的理由：**将来该运行时支持无头派发时它会变红**，那时应升级成正向检查。
    const cmdRun = await runner.runAgent({
      renderDir: s.renderDir, endpoint: gateway.url, prompt: "/project skills", timeoutMs: 120000, zeroCredential: true,
    });
    const commandEvents = cmdRun.native.filter((e) => /command/i.test(String(e?.type ?? "")));
    const reportInOutput = /· alpha/.test(String(cmdRun.stdout ?? ""));
    check("无头模式**没有**把它当命令派发（提示词进了模型）⇒ 交互面需 UI 宿主，属已声明限制",
      cmdRun.exitCode === 0 && commandEvents.length === 0 && !reportInOutput,
      `exit=${cmdRun.exitCode} commandEvents=${commandEvents.length} reportInOutput=${reportInOutput}`);
    if (commandEvents.length || reportInOutput) {
      console.log("    ⚠️ 本运行时开始支持无头派发命令了 —— 请把这条**升级成「真敲一次」的正向检查**（照另一个运行时的做法）");
    }
  } finally { await gateway.close?.(); }
}

console.log("");
if (failures) {
  console.log(`❌ 本运行时 /project 自检：失败 ${failures} 项`);
  process.exit(1);
}
console.log("✅ 本运行时 /project 自检：全绿");
// dsh's native runtime can retain libuv watchers after its child session exits.
// End the selftest explicitly so CI does not wait on runtime-owned handles.
process.exit(0);
