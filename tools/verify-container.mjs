#!/usr/bin/env node
// ============================================================================
// 受控容器验证入口（路线图 §30 A2）
//
// 用法：
//   node tools/verify-container.mjs <AGENT_DIR> [--harness pi] [--arch arm64|amd64]
//                                   [--render-dir DIR] [--dry-run] [--json]
//
// ## 为什么要有它（而不是让 AI 直接敲 docker）
//
// 让代理自己拼 `docker run` 等于把宿主交给它：`-v /:/host`、`--privileged`、挂 docker socket
// 都是"一条命令拿到宿主"的路径。所以这里的契约是：
//
//   **调用方只说"验哪个项目、哪个运行时、哪个架构"；docker 参数全部由基座生成，且不可追加。**
//
// 具体三条：
//   ① 旗标表是**封闭**的 —— 未知旗标直接拒（没有"再传一个 -v"的口子）
//   ② **绑定面 = 当前项目**：只挂两处，都是**只读**，落点固定（`/work/agent`、`/opt/agent-base/artifact`）；
//      基座工具链来自镜像**不挂**；宿主 node_modules 不挂；网络 `none`、根只读、能力全丢
//   ③ 项目目录**先 realpath 校验**（符号链接会被点名拒绝），且必须"像个智能体定义"（有 agent.yaml）；
//      另拒绝把 `/`、`$HOME`、仓库根当项目挂进去
//
// `--dry-run` 打印将执行的 docker 参数（含挂载的 source/mode）——**可供人工审阅，也可被自检断言**：
// "受控"如果不可验证就只是口号。
//
// 退出码：0 通过 / 2 用法或前置条件不满足（镜像缺失等）/ 容器内的退出码（失败时）/ 50 崩溃。
// ============================================================================

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { EXIT_CODES, parseArgs } from "../core/gates/index.mjs";
import { CONTAINER_ONLY } from "../core/introspect/_container-only.mjs";
import { GATE_DIFFERENCE_CLASS } from "../core/env/parity.mjs";
import { attributeFailure, GATE_LABELS, renderAttribution } from "../core/verify/attribution.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const REPO_VERSION = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8")).version;
const log = (s) => process.stderr.write(`${s}\n`);
const die = (msg, code = EXIT_CODES.usage) => { log(`❌ ${msg}`); process.exit(code); };

const { values, flags, positionals, errors } = parseArgs(process.argv.slice(2), {
  valueFlags: ["--harness", "--arch", "--render-dir"],
  booleanFlags: ["--dry-run", "--json", "--no-cache", "--allow-stale-image", "--help"],
});
const ALLOWED_FLAGS = new Set(["--dry-run", "--json", "--no-cache", "--allow-stale-image", "--help"]);
const unknown = [...flags].filter((f) => !ALLOWED_FLAGS.has(f));
if (unknown.length) die(`未知旗标：${unknown.join(", ")} —— 可用：${[...ALLOWED_FLAGS].join(" / ")}。`
  + `（docker 参数不接受调用方拼：绑定面由基座生成，见本文件顶部）`);
if (errors?.length) die(errors.join("；"));
if (flags.has("--help")) { log("用法: node tools/verify-container.mjs <AGENT_DIR> [--harness pi] [--arch arm64|amd64] [--render-dir DIR] [--dry-run] [--no-cache] [--json]"); process.exit(EXIT_CODES.ok); }

const asJson = flags.has("--json");
const dryRun = flags.has("--dry-run");
const harness = values["--harness"] ?? "pi";
const arch = values["--arch"] ?? (process.arch === "x64" ? "amd64" : "arm64");
const agentArg = positionals[0];
if (!agentArg) die("必须给 AGENT_DIR（要验哪个项目）");
// 只允许**一个**位置参数：单横线旗标（如 `-v /:/host`）会被当成位置参数，
// 若不管，调用方就能用"多塞一个位置参数"的方式绕过旗标白名单 —— 这条必须拦。
if (positionals.length > 1) die(`只接受一个位置参数（项目目录），多了：${positionals.slice(1).join(" ")}`
  + ` —— docker 参数不接受调用方拼（见本文件顶部）`);
