#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import { assertSafeOutputRoot } from "./output-path.mjs";

const failures = [];
const check = (name, fn) => { try { fn(); failures.push(name); } catch { /* expected rejection */ } };
check("拒绝文件系统根目录", () => assertSafeOutputRoot(path.parse(process.cwd()).root, { repoRoot: process.cwd() }));
check("拒绝 HOME", () => assertSafeOutputRoot(os.homedir(), { repoRoot: process.cwd() }));
let allowed = true;
try { assertSafeOutputRoot(path.join(os.tmpdir(), "agent-base-safe-output"), { repoRoot: process.cwd() }); } catch { allowed = false; }
if (!allowed) failures.push("允许专用临时目录");

if (failures.length) {
  console.error(`❌ output-path-selftest ${failures.length} 项失败`);
  for (const failure of failures) console.error(`  · ${failure}`);
  process.exit(1);
}
console.log("✅ output-path-selftest 通过");
