// ============================================================================
// 受控容器验证入口自检（路线图 §30 A2）
//
// 判据是"**受控**必须可验证，否则只是口号"：
//   · 生成的 docker 参数里**不含**任何逃逸面：`--privileged` / `-v /` / socket / `--net=host` / `--cap-add`
//   · 绑定面就是**两处只读**（项目 + 产物），落点是固定路径，且项目挂的是 **realpath 后的真实目录**
//   · 镜像必须是**生产变体**（不是 `-debug`），架构只能是 arm64/amd64
//   · 调用方**无法追加** docker 参数：未知旗标直接拒
//   · 符号链接项目、缺 agent.yaml 的目录 ⇒ 拒绝（"我以为挂的是项目"这类偏差必须显式拦）
//   · **真跑一次**（镜像在本地时）：容器内四道闸门（闸门 1 是 agent-only）全过、离线零凭据
//
// 用法：node tools/verify-container-selftest.mjs  （或 make verify-container-selftest）
// ============================================================================

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const TOOL = path.join(HERE, "verify-container.mjs");

let failures = 0;
const check = (name, cond, extra = "") => {
  if (!cond) failures++;
  console.log(`${cond ? "✅" : "❌"} ${name}${cond || !extra ? "" : `\n      ${extra}`}`);
};
const run = (args, timeout = 900000) => spawnSync(process.execPath, [TOOL, ...args], { encoding: "utf8", cwd: REPO, timeout });
const jsonOf = (r) => { try { return JSON.parse(r.stdout); } catch { return null; } };

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
function makeAgent(name) {
  const d = path.join(tmp("vc-agent-"), name);
  fs.mkdirSync(path.join(d, "skills", "alpha"), { recursive: true });
  fs.writeFileSync(path.join(d, "agent.yaml"),
    `apiVersion: agent-base/v1\nname: ${name}\ndescription: 容器验证自检\npersona: { instructions: 自检。 }\n`
    + `model: { provider: corp-gateway, name: corp-think }\nconnectorsFile: connectors.yaml\n`);
  fs.writeFileSync(path.join(d, "connectors.yaml"), "apiVersion: agent-base/v1\nmcpServers: []\n");
  fs.writeFileSync(path.join(d, "skills", "alpha", "SKILL.md"), "---\nname: alpha\ndescription: 一句话\n---\n正文\n");
  return d;
}

console.log("── A. 绑定面与参数：受控必须可验证 ──");
const agent = makeAgent("verify-container-selftest");
const dry = run([agent, "--dry-run", "--json"]);
check("干跑退出码 0", dry.status === 0, (dry.stderr ?? "").slice(-200));
const doc = jsonOf(dry);
check("干跑出 JSON（可被审阅/断言）", !!doc);
const argv = doc?.argv ?? [];
const flat = argv.join(" ");
check("网络为 none（运行期无外网）", flat.includes("--network none"));
check("根只读 + 只给 /tmp 可写", flat.includes("--read-only") && flat.includes("--tmpfs /tmp"));
check("能力全丢 + 不允许提权", flat.includes("--cap-drop ALL") && flat.includes("no-new-privileges"));
check("没有 --privileged", !flat.includes("--privileged"));
check("没有 docker socket", !flat.includes("docker.sock"));
check("没有 --net=host", !flat.includes("--net=host") && !flat.includes("--network host"));
check("没有 --cap-add", !flat.includes("--cap-add"));
check("绑定面恰好两处（项目 + 产物）", (doc?.mounts ?? []).length === 2, JSON.stringify(doc?.mounts));
check("两处挂载都是只读", (doc?.mounts ?? []).every((m) => m.mode === "ro"), JSON.stringify(doc?.mounts));
check("落点是固定路径（不由调用方指定）",
  (doc?.mounts ?? []).some((m) => m.dst === "/work/agent") && (doc?.mounts ?? []).some((m) => m.dst === "/opt/agent-base/artifact"));
check("没有把根 / 挂进去", !(doc?.mounts ?? []).some((m) => path.resolve(m.src) === "/"), JSON.stringify(doc?.mounts));
check("项目挂的是 realpath 后的真实目录", (doc?.mounts ?? []).some((m) => m.role === "project" && m.src === fs.realpathSync(agent)));
check("镜像取**生产变体**（不是 -debug）", /^agent-base:[0-9.]+-arm64$|^agent-base:[0-9.]+-amd64$/.test(doc?.image ?? ""), String(doc?.image));

