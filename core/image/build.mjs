#!/usr/bin/env node
// ============================================================================
// 镜像构建（统一设计 §9 / §12.4）
//
// ## 为什么按架构**分开构建**，而不是一次 `--platform a,b`
//
// 一次多平台构建要在 arm64 机器上通过 QEMU 模拟 amd64，装 11 个 MCP 服务器 + 两个 harness
// 会慢到不可用，而且**任何一架构失败都会毁掉整个构建**，排查时分不清是"代码问题"还是"模拟问题"。
//
// 所以主路径是：
//   ① `--arch <a>` 单架构构建并 `--load` —— 本机架构是原生的（快），另一个走模拟（慢但隔离）
//   ② `--manifest`   用一次多平台构建产出**真正的多架构 manifest list**（OCI 归档落盘）
//
// 这样消费者最终仍拿到"一个 tag 两个架构"，而日常开发不为模拟付代价。
//
// ## 版本 pin 的单一真源
//
// `PI_VERSION` / `DSH_VERSION` 从 `adapters/*/adapter.yaml` 读出来传给构建参数。
// **不在 Dockerfile 里抄第二份** —— 两份 pin 一定会漂移，且漂移时都不报错。
//
// 用法：
//   node core/image/build.mjs [--arch arm64|amd64] [--all] [--debug] [--manifest] [--tag-suffix S]
// ============================================================================

import fs from "node:fs";
import fsSync from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { EXIT_CODES } from "../gates/index.mjs";
import { parseArgs } from "../gates/cli.mjs";
// 输入指纹：构建端与检查端**共用同一份实现**（core/image/inputs-digest.mjs）
import { imageInputsDigest, IMAGE_CONTEXT_EXCLUDES, IMAGE_COPY_DIRS } from "./inputs-digest.mjs";
import { hostImageArch } from "./host-arch.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const IMAGE_DIR = HERE;

const log = (m) => process.stderr.write(m + "\n");

/** 坐标表 → 单个构建参数（空格分隔的 pkg@ver）。镜像据此安装，Dockerfile 无需认识任何 harness。 */
const specsArg = (specs) => specs.map((s) => `${s.package}@${s.version}`).join(" ");

/**
 * 保障多架构 builder 就绪（`--manifest` 与 `--push` 共用）。
 *
 * 本机由 OrbStack 管理 Docker，其 context 只有 `docker` 驱动，而该驱动**不支持 manifest list**
 * （`--load` 实测报错 "docker exporter does not currently support exporting manifest lists"），
 * OrbStack 也未暴露 containerd 镜像存储开关。因此多架构必须落到 `docker-container` 驱动的 builder。
 */
const MULTI_BUILDER = "ab-multi";

/**
 * 找出一个 **docker 驱动**的 builder 名字。
 *
 * 为什么单架构/调试变体必须用它，而不是 container builder：
 *   · 调试变体是 `FROM <基础镜像 tag>`，而基础镜像只在**本地镜像库**里；
 *   · `docker-container` 驱动的 builder 有自己独立的镜像库，**看不到**前者 ⇒ 找不到基础镜像。
 * 这正是"把当前 builder 切成 container 后，`--all --debug` 开始失败"的原因。
 *
 * 反过来，多平台构建必须在 container builder 上做（docker 驱动不支持）。
 * 所以结论是：**每次构建显式指定对的 builder**，不要依赖"当前 builder"。
 */
/**
 * 列出 buildx builder（名字 + 驱动）。
 *
 * **不要用 `docker buildx ls --format`**：本机 buildx 0.33 下它对 `{{.Name}}/{{.Driver}}` 返回**空**，
 * 于是探测永远失败、调试变体构建挂掉（构建信息里只有一段看不懂的 buildkit 堆栈）。
 * 解析纯文本表格反而稳定（`NAME/NODE` 表头 + 以 `\_` 开头的节点行要跳过）。
 */
function listBuilders() {
  const out = spawnSync("docker", ["buildx", "ls"], { encoding: "utf8" }).stdout;
  const rows = [];
  for (const line of out.split("\n")) {
    const t = line.trim();
    if (!t || /^NAME\/NODE/.test(t) || t.startsWith("\\_") || t.startsWith("Cannot load")) continue;
    const m = t.match(/^(\S+)\s+(\S+)/);
    if (m) rows.push({ name: m[1].replace(/\*$/, ""), driver: m[2] });
  }
  return rows;
}

