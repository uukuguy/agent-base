#!/usr/bin/env node
// ============================================================================
// 本地开发环境：按 pin 校验/安装 harness（统一设计 §9.3）
//
// ## 它解决什么
//
// 「本地跑的」和「镜像里跑的」必须是同一批版本，否则本地验过的问题在容器里复现不出来、
// 或反过来。而版本 pin 的单一真源是各 `adapters/<h>/adapter.yaml`（镜像也读它）。
// 所以本命令把"你本机的 harness 版本"与那份 pin 对齐，并明确报告差异。
//
// ## 行为
//
//   默认：校验 + **缺/不符就装**（dev-env 的意义就是让环境就位）
//   CHECK=1 / --check：只校验，不改动本机
//
// 装是**全局**装 —— 与本机既有布局一致（`npm ls -g` 可见）。它确实会改动开发者机器，
// 所以每一步都打印出来，并且只在版本不一致时才动手。
//
// 用法：node tools/dev-env.mjs [--check] [--json]
// 退出码：0 就绪 / 2 用法错误 / 10 未就绪（check 模式下有差异）/ 50 安装失败
// ============================================================================

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { EXIT_CODES, parseArgs } from "../core/gates/index.mjs";
// pin 的读取只有一处实现（`make env-check` 也用它，避免两处各读一遍 adapters/ 而漂移）
import { readAdapterPins as readAdapters } from "../core/catalog/adapter-pins.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");

/** 已全局安装的包 → 版本。 */
function installedGlobal() {
  const r = spawnSync("npm", ["ls", "-g", "--depth=0", "--json"], { encoding: "utf8", timeout: 120000 });
  try {
    const deps = JSON.parse(r.stdout || "{}").dependencies ?? {};
    return Object.fromEntries(Object.entries(deps).map(([k, v]) => [k, v.version]));
  } catch {
    return {};
  }
}

function binVersion(bin) {
  const r = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 60000 });
  return r.status === 0 ? (r.stdout.trim().split("\n")[0] || null) : null;
}

const main = () => {
  const { flags } = parseArgs(process.argv.slice(2));
  if (flags.has("--help") || flags.has("-h")) {
    process.stderr.write("用法: node tools/dev-env.mjs [--check] [--json]\n");
    process.exit(EXIT_CODES.ok);
  }
  const checkOnly = flags.has("--check") || process.env.CHECK === "1";
  const adapters = readAdapters();
  if (!adapters.length) { process.stderr.write("❌ adapters/ 下没有可用的 adapter.yaml\n"); process.exit(EXIT_CODES.static); }

  const installed = installedGlobal();
  const rows = [];
  let needInstall = [];

  for (const a of adapters) {
    const have = installed[a.pkg] ?? null;
    const want = a.version;
    const state = have === want ? "ok" : have ? "mismatch" : "missing";
    if (state !== "ok") needInstall.push({ ...a, have });
    rows.push({ ...a, have, state, binVersion: binVersion(a.bin) });
  }

  process.stderr.write("── harness 版本（pin 单一真源：adapters/*/adapter.yaml）──\n");
  for (const r of rows) {
    const mark = r.state === "ok" ? "✅" : r.state === "missing" ? "✖" : "⚠️";
    process.stderr.write(`  ${mark} ${r.adapter.padEnd(5)} 期望 ${r.version.padEnd(12)} 本机 ${(r.have ?? "未安装").padEnd(12)} 可执行 ${r.binVersion ?? "不可用"}\n`);
  }

  if (!needInstall.length) {
    process.stderr.write("\n✅ 本地环境与 pin 一致。\n");
    if (flags.has("--json")) process.stdout.write(JSON.stringify({ ok: true, harnesses: rows }, null, 2) + "\n");
    process.exit(EXIT_CODES.ok);
  }

  if (checkOnly) {
    process.stderr.write(`\n❌ ${needInstall.length} 个 harness 与 pin 不一致（--check 模式，未改动本机）。安装：\n`);
    for (const n of needInstall) process.stderr.write(`     npm install -g ${n.pkg}@${n.version}\n`);
    process.exit(EXIT_CODES.static);
  }

  process.stderr.write(`\n▶ 安装/对齐 ${needInstall.length} 个 harness（全局）──\n`);
  for (const n of needInstall) {
    process.stderr.write(`  npm install -g ${n.pkg}@${n.version}\n`);
    const r = spawnSync("npm", ["install", "-g", "--no-audit", "--no-fund", `${n.pkg}@${n.version}`], { stdio: "inherit", timeout: 900000 });
    if (r.status !== 0) {
      process.stderr.write(`\n❌ 安装失败：${n.pkg}@${n.version}\n   内网拉不到 npm 时，需要先配好 registry（外部输入 I2）。\n`);
      process.exit(EXIT_CODES.crash);
    }
  }

  const after = installedGlobal();
  const bad = adapters.filter((a) => after[a.pkg] !== a.version);
  if (bad.length) { process.stderr.write(`\n❌ 安装后仍不一致：${bad.map((b) => b.pkg).join(", ")}\n`); process.exit(EXIT_CODES.crash); }
  process.stderr.write("\n✅ 本地环境已与 pin 对齐。\n");
  if (flags.has("--json")) process.stdout.write(JSON.stringify({ ok: true, installed: needInstall.map((n) => `${n.pkg}@${n.version}`) }, null, 2) + "\n");
  process.exit(EXIT_CODES.ok);
};

main();
