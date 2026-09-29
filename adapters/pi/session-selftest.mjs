// ============================================================================
// 会话续跑自检（E6 的另一半：**续跑可留痕**）
//
// 判据不是"能跑第二次"，而是：**事后从记录里能看出这次是在续哪一次**。所以本自检断言：
//   ① 首次运行：轨迹的 `run.meta.session` == 基座持有的会话 id
//   ② 续跑：同一个会话 id 出现在第二条 run 的 `run.meta` 里，且 `resumed: true`
//   ③ **核验**：运行时实际用的会话 id 就是基座那个（不核验的话，轨迹里的 session 只是"声称"）
//   ④ **接错会话 ⇒ 响亮失败**（负例；不给它静默接上别的会话的机会）
//   ⑤ 续跑**复用**会话文件，不另开一个
//
// ## 实测到的两条硬约束（决定了本自检怎么写）
//
//   · `--session-id` 与 `--continue` **互斥**（组合使用直接退出 1）⇒ 首次用 id 建会话，续跑只用 `--continue`
//   · 该运行时的"项目会话"按**工作目录**归属 ⇒ 两次必须跑在**同一个 cwd**，
//     否则 `--continue` 会接上别的会话（实测踩到：接到了一个早先探针留下的会话，被核验抓出来）
//
// 用法：node adapters/pi/session-selftest.mjs
// ============================================================================

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { runAgent } from "./run.mjs";
import { startFakeGateway } from "../../tools/fake-gateway/server.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");

let failures = 0;
const check = (name, cond, extra = "") => {
  if (!cond) failures++;
  console.log(`${cond ? "✅" : "❌"} ${name}${cond || !extra ? "" : `\n      ${String(extra).slice(0, 400)}`}`);
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), "session-selftest-"));
const agent = path.join(root, "agent");
fs.mkdirSync(path.join(agent, "skills", "alpha"), { recursive: true });
fs.writeFileSync(path.join(agent, "agent.yaml"),
  "apiVersion: agent-base/v1\nname: session-selftest\ndescription: 续跑自检\n"
  + "persona: { instructions: 自检。 }\nmodel: { provider: corp-gateway, name: corp-think }\nconnectorsFile: connectors.yaml\n");
fs.writeFileSync(path.join(agent, "connectors.yaml"), "apiVersion: agent-base/v1\nmcpServers: []\n");
fs.writeFileSync(path.join(agent, "skills", "alpha", "SKILL.md"), "---\nname: alpha\ndescription: 一句话\n---\n正文\n");
const renderDir = path.join(root, "render");
const r = spawnSync(process.execPath, [path.join(HERE, "render.mjs"), agent, "--out", renderDir], { encoding: "utf8", cwd: REPO });
if (r.status !== 0) { console.log(`❌ 渲染失败：${(r.stderr ?? "").slice(-300)}`); process.exit(1); }

const sessionDir = path.join(root, "sessions");
const workDir = path.join(root, "work");
fs.mkdirSync(workDir, { recursive: true });
const sessionId = "session-selftest-0001";
const metaOf = (run) => (run.events ?? []).find((e) => e.type === "run.meta") ?? null;

const gateway = await startFakeGateway({ silent: true });
try {
  console.log("── A. 首次运行：会话身份进轨迹 ──");
  const first = await runAgent({
    renderDir, endpoint: gateway.url, prompt: "hi", timeoutMs: 120000, zeroCredential: true,
    sessionId, sessionDir, workDir,
  });
  check("首次运行退出码 0", first.exitCode === 0, `退出码 ${first.exitCode}：${String(first.stderr ?? "").slice(-200)}`);
  check("轨迹里记下了会话身份（run.meta.session）", metaOf(first)?.session === sessionId, JSON.stringify(metaOf(first)));
  check("首次运行**不是**续跑（没有 resumed）", metaOf(first)?.resumed === undefined, JSON.stringify(metaOf(first)));
  check("运行时实际用的会话 id 与基座持有的一致（**核验过**）", first.sessionVerified === true, String(first.sessionVerified));

  console.log("── B. 续跑：同一个会话、并且标了 resumed ──");
  const second = await runAgent({
    renderDir, endpoint: gateway.url, prompt: "again", timeoutMs: 120000, zeroCredential: true,
    sessionId, sessionDir, continueSession: true, workDir,
  });
  check("续跑退出码 0", second.exitCode === 0, `退出码 ${second.exitCode}：${String(second.stderr ?? "").slice(-200)}`);
  check("续跑的轨迹里是**同一个**会话 id", metaOf(second)?.session === sessionId, JSON.stringify(metaOf(second)));
  check("续跑的轨迹里明确标了 resumed: true", metaOf(second)?.resumed === true, JSON.stringify(metaOf(second)));
  check("两次的 run id 不同（各自留痕，不混成一次）", first.events[0]?.run !== second.events[0]?.run);
  check("续跑**复用**会话文件（没另开一个）",
    fs.existsSync(sessionDir) && fs.readdirSync(sessionDir).length === 1, JSON.stringify(fs.existsSync(sessionDir) ? fs.readdirSync(sessionDir) : null));

  console.log("── C. 负例：接错会话 ⇒ 响亮失败（不给静默接错的机会）──");
  const wrong = await runAgent({
    renderDir, endpoint: gateway.url, prompt: "again", timeoutMs: 120000, zeroCredential: true,
    sessionId: "base-thinks-this-one", sessionDir, continueSession: true, workDir,
  });
  check("期望的会话 id 与实际不符 ⇒ 明确报出不一致（sessionVerified=false）",
    wrong.sessionVerified === false && /session-mismatch/.test(String(wrong.stderr ?? "")),
    `verified=${wrong.sessionVerified} stderr=${String(wrong.stderr ?? "").slice(-200)}`);
  check("核验失败时不产出事件（不让「接错会话」看起来像跑完了）", (wrong.events ?? []).length === 0, JSON.stringify((wrong.events ?? []).map((e) => e.type)));
} finally { await gateway.close?.(); }

console.log("");
if (failures) {
  console.log(`❌ 会话续跑自检：失败 ${failures} 项`);
  process.exit(1);
}
console.log("✅ 会话续跑自检：全绿");
// Pi's native runtime can leave parent-side stdio handles after the child has
// exited.  The checks above are complete; terminate deterministically so CI
// does not wait on runtime-owned handles.
process.exit(0);
