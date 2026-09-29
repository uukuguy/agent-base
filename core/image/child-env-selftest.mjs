#!/usr/bin/env node
import { buildChildEnv, DEFAULT_PERMISSION_MODE } from "./child-env.mjs";

const failures = [];
const check = (name, ok, detail = "") => { if (!ok) failures.push(`${name}${detail ? `：${detail}` : ""}`); };

const env = buildChildEnv({
  baseEnv: {
    PATH: "/bin",
    HOME: "/tmp/home",
    LANG: "C.UTF-8",
    AWS_SECRET_ACCESS_KEY: "must-not-cross",
    RANDOM_HOST_SECRET: "must-not-cross",
  },
  values: { MODEL_URL: "http://127.0.0.1:9/v1", API_KEY: "placeholder-not-a-credential" },
  extra: { AGENT_TRACE_CONTENT: "digest", AB_TEST_MARKER: "kept-explicitly" },
  allowedExtra: ["AGENT_TRACE_CONTENT", "AB_TEST_MARKER"],
  platform: { PI_OFFLINE: "1" },
});
check("保留安全基础变量", env.PATH === "/bin" && env.HOME === "/tmp/home");
check("移除宿主敏感变量", env.AWS_SECRET_ACCESS_KEY === undefined && env.RANDOM_HOST_SECRET === undefined);
check("注入声明参数", env.MODEL_URL?.startsWith("http") && env.API_KEY === "placeholder-not-a-credential");
check("保留显式额外变量", env.PI_OFFLINE === "1" && env.AB_TEST_MARKER === "kept-explicitly");
check("默认权限为受控模式", DEFAULT_PERMISSION_MODE === "workspace-write");
let rejected = false;
try { buildChildEnv({ permissionMode: "invalid" }); } catch { rejected = true; }
check("拒绝非法权限模式", rejected);

if (failures.length) {
  console.error(`❌ child-env-selftest ${failures.length} 项失败`);
  for (const failure of failures) console.error(`  · ${failure}`);
  process.exit(1);
}
console.log("✅ child-env-selftest 通过");
