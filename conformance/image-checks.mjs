// ============================================================================
// 容器内安全下限实测（conformance C9 的输入 · 统一设计 §9.2 / §10.4 H5）
//
// ## 这一项在验什么
//
//   **「声明的安全能力」与「容器内实测」必须一致 —— 不许夸大。**
//
// 具体到这个基座：harness 自己**没有** OS 级沙箱（adapter.yaml 里 `osSandbox: unsupported`，
// 实测 pi 在 Linux 下也没有等价物）。设计把硬下限交给**容器层**（§7.2）。
// 于是"容器层真的兜住了"就成了基座必须自证的事：
//
//   ① 非 root（身份）
//   ② 只读根文件系统（不能改自己的代码/配置）
//   ③ 能力被丢干净（cap-drop ALL）
//   ④ 默认离线也能跑（内网拉不到 npm 是既有风险 I2）
//   ⑤ 生产变体**拒绝**调试模式（调试能力才在 -debug 变体里）
//   ⑥ 调试变体确实给得出诊断 shell（否则第 ④ 道调试手段是空的）
//
// 若容器层没兜住，而 adapter 又写着 osSandbox: unsupported，那安全承诺就是一句空话 ——
// 这正是"不许夸大"要抓的东西。
//
// ## 为什么不自动构建镜像
//
// 构建要拉基础镜像 + 装十几个包，属**环境准备**而不是合规判定。所以镜像不在时就记 pending
// （runner 对 pending 一律非零退出：**未实现不算通过**），并明确指出该跑什么命令。
// ============================================================================

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { runLlmConfigChecks } from "./image-capability-checks.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");

const HARDENING = [
  "--rm",
  "--read-only",                     // 只读根
  "--cap-drop", "ALL",               // 丢能力
  "--security-opt", "no-new-privileges",
  "--network", "none",               // 默认离线
  "--tmpfs", "/tmp",                 // 只读根下仍需一个可写临时区
];

export function hostArch() {
  const m = spawnSync("uname", ["-m"], { encoding: "utf8" }).stdout.trim();
  return m === "x86_64" ? "amd64" : m === "arm64" || m === "aarch64" ? "arm64" : m;
}

export function dockerAvailable() {
  const r = spawnSync("docker", ["version", "--format", "{{.Server.Os}}"], { encoding: "utf8", timeout: 20000 });
  return r.status === 0;
}

function imageExists(tag) {
  const r = spawnSync("docker", ["image", "inspect", tag], { encoding: "utf8", timeout: 20000, stdio: "pipe" });
  return r.status === 0;
}

