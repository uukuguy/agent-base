#!/usr/bin/env node
import { digestManifest, verifyManifest } from "./manifest-integrity.mjs";

const failures = [];
const check = (name, ok, detail = "") => { if (!ok) failures.push(`${name}${detail ? `：${detail}` : ""}`); };
const manifest = { harness: "test", runtimePlan: { configDir: "agent-dir", prependArgs: ["--safe"] }, artifactsDigest: "sha256:a", effectiveConfigDigest: "sha256:b" };
const signed = { ...manifest, manifestDigest: digestManifest(manifest) };
check("生成 manifestDigest", /^sha256:[0-9a-f]{64}$/.test(signed.manifestDigest));
check("原始清单校验通过", verifyManifest(signed).ok);
check("控制面被篡改后拒绝", !verifyManifest({ ...signed, runtimePlan: { ...signed.runtimePlan, prependArgs: ["--unsafe"] } }).ok);
check("缺少摘要拒绝", !verifyManifest(manifest).ok);

if (failures.length) {
  console.error(`❌ manifest-integrity-selftest ${failures.length} 项失败`);
  for (const failure of failures) console.error(`  · ${failure}`);
  process.exit(1);
}
console.log("✅ manifest-integrity-selftest 通过");
