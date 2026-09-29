#!/usr/bin/env node
import { sanitizeNativeRecord, crashTail } from "./sanitize.mjs";

const failures = [];
const check = (name, ok, detail = "") => { if (!ok) failures.push(`${name}${detail ? `：${detail}` : ""}`); };
const source = {
  type: "tool_result",
  status: "ok",
  toolName: "shell",
  callId: "c1",
  result: { output: "TOP_SECRET_OUTPUT", headers: { authorization: "Bearer SECRET" } },
  message: "PRIVATE_MESSAGE",
};
const safe = sanitizeNativeRecord(source, { mode: "digest" });
check("保留可诊断字段", safe.type === "tool_result" && safe.callId === "c1");
check("默认移除原始正文", !JSON.stringify(safe).includes("TOP_SECRET_OUTPUT") && !JSON.stringify(safe).includes("PRIVATE_MESSAGE"));
check("提供原始摘要", typeof safe.rawDigest === "string" && safe.rawDigest.length === 64);
const full = sanitizeNativeRecord(source, { mode: "full", maxBytes: 80 });
check("full 也受长度限制", JSON.stringify(full).length <= 500);
const tail = crashTail([source, { type: "final", message: "SECRET_FINAL" }], { lines: 1, maxBytes: 200 });
check("崩溃摘要不输出正文", !tail.includes("SECRET_FINAL") && tail.split("\n").length <= 2);

if (failures.length) {
  console.error(`❌ sanitize-selftest ${failures.length} 项失败`);
  for (const failure of failures) console.error(`  · ${failure}`);
  process.exit(1);
}
console.log("✅ sanitize-selftest 通过");