function dockerDriverBuilder() {
  const dockerOnes = listBuilders().filter((r) => r.driver === "docker").map((r) => r.name);
  if (!dockerOnes.length) return null;
  // 优先与当前 docker context 同名的那个（OrbStack 下即为 `orbstack`），否则退到第一个
  const ctx = spawnSync("docker", ["context", "show"], { encoding: "utf8" }).stdout.trim();
  return dockerOnes.includes(ctx) ? ctx : dockerOnes[0];
}
function ensureMultiBuilder() {
  const have = listBuilders().map((r) => r.name);
  if (!have.includes(MULTI_BUILDER)) {
    log(`▶ 创建多架构 builder：${MULTI_BUILDER}（docker-container 驱动 —— 本机 docker 驱动不支持 manifest list）`);
    const c = docker(["buildx", "create", "--name", MULTI_BUILDER, "--driver", "docker-container", "--bootstrap"], { capture: true });
    if (c.status !== 0) { log(c.stdout + c.stderr); log("\n❌ 无法创建多架构 builder"); process.exit(EXIT_CODES.crash); }
    return;
  }
  // 复用前确认它真的在跑：只 ls 到名字就开工会拿到含糊的 "no builder" 失败（OrbStack 重启后常见）
  const b = docker(["buildx", "inspect", MULTI_BUILDER, "--bootstrap"], { capture: true });
  if (b.status !== 0) { log(b.stdout + b.stderr); log(`\n❌ 多架构 builder ${MULTI_BUILDER} 无法就绪`); process.exit(EXIT_CODES.crash); }
}

/**
 * 从各 `adapters/<h>/adapter.yaml` 读安装坐标 —— **pin 的单一真源**。
 *
 * 本文件在 `core/` 下，因此**不得出现任何 harness 名**（core/ 的硬规则）：
 * 这里只做"遍历 adapters/ 目录"，具体是哪个 harness 由目录与 adapter.yaml 决定。
 * 结果是给镜像用的一份坐标表（写入 harnesses.lock.json），Dockerfile 完全数据驱动。
 */
function readHarnessSpecs() {
  const dir = path.join(REPO, "adapters");
  const specs = [];
  for (const name of fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()) {
    const f = path.join(dir, name, "adapter.yaml");
    if (!fs.existsSync(f)) continue;
    const a = YAML.parse(fs.readFileSync(f, "utf8"));
    if (!a?.version) throw new Error(`adapters/${name}/adapter.yaml 缺 version —— 镜像 pin 无处可取`);
    if (!a?.package) throw new Error(`adapters/${name}/adapter.yaml 缺 package —— 镜像装什么无从得知`);
    // 表里**只放包坐标**：本文件在 core/ 下，出现 harness 名会违反 core/ 的分层规则，
    // 而构建/运行其实都不需要名字 —— 装什么由 package@version 决定。
    // 带上可执行名：镜像自己该知道"有哪些运行时、各自怎么起" ——
  // 入口脚本据此在"只装了一个运行时"时免去调用方指定（并明确提示是按哪个起的）。
  specs.push({ package: a.package, version: a.version, bin: a.bin });
  }
  specs.sort((a, b) => a.package.localeCompare(b.package));
  if (specs.length === 0) throw new Error("adapters/ 下没有可用的 adapter.yaml —— 镜像没有 harness 可装");
  return specs;
}

/**
 * 组装**构建上下文**。
 *
 * 为什么生成的构建输入不放在 `core/image/` 里：坐标表必须写出 npm 包名，而**包名本身
 * 就带着 harness 名**（scope 与包名里都有），于是 `core/harness-name` 这条分层规则会被
 * 自己生成的产物踩中。**生成的构建输入不是源码** —— 落在 `dist/`（已 gitignore）才是它
 * 该在的地方，core/ 只留人工维护的源文件。
 */
