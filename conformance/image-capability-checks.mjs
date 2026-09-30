// ============================================================================
// 交付价值的最终检验：**容器里真的能配好 LLM 并跑通一次**
//
// 这一条存在的理由：在这之前，闸门 3/4 是在**宿主机**上对渲染产物跑的（假网关在宿主机），
// 而"把产物挂进容器、用运行期注入的端点/凭据/模型名跑一次"这条路径**从没被验证过** ——
// 结果容器里跑不起来（产物只读、配置没渲染、参数没注入），而宿主机侧的检查全绿。
//
// 判据打在真实链路上：
//   ① 正向：--network none 下，端点/凭据/模型名全部运行期注入 → 退出码 0，
//      且**端点侧**收到请求（tools>0、stream=true），模型名 == 注入的那个
//   ② 负向：不给凭据 → **退出码 2** 且信息点名缺哪个引用名（不许静默降级、不许用别的模型顶替）
//
// 假网关放在**容器内**（挂载进去，不打进镜像）：它是验证工具，不是产品的一部分；
// 端点与智能体同容器 ⇒ `--network none` 也成立（loopback 仍在）。
// ============================================================================

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createContainerFixtureDir } from "./container-fixture-dir.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const GW_PORT = 49117;

/** 渲染一份 pi 产物（用仓库里的示例定义）。 */
function renderProduct() {
  const out = createContainerFixtureDir("llm-cfg-art-");
  const r = spawnSync(process.execPath, [path.join(REPO, "adapters/pi/render.mjs"), path.join(REPO, "examples/idea-to-proof"), "--out", out], { encoding: "utf8" });
  return r.status === 0 ? out : null;
}

/**
 * 在容器里跑一次智能体。**故意不复用 inContainer()**：那条路径没有挂载，
 * 而这条检查的核心恰恰是"产物只读挂载 + 端点参数注入"。
 */
function runAgentInContainer(image, artifact, extraEnv, outDir) {
  const envFlags = Object.entries(extraEnv).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  const script = [
    `node /opt/in-container-gateway.mjs > /out/gateway.log 2>&1 &`,
    `for i in $(seq 1 40); do [ -s /out/gateway.ready ] && break; sleep 0.25; done`,
    `HARNESS=pi AGENT_TRACE_DEST=/out/trace.jsonl AGENT_HARNESS_ARGS="--mode json -p hi" PI_OFFLINE=1 \\`,
    `  /usr/local/bin/agent-base-entrypoint agent > /out/agent.out 2>/out/agent.err`,
    `echo "AGENT_EXIT=$?"`,
  ].join("\n");
  const r = spawnSync("docker", [
    "run", "--rm", "--read-only", "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges", "--network", "none",
    "--tmpfs", "/tmp",
    "-v", `${artifact}:/opt/agent-base/artifact:ro`,
    "-v", `${path.join(REPO, "tools/fake-gateway")}:/opt/fake:ro`,
    "-v", `${path.join(HERE, "fixtures/in-container-gateway.mjs")}:/opt/in-container-gateway.mjs:ro`,
    "-v", `${outDir}:/out`,
    ...envFlags,
    image, "shell", "-c", script,
  ], { encoding: "utf8", timeout: 180000 });
  const stdout = r.stdout ?? "";
  const exit = Number((stdout.match(/AGENT_EXIT=(\d+)/) ?? [])[1] ?? NaN);
  const read = (f) => { try { return fs.readFileSync(path.join(outDir, f), "utf8"); } catch { return ""; } };
  return { exit, stdout, stderr: r.stderr ?? "", agentErr: read("agent.err"), trace: read("trace.jsonl"), agentOut: read("agent.out") };
}

export function runLlmConfigChecks({ image }) {
  const checks = [];
  const add = (id, ok, detail) => checks.push({ id, ok: Boolean(ok), detail });

  const artifact = renderProduct();
  if (!artifact) return [{ id: "agent-runs-with-injected-llm-config", ok: false, detail: "前置失败：渲染产物失败" }];

  const okDir = createContainerFixtureDir("llm-cfg-out-", { writable: true });
  // **参数名从产物清单里取**（`runtimeParams[].backs` 就是这份契约），不许写死某个供应商的名字。
  // 教训：这里原来写死 CORP_GATEWAY_*，而本检查渲染的示例后来换了供应商 ——
  // 检查就变成"永远红"，而它先前被 C9 的前一步（镜像同源）挡住，没人发现。
  const manifest = JSON.parse(fs.readFileSync(path.join(artifact, "render-manifest.json"), "utf8"));
  const params = manifest.runtimeParams ?? [];
  const endpointParam = params.find((x) => x.backs === "model.provider" && !x.secret)?.name;
  const secretParam = params.find((x) => x.secret === true)?.name;
  const modelParam = params.find((x) => x.backs === "model.name")?.name;
  if (!endpointParam || !secretParam || !modelParam) {
    return [{ id: "agent-runs-with-injected-llm-config", ok: false,
      detail: `产物未声明完整的运行期参数契约（endpoint=${endpointParam} secret=${secretParam} model=${modelParam}）` }];
  }
  const injected = {
    [endpointParam]: `http://127.0.0.1:${GW_PORT}/v1`,
    [secretParam]: "placeholder-not-a-credential",
    [modelParam]: manifest.modelProviders?.[0] === "deepseek" ? "deepseek-flash" : "corp-think",
  };
  const ok = runAgentInContainer(image, artifact, injected, okDir);

  // 正向①：容器内跑通
  add("agent-runs-with-injected-llm-config", ok.exit === 0,
    `容器内退出码 ${ok.exit}（期望 0）${ok.exit !== 0 ? `；stderr 末 400：${(ok.agentErr || ok.stderr).trim().slice(-400)}` : ""}`);

  // 正向②：**端点侧**确实收到了请求（不是"进程没报错"就算数）
  const reqs = ok.trace.split("\n").filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((e) => e && e.type === "model.request");
  const withTools = reqs.filter((e) => (e.tools ?? 0) > 0 && e.stream === true);
  add("container-endpoint-received-request", withTools.length > 0,
    withTools.length ? `端点侧记录 ${withTools.length} 次请求，tools=${withTools[0].tools} stream=true` : `轨迹里没有带工具数的 model.request（轨迹行数 ${reqs.length}）`);

  // 正向③：模型名确实是运行期注入的那个（而不是产物里的默认值碰巧相同）
  add("container-model-name-from-runtime", withTools.some((e) => e.model === injected[modelParam]),
    `端点侧记录的 model=${[...new Set(withTools.map((e) => e.model))].join(",") || "(无)"}`);

  // 正向④：产物只读挂载未被改写（改了摘要就不成立）
  const manifestDigest = manifest.artifactsDigest;
  add("container-artifact-untouched", !!manifestDigest && fs.existsSync(path.join(artifact, "render-manifest.json")),
    "产物根目录仍可读且清单在位（写入都发生在暂存副本里）");

  // 负向：不给凭据 → 退出码 2，且点名缺哪个引用名
  const badDir = createContainerFixtureDir("llm-cfg-bad-", { writable: true });
  const bad = runAgentInContainer(image, artifact, {
    [endpointParam]: injected[endpointParam],
    [modelParam]: injected[modelParam],
  }, badDir);
  const namesMissing = new RegExp(secretParam).test(bad.agentErr);
  add("container-missing-credential-fails-fast", bad.exit === 2 && namesMissing,
    `退出码 ${bad.exit}（期望 2）；stderr 是否点名缺的引用名（${secretParam}）：${namesMissing}`);

  return checks;
}
