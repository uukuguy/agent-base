#!/usr/bin/env node
// ============================================================================
// Provider（供应商）配置的自检
//
// 为什么需要：`model.provider` 决定"连哪家、用哪家的密钥名、有哪些模型"，
// 而这块**必须能由开发者方便地覆盖与新增**（为了换个端点去改基座代码是不可接受的）。
// 这份自检把四件事钉住：
//
//   ① 解析优先级：AGENT_PROVIDERS_FILE > AGENT_CATALOG_DIR > 智能体自带 > 基座内置
//   ② 同名 id **按字段合并**（只写要改的字段）
//   ③ 显式指定却读不到 ⇒ **响亮失败**，不静默回退内置
//   ④ `make providers-init` 能**从端点问出模型名**并生成可用的 provider 目录
//
// 用法：node tools/providers-selftest.mjs
// ============================================================================

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { EXIT_CODES } from "../core/gates/index.mjs";
import { loadProviders, findProvider, BUILTIN_PROVIDERS_PATH } from "../core/catalog/providers.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");

let pass = 0;
let fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) { pass += 1; process.stdout.write(`✅ ${name}\n`); }
  else { fail += 1; process.stdout.write(`❌ ${name}${detail ? ` —— ${detail}` : ""}` + "\n"); }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "providers-selftest-"));
const writeCatalog = (file, entries) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = entries.map((e) => [
    `  - id: ${e.id}`,
    e.baseUrl ? `    baseUrl: ${e.baseUrl}` : null,
    e.api ? `    api: ${e.api}` : null,
    e.credentialEnv ? `    credentialEnv: ${e.credentialEnv}` : null,
    `    models: [${(e.models ?? []).join(", ")}]`,
  ].filter(Boolean).join("\n")).join("\n");
  fs.writeFileSync(file, `apiVersion: agent-base/v1\nproviders:\n${body}\n`);
};

// ① 内置目录可用
{
  const l = loadProviders({ env: {} });
  check("基座内置 provider 目录可读（deepseek / openai / corp-gateway）",
    l.errors.length === 0 && ["deepseek", "openai", "corp-gateway"].every((id) => findProvider(l, id)),
    JSON.stringify(l.errors));
  const ds = findProvider(l, "deepseek");
  check("内置 provider 带常用密钥名与端点（不需要用户推导变量名）",
    ds?.credentialParam === "DEEPSEEK_API_KEY" && ds?.baseUrl === "https://api.deepseek.com",
    JSON.stringify({ key: ds?.credentialParam, url: ds?.baseUrl }));
  check("内置目录存在（路径）", fs.existsSync(BUILTIN_PROVIDERS_PATH));
}

// ② 优先级 + 合并
{
  const explicit = path.join(tmp, "a", "providers.yaml");
  writeCatalog(explicit, [{ id: "deepseek", baseUrl: "https://mirror.example.com", models: ["m-explicit"] }]);
  const dir = path.join(tmp, "b");
  writeCatalog(path.join(dir, "providers.yaml"), [{ id: "deepseek", models: ["m-from-dir"] }]);

  let l = loadProviders({ env: { AGENT_PROVIDERS_FILE: explicit } });
  check("优先级：AGENT_PROVIDERS_FILE 生效（内置作基础层 + 它作覆盖层）",
    l.sources.some((x) => x.startsWith("AGENT_PROVIDERS_FILE")) && l.sources.some((x) => x.startsWith("基座内置")), l.sources.join(" | "));
  const ds = findProvider(l, "deepseek");
  check("覆盖层**按字段合并**：只写 baseUrl 时其余继承内置",
    ds?.baseUrl === "https://mirror.example.com" && ds?.credentialParam === "DEEPSEEK_API_KEY",
    JSON.stringify({ url: ds?.baseUrl, key: ds?.credentialParam }));
  check("覆盖层的 models 生效", JSON.stringify(ds?.models) === JSON.stringify(["m-explicit"]), JSON.stringify(ds?.models));

  l = loadProviders({ env: { AGENT_CATALOG_DIR: dir } });
  check("优先级：没给文件时用 AGENT_CATALOG_DIR/providers.yaml", l.sources.some((x) => x.startsWith("AGENT_CATALOG_DIR")), l.sources.join(" | "));

  const agentDir = path.join(tmp, "agent-own");
  writeCatalog(path.join(agentDir, "providers.yaml"), [{ id: "deepseek", models: ["m-agent-local"] }]);
  l = loadProviders({ env: {}, agentDir });
  check("优先级：智能体自带的 providers.yaml 生效", l.sources.some((x) => x.startsWith("agent-local")), l.sources.join(" | "));
  check("合并后仍是同一家（id 不变）", findProvider(l, "deepseek")?.credentialParam === "DEEPSEEK_API_KEY");

  l = loadProviders({ env: {}, agentDir: tmp });
  check("没有覆盖层时只用基座内置", l.sources.every((x) => x.startsWith("基座内置")), l.sources.join(" | "));
}