function prepareContext(specs) {
  const ctx = path.join(REPO, "dist/image/context");
  fs.rmSync(ctx, { recursive: true, force: true });
  fs.mkdirSync(ctx, { recursive: true });
  // 启动期准备脚本必须进上下文：它是"参数下放"的落地点（见 core/image/startup.mjs 的文件头）
  for (const f of ["Dockerfile", "Dockerfile.debug", "entrypoint.sh", "preinstall.lock.txt"]) {
  // 注意：inputs-digest.mjs 只被 build.mjs 自己 import，不必进上下文（它不参与镜像内容）
    fs.copyFileSync(path.join(IMAGE_DIR, f), path.join(ctx, f));
  }
  // startup.mjs **不再拷成一份独立副本**，而是在镜像根放一个**转发**：
  // 真实实现随 `gates/` 一起进去（`gates/core/image/startup.mjs`），那里的相对导入才解析得到
  // （实测踩中：根上的副本 import `../bundles/index.mjs` → 解析成 `/opt/bundles` ⇒ ERR_MODULE_NOT_FOUND）。
  // 转发让"镜像根的入口路径"保持不变（entrypoint 与 docs/06 都引用它），而实现只有一份。
  fs.writeFileSync(path.join(ctx, "startup.mjs"),
    "// 生成的转发文件（见 core/image/build.mjs）：真实实现在 gates/core/image/startup.mjs ——\n"
    + "// 那是它相对导入（../bundles、../gates 等）能解析的位置。别在这里加逻辑。\n"
    + 'import "./gates/core/image/startup.mjs";\n');
  // 闸门源码进上下文（P2：镜像内自证）。保持相对布局 —— 各工具靠**自身位置**推 REPO，
  // 所以在 /opt/agent-base/gates/ 下同样成立。不含 node_modules；依赖在 Dockerfile 里装。
  // 拷哪几棵树、排除什么：与指纹实现**同一份清单**（各写一份迟早漂移 —— D13 就是这么来的）
  for (const dir of IMAGE_COPY_DIRS) {
    fs.cpSync(path.join(REPO, dir), path.join(ctx, "gates", dir), {
      recursive: true,
      filter: (src) => !IMAGE_CONTEXT_EXCLUDES.some((x) => src.includes(`${path.sep}${x}`)),
    });
  }
  fs.copyFileSync(path.join(REPO, "core/image/verify-in-image.mjs"), path.join(ctx, "gates", "verify-in-image.mjs"));

  fs.writeFileSync(path.join(ctx, "harnesses.lock.json"), JSON.stringify({
    note: "由 core/image/build.mjs 从 adapters/*/adapter.yaml 生成 —— 不要手改。",
    harnesses: specs,
  }, null, 2) + "\n");
  return ctx;
}

function docker(args, { capture = false } = {}) {
  const r = spawnSync("docker", args, { encoding: "utf8", cwd: REPO, stdio: capture ? "pipe" : "inherit" });
  if (capture) return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  return { status: r.status };
}

function hostArch() {
  const m = spawnSync("uname", ["-m"], { encoding: "utf8" }).stdout.trim();
  return hostImageArch(m);
}

function buildArch({ arch, tag, baseTag, debug, specs, ctx, noCache, inputsDigest }) {
  const platform = `linux/${arch}`;
  const args = [
    "buildx", "build", `--platform`, platform, "--load",
    "-t", tag,
  ];
  // 显式指定 docker 驱动的 builder：调试变体要 FROM 本地基础镜像，只有它能看见本地镜像库
  const localBuilder = dockerDriverBuilder();
  if (localBuilder) args.push("--builder", localBuilder);
  else log("⚠️ 没找到 docker 驱动的 builder，将沿用当前 builder（若当前是 container 驱动，调试变体会因看不到本地镜像而失败）");
  if (noCache) args.push("--no-cache");
  // 烤进镜像的输入指纹：让"镜像是否与当前源码同源"可被检查（而不是靠人记得重建）
  if (inputsDigest) args.push("--build-arg", `IMAGE_INPUTS_DIGEST=${inputsDigest}`);
  if (debug) {
    // 显式传基础镜像 tag：早前用 `tag.replace(/-debug$/, "")` 猜，而调试 tag 形如
    // `...-debug-arm64`（结尾是架构），替换不中 ⇒ BASE_IMAGE 指回自己 ⇒ 拉取失败。
    args.push("--build-arg", `BASE_IMAGE=${baseTag}`, "-f", path.join(ctx, "Dockerfile.debug"), ctx);
  } else {
    args.push("-f", path.join(ctx, "Dockerfile"), ctx);
  }
  log(`\n▶ 构建 ${tag}（${platform}${debug ? " · 调试变体" : ""}）`);
  const r = docker(args, { capture: true });
  if (r.status !== 0) {
    // 只把尾部给出来：docker 输出极长，头部都是无关的拉取进度
    log(r.stdout.split("\n").slice(-25).join("\n"));
    log(r.stderr.split("\n").slice(-15).join("\n"));
    return { ok: false };
  }
  const digest = docker(["image", "inspect", "--format", "{{index .RepoDigests 0}}", tag], { capture: true }).stdout.trim()
    || docker(["image", "inspect", "--format", "{{.Id}}", tag], { capture: true }).stdout.trim();
  log(`✅ ${tag}  摘要 ${digest || "(未取到)"}`);
  return { ok: true, tag, digest, arch };
}

