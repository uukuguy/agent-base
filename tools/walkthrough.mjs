#!/usr/bin/env node
// ============================================================================
// 开发场景演练（真实开发循环，不是"跑一下示例"）
//
// ## 为什么单独有这个工具
//
// 基座自带的**样子示例**（可整体删除的那份）跑的是零凭据假网关，回答"这东西长什么样"。
// 要验证"基座各项功能在真实开发场景下能不能用"，得走开发者实际会走的循环：
//
//   派生 → 写定义 → 闸门拦住写错的东西 → 改对 → 渲染 → 本地真跑 → 装容器 → 跨运行时比对
//
// 这个工具把这条循环**真的走一遍**，并把每一步的证据打出来（功能 × 证据 × 结论）。
// 默认全部离线（零凭据假网关），不花任何额度；加 `WALKTHROUGH_LIVE=1` 再打真实端点。
//
// 用法：
//   node tools/walkthrough.mjs [--keep] [--json]
//   ENDPOINT=https://… API_KEY=… WALKTHROUGH_LIVE=1 node tools/walkthrough.mjs
//
// 与"自带的示例目录"的分工见 docs/12-dev-walkthrough.md。
//
// 退出码：0 = 离线闭环全过（不能判定的项会标明"需真实端点"）；1 = 有失败。
// ============================================================================

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { EXIT_CODES, parseArgs } from "../core/gates/index.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const { flags } = parseArgs(process.argv.slice(2));
const KEEP = flags.has("--keep");
const LIVE = process.env.WALKTHROUGH_LIVE === "1";
const ENDPOINT = process.env.ENDPOINT ?? null;
const API_KEY = process.env.API_KEY ?? null;

const steps = [];
let failed = 0;
const record = (feature, evidence, ok, note = "") => {
  steps.push({ feature, evidence, ok, note });
  const mark = ok === true ? "✅" : ok === "skip" ? "➖" : "❌";
  process.stdout.write(`${mark} ${feature}\n     ${evidence}${note ? `\n     ${note}` : ""}\n`);
  if (ok === false) failed += 1;
};

const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { cwd: REPO, encoding: "utf8", ...opts });

/**
 * 从输出里取出 JSON 对象。工具的 JSON 可能是**多行缩进**的（startup prepare 就是），
 * 也可能前后夹着日志 —— 所以先整体试，再退回到"第一个 { 到最后一个 }"的切片。
 */
function lastJson(text) {
  const raw = String(text ?? "");
  try { return JSON.parse(raw.trim()); } catch { /* 继续 */ }
  const a = raw.indexOf("{");
  const b = raw.lastIndexOf("}");
  if (a >= 0 && b > a) {
    try { return JSON.parse(raw.slice(a, b + 1)); } catch { /* 继续 */ }
  }
  return null;
}
const node = (args, opts = {}) => run(process.execPath, args, opts);

const work = fs.mkdtempSync(path.join(os.tmpdir(), "walkthrough-"));
const agentDir = path.join(work, "prod-agent");
process.stdout.write(`\n演练工作区：${work}${KEEP ? "（--keep：保留）" : ""}\nLIVE=${LIVE ? "开" : "关（离线闭环）"}\n\n`);

// ─────────────────────────────────────────────── ① 派生一个真实智能体
{
  const r = node([path.join(HERE, "new-agent.mjs"), "--name", "prod-agent", "--description", "演练：把想法变成可验证的东西", "--out", agentDir]);
  const wanted = ["agent.yaml", "connectors.yaml", "Makefile", "README.md", "skills"];
  const missing = wanted.filter((f) => !fs.existsSync(path.join(agentDir, f)));
  record("派生：new-agent 产出可用骨架（含 Makefile，派生者不必碰基座）",
    `${r.status === 0 ? "命令成功" : `命令退出码 ${r.status}`}；产出 ${wanted.length - missing.length}/${wanted.length} 项`,
    r.status === 0 && missing.length === 0, missing.length ? `缺：${missing.join(", ")}` : "");
}