if (!["arm64", "amd64"].includes(arch)) die(`--arch 只能是 arm64 或 amd64（给了 ${arch}）`);
if (!/^[a-z][a-z0-9-]{0,30}$/.test(harness)) die(`--harness 形状不合法：${harness}`);

// ---------------------------------------------------------------------------
// ① 项目目录：符号链接拒绝 + "像个智能体定义" + 拒绝危险落点
// ---------------------------------------------------------------------------
const agentAbs = path.resolve(agentArg);
if (!fs.existsSync(agentAbs)) die(`项目目录不存在：${agentAbs}`);
// **只拦"输入路径本身是符号链接"**：那才是"你以为挂的是 A，实际挂的是 B"的风险。
// 不拿 `realpath != resolve` 当判据 —— macOS 上 `/var`、`/tmp` 这类**祖先**是系统别名
// （真项目目录并没有符号链接），按那个判据会把所有临时目录都误杀（本轮实测踩中）。
if (fs.lstatSync(agentAbs).isSymbolicLink()) {
  die(`项目目录本身是符号链接，拒绝（realpath=${fs.realpathSync(agentAbs)}）—— 挂载源必须是真实目录，不猜。`);
}
// 实际挂 **realpath**（这样"挂进去的是哪个目录"无歧义），并在输出里同时给出原路径
const real = fs.realpathSync(agentAbs);
const stat = fs.statSync(real);
if (!stat.isDirectory()) die(`项目目录不是目录：${real}`);
if (!fs.existsSync(path.join(real, "agent.yaml"))) die(`${real} 里没有 agent.yaml —— 这不像一个智能体定义，拒绝挂载。`);
const forbidden = new Set(["/", os.homedir(), REPO]);
if (forbidden.has(real)) die(`拒绝把 ${real} 当项目挂进容器（根 / 家目录 / 仓库根都不是"当前项目"）。`);

// ---------------------------------------------------------------------------
// ② 渲染到**临时目录**：容器只拿到只读产物 + 只读定义，拿不到仓库
// ---------------------------------------------------------------------------
const artifactDir = path.resolve(values["--render-dir"] ?? fs.mkdtempSync(path.join(os.tmpdir(), "verify-container-artifact-")));
if (!dryRun) {
  const r = spawnSync(process.execPath, [path.join(REPO, `adapters/${harness}/render.mjs`), real, "--out", artifactDir],
    { encoding: "utf8", cwd: REPO, timeout: 300000 });
  if (r.status !== 0) {
    log(`❌ 渲染失败（退出码 ${r.status}）：`);
    log(`${(r.stdout ?? "")}${(r.stderr ?? "")}`.trim().split("\n").slice(-10).join("\n"));
    process.exit(EXIT_CODES.crash);
  }
}

// ---------------------------------------------------------------------------
// ③ docker 参数：**全部在这里生成**，调用方无法追加
// ---------------------------------------------------------------------------
const image = `agent-base:${REPO_VERSION}-${arch}`;          // 生产变体（不是 -debug）
const argv = [
  "docker", "run", "--rm",
  "--network", "none",                                       // 运行期无外网（与交付语义一致）
  "--platform", `linux/${arch}`,
  "--read-only",                                             // 只读根（安全下限的一部分）
  "--tmpfs", "/tmp",                                         // 只有 /tmp 可写
  "--cap-drop", "ALL",                                       // 能力全丢
  "--security-opt", "no-new-privileges",
  "-e", `HARNESS=${harness}`,
  "-e", "AGENT_DEFINITION_DIR=/work/agent",                  // 给了定义 ⇒ 闸门 1 也在容器里跑（agent-only）
  "-e", "HOME=/tmp/home",
  "-v", `${real}:/work/agent:ro`,                            // 当前项目：只读
  "-v", `${artifactDir}:/opt/agent-base/artifact:ro`,        // 产物：只读
  image, "verify",
];

