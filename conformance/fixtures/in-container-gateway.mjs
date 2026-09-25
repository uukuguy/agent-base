// ============================================================================
// 容器内的零凭据假网关（供容器内端到端检查使用）
//
// 为什么在容器内：端点与智能体同容器 ⇒ `--network none` 也成立（loopback 仍在），
// 于是"运行期确实不需要出网"这条能被真跑一次来证明，而不只是声明。
//
// 为什么是挂载而不是打进镜像：假网关是**验证工具**，不是产品的一部分。
//
// 用法：node /opt/in-container-gateway.mjs
//   环境：GW_PORT（默认 49117）、GW_OUT（轨迹落盘路径）、GW_READY（就绪标记文件）
// ============================================================================
import fs from "node:fs";
import path from "node:path";

const PORT = Number(process.env.GW_PORT ?? 49117);
const OUT = process.env.GW_OUT ?? "/out/gateway-trace.jsonl";
const READY = process.env.GW_READY ?? "/out/gateway.ready";

const mod = await import("/opt/fake/server.mjs");
// 该实现把轨迹推进 sink（数组语义）—— 这里每来一条就落盘，保证容器结束前证据已经在盘上
const sink = [];
sink.push = (line) => {
  Array.prototype.push.call(sink, line);
  try {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, sink.join("\n") + "\n");
  } catch { /* 落盘失败不影响服务 */ }
};

const gw = await mod.startFakeGateway({ port: PORT, trace: true, sink });
fs.writeFileSync(READY, `${gw.url}\n`);
process.stderr.write(`[gw] 就绪 ${gw.url} → ${OUT}\n`);
setInterval(() => {}, 1 << 30);
