// ============================================================================
// 会话内项目自省命令自检（路线图 §26 V1 的验收证据）
//
// 判据是"这条命令说的事**必须是真的、且随项目变**"：
//   · 声明了什么就报什么（技能/连接器/增强/钩子事件都从产物现算，不是硬编码文案）
//   · **补全即目录**：一级补分类，二级补该项目里真实存在的值（删一个技能 ⇒ 补全项跟着少）
//   · 钩子事件名会**真的对名字**：写错的名字被标红（不假装通过）
//   · 读不到产物就**响亮失败**，不给半份报告
//   · 命令真的出现在运行时里（`get_commands` 取证），而不是"我们以为注册了"
//
// 两层证据刻意分开：
//   A. **纯逻辑**：直接 import `_project-info.mjs`（不起 pi、不需要终端，快且确定）
//   B. **真运行时**：真渲染 → 真起 pi → `get_commands` 里必须有 `project`（source=extension）
//
// 用法：node adapters/pi/project-info-selftest.mjs  （或 make project-info-selftest）
// ============================================================================

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { CATEGORIES, collect, complete, render } from "../../core/introspect/project-info.mjs";
// 本运行时的产物读法：与真实扩展**同一份**（自省逻辑运行时无关，读法由适配器给）
import { projectLayout } from "./project-layout.mjs";
import { piRpc, stageRenderDir } from "./run.mjs";
import { localPlatformEnv } from "../../core/image/platform-env.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");

let failures = 0;
const check = (name, cond, extra = "") => {
  if (!cond) failures++;
  console.log(`${cond ? "✅" : "❌"} ${name}${cond || !extra ? "" : `\n      ${extra}`}`);
};

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

/** 造一个最小智能体定义并渲染出真产物（走的是`render.mjs`本身，不是自检里另写一份渲染）。 */
function renderAgent({ name, skills = ["alpha", "beta"], hookEnhancement = null } = {}) {
  const agent = path.join(tmp("pi-agent-"), "agent");
  fs.mkdirSync(path.join(agent, "skills"), { recursive: true });
  fs.writeFileSync(path.join(agent, "agent.yaml"),
    `apiVersion: agent-base/v1\nname: ${name}\ndescription: 自省命令自检\npersona: { instructions: 自检。 }\n`
    + `model: { provider: corp-gateway, name: corp-think }\nconnectorsFile: connectors.yaml\n`);
  fs.writeFileSync(path.join(agent, "connectors.yaml"), "apiVersion: agent-base/v1\nmcpServers: []\n");
  for (const s of skills) {
    fs.mkdirSync(path.join(agent, "skills", s), { recursive: true });
    fs.writeFileSync(path.join(agent, "skills", s, "SKILL.md"),
      `---\nname: ${s}\ndescription: 技能 ${s} 的一句话\n---\n正文\n`);
  }
  if (hookEnhancement) {
    const dir = path.join(agent, "harness", "pi");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "enhancements.yaml"), hookEnhancement);
  }
  const out = path.join(tmp("pi-out-"), "render");
  const r = spawnSync(process.execPath, [path.join(HERE, "render.mjs"), agent, "--out", out, "--json"],
    { encoding: "utf8", cwd: REPO });
  if (r.status !== 0) throw new Error(`render 失败：${(r.stderr ?? "").slice(-400)}`);
  return { out, agentDir: agent, productDir: path.join(out, "agent-dir") };
}

/** 跑闸门 1，取它对可移植性的结论文本（用来证明我们与它**同源**，而不是各说一套）。
 *  注意：人读报告走 stderr，stdout 只放 `--json` —— 所以这里按 JSON 取，别去 grep 文本。 */
function gatePortability(agentDir) {
  const r = spawnSync(process.execPath, [path.join(REPO, "tools/validate.mjs"), agentDir, "--json"],
    { encoding: "utf8", cwd: REPO });
  try {
    const j = JSON.parse(r.stdout);
    const c = (j.gates ?? []).flatMap((g) => g.checks ?? []).find((x) => x.id === "portability/report");
    return (c?.detail ?? "").replace(/^本智能体可移植性：/, "") || null;
  } catch { return null; }
}