// ─────────────────────────────────────────────── ② 像开发者那样改定义
const agentYaml = path.join(agentDir, "agent.yaml");
const read = (f) => fs.readFileSync(path.join(agentDir, f), "utf8");
const write = (f, s) => fs.writeFileSync(path.join(agentDir, f), s);
{
  // 加一个自己的技能
  const sk = path.join(agentDir, "skills", "domain-notes");
  fs.mkdirSync(sk, { recursive: true });
  fs.writeFileSync(path.join(sk, "SKILL.md"), "---\nname: domain-notes\ndescription: 记录领域判断\n---\n\n正文：把判断写清楚，能验证的才写。\n");
  // 技能是**目录发现**（不是定义里的清单字段）—— 这正是开发者实际要做的事
  let s = read("agent.yaml").replace("model:", "tools:\n  deny: [bash]\n\nmodel:");
  write("agent.yaml", s);
  const ok = /deny: \[bash\]/.test(read("agent.yaml")) && fs.existsSync(path.join(sk, "SKILL.md"));
  record("改定义：加一个自己的技能（skills/<名>/SKILL.md 目录发现）+ 工具边界 deny",
    "新建 skills/domain-notes/SKILL.md；agent.yaml 新增 tools.deny: [bash]（技能不在定义里列清单）", ok);
}

// ─────────────────────────────────────────────── ③ 闸门必须拦住写错的东西
{
  const bad = read("agent.yaml").replace("name: corp-think", "name: no-such-model");
  write("agent.yaml", bad);
  const r = node([path.join(HERE, "validate.mjs"), agentDir]);
  const listed = /corp-think/.test(`${r.stdout}${r.stderr}`);
  record("闸门 1 真的管事：模型名写错当场失败，并列出可用取值",
    `退出码 ${r.status}（期望非 0）；报错里${listed ? "有" : "没有"}可用取值`, r.status !== 0 && listed);

  // 引用不存在的技能
  write("agent.yaml", read("agent.yaml").replace("  - domain-notes", "  - not-a-skill"));
  const r2 = node([path.join(HERE, "validate.mjs"), agentDir]);
  record("闸门 1 真的管事：引用不存在的技能当场失败",
    `退出码 ${r2.status}（期望非 0）`, r2.status !== 0);

  // 改回正确
  let s = read("agent.yaml").replace("name: no-such-model", "name: corp-think").replace("  - not-a-skill", "  - domain-notes");
  write("agent.yaml", s);
  const r3 = node([path.join(HERE, "validate.mjs"), agentDir]);
  record("改对之后闸门 1 全绿", `退出码 ${r3.status}（期望 0）`, r3.status === 0);
}

// ─────────────────────────────────────────────── ④ 渲染：确定性与产物
const renderDir = path.join(work, "render");
{
  const r1 = node([path.join(REPO, "adapters/pi/render.mjs"), agentDir, "--out", renderDir]);
  const digest1 = (fs.existsSync(path.join(renderDir, "render-manifest.json"))
    ? JSON.parse(fs.readFileSync(path.join(renderDir, "render-manifest.json"), "utf8")).artifactsDigest : null);
  const renderDir2 = `${renderDir}-2`;
  node([path.join(REPO, "adapters/pi/render.mjs"), agentDir, "--out", renderDir2]);
  const digest2 = JSON.parse(fs.readFileSync(path.join(renderDir2, "render-manifest.json"), "utf8")).artifactsDigest;
  record("渲染：确定性（同一定义渲两次 digest 相同）",
    `${digest1?.slice(0, 22)}… vs ${digest2.slice(0, 22)}…`, r1.status === 0 && digest1 === digest2);
  const manifest = JSON.parse(fs.readFileSync(path.join(renderDir, "render-manifest.json"), "utf8"));
  record("渲染：产物自带运行期参数契约（端点/凭据/模型名三种引用名）",
    `runtimeParams = ${(manifest.runtimeParams ?? []).map((p) => p.name).join(", ")}`,
    (manifest.runtimeParams ?? []).length >= 3);
  const skills = manifest.declaredSkills ?? [];
  const excluded = manifest.runArgs?.excludeTools ?? [];
  record("渲染：自己的技能被收进产物、工具边界生效（不看定义文件，看渲染清单）",
    `declaredSkills = ${JSON.stringify(skills)}；excludeTools = ${JSON.stringify(excluded)}`,
    skills.includes("domain-notes") && excluded.includes("bash"));
}

