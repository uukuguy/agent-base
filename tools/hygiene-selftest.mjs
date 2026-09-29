#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const check = (name, ok, detail = "") => { if (!ok) failures.push(`${name}${detail ? `：${detail}` : ""}`); };

check("工作树不存在 .env", !fs.existsSync(path.join(repo, ".env")));
const ignored = spawnSync("git", ["check-ignore", "-q", ".env"], { cwd: repo });
check(".env 被 gitignore 忽略", ignored.status === 0);
const tracked = spawnSync("git", ["ls-files", "--error-unmatch", ".env"], { cwd: repo, encoding: "utf8" });
check(".env 不再被 Git 跟踪", tracked.status !== 0);
const historicalEnv = spawnSync("git", ["log", "--all", "--format=", "--name-only", "--", ".env"], { cwd: repo, encoding: "utf8" });
check("Git 历史不再包含 .env 路径", historicalEnv.status === 0 && !historicalEnv.stdout.trim());
const commits = spawnSync("git", ["rev-list", "--all"], { cwd: repo, encoding: "utf8" });
let historicalSecret = false;
let historyScanError = commits.status !== 0;
if (!historyScanError) {
  for (const commit of commits.stdout.split("\n").filter(Boolean)) {
    const scan = spawnSync("git", ["grep", "-I", "-n", "-E", "sk-[A-Za-z0-9]{20,}|(OPENAI|DEEPSEEK)_API_KEY=[A-Za-z0-9_-]{12,}", commit], { cwd: repo, encoding: "utf8" });
    if (scan.status === 0) { historicalSecret = true; break; }
    if (scan.status !== 1) { historyScanError = true; break; }
  }
}
check("Git 历史不包含明显凭据值", !historyScanError && !historicalSecret);
const pkg = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8"));
check("package.json 提供 test 脚本", typeof pkg.scripts?.test === "string");

if (failures.length) {
  console.error(`❌ hygiene-selftest ${failures.length} 项失败`);
  for (const failure of failures) console.error(`  · ${failure}`);
  process.exit(1);
}
console.log("✅ hygiene-selftest 通过");