let imageSameSource = null;
let imageInputsDigestOfTag = null;
let expectedInputsDigest = null;

const mounts = [
  { src: real, dst: "/work/agent", mode: "ro", role: "project" },
  { src: artifactDir, dst: "/opt/agent-base/artifact", mode: "ro", role: "artifact" },
];

// 镜像必须先存在（否则 docker 会去远端拉 —— 那是"静默换了要验的东西"，必须拦住并告诉你怎么建）
const imgInspect = spawnSync("docker", ["image", "inspect", image, "--format", "{{.Id}}"], { encoding: "utf8", timeout: 60000 });
const imageExists = imgInspect.status === 0;
const imageDigest = imageExists ? imgInspect.stdout.trim() : null;

if (dryRun) {
  const out = { where: "container", image, imageDigest, arch, harness, projectDir: real, artifactDir,
    mounts, argv, imageExists,
    note: "这是将要执行的 docker 参数（绑定面由基座生成；调用方无法追加参数）" };
  if (asJson) process.stdout.write(JSON.stringify(out, null, 2) + "\n");
  else {
    log("── 将执行的 docker 参数（干跑）──");
    log(`  镜像 ${image}${imageExists ? `（本地已有，${String(imageDigest).slice(0, 19)}…）` : "（本地没有，真跑会拒绝）"}`);
    for (const m of mounts) log(`  挂载 ${m.src} → ${m.dst} (${m.mode})  [${m.role}]`);
    log(`  ${argv.join(" ")}`);
  }
  process.exit(EXIT_CODES.ok);
}

if (!imageExists) {
  die(`本地没有镜像 ${image} —— 拒绝让 docker 去远端拉（那等于静默换了要验的东西）。\n`
    + `   先构建：node core/image/build.mjs --arch ${arch}（或 make image-all）`, EXIT_CODES.usage);
}

// ---------------------------------------------------------------------------
// ③′ **镜像过期就拒绝**（D13 的教训）
//
// 闸门源码是**烤进镜像**的。改了闸门判据但没重建镜像时，镜像里跑的是旧判据，
// 于是会出现"容器挂、本地过"的**假差异** —— 看起来像环境问题，其实是被验对象与验证者不同版本。
// 所以这里先比一次指纹（与构建端同一份实现）：不同源 ⇒ 拒绝，并给出重建命令。
// 确实要用旧镜像时显式 `--allow-stale-image`（把决定留痕在输出里）。
// ---------------------------------------------------------------------------
{
  const { imageInputsDigest } = await import("../core/image/inputs-digest.mjs");
  const expected = imageInputsDigest(REPO);
  const lbl = spawnSync("docker", ["image", "inspect", image, "--format", '{{index .Config.Labels "agent-base.inputs-digest"}}'],
    { encoding: "utf8", timeout: 60000 }).stdout.trim();
  imageSameSource = lbl === expected;
  imageInputsDigestOfTag = lbl || null;
  expectedInputsDigest = expected;
  if (!imageSameSource && !flags.has("--allow-stale-image")) {
    die(`镜像 ${image} 与当前源码**不同源**（镜像 LABEL ${lbl ? `${lbl.slice(0, 15)}…` : "缺失"} ≠ 当前源码 ${expected.slice(0, 15)}…）。\n`
      + `   闸门判据是烤进镜像的 ⇒ 用旧镜像验新产物会得到"容器挂、本地过"的假差异，结论不可比。\n`
      + `   先重建：node core/image/build.mjs --arch ${arch}（或 make image-all）；确实要用旧镜像时加 --allow-stale-image。`,
      EXIT_CODES.usage);
  }
  if (!imageSameSource) log(`⚠️ 用旧镜像（inputs-digest 不同源，已显式放行）—— 结论不与当前源码可比。`);
}

