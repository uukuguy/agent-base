#!/usr/bin/env node
// ============================================================================
// 派生镜像（业务层）的构建与自证 —— P1
//
// 做三件事，每件都有可见证据：
//   ① 渲染产物（默认按某个运行时；产物是**烤进镜像**的，运行时不必挂载）
//   ② 组装构建上下文（Dockerfile + 产物 + 定义 + 接入缝 overlay），`docker build`
//   ③ **在镜像内自证**：`config-check`（配置齐备）+ `verify`（闸门 1–4，离线零凭据）
//
// 用法：
//   node tools/derived-image.mjs <AGENT_DIR> [--harness pi] [--base agent-base:0.1.0-arm64]
//        [--ref <镜像名:tag>] [--overlay <overlay 目录>] [--keep]
//
// 为什么要一个工具而不是一段文档：这条路径的价值就是"**从基座开始能有个足够好的起点**"，
// 起点必须**能一条命令跑通并自己确认没坏**，否则它只是又一份说明书。
// ============================================================================

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { EXIT_CODES, parseArgs } from "../core/gates/index.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const { values, flags, positionals, errors } = parseArgs(process.argv.slice(2), {
  valueFlags: ["--harness", "--base", "--ref", "--overlay"],
});

const usage = `用法: node tools/derived-image.mjs <AGENT_DIR> [--harness pi|dsh] [--base <基座镜像>] [--ref <镜像名:tag>] [--overlay <目录>] [--keep]`;
if (errors.length || positionals.length !== 1) {
  process.stderr.write(`${errors.join("；")}\n${usage}\n`);
  process.exit(EXIT_CODES.usage);
}

const agentDir = path.resolve(positionals[0]);
const harness = values["--harness"] ?? "pi";
const agentName = path.basename(agentDir);
const baseImage = values["--base"] ?? "agent-base:0.1.0-arm64";
const ref = values["--ref"] ?? `agent:${agentName}`;
const overlaySrc = values["--overlay"] ? path.resolve(values["--overlay"]) : null;
const keep = flags.has("--keep");

const step = (n, s) => process.stderr.write(`\n── ${n} ${s} ──\n`);
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", ...opts });

// ① 渲染产物
step(1, `渲染产物（harness=${harness}）`);
const work = fs.mkdtempSync(path.join(os.tmpdir(), "derived-image-"));
const artifact = path.join(work, "artifact");
const r = run(process.execPath, [path.join(REPO, `adapters/${harness}/render.mjs`), agentDir, "--out", artifact], { cwd: REPO });
if (r.status !== 0) {
  process.stderr.write(`❌ 渲染失败：\n${(r.stderr ?? "").slice(-400)}\n`);
  process.exit(EXIT_CODES.static);
}
process.stderr.write(`  ✅ 产物：${artifact}\n`);

// ② 组装上下文
step(2, "组装构建上下文");
const ctx = path.join(work, "context");
fs.mkdirSync(ctx, { recursive: true });
fs.copyFileSync(path.join(REPO, "core/image/derived/Dockerfile"), path.join(ctx, "Dockerfile"));
fs.cpSync(artifact, path.join(ctx, "artifact"), { recursive: true });
// 定义一起烤进去：镜像内自证就能连闸门 1 一起跑（否则只能跑闸门 2/3/4）
fs.cpSync(agentDir, path.join(ctx, "definition"), {
  recursive: true,
  filter: (src) => !src.includes(`${path.sep}.render`) && !src.includes(`${path.sep}dist`),
});
fs.mkdirSync(path.join(ctx, "overlay"), { recursive: true });
if (overlaySrc) {
  fs.cpSync(overlaySrc, path.join(ctx, "overlay"), { recursive: true });
  process.stderr.write(`  ✅ 接入缝：${overlaySrc}\n`);
} else {
  // 没有接入缝也要留一个**说明性**的空目录：让开发者知道这里是放业务代码/钩子的地方
  fs.writeFileSync(path.join(ctx, "overlay", "README.md"),
    "把业务代码与钩子放这里（见 agent-base 的 `docs/06-deploy.md` 的接入缝一节）。\n"
    + "最小形态：overlay.yaml 声明 harness 与 enhancements，extensions/ 放接入件，business/ 放共享业务代码。\n");
  process.stderr.write("  （未给 --overlay：留了一个空目录 + 说明）\n");
}

step(3, `docker build → ${ref}（FROM ${baseImage}）`);
const build = run("docker", ["build", "--build-arg", `BASE_IMAGE=${baseImage}`, "-t", ref, ctx], { timeout: 1800000 });
if (build.status !== 0) {
  process.stderr.write((build.stderr ?? "").split("\n").slice(-20).join("\n") + "\n");
  process.stderr.write("❌ 构建失败\n");
  process.exit(EXIT_CODES.crash);
}
process.stderr.write(`  ✅ 已构建 ${ref}\n`);

// ③ 镜像内自证（不挂载任何东西 —— 产物与定义都烤在里面了）
step(4, "镜像内自证：config-check + verify（离线、零凭据）");
const CREDS = ["-e", "CORP_GATEWAY_BASE_URL=http://127.0.0.1:9/v1", "-e", "CORP_GATEWAY_API_KEY=placeholder"];
const smoke = (label, args, { expectOk = true, creds = true } = {}) => {
  const s = run("docker", ["run", "--rm", "--network", "none", "-e", `HARNESS=${harness}`,
    ...(creds ? CREDS : []), ref, ...args], { timeout: 900000 });
  const ok = expectOk ? s.status === 0 : s.status !== 0;
  process.stderr.write(`  ${ok ? "✅" : "❌"} ${label}（退出码 ${s.status}）\n`);
  if (!ok) process.stderr.write((`${s.stdout ?? ""}${s.stderr ?? ""}`).split("\n").slice(-10).join("\n") + "\n");
  return ok;
};
const checks = [];
// config-check 本来就要端点与凭据（给了才通过）；不给时必须 fail-fast —— 两条都要验
checks.push(smoke("配置齐备（config-check，无挂载）", ["config-check"]));
checks.push(smoke("缺凭据 fail-fast（不静默跑）", ["config-check"], { expectOk: false, creds: false }));
const verify = run("docker", ["run", "--rm", "--network", "none", "-e", `HARNESS=${harness}`, ...CREDS, ref, "verify"], { timeout: 1800000 });
if (verify.status !== 0) process.stderr.write(`${verify.stdout ?? ""}${verify.stderr ?? ""}`.split("\n").slice(-14).join("\n") + "\n");
else process.stderr.write(`${verify.stdout ?? ""}`.split("\n").filter((l) => /镜像内自证|✅|❌/.test(l)).join("\n") + "\n");
checks.push(verify.status === 0);

process.stderr.write(`\n════ 派生镜像：${ref} ════\n`);
process.stderr.write(checks.every(Boolean)
  ? "✅ 可用：派生镜像构建成功，并在镜像内自证通过（产物与定义已烤入，运行时无需挂载）\n"
  : "❌ 派生镜像自证未通过\n");
if (keep) process.stderr.write(`构建上下文保留在：${ctx}\n`);
else fs.rmSync(work, { recursive: true, force: true });
process.exit(checks.every(Boolean) ? EXIT_CODES.ok : 1);
