#!/usr/bin/env node
// ============================================================================
// **收尾回归** —— 一条命令，把"改完代码到确认没坏"之间的所有机械步骤跑完。
//
// 为什么值得单独一个入口（§28 Q1 的"降调试次数"落在开发流上的形态）：
//   收尾要跑的东西有六类（自检 ×22 · 两侧 conformance · examples-check · selfcheck ·
//   生成物同步 · **镜像是否过期**），而最容易忘、代价最大的恰恰是最后一条 ——
//   闸门源码是烤进镜像的，改了闸门不重建镜像，后面对容器的每一条判断都不可比（D13）。
//   所以这里**先检查指纹、过期就先重建**，再往下跑。
//
// 用法：node tools/regression.mjs [--fast] [--json]   （或 make regression）
//   --fast：跳过"要真跑容器/真跑运行时"的几项（本地快检用；⚠️ 跳过的项**不算通过**）
//
// 退出码：0 全绿 · 1 有失败 · 2 用法错。
// ============================================================================

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { EXIT_CODES, parseArgs } from "../core/gates/index.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const { flags, errors } = parseArgs(process.argv.slice(2), { booleanFlags: ["--fast", "--json", "--help"] });
if (errors?.length) { process.stderr.write(`❌ ${errors.join("；")}\n`); process.exit(EXIT_CODES.usage); }
if (flags.has("--help")) { process.stderr.write("用法: node tools/regression.mjs [--fast] [--json]\n"); process.exit(EXIT_CODES.ok); }
const fast = flags.has("--fast");

/** 自检清单：与 CLAUDE.md / docs/14 里那份一致（这里也就成了它的单一真源）。 */
const SELFTESTS = [
  "validate", "validate-selftest", "hygiene-selftest", "child-env-selftest", "sanitize-selftest", "manifest-integrity-selftest", "host-arch-selftest", "dsh-staging-selftest", "capabilities-selftest", "bundles-selftest", "local-packages-check", "base-skills-selftest", "gates-selftest", "trace-selftest", "emit-selftest", "trace-view-selftest",
  "container-fixture-dir-selftest", "gateway-selftest", "providers-selftest", "startup-selftest", "pi-selftest", "pi-trace-selftest",
  "pi-trace-ext-selftest", "pi-project-info-selftest", "pi-capabilities-selftest", "pi-session-selftest", "pi-verify-container-selftest",
  "dsh-verify-container-selftest", "dsh-project-info-selftest", "dsh-capabilities-selftest", "probe-selftest", "project-info-selftest", "env-check-selftest",
  "verify-container-selftest", "unattended-selftest", "new-agent-selftest", "local-selftest",
];
/** 要真跑容器/真跑运行时的项：`--fast` 时跳过（并明确标"没验"）。 */
const HEAVY = new Set(["pi-verify-container-selftest", "dsh-verify-container-selftest", "verify-container-selftest", "unattended-selftest"]);

const log = (s) => process.stderr.write(`${s}\n`);
const results = [];
const record = (name, ok, detail, skipped = false) => {
  results.push({ name, ok, detail, skipped });
  log(`${skipped ? "⏭ " : ok ? "✅" : "❌"} ${name}${detail ? ` —— ${detail}` : ""}`);
};

const failureDetail = (r) => {
  if (r.status === 0) return "";
  const text = `${r.stderr ?? ""}\n${r.stdout ?? ""}`.trim().split("\n").filter(Boolean);
  return `退出码 ${r.status}${text.length ? `；输出尾部：${text.slice(-12).join(" | ")}` : ""}`;
};

const run = (cmd, args, timeout = 1800000) =>
  spawnSync(cmd, args, { cwd: REPO, encoding: "utf8", timeout });