const env = (productDir, artifactDir) => ({
  ...process.env,
  HOME: tmp("pi-home-"),
  PI_CODING_AGENT_DIR: productDir,
  AGENT_ARTIFACT_DIR: artifactDir,
  AGENT_GATES_DIR: REPO,
  PI_OFFLINE: "1",
  AGENT_EFFECTIVE_CONFIG_DIGEST: `sha256:${"b".repeat(64)}`,
});

// ---------------------------------------------------------------------------
// A. 纯逻辑（真产物）
// ---------------------------------------------------------------------------
console.log("── A. 纯逻辑：命令说的必须是真的 ──");

const two = renderAgent({ name: "selftest-two", skills: ["alpha", "beta"] });
const facts = collect({ productDir: two.productDir, artifactDir: two.out, gatesDir: REPO, layout: projectLayout });
check("产物齐全时 collect 无 problem", facts.problems.length === 0, facts.problems.join("；"));

const skillsText = render("skills", facts);
check("skills 报出产物里真实存在的两个技能",
  skillsText.includes("alpha") && skillsText.includes("beta"), skillsText.slice(0, 200));
const skillsText2 = render("skills", facts);   // 幂等
check("同一输入渲染两次结果相同（可复算）", skillsText === skillsText2);

// 定义变了 ⇒ 输出跟着变（这条就是"不是硬编码文案"的证据）
const one = renderAgent({ name: "selftest-one", skills: ["alpha"] });
const oneFacts = collect({ productDir: one.productDir, artifactDir: one.out, gatesDir: REPO, layout: projectLayout });
const oneSkills = render("skills", oneFacts);
check("删掉一个技能 ⇒ 输出里它消失（不是硬编码文案）",
  !oneSkills.includes("beta") && oneSkills.includes("alpha"), oneSkills.slice(0, 200));

// 补全：一级是分类目录，二级是真实值
const cats = complete("", facts).map((c) => c.value);
check("一级补全 = 分类目录（「一个项目应该有哪些信息」）",
  CATEGORIES.every((c) => cats.includes(c.name)) && cats.length === CATEGORIES.length, cats.join(","));
const catItems = complete("", facts);
check("补全项带说明（否则用户不知道每个分类是什么）",
  catItems.every((c) => typeof c.description === "string" && c.description.length > 0));
const lvl2 = complete("skills ", facts).map((c) => c.value).sort();
check("二级补全 = 产物里真实的技能名", JSON.stringify(lvl2) === JSON.stringify(["alpha", "beta"]), lvl2.join(","));
const lvl2filtered = complete("skills a", facts).map((c) => c.value);
check("二级补全按前缀过滤", JSON.stringify(lvl2filtered) === JSON.stringify(["alpha"]), lvl2filtered.join(","));
const enhLvl2 = complete("enhancements ", facts).map((c) => c.value);
check("增强补全含基座不变量（trace 与自省命令本身都在产物里）",
  enhLvl2.includes("trace") && enhLvl2.includes("project-info"), enhLvl2.join(","));

// 模型信息：只打印引用名
const modelText = render("model", facts);
check("模型信息只给引用名，不打印值", modelText.includes("${") && !/\bsk-/.test(modelText), modelText);

// 轨迹：事件类型从 schema 现算（**不写死数字** —— 写死就会在加类型时过期，本轮加了 approval.decision）
const traceText = render("trace", facts);
const schemaEventTypes = Object.keys(JSON.parse(fs.readFileSync(path.join(REPO, "core/trace/schema.json"), "utf8")).$defs.typed.oneOf).length;
check(`轨迹报出 ${schemaEventTypes} 类事件（从 core/trace/schema.json 现算）`, new RegExp(`${schemaEventTypes} 类`).test(traceText), traceText);

// 钩子事件名核对：正确的事件名 ✅
const good = renderAgent({
  name: "selftest-hook-ok", skills: ["alpha"],
  hookEnhancement: "apiVersion: agent-base/v1\nharness: pi\nenhancements:\n  - kind: hook\n    id: probe-hook\n    entry: extensions/hook.ts\n    events: [tool_call]\n",
});
const goodFacts = collect({ productDir: good.productDir, artifactDir: good.out, gatesDir: REPO, layout: projectLayout });
check("钩子订阅真事件 ⇒ 报 ✅ 且在集合内", /✅ 订阅的 \d+ 个事件都在集合内/.test(render("hooks", goodFacts)),
  render("hooks", goodFacts));