console.log("\n── B. 调用方不能追加 docker 参数 ──");
for (const bad of [["--privileged"], ["-v", "/:/host"], ["--mount", "type=bind,src=/,dst=/host"], ["--net", "host"]]) {
  const r = run([agent, ...bad, "--dry-run"]);
  // 单横线旗标会被当成位置参数 ⇒ 用"只接受一个位置参数"拦；双横线则"未知旗标"拦。
  // 两条都是拒绝，理由要说清。
  check(`追加 ${bad.join(" ")} ⇒ 拒绝（退出码 2 且说明原因）`,
    r.status === 2 && /未知旗标|只接受一个位置参数/.test(r.stderr ?? ""), `${r.status} ${(r.stderr ?? "").slice(0, 140)}`);
}

console.log("\n── C. 危险/不合法的项目目录 ──");
const link = path.join(tmp("vc-link-"), "link-to-agent");
fs.symlinkSync(agent, link);
const symRun = run([link, "--dry-run"]);
check("符号链接项目 ⇒ 拒绝并点名 realpath", symRun.status === 2 && /符号链接/.test(symRun.stderr ?? ""), (symRun.stderr ?? "").slice(-160));
const noAgent = tmp("vc-noagent-");
fs.writeFileSync(path.join(noAgent, "README.md"), "x\n");
const noAgentRun = run([noAgent, "--dry-run"]);
check("目录里没有 agent.yaml ⇒ 拒绝（这不像智能体定义）", noAgentRun.status === 2 && /agent\.yaml/.test(noAgentRun.stderr ?? ""), (noAgentRun.stderr ?? "").slice(-160));
const rootRun = run(["/", "--dry-run"]);
check("把 / 当项目 ⇒ 拒绝", rootRun.status === 2, (rootRun.stderr ?? "").slice(-160));
const homeRun = run([os.homedir(), "--dry-run"]);
check("把家目录当项目 ⇒ 拒绝", homeRun.status === 2, (homeRun.stderr ?? "").slice(-160));
const badArch = run([agent, "--arch", "mips", "--dry-run"]);
check("不支持的架构 ⇒ 拒绝", badArch.status === 2 && /arch/.test(badArch.stderr ?? ""), (badArch.stderr ?? "").slice(-120));
const noDir = run([path.join(os.tmpdir(), "vc-does-not-exist-xyz"), "--dry-run"]);
check("项目目录不存在 ⇒ 拒绝", noDir.status === 2);

console.log("\n── D. 真跑一次（镜像在本地时）──");
{
  const probe = run([agent, "--dry-run", "--json"]);
  const pdoc = jsonOf(probe);
  if (!pdoc?.imageExists) {
    // 跳过**不算通过**（本仓库的纪律）：明确打印出来，别让人以为验过了
    console.log(`⏭  跳过真跑：本地没有镜像 ${pdoc?.image}（先 node core/image/build.mjs --arch ${pdoc?.arch}）—— 这一项**没验**`);
  } else {
    const r = run([agent]);
    const rdoc = jsonOf(run([agent, "--json"]));
    check("真跑退出码 0（容器内四道闸门全过）", r.status === 0, `${r.status} ${(r.stderr ?? "").slice(-200)}`);
    check("结构化输出标了 where=container 并带镜像摘要",
      rdoc?.where === "container" && typeof rdoc?.imageDigest === "string" && rdoc.imageDigest.startsWith("sha256:"),
      JSON.stringify({ where: rdoc?.where, imageDigest: rdoc?.imageDigest }));
    check("容器内跑到了四道闸门（闸门 1 为 agent-only）", (rdoc?.steps ?? []).length === 4, JSON.stringify((rdoc?.steps ?? []).map((s) => s.label)));
    check("如实标出本次未覆盖的（安全下限/双架构/同源）",
      (rdoc?.notCovered ?? []).some((x) => /security-floor/.test(x)) && (rdoc?.covered ?? []).length >= 4,
      JSON.stringify({ covered: rdoc?.covered, notCovered: rdoc?.notCovered }));
    check("同一份定义重复触发 ⇒ 结论一致（可复现）", rdoc?.usable === true && r.status === 0);
  }
}

console.log("");
if (failures) {
  console.log(`❌ 受控容器验证自检：失败 ${failures} 项`);
  process.exit(1);
}
console.log("✅ 受控容器验证自检：全绿");