// ---------------------------------------------------------------------------
// 0. 镜像是否与源码同源（过期就先重建）—— 这一步是这条命令存在的首要理由
// ---------------------------------------------------------------------------
const digestOfSource = () => {
  const r = run(process.execPath, ["-e", `
    import("${path.join(REPO, "core/image/inputs-digest.mjs").replace(/\\/g, "/")}").then((m) => process.stdout.write(m.imageInputsDigest()));
  `], 120000);
  return (r.stdout ?? "").trim();
};
let imageReady = false;
{
  const expected = digestOfSource();
  const tag = `agent-base:${JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8")).version}-${process.arch === "x64" ? "amd64" : "arm64"}`;
  const lbl = (run("docker", ["image", "inspect", tag, "--format", '{{index .Config.Labels "agent-base.inputs-digest"}}'], 60000).stdout ?? "").trim();
  if (lbl === expected && lbl) {
    imageReady = true;
    record("镜像与源码同源", true, `${tag}（${expected.slice(0, 15)}…）`);
  } else if (fast) {
    record("镜像与源码同源", false, `镜像过期（LABEL ${lbl ? lbl.slice(0, 12) : "缺失"}… ≠ 源码 ${expected.slice(0, 12)}…）—— --fast 不重建，相关项会跳过`, true);
  } else {
    log(`▶ 镜像过期（LABEL ${lbl ? `${lbl.slice(0, 12)}…` : "缺失"} ≠ 源码 ${expected.slice(0, 12)}…）⇒ 先重建（这是 D13 的教训：不重建就谈不上"验过"）`);
    const b = run(process.execPath, [path.join(REPO, "core/image/build.mjs"), "--all", "--debug"], 3000000);
    if (b.status !== 0) {
      record("镜像与源码同源", false, "重建失败，后续容器相关项不可信");
    } else {
      const lbl2 = (run("docker", ["image", "inspect", tag, "--format", '{{index .Config.Labels "agent-base.inputs-digest"}}'], 60000).stdout ?? "").trim();
      imageReady = lbl2 === expected;
      record("镜像与源码同源", imageReady, imageReady ? "已重建并核对" : "重建后仍不同源");
    }
  }
}

// ---------------------------------------------------------------------------
// 1. 生成物同步 + 自检 + 两侧 conformance + examples-check + 清单
// ---------------------------------------------------------------------------
for (const gen of [["tools/gen-capability-doc.mjs", "生成物：能力目录文档"], ["tools/gen-selection-facts.mjs", "生成物：选型事实材料"]]) {
  const r = run(process.execPath, [path.join(REPO, gen[0]), "--check"], 300000);
  record(gen[1], r.status === 0, r.status === 0 ? "与真源同步" : "**不同步** ⇒ 跑 make gen-docs");
}

for (const t of SELFTESTS) {
  if (fast && HEAVY.has(t)) { record(t, false, "要真跑容器/运行时 ⇒ --fast 跳过（**没验**）", true); continue; }
  if (!fast && HEAVY.has(t) && !imageReady) { record(t, false, "镜像不可用 ⇒ 跳过（**没验**）", true); continue; }
  const r = run("make", ["-s", t]);
  record(t, r.status === 0, r.status === 0 ? "" : `退出码 ${r.status}`);
}

for (const h of ["pi", "dsh"]) {
  const r = run(process.execPath, [path.join(REPO, "conformance/run.mjs"), "--harness", h], 1800000);
  record(`conformance(${h})`, r.status === 0, r.status === 0 ? "C1–C10 全过" : failureDetail(r));
}

{
  const r = run("make", ["-s", "examples-check"], 1800000);
  record("examples-check", r.status === 0, r.status === 0 ? "" : failureDetail(r));
}
{
  const r = run(process.execPath, [path.join(REPO, "tools/selfcheck.mjs")], 300000);
  record("selfcheck（能力 → 判据）", r.status === 0, r.status === 0 ? "每条能力都能指向真实判据" : failureDetail(r));
}

// ---------------------------------------------------------------------------
const failed = results.filter((r) => !r.ok && !r.skipped);
const skipped = results.filter((r) => r.skipped);
if (flags.has("--json")) {
  process.stdout.write(JSON.stringify({ ok: failed.length === 0, failed, skipped, results }, null, 2) + "\n");
} else {
  log("");
  log(failed.length
    ? `❌ 回归失败 ${failed.length} 项：${failed.map((f) => f.name).join(", ")}`
    : `✅ 回归全绿（${results.length - skipped.length} 项）${skipped.length ? `，另有 ${skipped.length} 项**没验**（不是通过）：${skipped.map((s) => s.name).join(", ")}` : ""}`);
}
process.exit(failed.length ? 1 : EXIT_CODES.ok);
