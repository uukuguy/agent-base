// ============================================================================
// 本地预装镜像（.local-packages）**按锁装齐 / 校验**
//
// ## 为什么要有这条
//
// 本地要跑真东西（连接器、插件、闸门 3/4），就需要镜像里那些 npm 包的**对应物**。
// 这个目录过去是**手工**攒的：无 package.json、无锁、无校验。代价在本轮实测过一次：
// 为了让一个新插件在本地可用，我用 `npm install --prefix .local-packages <两个包>`
// —— npm 顺手把**其余包全剪掉了**（`@modelcontextprotocol/server-filesystem` 等当场消失），
// 于是闸门 3 报"连接器的包不在本地/镜像里"。手工目录就是这样：一次"只装一个"的操作能毁掉全部。
//
// 现在它与镜像**同源**：输入就是 `core/image/preinstall.lock.txt`（镜像构建用的同一份锁）。
// 用法：node tools/local-packages.mjs [--check]
// ============================================================================

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const LOCK = path.join(REPO, "core/image/preinstall.lock.txt");
const MIRROR = path.join(REPO, ".local-packages");
const check = process.argv.includes("--check");

if (!fs.existsSync(LOCK)) {
  process.stderr.write(`❌ 找不到预装锁：${LOCK}（先跑 make image-lock）\n`);
  process.exit(2);
}
const lockText = fs.readFileSync(LOCK, "utf8");
const specs = lockText.split("\n").filter((l) => l.startsWith("npm ")).map((l) => l.slice(4).trim()).filter(Boolean);
// apt 行是「一行多个包」（`apt pkg1 pkg2 …`）⇒ 摊平成逐项，好在报告里逐个说清
const nameOf = (spec) => spec.replace(/@[^@]+$/, "");
const aptSpecs = lockText.split("\n").filter((l) => l.startsWith("apt ")).flatMap((l) => l.slice(4).trim().split(/\s+/)).filter(Boolean);
const dirOf = (spec) => path.join(MIRROR, "node_modules", ...nameOf(spec).split("/"));
const missing = specs.filter((s) => !fs.existsSync(dirOf(s)));
const wantLock = process.argv.includes("--lock");
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

// 版本核对：镜像锁是**精确 pin**，本地镜像也必须落在同一版本上（不然"本地过"与"镜像过"说的不是一回事）
const installed = specs.map((spec) => {
  const pj = path.join(dirOf(spec), "package.json");
  let version = null;
  try { version = JSON.parse(fs.readFileSync(pj, "utf8")).version ?? null; } catch { version = null; }
  const pinned = spec.slice(nameOf(spec).length + 1);
  return { spec, name: nameOf(spec), pinned, version, matches: version === pinned };
});
const versionDrift = installed.filter((x) => x.version && !x.matches);

/** 可复算指纹：只覆盖"锁里声明了什么 + 本地落在什么版本"，与镜像同一份输入。 */
function fingerprint() {
  return {
    apiVersion: "agent-base/v1",
    source: "core/image/preinstall.lock.txt",
    lockDigest: `sha256:${sha256(lockText)}`,
    npm: installed.map((x) => ({ spec: x.spec, version: x.version })),
    apt: aptSpecs.map((spec) => ({
      spec,
      // apt 类在本地是**宿主提供**（不是我们装的）：如实标注，不假装本地镜像管了它
      hostProvided: true,
      note: "本机由宿主提供（版本不保证与镜像一致）；只有镜像里才是按锁装的",
    })),
  };
}
/** 同一份输入的复算（排序后拼字符串再哈希 ⇒ 与遍历顺序无关）。 */
function digestOf(fp) {
  const body = [...fp.npm.map((x) => `npm:${x.spec}@${x.version ?? "missing"}`), ...fp.apt.map((x) => `apt:${x.spec}`)].sort().join("\n");
  return `sha256:${sha256(body)}`;
}
// ⚠️ 指纹**不放 core/**：里面的包名含运行时名，`core/harness-name` 会（正确地）判红；
// 而且它描述的是"开发机上的对应物"，本就属于仓库根。
const FP_PATH = path.join(REPO, ".local-packages.lock.json");

if (wantLock) {
  const fp = { ...fingerprint(), digest: null };
  fp.digest = digestOf(fp);
  fs.mkdirSync(path.dirname(FP_PATH), { recursive: true });
  fs.writeFileSync(FP_PATH, JSON.stringify(fp, null, 2) + "\n");
  console.log(`✅ 已生成本地预装镜像指纹：${path.relative(REPO, FP_PATH)}（npm ${fp.npm.length} · apt ${fp.apt.length} · ${fp.digest.slice(0, 18)}…）`);
  process.exit(0);
}

if (check) {
  const problems = [];
  if (missing.length) problems.push(`缺 ${missing.length} 项（跑 make local-packages）：${missing.join(", ")}`);
  if (versionDrift.length) problems.push(`版本与锁不一致：${versionDrift.map((x) => `${x.spec} → 本地 ${x.version}`).join(", ")}`);
  if (!fs.existsSync(FP_PATH)) problems.push("没有指纹文件（跑 make local-packages-lock）");
  else {
    const fp = JSON.parse(fs.readFileSync(FP_PATH, "utf8"));
    if (fp.lockDigest !== `sha256:${sha256(lockText)}`) problems.push("**锁变了而本地镜像没重刷**（指纹里的 lockDigest 与当前锁不同）⇒ 跑 make local-packages-lock");
    else if (fp.digest !== digestOf(fp)) problems.push("指纹文件自身对不上（被手改过？）⇒ 跑 make local-packages-lock");
    else {
      const fpNpm = new Map(fp.npm.map((x) => [x.spec, x.version]));
      const drift = installed.filter((x) => fpNpm.get(x.spec) !== x.version);
      if (drift.length) problems.push(`本地镜像与指纹不一致：${drift.map((x) => x.spec).join(", ")}`);
    }
  }
  if (problems.length) {
    for (const p of problems) process.stderr.write(`❌ ${p}\n`);
    process.exit(1);
  }
  console.log(`✅ 本地预装镜像与锁一致（npm ${specs.length} 项版本全对 · 指纹 ${fp0().slice(0, 18)}…）`);
  console.log(`   注：apt ${aptSpecs.length} 项在本机是**宿主提供**（版本不保证与镜像一致）—— 如实标注，不假装本地镜像管了它`);
  process.exit(0);
}
function fp0() { return JSON.parse(fs.readFileSync(FP_PATH, "utf8")).digest; }

if (!missing.length) {
  console.log(`✅ 本地预装镜像已覆盖锁里全部 ${specs.length} 个 npm 项（无需改动）`);
  process.exit(0);
}
process.stderr.write(`装入 ${missing.length} 项（按锁）：${missing.join(", ")}\n`);
const r = spawnSync("npm", ["install", "--prefix", MIRROR, "--no-audit", "--no-fund", ...specs], { stdio: "inherit", timeout: 1800000 });
if (r.status !== 0) { process.stderr.write("❌ 安装失败（网络/私有源？）\n"); process.exit(r.status ?? 1); }
console.log(`✅ 本地预装镜像已按锁装齐（${specs.length} 项）`);