// ─────────────────────────────────────────────── ⑤ 闸门 2/3/4（离线，零凭据假网关）
{
  for (const [label, tool] of [["闸门 2 解析自证", `adapters/pi/doctor.mjs`], ["闸门 3 集成探针", "tools/probe.mjs"], ["闸门 4 端到端冒烟", "tools/smoke.mjs"]]) {
    const r = node([path.join(REPO, tool), renderDir, "--json", "--harness", "pi"]);
    const ok = r.status === EXIT_CODES.ok;
    const rep = lastJson(r.stdout);
    const checks = (rep?.gates ?? []).flatMap((g) => g.checks ?? []);
    const detail = checks.length
      ? `${checks.filter((c) => c.status === "pass").length} 项通过（退出码 ${r.status}）`
      : `退出码 ${r.status}`;
    record(`${label}（离线）`, detail, ok, ok ? "" : (r.stderr ?? "").trim().split("\n").slice(-2).join(" "));
  }
}

// ─────────────────────────────────────────────── ⑥ 运行期参数的四种给法
{
  // 实测（startup prepare 的 params[].source）：env / file:<路径> / secrets-dir:<路径> / definition-default
  const cases = [
    ["环境变量", "env"],
    ["变量文件（_FILE）", "file"],
    ["凭据目录（AGENT_SECRETS_DIR）", "secrets-dir"],
  ];
  const tmpFiles = path.join(work, "secrets");
  fs.mkdirSync(tmpFiles, { recursive: true });
  fs.writeFileSync(path.join(tmpFiles, "CORP_GATEWAY_API_KEY"), "k-from-secretsdir");
  fs.writeFileSync(path.join(work, "key.txt"), "k-from-file\n");

  const results = [];
  for (const [label, expectPrefix] of cases) {
    const runDir = path.join(work, `stage-${expectPrefix}`);
    const env = { ...process.env };
    delete env.CORP_GATEWAY_API_KEY;
    delete env.CORP_GATEWAY_API_KEY_FILE;
    delete env.AGENT_SECRETS_DIR;
    // 端点是被测参数之外的必填项：每次都给，否则失败原因会变成"缺端点"而不是被测的那条路径
    env.CORP_GATEWAY_BASE_URL = "http://127.0.0.1:9/v1";
    if (expectPrefix === "env") env.CORP_GATEWAY_API_KEY = "k-from-env";
    if (expectPrefix === "file") env.CORP_GATEWAY_API_KEY_FILE = path.join(work, "key.txt");
    if (expectPrefix === "secrets-dir") env.AGENT_SECRETS_DIR = tmpFiles;
    const r = node([path.join(REPO, "core/image/startup.mjs"), "prepare", "--artifact", renderDir, "--run-dir", runDir, "--json"], { env });
    const prep = lastJson(r.stdout);
    const got = prep?.params?.CORP_GATEWAY_API_KEY?.source ?? null;
    results.push(`${label}→${(got ?? "失败").split(":")[0]}`);
    record(`参数注入：${label}`, `来源 = ${got ?? "(未解析)"}`, typeof got === "string" && got.startsWith(expectPrefix));
  }
  // ④ 定义默认值：不设模型名的环境变量，取定义里的 corp-think（凭据照给，否则 prepare 直接失败）
  {
    const runDir = path.join(work, "stage-definition-default");
    const env = { ...process.env, CORP_GATEWAY_BASE_URL: "http://127.0.0.1:9/v1", CORP_GATEWAY_API_KEY: "k-env" };
    delete env.CORP_GATEWAY_MODEL;
    const r = node([path.join(REPO, "core/image/startup.mjs"), "prepare", "--artifact", renderDir, "--run-dir", runDir, "--json"], { env });
    const prep = lastJson(r.stdout);
    const modelSrc = prep?.params?.CORP_GATEWAY_MODEL?.source ?? null;
    results.push(`定义默认值→${modelSrc ?? "失败"}`);
    record("参数注入④：定义默认值兜底（模型名）", `来源 = ${modelSrc}`, modelSrc === "definition-default");
  }
  record("参数注入：四种给法都能被解析（优先级 ①>②>③>④）", results.join(" · "), results.every((x) => !x.includes("失败")));
}

