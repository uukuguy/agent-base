// ============================================================================
// 本地开发环境自检（§9.3）：dev-env 与 run-local 是否真的能用
//
// 为什么值得单独一条自检：这两条是**上手路径的最后一段**——业务开发者第一次接触基座时
// 跑的就是它们。它们失败的方式又特别不显眼（比如"技能多出来一个"是隐式源没隔离干净、
// "本地跑得通容器里跑不通"是 HOME 没中立化）。所以这里按"可观察的结果"验，而不是看是否退出 0。
//
// 用法：node tools/local-selftest.mjs  （或 make local-selftest）
// ============================================================================

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { EXIT_CODES } from "../core/gates/index.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = (name, cond, extra = "") => {
  if (!cond) failures++;
  console.log(`${cond ? "✅" : "❌"} ${name}${cond || !extra ? "" : `\n      ${extra}`}`);
};

function makeAgent(dir) {
  fs.mkdirSync(path.join(dir, "skills", "scratch"), { recursive: true });
  fs.writeFileSync(path.join(dir, "agent.yaml"),
    "apiVersion: agent-base/v1\nname: local-check\ndescription: 本地运行入口验证\npersona: { instructions: 测试。 }\nmodel: { provider: corp-gateway, name: corp-think }\n");
  fs.writeFileSync(path.join(dir, "connectors.yaml"), "apiVersion: agent-base/v1\nmcpServers: []\n");
  fs.writeFileSync(path.join(dir, "skills/scratch/SKILL.md"), "---\nname: scratch\ndescription: 示例技能\n---\n正文\n");
}

// ---------------------------------------------------------------------------
console.log("── dev-env：本机 harness 版本必须与 adapter 的 pin 一致 ──");
const dev = spawnSync(process.execPath, [path.join(HERE, "dev-env.mjs"), "--check"], { encoding: "utf8", cwd: REPO });
check("dev-env --check 退出码 0（本机与 pin 一致）", dev.status === 0, (dev.stderr ?? "").slice(-300));
check("报告里逐条列出了期望/本机/可执行版本", /期望/.test(dev.stderr ?? "") && /可执行/.test(dev.stderr ?? ""));

console.log("\n── run-local：用临时 HOME 跑制品，且真的能跑通 ──");
const base = fs.mkdtempSync(path.join(os.tmpdir(), "local-selftest-"));
const agent = path.join(base, "agent");
makeAgent(agent);

// 零凭据假网关（独立进程：教训——同一进程内起网关 + 子进程 harness 会收不到请求）
const port = 47901;
const gw = spawn(process.execPath, ["-e",
  `import("${REPO}/tools/fake-gateway/server.mjs").then(async (m) => { const g = await m.startFakeGateway({ port: ${port} }); setTimeout(async () => { await g.close(); process.exit(0); }, 90000); });`],
  { stdio: "ignore" });
await sleep(2500);
const reachable = await new Promise((res) => { const s = net.connect(port, "127.0.0.1"); s.on("connect", () => { s.destroy(); res(true); }); s.on("error", () => res(false)); });
check("零凭据假网关已就绪", reachable);

const before = fs.existsSync(path.join(os.homedir(), ".pi")) ? fs.statSync(path.join(os.homedir(), ".pi")).mtimeMs : null;
const r = spawnSync(process.execPath, [
  path.join(HERE, "run-local.mjs"), agent,
  "--prompt", "说一句话",
  "--endpoint", `http://127.0.0.1:${port}/v1`,
  "--render-dir", path.join(base, "render"),
  "--zero-credential", "true",   // 本地自检用零凭据模式（假网关 + 占位凭据）
], { encoding: "utf8", cwd: REPO, timeout: 180000 });
gw.kill("SIGTERM");

const log = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
check("run-local 退出码 0", r.status === 0, log.slice(-400));
check("先渲染再跑（不是直接跑源码目录）", /先渲染/.test(log) && fs.existsSync(path.join(base, "render", "render-manifest.json")));
check("沿用临时 HOME（隔离隐式技能源）", /HOME\s+\/var\/folders|HOME\s+\/tmp/.test(log), (log.match(/HOME.*/) ?? [""])[0]);
check("启动期参数已解析（零凭据模式下用占位/默认值，且如实列出）", /运行期参数|参数用占位值|模型端点/.test(log), (log.match(/模型端点.*/) ?? [""])[0]);
check("harness 真的跑到了模型（假网关标记出现）", /FAKE_GATEWAY_OK/.test(log));
check("产出统一轨迹", /轨迹 \d+ 条/.test(log) && !/轨迹 0 条/.test(log), (log.match(/── 结束.*/) ?? [""])[0]);
check("运行后未污染本机 ~/.pi（隔离生效）",
  before === null || !fs.existsSync(path.join(os.homedir(), ".pi")) || fs.statSync(path.join(os.homedir(), ".pi")).mtimeMs === before,
  "本机 ~/.pi 的 mtime 发生变化 ⇒ HOME 没隔离干净");

console.log("\n── 改了定义就不许复用旧产物（「改了没生效」是最费时间的坑）──");
{
  // 首次运行已经把产物渲进了 base/render；现在**改一下定义**再跑一次，
  // 必须（a）重新渲染、且（b）明说"定义已变"。不修的话：报错会指向已被改掉的供应商/参数名。
  const yamlFile = path.join(agent, "agent.yaml");
  const before = fs.readFileSync(yamlFile, "utf8");
  fs.writeFileSync(yamlFile, before.replace(/^(description:.*)$/m, "$1（改了）"));
  const gw2 = spawn(process.execPath, ["-e",
    `import("${REPO}/tools/fake-gateway/server.mjs").then(async (m) => { const g = await m.startFakeGateway({ port: ${port + 1} }); setTimeout(async () => { await g.close(); process.exit(0); }, 90000); });`],
    { stdio: "ignore" });
  await sleep(2500);
  const r2 = spawnSync(process.execPath, [
    path.join(HERE, "run-local.mjs"), agent, "--prompt", "再说一句",
    "--endpoint", `http://127.0.0.1:${port + 1}/v1`, "--zero-credential", "true",
    "--render-dir", path.join(base, "render"),
  ], { encoding: "utf8", cwd: REPO, timeout: 180000 });
  gw2.kill("SIGTERM");
  const log2 = `${r2.stdout ?? ""}\n${r2.stderr ?? ""}`;
  check("定义变了会重新渲染（而不是用旧产物）", /定义已变/.test(log2), log2.split("\n").slice(0, 3).join(" / "));
  check("重新渲染后仍然跑通", r2.status === 0 && /FAKE_GATEWAY_OK/.test(log2), (log2.match(/❌.*/) ?? [""])[0]);
  fs.writeFileSync(yamlFile, before);
}

console.log("\n── 未实现的 harness 必须响亮失败，不许静默改用别的 ──");
const other = spawnSync(process.execPath, [path.join(HERE, "run-local.mjs"), agent, "--harness", "nope"], { encoding: "utf8", cwd: REPO });
check("未知 harness 非零退出并说明原因", other.status !== 0 && /(尚未实现|没有运行器)/.test(other.stderr ?? ""), (other.stderr ?? "").slice(-200));

fs.rmSync(base, { recursive: true, force: true });
console.log(`\n${failures === 0 ? "本地开发环境自检：全绿" : `本地开发环境自检：失败 ${failures} 项`}`);
process.exit(failures === 0 ? EXIT_CODES.ok : 1);
