#!/usr/bin/env node
// ============================================================================
// 启动期准备的自检（core/image/startup.mjs）
//
// 为什么需要：这是"参数下放"的落地点 —— 端点/凭据/模型名在这里变成真值、产物在这里被暂存。
// 它坏掉的方式很隐蔽：容器里跑一个任务，模型报 401 或"没有模型"，而你会先去怀疑端点。
//
// **这份自检是运行时中性的**：适配器按目录发现，产物布局不写死文件名 ——
// 断言"注入的值出现在暂存后的产物里"，而不是"某个运行时的某个文件里"。
//
// 覆盖：契约齐全 · 正向注入 · 模型名覆盖 · 三种来源（env / *_FILE / 定义默认值）·
//       四个负向（缺端点、缺凭据、_FILE 不存在、模型名不在路由名单）· 产物不可变 ·
//       凭据不泄漏（stdout/JSON）· config-check 无副作用。
//
// 用法：node core/image/startup-selftest.mjs [--harness <名字>]（不带参数则逐适配器各跑一遍）
// ============================================================================

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { EXIT_CODES, parseArgs, digestDirectory, DEFAULT_EXCLUDES } from "../gates/index.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const STARTUP = path.join(HERE, "startup.mjs");

const { values } = parseArgs(process.argv.slice(2), { valueFlags: ["--harness"] });
// 适配器按目录发现（不写死运行时名 —— core/ 里不该出现它们）
const adapters = fs.readdirSync(path.join(REPO, "adapters"), { withFileTypes: true })
  .filter((e) => e.isDirectory() && fs.existsSync(path.join(REPO, "adapters", e.name, "adapter.yaml")))
  .map((e) => e.name).sort();
// 不给 --harness 就**逐个适配器各跑一遍**：两条能力路径不同（一条需要启动期渲染、一条原生插值），
// 只跑其中一个等于只验证了一半的契约。
if (!values["--harness"]) {
  let bad = 0;
  for (const h of adapters) {
    process.stdout.write(`\n── ${h} ──\n`);
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--harness", h], { stdio: "inherit" });
    if (r.status !== 0) bad += 1;
  }
  process.exit(bad ? 1 : 0);
}
const harness = values["--harness"];
/**
 * 自带一个最小智能体定义（**不引用示例目录** —— core/ 不得依赖示例，那是不变量 N5）。
 * 结构照中性定义写：人设 + 模型 + 一个技能 + 空连接器。
 */
function makeAgent() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "startup-selftest-agent-"));
  fs.mkdirSync(path.join(dir, "skills", "smoke"), { recursive: true });
  fs.writeFileSync(path.join(dir, "agent.yaml"), [
    "apiVersion: agent-base/v1",
    "name: startup-selftest",
    "description: 启动期准备自检用的最小定义",
    "persona:",
    "  instructions: |",
    "    你是自检用的智能体。",
    "model:",
    "  provider: corp-gateway",
    "  name: corp-think",
    "connectorsFile: connectors.yaml",
    "",
  ].join("\n"));
  fs.writeFileSync(path.join(dir, "connectors.yaml"), "apiVersion: agent-base/v1\nmcpServers: []\n");
  fs.writeFileSync(path.join(dir, "skills", "smoke", "SKILL.md"),
    "---\nname: smoke\ndescription: 自检用技能\n---\n正文\n");
  return dir;
}
const agentDir = makeAgent();

let pass = 0;
let fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) { pass += 1; process.stdout.write(`✅ ${name}\n`); }
  else { fail += 1; process.stdout.write(`❌ ${name}${detail ? ` —— ${detail}` : ""}\n`); }
};

/** 暂存后的产物树里是否出现过某段文本（不认文件名 —— 布局是运行时专有的）。 */
const treeHas = (root, needle) => {
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) { if (walk(f)) return true; continue; }
      try { if (fs.readFileSync(f, "utf8").includes(needle)) return true; } catch { /* 二进制跳过 */ }
    }
    return false;
  };
  return fs.existsSync(root) && walk(root);
};

const artifact = fs.mkdtempSync(path.join(os.tmpdir(), "startup-selftest-art-"));
const r0 = spawnSync(process.execPath, [path.join(REPO, "adapters", harness, "render.mjs"), agentDir, "--out", artifact], { encoding: "utf8" });
check(`前置：渲染产物成功（${harness}）`, r0.status === 0, (r0.stderr ?? "").slice(-200));
if (r0.status !== 0) { process.stdout.write("\n启动期准备自检：前置失败，后续跳过\n"); process.exit(1); }

const manifest = JSON.parse(fs.readFileSync(path.join(artifact, "render-manifest.json"), "utf8"));
const declared = manifest.runtimeParams ?? [];
const endpointParam = declared.find((p) => p.backs === "model.provider" && !p.secret) ?? {};
const secretParam = declared.find((p) => p.secret === true)?.name;
const modelParam = declared.find((p) => p.validate === "in-provider-models") ?? {};
const defaultModel = modelParam.default;
const models = manifest.modelProviderModels ?? [];