// ③ 显式指定却读不到 ⇒ 报错（不回退）
{
  const l = loadProviders({ env: { AGENT_PROVIDERS_FILE: path.join(tmp, "nope.yaml") } });
  check("显式文件不存在 ⇒ 报错且不静默回退", l.errors.length > 0 && /不存在/.test(l.errors[0]), l.errors[0] ?? "(无报错)");
  check("此时 provider 列表为空（不让上层拿着内置假装没事）", l.providers.length === 0, `providers=${l.providers.length}`);
}

// ④ 闸门 1 真的按覆盖判：同一份定义，两份目录给出相反结论
{
  const agent = path.join(tmp, "agent");
  fs.mkdirSync(path.join(agent, "skills", "s"), { recursive: true });
  fs.writeFileSync(path.join(agent, "agent.yaml"), [
    "apiVersion: agent-base/v1", "name: providers-selftest", "description: 自检用",
    "persona: { instructions: 自检 }", "model: { provider: deepseek, name: m-explicit }",
    "connectorsFile: connectors.yaml", "",
  ].join("\n"));
  fs.writeFileSync(path.join(agent, "connectors.yaml"), "apiVersion: agent-base/v1\nmcpServers: []\n");
  fs.writeFileSync(path.join(agent, "skills", "s", "SKILL.md"), "---\nname: s\ndescription: d\n---\n正文\n");

  const good = path.join(tmp, "good", "providers.yaml");
  writeCatalog(good, [{ id: "deepseek", models: ["m-explicit"] }]);
  const bad = path.join(tmp, "bad", "providers.yaml");
  writeCatalog(bad, [{ id: "deepseek", models: ["other-model"] }]);

  const runValidate = (env) => spawnSync(process.execPath, [path.join(HERE, "validate.mjs"), agent], { encoding: "utf8", env: { ...process.env, ...env } });
  let v = runValidate({ AGENT_PROVIDERS_FILE: good });
  check("闸门 1：按覆盖目录通过（模型名在覆盖名单里）", v.status === EXIT_CODES.ok, (v.stderr ?? "").slice(-200));
  v = runValidate({ AGENT_PROVIDERS_FILE: bad });
  check("闸门 1：覆盖目录换了名单后立即失败（说明它真的在按覆盖判）", v.status !== EXIT_CODES.ok, `退出码 ${v.status}`);
  v = runValidate({ AGENT_PROVIDERS_FILE: bad });
  check("失败信息里列出该 provider 实际提供的模型", /other-model/.test(`${v.stdout}${v.stderr}`), (v.stderr ?? "").slice(-200));
}

// ⑤ providers-init：从端点问出模型名（对着自带零凭据假网关跑，离线可验）
{
  const PORT = 48331;
  const gw = spawn("node", ["-e", `import('${REPO}/tools/fake-gateway/server.mjs').then(async m => { const g = await m.startFakeGateway({ port: ${PORT}, model: "endpoint-says-so" }); setTimeout(async () => { await g.close(); process.exit(0); }, 60000); })`],
    { cwd: REPO, stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 3000));
  const outFile = path.join(tmp, "generated", "providers.yaml");
  const ri = spawnSync(process.execPath, [path.join(HERE, "providers-init.mjs"), "--endpoint", `http://127.0.0.1:${PORT}/v1`, "--provider", "deepseek", "--out", outFile], { encoding: "utf8" });
  check("providers-init：从端点问出模型并生成目录", ri.status === EXIT_CODES.ok && fs.existsSync(outFile), (ri.stderr ?? "").slice(-300));
  if (fs.existsSync(outFile)) {
    const gen = loadProviders({ env: { AGENT_PROVIDERS_FILE: outFile } });
    check("生成的目录能被基座读、且模型名来自端点",
      gen.errors.length === 0 && findProvider(gen, "deepseek")?.models?.includes("endpoint-says-so"),
      JSON.stringify(findProvider(gen, "deepseek")?.models ?? gen.errors));
  }
  try { gw.kill("SIGTERM"); } catch { /* 已退出 */ }
}

// ⑥ 派生智能体：模板 Makefile 认旁边的 providers.yaml，且导出绝对路径
{
  const tmpl = fs.readFileSync(path.join(REPO, "template/Makefile"), "utf8");
  check("模板 Makefile 自动认智能体旁边的 providers.yaml（导出绝对路径）",
    /providers\.yaml/.test(tmpl) && /abspath/.test(tmpl) && /export AGENT_PROVIDERS_FILE/.test(tmpl));
  check("模板 Makefile 提供 run-local / providers-init",
    /^run-local:/m.test(tmpl) && /^providers-init:/m.test(tmpl));
}

process.stdout.write(`\nprovider 配置自检：${fail === 0 ? "全绿" : `失败 ${fail} 项`}（通过 ${pass}）\n`);
process.exit(fail === 0 ? EXIT_CODES.ok : 1);