/** 在容器里跑一段 shell，返回 {code, stdout, stderr}。 */
function inContainer(image, script, { timeoutMs = 180000 } = {}) {
  const r = spawnSync("docker", ["run", ...HARDENING, image, "shell", "-c", script], { encoding: "utf8", timeout: timeoutMs });
  // spawnSync 超时会返回空 stdout/stderr —— 显式标记出来，免得又变成"看不出原因的失败"
  if (r.error && r.error.code === "ETIMEDOUT") return { code: null, stdout: "", stderr: `TIMEOUT(${timeoutMs}ms)`, timedOut: true };
  return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** 读各 adapter 的可执行名（harness 专有事实在 adapters/，conformance 读取它是允许的）。 */
function harnessBins() {
  const bins = [];
  const dir = path.join(REPO, "adapters");
  for (const name of fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()) {
    const f = path.join(dir, name, "adapter.yaml");
    if (!fs.existsSync(f)) continue;
    const b = YAML.parse(fs.readFileSync(f, "utf8")).bin;
    if (b) bins.push(b);
  }
  return bins;
}

/** 读各 adapter 的安全声明（用于"声明 vs 实测"对照）。 */
function declaredSecurity() {
  const out = {};
  const dir = path.join(REPO, "adapters");
  for (const name of fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()) {
    const f = path.join(dir, name, "adapter.yaml");
    if (!fs.existsSync(f)) continue;
    const a = YAML.parse(fs.readFileSync(f, "utf8"));
    out[name] = {
      osSandbox: a.capabilities?.osSandbox ?? "unknown",
      osSandboxNote: a.capabilities?.osSandboxNote ?? "",
    };
  }
  return out;
}

/**
 * @returns {{pending: string|null, checks: Array<{id:string, ok:boolean, detail:string}>}}
 */
export function runImageChecks({ version, arch = hostArch() } = {}) {
  const base = `agent-base:${version}-${arch}`;
  const debug = `agent-base:${version}-debug-${arch}`;

  if (!dockerAvailable()) return { pending: "本机没有可用的容器运行时（docker 不可达）", checks: [] };
  if (!imageExists(base)) return { pending: `基座镜像 ${base} 尚未构建 —— 先跑 make image（或 make image-all）`, checks: [] };

  const checks = [];
  const add = (id, ok, detail) => checks.push({ id, ok: Boolean(ok), detail });

  // ① 非 root
  const uid = inContainer(base, "id -u");
  add("uid-non-root", uid.stdout.trim() === "10001", `容器内 uid=${uid.stdout.trim() || uid.stderr.trim()}（期望 10001）`);

  // ② 只读根：根不可写，但 /tmp 可写
  const ro = inContainer(base, "touch /should-fail 2>/dev/null && echo WRITABLE || echo READONLY; touch /tmp/ok && echo TMP-WRITABLE");
  add("rootfs-readonly", /READONLY/.test(ro.stdout) && /TMP-WRITABLE/.test(ro.stdout),
    `根文件系统与 /tmp 的可写性：${JSON.stringify(ro.stdout.trim())}`);

  // ③ 能力丢干净（CapEff 全 0）
  const caps = inContainer(base, "grep '^CapEff' /proc/self/status");
  const capHex = (caps.stdout.match(/CapEff:\s*([0-9a-fA-F]+)/) ?? [])[1] ?? "";
  add("capabilities-dropped", /^0+$/.test(capHex),
    `CapEff=${capHex || "(读不到)"}（期望全 0）`);

  // ④ 默认离线可用：镜像里装的 harness 在 --network none 下仍能自报版本
  const bins = harnessBins();
  const offline = inContainer(base,
    bins.map((b) => `printf '%s=' '${b}'; ${b} --version 2>&1 | head -1`).join("; "));
  const reported = offline.stdout.trim().split("\n").filter(Boolean);
  add("offline-harness-usable", reported.length > 0 && !/command not found|Cannot find module/.test(offline.stdout),
    `离线（--network none）自报：${reported.join(" | ") || offline.stderr.trim().slice(0, 120)}`);

  // ④b 默认离线 = **连接器也能离线解析**
  //
  // 判据必须打在**连接器真正跑的命**上：`npx -y <pkg>@<ver>`。
  // 早前这里测的是 `npx --offline ...` —— 那是系统从不使用的命令，它必然 ENOTCACHED，
  // 于是报出一个**假缺陷**（错的是检查，不是镜像）。这类"检查写错方向"比漏检更糟：
  // 它会让人去修一个本来正确的东西。
  //
  // 正确判据：断网下逐个预装条目跑真实命令，**不得出现 registry/网络错误**。
  // 服务器本身可能非零退出（多数不认 `--help`），那说明包已拿到并启动了，属成功。
  const NETWORK_ERRORS = /ENOTCACHED|ENOTFOUND|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|registry\.npmjs\.org|fetch failed/i;
  const offMcp = inContainer(base,
    'test -f /opt/agent-base/preinstall.npm.txt || { echo "NO-SPEC-LIST"; exit 0; }; ' +
    'fail=0; total=0; ' +
    'while read -r spec; do total=$((total+1)); ' +
    '  out="$(timeout 15 npx -y "$spec" --help </dev/null 2>&1 || true)"; ' +
    '  if printf %s "$out" | grep -qiE "ENOTCACHED|ENOTFOUND|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|registry[.]npmjs[.]org|fetch failed"; then ' +
    '    echo "OFFLINE-FAIL $spec"; fail=$((fail+1)); fi; ' +
    'done < /opt/agent-base/preinstall.npm.txt; ' +
    'echo "checked=$total failed=$fail"', { timeoutMs: 900000 });
  const offText = `${offMcp.stdout}\n${offMcp.stderr}`;
  const counts = (offText.match(/checked=(\d+) failed=(\d+)/) ?? []);
  add("offline-mcp-resolvable",
    !offMcp.timedOut && !/NO-SPEC-LIST/.test(offText) && counts.length === 3 && Number(counts[2]) === 0 && Number(counts[1]) > 0,
    `断网下逐条跑连接器真实命令（npx -y <pkg>@<ver>）：${counts.length === 3 ? `共 ${counts[1]} 条，网络错失败 ${counts[2]} 条` : offText.trim().slice(0, 160)}`);

  // ⑤ 生产变体拒绝调试模式（退出码 2）
  const dbgRefused = spawnSync("docker", ["run", ...HARDENING, "-e", "AGENT_RUN_MODE=debug", base, "shell", "-c", "true"], { encoding: "utf8", timeout: 120000 });
  add("production-refuses-debug", dbgRefused.status === 2,
    `退出码 ${dbgRefused.status}（期望 2）；stderr=${(dbgRefused.stderr ?? "").trim().slice(0, 140)}`);

  // ⑥ 调试变体给出诊断 shell
  if (!imageExists(debug)) {
    add("debug-variant-usable", false, `调试变体 ${debug} 未构建 —— 跑 make image DEBUG=1（第 ④ 道调试手段不能只是文档）`);
  } else {
    const dbg = spawnSync("docker", ["run", "--rm", "-e", "AGENT_RUN_MODE=debug", "-e", "HARNESS=x", debug, "x"], { encoding: "utf8", timeout: 120000 });
    add("debug-variant-usable", /调试变体诊断 shell/.test(dbg.stderr ?? ""),
      `stderr=${(dbg.stderr ?? "").trim().slice(0, 140)}`);
  }

  // ⑥b 双架构：另一个架构也必须真的能跑、且硬化生效（用户明确要求同时支持 arm64/amd64）
  // 不能只看"构建成功" —— 模拟架构下最典型的坑是"构建过了但跑不起来"。所以真跑。
  {
    const other = arch === "arm64" ? "amd64" : "arm64";
    const otherTag = `agent-base:${version}-${other}`;
    const expectMachine = other === "amd64" ? "x86_64" : "aarch64";
    if (!imageExists(otherTag)) {
      add("dual-arch-image", false, `${other} 架构镜像 ${otherTag} 未构建 —— 双架构是硬要求（make image-all）`);
    } else {
      const r = spawnSync("docker", ["run", "--rm", "--platform", `linux/${other}`, "--cap-drop", "ALL", otherTag, "shell", "-c",
        "printf 'arch='; uname -m; printf 'uid='; id -u; grep '^CapEff' /proc/self/status"],
        { encoding: "utf8", timeout: 300000 });
      const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
      const okArch = out.includes(`arch=${expectMachine}`);
      const okUid = /uid=10001/.test(out);
      const okCaps = /CapEff:\s*0+\b/.test(out);
      add("dual-arch-image", okArch && okUid && okCaps,
        `${other}：${out.trim().replace(/\n/g, " ").slice(0, 150)}`);
    }
  }

  // ⑥c 多架构打包形态：OCI 归档里必须真的含两个平台的镜象
  //
  // 注意归档是**两层**的：顶层 index.json 里那一条是 manifest list 本身
  // （mediaType = oci.image.index），平台条目在它指向的 blob 里。只读顶层会得出"0 个平台"的错觉。
  {
    const archive = path.join(REPO, "dist/image", `agent-base-${version}.oci.tar`);
    if (!fs.existsSync(archive)) {
      add("multiarch-manifest", false, `缺多架构归档 dist/image/agent-base-${version}.oci.tar —— 跑 make image-manifest`);
    } else {
      const readBlob = (name) => {
        const r = spawnSync("tar", ["-xOf", archive, name], { encoding: "utf8", timeout: 300000, maxBuffer: 64 * 1024 * 1024 });
        return r.status === 0 ? r.stdout : null;
      };
      let platforms = [];
      let note = "";
      try {
        const top = JSON.parse(readBlob("index.json") ?? "{}");
        let inner = top;
        // 顶层那条若是 image index（manifest list），继续往里取真正的平台清单
        if ((top.manifests ?? []).length && !(top.manifests ?? []).some((m) => m.platform)) {
          const d = top.manifests[0].digest ?? "";
          const hex = d.replace(/^sha256:/, "");
          inner = JSON.parse(readBlob(`blobs/sha256/${hex}`) ?? "{}");
        }
        platforms = (inner.manifests ?? []).map((m) => m.platform).filter(Boolean)
          .map((p) => `${p.os}/${p.architecture}`);
      } catch (e) { note = `解析失败：${String(e.message).slice(0, 80)}`; }
      const want = ["linux/arm64", "linux/amd64"];
      add("multiarch-manifest", want.every((w) => platforms.includes(w)),
        `OCI 归档内的平台：${platforms.join(", ") || note || "(空)"}`);
    }
  }

  // ⑦ 声明 vs 实测：声称无 OS 沙箱的 adapter，其依赖的容器下限必须真的成立
  const declared = declaredSecurity();
  const relying = Object.entries(declared).filter(([, v]) => v.osSandbox === "unsupported").map(([k]) => k);
  const floorOk = checks.filter((c) => ["uid-non-root", "rootfs-readonly", "capabilities-dropped"].includes(c.id)).every((c) => c.ok);
  add("declared-vs-measured", relying.length === 0 || floorOk,
    relying.length === 0
      ? "没有 adapter 声称无 OS 沙箱，无需对照"
      : `${relying.join(", ")} 声明 osSandbox=unsupported 并依赖容器层硬下限；容器下限实测${floorOk ? "成立" : "**不成立**（声明等于空话）"}`);

  // ⑤ 交付价值的最终检验：容器里能配好 LLM 并真跑通（含负向）
  for (const c of runLlmConfigChecks({ image: base })) add(c.id, c.ok, c.detail);

  return { pending: null, checks, images: { base, debug } };
}