const rendersParams = manifest.rendersParams === true;   // 该运行时是否需要启动期渲染（能力差异）
const work = fs.mkdtempSync(path.join(os.tmpdir(), "startup-selftest-work-"));
const digestBefore = digestDirectory(artifact, { excludes: [...DEFAULT_EXCLUDES] });
const run = (args, env = {}) => {
  const r = spawnSync(process.execPath, [STARTUP, ...args, "--artifact", artifact, "--run-dir", work],
    { encoding: "utf8", env: { ...process.env, ...env } });
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
};

check("契约齐全：清单声明了端点/凭据/模型名与模型名单",
  !!endpointParam.name && !!secretParam && !!modelParam.name && models.length > 0,
  `declared=${declared.map((p) => p.name).join(",")} models=${models.join(",")}`);
if (!endpointParam.name || !modelParam.name) { process.stdout.write("\n启动期准备自检：契约缺失，后续跳过\n"); process.exit(1); }

const okEnv = { [endpointParam.name]: "https://gw.internal/v1", [secretParam]: "sk-secret-value" };

// ① 正向：env 注入 + 暂存（+ 按能力决定是否渲染进产物）
//
// 断言分两层，因为**运行时能力不同**：
//   · 一律成立：`prepare` 把值解析对了（`--json` 里 `params[].value` / `source` 正确，密钥只报"有值"）
//   · 仅当 `rendersParams`：值真的落进了暂存产物（说明启动期渲染发生了）
// 一律要求"值出现在产物里"会把"原生插值的运行时"误判为失败 —— 那正是本项目的口径纪律。
let r = run(["prepare", "--json"], okEnv);
check("正向 prepare 退出码 0", r.code === 0, `退出码 ${r.code} ${r.err.slice(-160)}`);
let prep = null;
try { prep = JSON.parse(r.out); } catch { /* 下面按失败报 */ }
const P = prep?.params ?? {};
check("prepare 报告端点已解析（来源 env）", P[endpointParam.name]?.value === "https://gw.internal/v1" && P[endpointParam.name]?.source === "env",
  JSON.stringify(P[endpointParam.name] ?? null));
check("未覆盖时模型名取定义里的默认值", P[modelParam.name]?.value === defaultModel && P[modelParam.name]?.source === "definition-default",
  JSON.stringify(P[modelParam.name] ?? null));
check("凭据只报「已提供 + 来源」，不含值", P[secretParam]?.provided === true && P[secretParam]?.value === undefined,
  JSON.stringify(P[secretParam] ?? null));
check("凭据不出现在 stdout（掩码）", !r.out.includes("sk-secret-value"));
if (rendersParams) {
  check("该运行时需要渲染 ⇒ 端点真的落进暂存产物", treeHas(work, "https://gw.internal/v1"));
  check("该运行时需要渲染 ⇒ 凭据真的落进暂存产物", treeHas(work, "sk-secret-value"));
  check("该运行时需要渲染 ⇒ 默认模型名落进暂存产物", treeHas(work, String(defaultModel)));
} else {
  check("该运行时原生插值 ⇒ 端点不进产物，只经环境变量传入（能力差异，非缺陷）",
    !treeHas(work, "sk-secret-value"));
}

// ② 模型名运行期覆盖（名单里另取一个值；只有一个模型时用原名，仍验证这条路径通）
const other = models.find((m) => m !== defaultModel) ?? defaultModel;
r = run(["prepare", "--json"], { ...okEnv, [modelParam.name]: other });
let prep2 = null;
try { prep2 = JSON.parse(r.out); } catch { /* 下面按失败报 */ }
check("模型名可运行期覆盖（报告里是新值，来源 env）",
  r.code === 0 && prep2?.params?.[modelParam.name]?.value === other && prep2?.params?.[modelParam.name]?.source === "env",
  `退出码 ${r.code} value=${prep2?.params?.[modelParam.name]?.value}`);
if (rendersParams) check("覆盖后的模型名也落进产物", treeHas(work, other));

// ③ 负向：模型名不在路由名单内
r = run(["prepare"], { ...okEnv, [modelParam.name]: "not-a-model" });
check("模型名不在路由名单 → 退出码 2", r.code === EXIT_CODES.usage, `退出码 ${r.code}`);
check("失败信息列出该路由可用的模型", models.some((m) => r.err.includes(m)), r.err.slice(-160));

