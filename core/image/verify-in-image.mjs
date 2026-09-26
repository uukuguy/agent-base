#!/usr/bin/env node
// ============================================================================
// 镜像内自证：不依赖仓库、不依赖挂载，直接在产物上跑闸门。
//
// ## 为什么需要它（P2）
//
// 之前镜像里只有启动器：**派生镜像无法自证** —— 改完业务层只能回仓库验，
// CI 也没法在镜像内验收。而"上层自由发挥"的前提是**上层能自己确认没坏**。
//
// ## 判据范围（诚实划清）
//
//   · 有产物（`AGENT_ARTIFACT_DIR`）      → 跑闸门 2 解析自证 · 3 集成探针 · 4 端到端冒烟
//   · 另有定义（`AGENT_DEFINITION_DIR`）  → 再跑闸门 1 静态校验
//   · 容器的**安全下限**（C9）**不在这里** —— 它需要 docker/镜像检视，只能在构建侧跑
//
// 闸门 3/4 默认走**零凭据假网关**（镜像里已带），所以这一步**不需要任何密钥、不需要外网**。
// ============================================================================

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// 闸门仓库根：**向上找**含 tools/validate.mjs 的那一层 —— 这个脚本在仓库里位于 core/image/，
// 在镜像里被放在 gates/ 根；写死相对层级就会像刚才那样指到 /opt 去（MODULE_NOT_FOUND）。
function findGatesRoot(from) {
  let dir = from;
  for (;;) {
    if (fs.existsSync(path.join(dir, "tools", "validate.mjs"))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}
const GATES = findGatesRoot(HERE);
if (!GATES) { process.stderr.write("❌ 找不到闸门仓库根（缺 tools/validate.mjs）\n"); process.exit(2); }
const ARTIFACT = process.env.AGENT_ARTIFACT_DIR ?? "/opt/agent-base/artifact";
const DEFINITION = process.env.AGENT_DEFINITION_DIR ?? null;
const HARNESS = process.env.HARNESS ?? null;

const log = (s) => process.stderr.write(`${s}\n`);
const run = (args) => spawnSync(process.execPath, args, { cwd: GATES, encoding: "utf8" });

if (!fs.existsSync(path.join(ARTIFACT, "render-manifest.json"))) {
  log(`❌ 找不到产物：${ARTIFACT}（缺 render-manifest.json）`);
  log(`   镜像里应当把渲染产物烤到 $AGENT_ARTIFACT_DIR，或运行时挂上去。`);
  process.exit(2);
}

// 运行时：产物清单里记了它是为哪个运行时渲染的；只有一个时也允许环境变量覆盖（多运行时镜像）
const manifest = JSON.parse(fs.readFileSync(path.join(ARTIFACT, "render-manifest.json"), "utf8"));
const harness = HARNESS ?? manifest.harness;
if (!harness) { log("❌ 无法确定运行时：产物清单里没有 harness，也没有给 HARNESS"); process.exit(2); }

const results = [];
const step = (label, args) => {
  log(`── ${label} ──`);
  const r = run(args);
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  // 只看结论行，避免把整篇报告刷进日志
  const verdict = out.split("\n").filter((l) => /可用|全绿|失败|❌/.test(l)).slice(-2).join(" · ");
  results.push({ label, status: r.status, verdict: verdict || `退出码 ${r.status}` });
  if (r.status !== 0) log((r.stderr ?? "").split("\n").slice(-8).join("\n"));
  return r.status === 0;
};

let ok = true;
if (DEFINITION && fs.existsSync(path.join(DEFINITION, "agent.yaml"))) {
  ok = step("闸门 1：静态校验", // 镜像里没有基座的 docs/ 与仓库布局 ⇒ 只跑"智能体定义"那部分（基座自洽在构建侧跑）
    [path.join(GATES, "tools/validate.mjs"), DEFINITION, "--agent-only"]) && ok;
} else {
  log("（没有定义目录 ⇒ 跳过闸门 1；给了 AGENT_DEFINITION_DIR 就会跑）");
}
ok = step("闸门 2：解析自证", [path.join(GATES, `adapters/${harness}/doctor.mjs`), ARTIFACT, "--json"]) && ok;
ok = step("闸门 3：集成探针", [path.join(GATES, "tools/probe.mjs"), ARTIFACT, "--json", "--harness", harness]) && ok;
ok = step("闸门 4：端到端冒烟", [path.join(GATES, "tools/smoke.mjs"), ARTIFACT, "--json", "--harness", harness]) && ok;

log("\n════ 镜像内自证 ════");
for (const r of results) log(`  ${r.status === 0 ? "✅" : "❌"} ${r.label} —— ${r.verdict}`);
log(ok ? "\n✅ 可用：镜像内自证通过（离线、零凭据）" : "\n❌ 不可用：镜像内自证失败");
process.exit(ok ? 0 : 1);
