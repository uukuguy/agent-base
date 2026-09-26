#!/usr/bin/env node
// ============================================================================
// 路由目录（routes.yaml）的自检
//
// 为什么需要：它决定"连哪个端点、端点服务哪些模型"，而这块**必须能由部署层提供**
// （业务为了换个端点去改基座代码是不可接受的）。这份自检把三件事钉住：
//
//   ① 解析优先级：AGENT_ROUTES_FILE > AGENT_CATALOG_DIR > 基座内置
//   ② 设了覆盖却读不到 ⇒ **响亮失败**，不静默回退内置（否则"我配了"与"系统在用内置"同时成立）
//   ③ `make routes-init` 能**从端点问出模型名**并生成一份可用的目录（对着自带零凭据假网关验）
//
// 用法：node tools/routes-selftest.mjs
// ============================================================================

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { EXIT_CODES, parseArgs } from "../core/gates/index.mjs";
import { loadRoutes, resolveRoutesSource } from "../core/catalog/routes.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");

let pass = 0;
let fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) { pass += 1; process.stdout.write(`✅ ${name}\n`); }
  else { fail += 1; process.stdout.write(`❌ ${name}${detail ? ` —— ${detail}` : ""}\n`); }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "routes-selftest-"));
const writeCatalog = (file, models, routeId = "corp-gateway") => {
  const prefix = routeId.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `apiVersion: agent-base/v1\nroutes:\n  - id: ${routeId}\n    api: openai-completions\n    baseUrlParam: ${prefix}_BASE_URL\n    credentialParam: ${prefix}_API_KEY\n    modelParam: ${prefix}_MODEL\n    models: [${models.join(", ")}]\n`);
};

// ① 优先级：显式文件 > 目录 > 内置
const f1 = path.join(tmp, "a", "routes.yaml");
writeCatalog(f1, ["m-from-file"]);
const d2 = path.join(tmp, "b");
writeCatalog(path.join(d2, "routes.yaml"), ["m-from-dir"]);

let src = resolveRoutesSource({ AGENT_ROUTES_FILE: f1, AGENT_CATALOG_DIR: d2 });
check("优先级：AGENT_ROUTES_FILE 胜出", src.source === "AGENT_ROUTES_FILE" && src.path === path.resolve(f1), src.source);
src = resolveRoutesSource({ AGENT_CATALOG_DIR: d2 });
check("优先级：没给文件时用 AGENT_CATALOG_DIR/routes.yaml", src.source === "AGENT_CATALOG_DIR" && src.path === path.join(path.resolve(d2), "routes.yaml"), src.path);
src = resolveRoutesSource({});
check("优先级：都没给时用基座内置", src.source === "base-builtin" && src.builtin === true, src.source);

// ② 内容能读到；设了却读不到 ⇒ 报错（不是回退）
let loaded = loadRoutes({ AGENT_ROUTES_FILE: f1 });
check("能读到覆盖目录里的路由与模型", loaded.error === null && loaded.routes[0]?.models?.includes("m-from-file"), JSON.stringify(loaded.error));
loaded = loadRoutes({ AGENT_ROUTES_FILE: path.join(tmp, "nope.yaml") });
check("覆盖指向不存在的文件 ⇒ 报错且不回退内置",
  loaded.error && loaded.routes.length === 0 && /不存在/.test(loaded.error) && loaded.builtin === false, loaded.error ?? "(没有报错)");

// ③ 闸门 1 真的按覆盖来判：同一份定义，两份目录给出相反结论
const agent = path.join(tmp, "agent");
fs.mkdirSync(path.join(agent, "skills", "s"), { recursive: true });
fs.writeFileSync(path.join(agent, "agent.yaml"), [
  "apiVersion: agent-base/v1", "name: routes-selftest", "description: 自检用",
  "persona: { instructions: 自检 }", "model: { route: corp-gateway, name: m-from-file }",
  "connectorsFile: connectors.yaml", "",
].join("\n"));
fs.writeFileSync(path.join(agent, "connectors.yaml"), "apiVersion: agent-base/v1\nmcpServers: []\n");
fs.writeFileSync(path.join(agent, "skills", "s", "SKILL.md"), "---\nname: s\ndescription: d\n---\n正文\n");

const runValidate = (env) => spawnSync(process.execPath, [path.join(HERE, "validate.mjs"), agent], { encoding: "utf8", env: { ...process.env, ...env } });
let v = runValidate({ AGENT_ROUTES_FILE: f1 });
check("闸门 1：按覆盖目录通过（模型名在覆盖名单里）", v.status === EXIT_CODES.ok, (v.stderr ?? "").slice(-200));
writeCatalog(f1, ["m-from-dir"]);   // 名单里没有 m-from-file 了
v = runValidate({ AGENT_ROUTES_FILE: f1 });
check("闸门 1：覆盖目录换了名单后立即失败（说明它真的在按覆盖判）", v.status !== EXIT_CODES.ok, `退出码 ${v.status}`);

// ④ routes-init：从端点问出模型名（对着自带零凭据假网关跑，离线可验）
const PORT = 48311;
// 注意用 spawn 而不是 spawnSync：后者会**等子进程结束**，而假网关是常驻服务（自检会一直卡住）
const gw = spawn("node", ["-e", `import('${REPO}/tools/fake-gateway/server.mjs').then(async m => { const g = await m.startFakeGateway({ port: ${PORT}, model: "endpoint-says-so" }); setTimeout(async () => { await g.close(); process.exit(0); }, 60000); })`],
  { cwd: REPO, stdio: "ignore" });
await new Promise((r) => setTimeout(r, 3000));
const outFile = path.join(tmp, "generated", "routes.yaml");
const ri = spawnSync(process.execPath, [path.join(HERE, "routes-init.mjs"), "--endpoint", `http://127.0.0.1:${PORT}/v1`, "--route", "corp-gateway", "--out", outFile], { encoding: "utf8" });
check("routes-init：从端点问出模型并生成目录", ri.status === EXIT_CODES.ok && fs.existsSync(outFile), (ri.stderr ?? "").slice(-300));
if (fs.existsSync(outFile)) {
  const gen = loadRoutes({ AGENT_ROUTES_FILE: outFile });
  check("routes-init 生成的目录能被基座读、且模型名来自端点",
    gen.error === null && gen.routes[0]?.models?.includes("endpoint-says-so"), JSON.stringify(gen.routes[0]?.models ?? gen.error));
  check("routes-init 按约定推出了引用名", gen.routes[0]?.baseUrlParam === "CORP_GATEWAY_BASE_URL" && gen.routes[0]?.modelParam === "CORP_GATEWAY_MODEL");
}
try { gw.kill("SIGTERM"); } catch { /* 已退出 */ }

// ⑤ 派生智能体自带 routes.yaml 时，生成的 Makefile 会自动用它
const tmpl = fs.readFileSync(path.join(REPO, "template/Makefile"), "utf8");
check("模板 Makefile 会自动认智能体旁边的 routes.yaml",
  /AGENT_ROUTES_FILE \?= \$\(wildcard \.\/routes\.yaml\)/.test(tmpl) && /export AGENT_ROUTES_FILE/.test(tmpl));

process.stdout.write(`\n路由目录自检：${fail === 0 ? "全绿" : `失败 ${fail} 项`}（通过 ${pass}）\n`);
process.exit(fail === 0 ? EXIT_CODES.ok : 1);