// 钩子事件名核对：写错的名字必须被标红（**不许假装通过**）
const bad = renderAgent({
  name: "selftest-hook-bad", skills: ["alpha"],
  hookEnhancement: "apiVersion: agent-base/v1\nharness: pi\nenhancements:\n  - kind: hook\n    id: probe-hook\n    entry: extensions/hook.ts\n    events: [tool_calls]\n",
});
const badFacts = collect({ productDir: bad.productDir, artifactDir: bad.out, gatesDir: REPO, layout: projectLayout });
check("钩子订阅不存在的事件 ⇒ 报 ❌ 并点名该事件",
  /❌/.test(render("hooks", badFacts)) && render("hooks", badFacts).includes("tool_calls"),
  render("hooks", badFacts));

// 读不到产物 ⇒ 响亮失败（不给半份报告）
const missing = collect({ productDir: path.join(os.tmpdir(), "pi-does-not-exist-xyz"), artifactDir: null, gatesDir: REPO });
check("产物不存在 ⇒ problems 非空（调用方据此响亮失败）", missing.problems.length >= 1 && /读不到渲染清单/.test(missing.problems.join("；")), JSON.stringify(missing.problems));
const empty = collect({});   // 什么都不知道时：交给调用方响亮失败
check("没给产物目录 ⇒ problems 非空并说明原因", empty.problems.length === 1, JSON.stringify(empty.problems));
check("未知分类给出可用分类列表", /未知分类/.test(render("nope", facts)));

// 本地入口（run-local）的环境必须**足够让本命令工作** —— 本轮真踩中：
// 容器入口会给 AGENT_ARTIFACT_DIR，而 run-local 自己手搓 env 漏了它 ⇒ 会话里报"读不到渲染清单"。
// 这里按 run-local 的**同一套拼装方式**（布局契约 + platform-env）重建一次，断言命令能读到清单。
{
  const staged = stageRenderDir(two.out, null, { zeroCredential: true });
  const localEnv = {
    ...staged.env,
    ...localPlatformEnv({ renderDir: two.out, runDir: staged.runDir }),
  };
  const productDir = localEnv.PI_CODING_AGENT_DIR ?? staged.staging;
  check("本地入口的 env 里有 AGENT_ARTIFACT_DIR 与 AGENT_GATES_DIR（少 = 容器能用、本地不能用）",
    !!localEnv.AGENT_ARTIFACT_DIR && !!localEnv.AGENT_GATES_DIR,
    JSON.stringify({ ARTIFACT: localEnv.AGENT_ARTIFACT_DIR, GATES: localEnv.AGENT_GATES_DIR }));
  check("AGENT_ARTIFACT_DIR 真的指向含渲染清单的产物根",
    fs.existsSync(path.join(localEnv.AGENT_ARTIFACT_DIR ?? "/nonexistent", "render-manifest.json")),
    String(localEnv.AGENT_ARTIFACT_DIR));
  const localFacts = collect({ productDir, artifactDir: localEnv.AGENT_ARTIFACT_DIR, gatesDir: localEnv.AGENT_GATES_DIR });
  check("用本地入口的 env 调本命令 ⇒ 读得到声明（本轮用户报的就是这条失败）",
    localFacts.problems.length === 0, localFacts.problems.join("；"));
  check("布局契约带出了运行时配置目录变量（不在这里手搓）",
    Object.values(staged.env ?? {}).some((v) => String(v).includes("agent-dir")),
    JSON.stringify(staged.env));
}

// 可移植性：必须与**闸门 1 同源**（基座不变量不算这个智能体引入的不可移植性）
const portNoBiz = render("portability", facts);
const gateNoBiz = gatePortability(two.agentDir);
check("无可移植性增强时：命令与闸门 1 都判「可移植」",
  /^核心（可移植/.test(portNoBiz) && /^核心（可移植/.test(gateNoBiz ?? ""),
  `命令=${portNoBiz.split("\n")[0]}\n      闸门1=${gateNoBiz}`);