function main() {
  const { values, flags } = parseArgs(process.argv.slice(2), { valueFlags: ["--arch", "--tag-suffix", "--push"] });
  if (flags.has("--help") || flags.has("-h")) {
    process.stderr.write([
      "用法: node core/image/build.mjs [选项]",
      "",
      "  --arch arm64|amd64   只构建该架构（本地 --load，原生优先）",
      "  --all                两个架构分别构建并 --load（本地验证用）",
      "  --debug              连调试变体一起构建",
      "  --manifest           产出多架构 OCI 归档（无需 registry）",
      "  --push <ref>         构建两个架构并推送到 registry —— **本机多架构的标准路径**",
      "  --tag-suffix S       镜像 tag 后缀",
      "  --no-cache           禁用构建缓存",
      "  --ensure-builder     建好多架构 builder 并设为当前（让手敲 buildx 多平台命令可用）",
      "",
      "为什么 --push 是标准路径：本机存储驱动是 overlay2（经典存储），",
      "`--load` 明确不支持 manifest list（实测报错）。所以「一个 tag 两个架构」要么推 registry，",
      "要么落 OCI 归档，要么分架构各存一份。",
    ].join("\n") + "\n");
    process.exit(EXIT_CODES.ok);
  }

  // 构建前先确认锁与清单同步：镜像里装的包必须与清单一致，不能等构建完才发现
  const lock = spawnSync(process.execPath, [path.join(IMAGE_DIR, "gen-preinstall-lock.mjs"), "--check"], { encoding: "utf8" });
  if (lock.status !== 0) { log(lock.stdout + lock.stderr); process.exit(EXIT_CODES.static); }

  const specs = readHarnessSpecs();
  const ctx = prepareContext(specs);
  log(`版本 pin（来自 adapters/*/adapter.yaml）：${specsArg(specs)}`);
  const version = YAML.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8")).version ?? "0.1.0";
  const suffix = values["--tag-suffix"] ?? "";
  const tagFor = (arch, debug) => `agent-base:${version}${suffix}${debug ? "-debug" : ""}-${arch}`;

  if (flags.has("--ensure-builder")) {
    // 只为"手敲 buildx 多平台命令"准备环境：建好并**切为当前** builder。
    // 为什么需要它：`docker buildx build` 不指定 builder 时用当前选中的那个，而本机当前
    // 默认是 OrbStack 的 docker 驱动 —— 该驱动连多平台构建都不支持。切过来之后，
    // 最朴素的这条命令即可工作：
    //   docker buildx build -f Dockerfile --platform linux/arm64,linux/amd64 -t my-image .
    ensureMultiBuilder();
    const u = docker(["buildx", "use", MULTI_BUILDER], { capture: true });
    if (u.status !== 0) { log(u.stdout + u.stderr); log("\n❌ 无法切换当前 builder"); process.exit(EXIT_CODES.crash); }
    log(`✅ 当前 builder 已设为 ${MULTI_BUILDER}（docker-container 驱动）。`);
    log("   注意：不加 --load/--push/--output 时，构建结果只留在 build cache 里（buildx 会给出 WARNING），");
    log("   `docker images` 里看不到 —— 需要落本地就加 --load（单架构），要一个 tag 两个架构就 --push 或 --output。");
    process.exit(EXIT_CODES.ok);
  }

  const all = flags.has("--all");
  const arches = all ? ["arm64", "amd64"] : [values["--arch"] ?? hostArch()];
  const results = [];

  if (!flags.has("--manifest")) {
    for (const arch of arches) {
      // 指纹按**源码树**算（不是按上下文）：这样「改了闸门代码但没重建镜像」一定会被发现（D13）
      const inputsDigest = imageInputsDigest(REPO);
      const base = buildArch({ arch, tag: tagFor(arch, false), debug: false, specs, ctx, noCache: flags.has("--no-cache"), inputsDigest });
      if (!base.ok) { log(`\n❌ ${arch} 基础镜像构建失败`); process.exit(EXIT_CODES.crash); }
      results.push(base);
      if (flags.has("--debug")) {
        const dbg = buildArch({ arch, tag: tagFor(arch, true), baseTag: tagFor(arch, false), debug: true, specs, ctx, noCache: flags.has("--no-cache"), inputsDigest });
        if (!dbg.ok) { log(`\n❌ ${arch} 调试变体构建失败`); process.exit(EXIT_CODES.crash); }
        results.push(dbg);
      }
    }
  }

  if (values["--push"]) {
    // 本机（OrbStack + overlay2）多架构的标准路径：构建两架构并推到 registry。
    // 这是唯一能给出「一个 tag + manifest list 摘要」的本地可行方式。
    const ref = values["--push"];
    if (/\s/.test(ref) || !ref.includes(":")) { log(`❌ --push 需要一个完整引用（含 tag），例如 registry.example.com/ns/agent-base:0.1.0（收到「${ref}」）`); process.exit(EXIT_CODES.usage); }
    ensureMultiBuilder();
    log(`\n▶ 构建并推送多架构镜像 → ${ref}`);
    const r = docker([
      "buildx", "build", "--builder", MULTI_BUILDER,
      "--platform", "linux/arm64,linux/amd64",
      "-f", path.join(ctx, "Dockerfile"),
      "--push", "-t", ref,
      ctx,
    ], { capture: true });
    if (r.status !== 0) { log(r.stdout.split("\n").slice(-20).join("\n")); log(r.stderr.split("\n").slice(-12).join("\n")); log("\n❌ 推送失败"); process.exit(EXIT_CODES.crash); }
    const insp = docker(["buildx", "imagetools", "inspect", ref], { capture: true }).stdout;
    log(`✅ 已推送：${ref}`);
    log(insp.split("\n").filter((l) => /Name:|Platform|Digest|Manifest/.test(l)).slice(0, 8).join("\n"));
    process.stdout.write(JSON.stringify({ version, harnesses: specs, pushed: ref, platforms: insp.split("\n").filter((l) => /Platform:/.test(l)).map((l) => l.trim()) }, null, 2) + "\n");
    process.exit(EXIT_CODES.ok);
  }

  if (flags.has("--manifest")) {
    ensureMultiBuilder();
    // 多架构 manifest 需要能导出 OCI 的 builder。本机由 **OrbStack** 管理 Docker，
    // 它的 context 只有 `docker` 驱动（default / orbstack 两个 builder 都是），
    // 而该驱动**不支持 OCI 导出**（实测报错 "OCI exporter is not supported for the docker driver"）。
    // 因此必须用 `docker-container` 驱动的 builder —— 这不是多此一举，是本环境下的唯一路径。
    // 复用已存在的那个；若它只是存在但没起来，先 bootstrap（OrbStack 重启后会遇到）。
    // 真正的多架构 manifest list：用一次多平台构建产出 OCI 归档。
    // 没有 registry 也能落盘验证；将来 I2（内网能否推镜像）解决后换成 --push 即可。
    const dest = path.join(REPO, "dist/image", `agent-base-${version}${suffix}.oci.tar`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    log(`\n▶ 合并多架构 manifest → ${path.relative(REPO, dest)}`);
    const r = docker([
      "buildx", "build",
      "--builder", MULTI_BUILDER,
      "--platform", "linux/arm64,linux/amd64",
      "-f", path.join(ctx, "Dockerfile"),
      // 归档里的镜像也要带**输入指纹**：实测漏过一次 —— 本地镜像带指纹、归档里却是 unknown，
      // 于是"归档是否与当前源码同源"无从判断。
      "--build-arg", `IMAGE_INPUTS_DIGEST=${imageInputsDigest(REPO)}`,
      "--output", `type=oci,dest=${dest}`,
      ctx,
    ], { capture: true });
    if (r.status !== 0) {
      log(r.stdout.split("\n").slice(-25).join("\n"));
      log(r.stderr.split("\n").slice(-15).join("\n"));
      log("\n❌ manifest 构建失败");
      process.exit(EXIT_CODES.crash);
    }
    log(`✅ 多架构 manifest 已落盘：${path.relative(REPO, dest)}`);
  }

  process.stdout.write(JSON.stringify({
    version, harnesses: specs,
    images: results.map((r) => ({ tag: r.tag, arch: r.arch, digest: r.digest })),
    manifest: flags.has("--manifest") ? `dist/image/agent-base-${version}${suffix}.oci.tar` : null,
  }, null, 2) + "\n");
  process.exit(EXIT_CODES.ok);
}

main();