// ---------------------------------------------------------------------------
// ④ 结果缓存（A5 的"同一输入重复触发结果一致、不无效重跑"）
//
// 缓存的键 = **本次结论绑定的全部身份**：定义摘要 + 产物摘要 + 渲染输入摘要 + 镜像摘要 + 架构 + 运行时。
// 任一处变了就不再命中（换定义、改基座、重建镜像都会让键变）。
//
// **只缓存通过**（`usable: true`）。失败不缓存：失败往往意味着"正在改"，缓存它会让下一次
// 直接拿到旧结论、把迭代卡住 —— 而且真是环境抖动的话，缓存会把一次性故障永久固化。
// 想强制重跑：`--no-cache`。
// ---------------------------------------------------------------------------
const { digestCanonical } = await import("../core/gates/index.mjs");
const identityForCache = {
  definitionDigest: safeManifest(artifactDir, "definitionDigest"),
  artifactsDigest: safeManifest(artifactDir, "artifactsDigest"),
  renderInputsDigest: safeManifest(artifactDir, "renderInputsDigest"),
  imageDigest, arch, harness,
};
const cacheKey = digestCanonical(identityForCache);
const cacheFile = path.join(REPO, "dist", "verify-cache", `${cacheKey.replace(/^sha256:/, "")}.json`);
if (!flags.has("--no-cache") && fs.existsSync(cacheFile)) {
  try {
    const hit = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    const out = { ...hit, cached: true, cacheKey, note: "同一输入（定义/产物/渲染输入/镜像/架构/运行时）此前已通过 ⇒ 直接复用结论；用 --no-cache 强制重跑" };
    if (asJson) process.stdout.write(JSON.stringify(out, null, 2) + "\n");
    else log(`✅ 命中缓存（同一输入此前已通过，${hit.cachedAt ?? "?"}）—— 未重新跑容器。用 --no-cache 可强制重跑。`);
    process.exit(EXIT_CODES.ok);
  } catch { /* 缓存坏了就重跑，不因此失败 */ }
}

// ---------------------------------------------------------------------------
// ⑤ 跑，并把结果整理成结构化输出（AI 要读）
// ---------------------------------------------------------------------------
log(`▶ 容器内验证：${image}（arch=${arch}，绑定面 ${mounts.length} 处只读，网络 none）`);
const startedAt = Date.now();
const run = spawnSync(argv[0], argv.slice(1), { encoding: "utf8", timeout: 900000 });
const durationMs = Date.now() - startedAt;
const text = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;
const steps = text.split("\n")
  .map((l) => l.match(/^\s*(✅|❌)\s*(闸门 \d：[^—]+?)——\s*(.*)$/))
  .filter(Boolean)
  .map((m) => ({ ok: m[1] === "✅", label: m[2].trim(), verdict: m[3].trim() }));
const usable = run.status === 0 && /可用：镜像内自证通过/.test(text);

const report = {
  where: "container",
  image,
  imageDigest,
  arch,
  harness,
  identity: {
    definitionDigest: safeManifest(artifactDir, "definitionDigest"),
    artifactsDigest: safeManifest(artifactDir, "artifactsDigest"),
    effectiveConfigDigest: safeManifest(artifactDir, "effectiveConfigDigest"),
  },
  mounts,
  exitCode: run.status,
  usable,
  cached: false,                 // 本次是真跑的（命中缓存时在上面直接返回，标 cached: true）
  imageSameSource,               // 镜像与当前源码是否同源（D13：不同源必须显式放行才跑）
  imageInputsDigest: imageInputsDigestOfTag,
  expectedInputsDigest,
  durationMs,                    // 真实耗时（"不无效重跑"的证据）
  cacheKey,
  steps,
  // 本次容器结论**覆盖**的与**没覆盖**的（后者只能构建侧/镜像侧看）
  covered: ["static(agent-only)", "resolution", "probes", "smoke"],
  notCovered: ["security-floor(C9)", "dual-arch", "images-same-source"],
  attribution: null,
  rawTail: text.trim().split("\n").slice(-6),
};

