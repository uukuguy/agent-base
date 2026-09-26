// ============================================================================
// 模板「开箱可跑」自检（统一设计 §12.2 的判据，逐条验证）
//
// 判据原文：
//   · 生成后立刻 `make validate && make render && make doctor` 全绿
//   · `grep -rn TODO my-agent/` 为空
//   · `my-agent/` 内无 `package.json`、无绝对路径
//
// 本自检刻意**跑生成出来的 Makefile**（而不是直接调基座工具）——
// 那样才验证了"薄转发层"本身能用；只调工具会漏掉 Makefile 写错这类问题。
//
// 用法：node tools/new-agent-selftest.mjs  （或 make new-agent-selftest）
// ============================================================================

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { EXIT_CODES } from "../core/gates/index.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");

let failures = 0;
const check = (name, cond, extra = "") => {
  if (!cond) failures++;
  console.log(`${cond ? "✅" : "❌"} ${name}${cond || !extra ? "" : `\n      ${extra}`}`);
};

const runMake = (dir, target, extraEnv = {}) => {
  const r = spawnSync("make", ["-s", target], {
    cwd: dir, encoding: "utf8",
    env: { ...process.env, ...extraEnv },
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

const walk = (dir, acc = []) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc); else acc.push(p);
  }
  return acc;
};

// ---------------------------------------------------------------------------
const base = fs.mkdtempSync(path.join(os.tmpdir(), "newagent-"));
const target = path.join(base, "my-first-agent");
console.log(`派生到：${target}`);

const gen = spawnSync(process.execPath, [path.join(HERE, "new-agent.mjs"), "my-first-agent", "--out", target], { encoding: "utf8", cwd: REPO });
check("new-agent 退出码 0", gen.status === 0, gen.stderr?.slice(-300));
check("派生目录已生成", fs.existsSync(target));

console.log("\n── §12.2 判据：结构 ──");
const files = walk(target).map((f) => path.relative(target, f).split(path.sep).join("/")).sort();
console.log("      文件：" + files.join(" · "));
check("有 agent.yaml / connectors.yaml / Makefile / README.md",
  ["agent.yaml", "connectors.yaml", "Makefile", "README.md"].every((f) => files.includes(f)));
check("有一个技能目录（skills/example/SKILL.md）", files.includes("skills/example/SKILL.md"));
check("**无 package.json**（业务方不需要管依赖）", !files.includes("package.json"));
check("无遗留占位符 {{...}}",
  !walk(target).some((f) => /\{\{[A-Z_]+\}\}/.test(fs.readFileSync(f, "utf8"))));

console.log("\n── §12.2 判据：无 TODO、无绝对路径 ──");
const todoHits = walk(target).filter((f) => /\bTODO\b|FIXME/.test(fs.readFileSync(f, "utf8")))
  .map((f) => path.relative(target, f));
check("grep TODO 为空", todoHits.length === 0, todoHits.join(", "));
const absHits = walk(target).filter((f) => {
  const t = fs.readFileSync(f, "utf8");
  // ① 基座引用必须是**相对**的：`AGENT_BASE_DIR` 不能以 `/` 开头
  //    （注意：`../../../Users/x/agent-base` 这种相对引用**包含**基座的绝对路径作为后缀，
  //      不能拿 includes(REPO) 去判 —— 那会把正确的相对引用误判成绝对路径）
  const m = t.match(/^AGENT_BASE_DIR \?= (\S+)$/m);
  if (m && m[1].startsWith("/")) return true;
  // ② **宿主**路径不该出现（前置字符是 `.` 或 `/` 说明属于 ../ 相对引用）。
  //    注意：容器内部路径（`/opt/...`）是**合法且必要**的 —— 它不绑定任何具体主机；
  //    早先连 `/opt` 一起禁，会把"镜像里 COPY 到 /opt/agent-base"这种正确写法误判成违规。
  return /(^|[\s"'=(])\/(Users|home)\//.test(t);
}).map((f) => path.relative(target, f));
check("无绝对路径（基座引用为相对路径）", absHits.length === 0, absHits.join(", "));

console.log("\n── §12.2 判据：生成后立刻全绿（跑生成出来的 Makefile）──");
for (const [targetName, label] of [["validate", "闸门 1"], ["render", "渲染"], ["doctor", "闸门 2"]]) {
  const r = runMake(target, targetName);
  check(`make ${targetName}（${label}）退出码 0`, r.status === 0, (r.stderr || r.stdout).slice(-300));
}

console.log("\n── 端到端：新派生出来的智能体应当四道闸门全过（开箱可用）──");
const v = runMake(target, "verify");
const usable = /可用：四道闸门全过/.test(v.stdout + v.stderr);
check("make verify 退出码 0", v.status === 0, (v.stderr || v.stdout).slice(-400));
check("并给出「可用」结论", usable, (v.stdout + v.stderr).slice(-400));

console.log("\n── 换运行时只需一个变量（定义不改）──");
const help = runMake(target, "help");
check("make help 可用（说明转发层取到了基座）", help.status === 0 && /HARNESS/.test(help.stdout + help.stderr));

console.log("\n── 生成器自身的防护 ──");
const dup = spawnSync(process.execPath, [path.join(HERE, "new-agent.mjs"), "my-first-agent", "--out", target], { encoding: "utf8", cwd: REPO });
check("目标已存在且非空时拒绝并给非零退出码", dup.status !== 0, `退出码 ${dup.status}`);
const badName = spawnSync(process.execPath, [path.join(HERE, "new-agent.mjs"), "Bad_Name", "--out", path.join(base, "x")], { encoding: "utf8", cwd: REPO });
check("非法 NAME 被拒绝", badName.status !== 0 && /不合法/.test(badName.stderr ?? ""), (badName.stderr ?? "").slice(-200));
const noName = spawnSync(process.execPath, [path.join(HERE, "new-agent.mjs")], { encoding: "utf8", cwd: REPO });
check("缺 NAME 时给用法而非静默成功", noName.status === EXIT_CODES.usage && /NAME/.test(noName.stderr ?? ""));

fs.rmSync(base, { recursive: true, force: true });
console.log(`\n${failures === 0 ? "模板自检：全绿（开箱可跑成立）" : `模板自检：失败 ${failures} 项`}`);
process.exit(failures === 0 ? EXIT_CODES.ok : 1);