const portBiz = render("portability", goodFacts);
const gateBiz = gatePortability(good.agentDir);
check("有业务增强时：命令与闸门 1 都判「不可移植」且点名同一个增强",
  /不可移植/.test(portBiz) && /不可移植/.test(gateBiz ?? "") && portBiz.includes("probe-hook") && (gateBiz ?? "").includes("pi"),
  `命令=${portBiz.split("\n")[0]}\n      闸门1=${gateBiz}`);

// ---------------------------------------------------------------------------
// B. 真运行时：命令必须真的出现在会话里
// ---------------------------------------------------------------------------
console.log("── B. 真运行时：命令真的注册了（get_commands 取证）──");

const integration = await (async () => {
  if (process.env.SKIP_PI_RUNTIME === "1") return { skipped: true };
  const staged = stageRenderDir(two.out, null, { zeroCredential: true });
  const rpc = await piRpc({
    env: env(staged.staging, two.out),
    cwd: os.tmpdir(),
    staging: staged.staging,
    requests: [{ id: "c1", type: "get_commands" }],
  });
  const cmds = rpc.responses.get("get_commands")?.data?.commands ?? [];
  return { skipped: false, complete: rpc.complete, cmds };
})();

if (integration.skipped) {
  console.log("⏭  跳过真运行时检查（SKIP_PI_RUNTIME=1）—— 这**不算通过**，只是没验");
} else {
  const mine = integration.cmds.filter((c) => c.name === "project");
  check("会话里有 `project` 命令", mine.length === 1, integration.cmds.map((c) => `${c.name}[${c.source}]`).join(", "));
  check("它的 source 是 extension（不是 skill/内建）", mine[0]?.source === "extension", String(mine[0]?.source));
  check("它带 description（补全列表里能看出这是干什么的）",
    typeof mine[0]?.description === "string" && mine[0].description.length > 0, String(mine[0]?.description));
  // ---- 端到端：**真敲一次命令**（RPC 发 `/project skills`）----
  // 只验"注册了"是不够的：注册了但 handler 不产出、或产出的东西不是那份报告，用户照样用不了。
  // 用 `untilMessage` 命中注入的自定义消息即可收工（不必等超时）。
  const e2e = await (async () => {
    const staged2 = stageRenderDir(two.out, null, { zeroCredential: true });
    const rpc2 = await piRpc({
      env: env(staged2.staging, two.out),
      cwd: os.tmpdir(),
      staging: staged2.staging,
      requests: [{ id: "p1", type: "prompt", message: "/project skills" }],
      timeoutMs: 30000,
      untilMessage: (r) => r?.type === "message_start" && r?.message?.customType === "agent-base.project-info",
    });
    return rpc2.messages.filter((m) => m?.message?.customType === "agent-base.project-info");
  })();
  const report = String(e2e[0]?.message?.content ?? "");
  check("真敲 `/project skills` ⇒ 会话里出现那份报告（端到端）", e2e.length === 1 && /alpha/.test(report), report.slice(0, 200));
  check("报告里说的是真实事实（技能名来自产物、不是模板）", /· alpha/.test(report) && /SKILL\.md/.test(report), report.slice(0, 200));

  const helper = integration.cmds.filter((c) => c.name.includes("_project-info"));
  check("助手文件 `_project-info.mjs` **没有**被当成扩展登记", helper.length === 0, helper.map((c) => c.name).join(","));

  // 受控容器验证命令（§30 A6）：它是**审批门**，所以只在真运行时里确认"确实注册进来了"
  // （审批走向由 `verify-container-ext-selftest` 覆盖；这里只防"声明了但没加载"）。
  const vc = integration.cmds.filter((c) => c.name === "verify-container");
  check("会话里有 `verify-container` 命令（审批门）", vc.length === 1, integration.cmds.map((c) => c.name).join(", "));
  check("它的 source 也是 extension 且带 description",
    vc[0]?.source === "extension" && typeof vc[0]?.description === "string" && vc[0].description.length > 0,
    JSON.stringify(vc[0] ?? null));
}

console.log("");
if (failures) {
  console.log(`❌ 项目自省命令自检：失败 ${failures} 项`);
  process.exit(1);
}
console.log("✅ 项目自省命令自检：全绿");
