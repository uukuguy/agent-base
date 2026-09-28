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
const specs = fs.readFileSync(LOCK, "utf8").split("\n")
  .filter((l) => l.startsWith("npm ")).map((l) => l.slice(4).trim()).filter(Boolean);
const nameOf = (spec) => spec.replace(/@[^@]+$/, "");
const missing = specs.filter((s) => !fs.existsSync(path.join(MIRROR, "node_modules", nameOf(s))));

if (check) {
  if (missing.length) {
    process.stderr.write(`❌ 本地预装镜像缺 ${missing.length} 项（跑 make local-packages）：${missing.join(", ")}\n`);
    process.exit(1);
  }
  console.log(`✅ 本地预装镜像覆盖锁里全部 ${specs.length} 个 npm 项`);
  process.exit(0);
}

if (!missing.length) {
  console.log(`✅ 本地预装镜像已覆盖锁里全部 ${specs.length} 个 npm 项（无需改动）`);
  process.exit(0);
}
process.stderr.write(`装入 ${missing.length} 项（按锁）：${missing.join(", ")}\n`);
const r = spawnSync("npm", ["install", "--prefix", MIRROR, "--no-audit", "--no-fund", ...specs], { stdio: "inherit", timeout: 1800000 });
if (r.status !== 0) { process.stderr.write("❌ 安装失败（网络/私有源？）\n"); process.exit(r.status ?? 1); }
console.log(`✅ 本地预装镜像已按锁装齐（${specs.length} 项）`);