// ---------------------------------------------------------------------------
// ⑤ 失败时**归因**（A4）：容器挂 ≠ 代码有 bug。跑一次宿主验证作对照，按类分开。
//    `unknown` 必须响亮上报 —— 它意味着存在**未声明的**差异，不许用"环境问题"糊过去。
// ---------------------------------------------------------------------------
if (!usable) {
  const failing = steps.filter((s) => !s.ok).map((s) => GATE_LABELS[s.label] ?? s.label);
  const hostRun = spawnSync(process.execPath,
    [path.join(REPO, "tools/verify.mjs"), real, "--harness", harness, "--out", artifactDir, "--json"],
    { encoding: "utf8", cwd: REPO, timeout: 900000 });
  let hostRan = [];
  let hostFailed = [];
  try {
    const hj = JSON.parse(hostRun.stdout);
    // ⚠️ 宿主 `verify` **首败即停**：`gates` 里只有真正跑过的那些 ⇒ 必须把"跑过"与"失败"分开。
    // 否则"没跑到"会被当成"本地通过"，凭空造出"容器专有失败"（本轮实测踩中，见 attribution.mjs 的注释）。
    hostRan = (hj.gates ?? []).map((g) => GATE_LABELS[g.id] ?? g.id);
    hostFailed = (hj.gates ?? []).filter((g) => !g.ok).map((g) => GATE_LABELS[g.id] ?? g.id);
  } catch { /* 宿主那侧跑不起来 ⇒ 都为空，归因会如实说"本地没跑到" */ }
  report.attribution = {
    ...attributeFailure({
      failing,
      containerOnly: CONTAINER_ONLY.map((c) => c.id),
      hostRan,
      hostFailed,
      gateDifferenceClass: GATE_DIFFERENCE_CLASS,
    }),
    hostExitCode: hostRun.status,
    hostRan,
  };
}

function safeManifest(dir, key) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, "render-manifest.json"), "utf8"))[key] ?? null; } catch { return null; }
}

// **只缓存通过**（理由见上面的注释）；写失败不影响本次结论
if (usable) {
  try {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify({ ...report, cached: undefined, cachedAt: new Date().toISOString() }, null, 2));
  } catch { /* 缓存写不了只是少一次加速，不是错误 */ }
}

if (asJson) process.stdout.write(JSON.stringify(report, null, 2) + "\n");
else {
  log("\n════ 容器内验证 ════");
  for (const s of steps) log(`  ${s.ok ? "✅" : "❌"} ${s.label} —— ${s.verdict}`);
  log(usable ? "\n✅ 容器内验证通过（离线、零凭据、只读绑定）" : `\n❌ 容器内验证未通过（退出码 ${run.status}）`);
  if (report.attribution) {
    log("\n── 失败归因（容器挂 ≠ 代码有 bug）──");
    log(renderAttribution(report.attribution));
    if (report.attribution.unknown.length) {
      log(`\n❗ 有 ${report.attribution.unknown.length} 项**未声明的差异**（${report.attribution.unknown.join(", ")}）`
        + `—— 本地过、容器挂且没人声明过：要么消差，要么在 core/env/parity.mjs 里登记它和理由。别猜。`);
    }
  }
  log(`  本次未覆盖：${report.notCovered.join(" · ")}`);
}
// 退出码：保持**语义表**（0/2/10/20/30/40/50）。容器内的退出码本身已按闸门语义给（verify-in-image
// 取首个失败闸门的码）；但对**旧镜像**（修之前构建的，失败时退 1）要对齐一次 ——
// 否则调用方拿到一个契约之外的码，CI/归因都没法判。
{
  const SEMANTIC = new Set(Object.values(EXIT_CODES));
  if (run.status === 0) process.exit(EXIT_CODES.ok);
  if (run.status >= 128) process.exit(EXIT_CODES.crash);
  if (SEMANTIC.has(run.status)) process.exit(run.status);
  const firstFailing = steps.find((s) => !s.ok);
  const gate = firstFailing ? GATE_LABELS[firstFailing.label] : null;
  const { exitCodeForGate } = await import("../core/gates/index.mjs");
  process.exit(gate ? exitCodeForGate(gate) : EXIT_CODES.crash);
}