// ④ 负向：缺端点 / 缺凭据
r = run(["prepare"], { [secretParam]: "x" });
check("缺端点 → 退出码 2", r.code === EXIT_CODES.usage, `退出码 ${r.code}`);
check("失败信息写出引用名与两种给法", r.err.includes(endpointParam.name) && /_FILE/.test(r.err));
r = run(["prepare"], { [endpointParam.name]: "https://gw.internal/v1" });
check("缺凭据 → 退出码 2", r.code === EXIT_CODES.usage, `退出码 ${r.code}`);
check("失败信息点名缺的引用名", r.err.includes(secretParam));

// ⑤ 凭据走文件（K8s/Docker secret 的标准接法；结尾换行要被去掉）
const secretFile = path.join(os.tmpdir(), `startup-selftest-secret-${process.pid}.txt`);
fs.writeFileSync(secretFile, "file-based-secret\n");
r = run(["prepare", "--json"], { [endpointParam.name]: "https://gw.internal/v1", [`${secretParam}_FILE`]: secretFile });
let prep3 = null;
try { prep3 = JSON.parse(r.out); } catch { /* 下面按失败报 */ }
check("凭据可从 *_FILE 读取（来源标为文件）", r.code === 0 && /^file:/.test(prep3?.params?.[secretParam]?.source ?? ""),
  `退出码 ${r.code} source=${prep3?.params?.[secretParam]?.source}`);
if (rendersParams) {
  check("从文件读到的凭据也去掉结尾换行后落进产物",
    treeHas(work, "file-based-secret") && !treeHas(work, "file-based-secret\\n"));
}

// ⑤b 凭据目录（AGENT_SECRETS_DIR）：不依赖任何编排层的一种给法 ——
//     目录里的文件名就是引用名，内容就是值。实际环境很杂，这条不能只有 K8s 一条路。
const secretsDir = fs.mkdtempSync(path.join(os.tmpdir(), "startup-selftest-secrets-"));
fs.writeFileSync(path.join(secretsDir, secretParam), "from-secrets-dir\n");
r = run(["prepare", "--json"], { [endpointParam.name]: "https://gw.internal/v1", AGENT_SECRETS_DIR: secretsDir });
let prep4 = null;
try { prep4 = JSON.parse(r.out); } catch { /* 下面按失败报 */ }
check("凭据可从 AGENT_SECRETS_DIR 读取（来源标为目录）",
  r.code === 0 && /^secrets-dir:/.test(prep4?.params?.[secretParam]?.source ?? ""),
  `退出码 ${r.code} source=${prep4?.params?.[secretParam]?.source}`);
if (rendersParams) {
  check("从目录读到的凭据去掉结尾换行后落进产物",
    treeHas(work, "from-secrets-dir") && !treeHas(work, "from-secrets-dir\\n"));
}

// ⑤c 优先级：显式环境变量 > 目录（固定优先级，只有一处实现）
r = run(["prepare", "--json"], { [endpointParam.name]: "https://gw.internal/v1", [secretParam]: "from-env", AGENT_SECRETS_DIR: secretsDir });
let prep5 = null;
try { prep5 = JSON.parse(r.out); } catch { /* 下面按失败报 */ }
check("优先级：环境变量 > 凭据目录", prep5?.params?.[secretParam]?.source === "env",
  `source=${prep5?.params?.[secretParam]?.source}`);

// ⑥ 负向：_FILE 指向不存在的文件
r = run(["prepare"], { [endpointParam.name]: "https://gw.internal/v1", [`${secretParam}_FILE`]: "/nope/missing" });
check("_FILE 不存在 → 退出码 2 且说明", r.code === EXIT_CODES.usage && /不存在/.test(r.err));

// ⑦ 产物不可变：只读产物永不被改写（改了摘要就不成立）
check("产物摘要未变（只暂存副本）", digestDirectory(artifact, { excludes: [...DEFAULT_EXCLUDES] }) === digestBefore);

// ⑧ config-check：只校验、不落盘、stdout 是纯 JSON
const freshWork = fs.mkdtempSync(path.join(os.tmpdir(), "startup-selftest-cc-"));
const cc = spawnSync(process.execPath, [STARTUP, "config-check", "--artifact", artifact, "--run-dir", freshWork, "--json"],
  { encoding: "utf8", env: { ...process.env, ...okEnv } });
let parsed = null;
try { parsed = JSON.parse(cc.stdout); } catch { /* 下面按失败报 */ }
check("config-check 通过且 stdout 是纯 JSON", cc.status === 0 && parsed !== null);
check("config-check 不泄漏凭据值", !JSON.stringify(parsed ?? {}).includes("sk-secret-value"));
check("config-check 不留运行目录", !fs.existsSync(freshWork) || fs.readdirSync(freshWork).length === 0);

process.stdout.write(`\n启动期准备自检：${fail === 0 ? "全绿" : `失败 ${fail} 项`}（通过 ${pass}）\n`);
process.exit(fail === 0 ? EXIT_CODES.ok : 1);