// ─────────────────────────────────────────────── ⑦ 隔离：产物只读、暂存可写
{
  const before = JSON.parse(fs.readFileSync(path.join(renderDir, "render-manifest.json"), "utf8")).artifactsDigest;
  // 常驻服务必须用 spawn：spawnSync 会**等子进程结束**，网关跑完了才轮到下一步（曾经因此假红）
  const gw = spawn("node", ["-e", `import('${REPO}/tools/fake-gateway/server.mjs').then(async m=>{const g=await m.startFakeGateway({port:48361,model:'corp-think'});setTimeout(async()=>{await g.close();process.exit(0)},90000)})`], { cwd: REPO, stdio: "ignore" });
  spawnSync("sleep", ["3"]);
  const fresh = path.join(work, "render-fresh");
  node([path.join(REPO, "adapters/pi/render.mjs"), agentDir, "--out", fresh]);
  const r = node([path.join(HERE, "run-local.mjs"), agentDir, "--harness", "pi", "--endpoint", "http://127.0.0.1:48361/v1", "--api-key", "placeholder", "--prompt", "say hi", "--render-dir", fresh]);
  const after = JSON.parse(fs.readFileSync(path.join(renderDir, "render-manifest.json"), "utf8")).artifactsDigest;
  record("本地真跑（零凭据假网关）并保持产物只读（运行后 digest 不变）",
    `退出码 ${r.status}；digest ${before === after ? "未变" : "变了"}`,
    r.status === 0 && before === after, r.status === 0 ? "" : (r.stderr ?? "").trim().split("\n").slice(-2).join(" "));
  try { gw.kill("SIGTERM"); } catch { /* 已退出 */ }
}

// ─────────────────────────────────────────────── ⑧ 跨运行时等价性
{
  const r = node([path.join(HERE, "compare.mjs"), agentDir]);
  record("跨运行时：同一份定义在 pi / dsh 上等价（差异必须有声明）",
    `退出码 ${r.status}（0 = 等价）`, r.status === 0, r.status === 0 ? "" : `${(r.stdout ?? "").slice(-200)}`);
}

// ─────────────────────────────────────────────── ⑨ 容器（离线 config-check）
{
  const image = "agent-base:0.1.0-arm64";
  const has = run("docker", ["image", "inspect", image]).status === 0;
  if (!has) record("容器：离线 config-check（镜像未构建，跳过）", `未找到 ${image} —— 先 make image-all`, "skip");
  else {
    const secrets = path.join(work, "secrets");
    fs.writeFileSync(path.join(secrets, "CORP_GATEWAY_BASE_URL"), "http://127.0.0.1:9/v1");
    const r = run("docker", ["run", "--rm", "--network", "none", "-v", `${renderDir}:/opt/agent-base/artifact:ro`, "-e", "HARNESS=pi", "-e", "AGENT_SECRETS_DIR=/secrets", "-v", `${secrets}:/secrets:ro`, image, "config-check"], { timeout: 120000 });
    record("容器：镜像里能配好 LLM 并离线自检（config-check）",
      `退出码 ${r.status}（0 = 配置齐备）`, r.status === 0, (r.stderr ?? "").trim().split("\n").slice(-2).join(" "));
    const r2 = run("docker", ["run", "--rm", "--network", "none", "-v", `${renderDir}:/opt/agent-base/artifact:ro`, "-e", "HARNESS=pi", image, "config-check"], { timeout: 120000 });
    record("容器：缺凭据时 fail-fast（不静默跑）", `退出码 ${r2.status}（期望非 0）`, r2.status !== 0);
  }
}

// ─────────────────────────────────────────────── ⑩ LIVE（可选）
if (LIVE && ENDPOINT) {
  const r = node([path.join(HERE, "verify.mjs"), agentDir, "--harness", "pi", "--live", "--endpoint", ENDPOINT],
    { env: { ...process.env, CORP_GATEWAY_API_KEY: API_KEY ?? "placeholder" } });
  record("LIVE：对真实端点跑四道闸门（真的调用模型）", `退出码 ${r.status}`, r.status === 0, r.status === 0 ? "" : (r.stderr ?? "").trim().split("\n").slice(-2).join(" "));
} else {
  record("LIVE：对真实端点跑四道闸门", "未启用（WALKTHROUGH_LIVE=1 + ENDPOINT=… 才跑）", "skip",
    "订阅读 models＝空 时可改用 providers-init 问端点列出模型");
}

// ─────────────────────────────────────────────── 汇总
const pass = steps.filter((s) => s.ok === true).length;
const skip = steps.filter((s) => s.ok === "skip").length;
process.stdout.write(`\n════ 演练结论：通过 ${pass} · 跳过 ${skip} · 失败 ${failed} ════\n`);
if (skip) process.stdout.write(`跳过的项需要真实端点或已构建镜像：它们不是"通过"，是"没验"。\n`);
if (!KEEP) fs.rmSync(work, { recursive: true, force: true });
else process.stdout.write(`工作区保留在：${work}\n`);
process.exit(failed === 0 ? EXIT_CODES.ok : 1);
