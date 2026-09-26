#!/usr/bin/env node
// ============================================================================
// 零凭据假网关 · 服务入口（统一设计 §6.4 / §2.4 / §8.2 / §8.3）
//
// 本层纪律：
//   放：HTTP 传输、统一轨迹落地（stderr / AGENT_TRACE_DEST）、进程契约（stdout 只放结果、
//       日志与轨迹走 stderr）、以及给闸门 3 用的编程入口 startFakeGateway()。
//   不放：判定逻辑（core.mjs）、协议形状（protocols/*.mjs）、任何凭据概念。
//
// 为什么存在（§6.4）：让闸门 1–3 在**零凭据**下可跑（N14），
// 使基座自身的回归不依赖任何外部系统。它是 harness 无关的——只讲协议，不讲 harness。
//
// 用法：
//   node tools/fake-gateway/server.mjs [--port 0] [--host 127.0.0.1] [--provider fake-gateway]
//                                     [--model fake-model] [--no-trace] [--help]
//   · stdout 只打印一行 base URL（§8.2：stdout 只放结果，便于脚本直接取用）
//   · 人读提示与轨迹都走 stderr
//
// 编程入口（闸门 3 用，见 README）：
//   import { startFakeGateway } from "<repo>/tools/fake-gateway/server.mjs";
//   const gw = await startFakeGateway({ port: 0, trace: true });
//   // gw.url / gw.port / gw.traceLines / await gw.close()
//
// 轨迹上下文（全部从环境变量取，缺省值保证零配置可跑）：
//   AGENT_TRACE_DIGEST  默认 = H(假网关自身确定性配置)
//   AGENT_RUN_ID        默认 = 随机 uuid（随机量只进轨迹，绝不进响应体）
//   AGENT_NAME / HARNESS / HARNESS_VERSION  已知时带上
//   AGENT_TRACE_DEST    默认 stderr；设为文件路径则改写入该文件
// ============================================================================

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";

import {
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
  FAKE_GATEWAY_VERSION,
  FakeGatewayRequestError,
  configDigest,
  gatewayConfig,
  handleNormalizedRequest,
} from "./core.mjs";
import * as openai from "./protocols/openai.mjs";

// 请求体上限。假网关只服务本地探针；超过说明调用方出了问题，宁可失败也不静默截断。
const MAX_BODY_BYTES = 8 * 1024 * 1024;

// ---------------------------------------------------------------------------
// 统一轨迹（§8.3）
// ---------------------------------------------------------------------------

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

/**
 * 轨迹上下文。`effectiveConfigDigest` 每条事件都带（§8.3）：事后归因不必再追问
 * 「当时生效的是什么」。缺省值 = 假网关自身配置的摘要，所以零配置也有合法 digest。
 */
export function traceContext(env = process.env, config = gatewayConfig()) {
  const digest = typeof env.AGENT_TRACE_DIGEST === "string" && DIGEST_PATTERN.test(env.AGENT_TRACE_DIGEST.trim())
    ? env.AGENT_TRACE_DIGEST.trim()
    : configDigest(config);
  const field = (name) => (typeof env[name] === "string" && env[name].trim() ? env[name].trim() : null);
  const ctx = { effectiveConfigDigest: digest, run: field("AGENT_RUN_ID") ?? crypto.randomUUID() };
  for (const [key, name] of [["agent", "AGENT_NAME"], ["harness", "HARNESS"], ["harnessVersion", "HARNESS_VERSION"]]) {
    const value = field(name);
    if (value) ctx[key] = value;
  }
  return ctx;
}

/**
 * 轨迹发射器。
 *
 * 两条硬约束：
 *   · **字段必须过 core/trace/schema.json**：schema 的 unevaluatedProperties 会拒绝臆造字段，
 *     所以这里只输出 schema 认识的东西（common 字段 + 该事件类型的字段）。
 *   · **写轨迹绝不允许影响 HTTP 响应**：所有 I/O 都裹在 try/catch 里，
 *     轨迹写失败只是丢一条审计，不是让探针失败——那会把网络层问题伪装成配置层问题。
 */
export function createTraceEmitter({ context, dest = "stderr", sink = null } = {}) {
  let seq = 0;
  let stream = null;
  if (dest && dest !== "stderr" && dest !== "none") {
    try {
      fs.mkdirSync(path.dirname(path.resolve(dest)), { recursive: true });
      stream = fs.createWriteStream(path.resolve(dest), { flags: "a" });
      // 轨迹流自身的错误不能变成未捕获异常
      stream.on("error", () => { stream = null; });
    } catch { stream = null; }
  }

  return {
    get seq() { return seq; },
    emit(fields) {
      const { type, ...rest } = fields;
      const event = {
        ts: new Date().toISOString(),
        seq: seq++,
        run: context.run,
        ...(context.agent ? { agent: context.agent } : {}),
        ...(context.harness ? { harness: context.harness } : {}),
        ...(context.harnessVersion ? { harnessVersion: context.harnessVersion } : {}),
        type,
        effectiveConfigDigest: context.effectiveConfigDigest,
        ...rest,
      };
      const line = JSON.stringify(event);
      try { if (sink) sink.push(line); } catch { /* 收集失败不影响响应 */ }
      try {
        if (stream) stream.write(`${line}\n`);
        else if (dest === "stderr") process.stderr.write(`${line}\n`);
      } catch { /* 轨迹写失败不影响响应 */ }
      return line;
    },
    close() {
      try { if (stream) stream.end(); } catch { /* 忽略 */ }
    },
  };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function sendJson(res, status, body, extraHeaders = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
    ...extraHeaders,
  });
  res.end(text);
}

function errorBody(message, code, type = "invalid_request_error") {
  return { error: { message, type, code } };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { tooLarge = true; return; }
      chunks.push(chunk);
    });
    req.on("end", () => resolve({
      tooLarge,
      text: tooLarge ? "" : Buffer.concat(chunks).toString("utf8"),
    }));
    req.on("error", reject);
  });
}

/**
 * 建一个可关闭的 HTTP 服务。
 *
 * 只看 method + path + body，**从不读 Authorization**：零凭据是硬需求，
 * 任何「顺手校验一下 key」的代码都会把假网关变成又一个需要凭据的外部依赖。
 */
function createServer({ config, emitter }) {
  const server = http.createServer((req, res) => {
    handleRequest(req, res, { config, emitter }).catch((err) => {
      // fail loud：不吞异常，但也绝不让单个请求打崩服务（否则闸门 3 只会看到连接被重置）
      try {
        if (!res.headersSent) {
          sendJson(res, 500, errorBody(`假网关内部错误：${err?.message ?? err}`, "INTERNAL", "server_error"));
        } else {
          res.end();
        }
      } catch { /* 客户端可能已断开 */ }
    });
  });
  // SSE 连接可能长时间空闲；不让 Node 的默认超时把它掐掉
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  return server;
}

async function handleRequest(req, res, { config, emitter }) {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
  const pathname = url.pathname.replace(/\/+$/, "") || "/";

  // 零凭据健康探针（§8.4：健康检查必须能在零凭据下回答）
  if (pathname === "/healthz") {
    if (req.method !== "GET" && req.method !== "HEAD") return sendJson(res, 405, errorBody("healthz 只接受 GET", "METHOD_NOT_ALLOWED"));
    return sendJson(res, 200, {
      ok: true,
      service: "fake-gateway",
      version: FAKE_GATEWAY_VERSION,
      protocol: openai.PROTOCOL_ID,
      credentials: "none",
      provider: config.provider,
      model: config.model,
    });
  }

  // 模型列表：部分 harness 启动时会先探它。确定性、无凭据。
  if (pathname === "/v1/models") {
    if (req.method !== "GET") return sendJson(res, 405, errorBody("/v1/models 只接受 GET", "METHOD_NOT_ALLOWED"));
    return sendJson(res, 200, {
      object: "list",
      data: [{ id: config.model, object: "model", created: 0, owned_by: "fake-gateway" }],
    });
  }

  if (pathname === "/v1/chat/completions") {
    if (req.method !== "POST") {
      emitter.emit({ type: "model.error", code: "METHOD_NOT_ALLOWED", provider: config.provider, message: "chat/completions 只接受 POST" });
      return sendJson(res, 405, errorBody("chat/completions 只接受 POST", "METHOD_NOT_ALLOWED"));
    }
    return handleChatCompletion(req, res, { config, emitter });
  }

  emitter.emit({ type: "model.error", code: "NOT_FOUND", provider: config.provider, message: `未知路径：${pathname}` });
  return sendJson(res, 404, errorBody(`假网关不提供该路径：${pathname}`, "NOT_FOUND"));
}

async function handleChatCompletion(req, res, { config, emitter }) {
  const body = await readBody(req);
  if (body.tooLarge) {
    emitter.emit({ type: "model.error", code: "PAYLOAD_TOO_LARGE", provider: config.provider, message: `请求体超过 ${MAX_BODY_BYTES} 字节` });
    return sendJson(res, 413, errorBody("请求体过大", "PAYLOAD_TOO_LARGE"));
  }

  let parsed;
  try {
    parsed = JSON.parse(body.text === "" ? "{}" : body.text);
  } catch (err) {
    emitter.emit({ type: "model.error", code: "BAD_JSON", provider: config.provider, message: "请求体不是合法 JSON" });
    return sendJson(res, 400, errorBody(`请求体不是合法 JSON：${err.message}`, "BAD_JSON"));
  }

  let normalized;
  let result;
  try {
    const raw = openai.parseChatCompletionRequest(parsed, req.headers);
    ({ normalized, result } = handleNormalizedRequest(raw, { provider: config.provider, toolArgs: config.toolArgs }));
  } catch (err) {
    const code = err instanceof FakeGatewayRequestError ? err.code : "BAD_REQUEST";
    const provider = normalized?.provider ?? config.provider;
    emitter.emit({ type: "model.error", code, provider, message: err.message });
    return sendJson(res, 400, errorBody(err.message, code));
  }

  // 轨迹：tools 计数与 stream 标记在这里对审计可见（§6.4 的核心断言对象）
  emitter.emit({
    type: "model.request",
    provider: normalized.provider,
    model: normalized.model,
    tools: normalized.tools.length,
    stream: normalized.stream,
  });

  const metaHeaders = openai.observabilityHeaders(normalized, result);
  if (normalized.stream) {
    res.writeHead(200, { ...openai.streamHeaders(), ...metaHeaders });
    for (const frame of openai.serializeChatCompletionStream(normalized, result)) res.write(frame);
    res.end();
    return;
  }
  sendJson(res, 200, openai.serializeChatCompletion(normalized, result), metaHeaders);
}

// ---------------------------------------------------------------------------
// 编程入口（闸门 3）
// ---------------------------------------------------------------------------

/**
 * 启动假网关。
 *
 * @param {object}  [options]
 * @param {number}  [options.port=0]        0 = 由内核分配空闲端口
 * @param {boolean} [options.trace=true]    false = 完全不产轨迹（traceLines 保持空）
 * @param {string}  [options.host="127.0.0.1"] 只绑本地：零凭据服务不对外
 * @param {string}  [options.provider]      缺省取 FAKE_GATEWAY_PROVIDER，再缺省 "fake-gateway"
 * @param {string}  [options.model]         缺省取 FAKE_GATEWAY_MODEL，再缺省 "fake-model"
 * @param {string}  [options.traceDest]     缺省取 AGENT_TRACE_DEST，再缺省 "stderr"
 * @param {object}  [options.env=process.env] 轨迹上下文来源（便于测试注入）
 * @returns {Promise<{url:string, port:number, traceLines:string[], config:object,
 *                    effectiveConfigDigest:string, close:()=>Promise<void>}>}
 */
export async function startFakeGateway(options = {}) {
  const {
    port = 0,
    trace = true,
    host = "127.0.0.1",
    provider = process.env.FAKE_GATEWAY_PROVIDER || DEFAULT_PROVIDER,
    // 测试用：按工具名覆盖入参（JSON）。例如让 read 去读某个 SKILL.md，用来触发技能级轨迹事件。
    toolArgs = process.env.FAKE_GATEWAY_TOOL_ARGS ? JSON.parse(process.env.FAKE_GATEWAY_TOOL_ARGS) : null,
    model = process.env.FAKE_GATEWAY_MODEL || DEFAULT_MODEL,
    traceDest,
    env = process.env,
  } = options;

  const config = gatewayConfig({ provider, model, protocol: openai.PROTOCOL_ID, toolArgs });
  const context = traceContext(env, config);
  const traceLines = [];
  const dest = traceDest ?? (env.AGENT_TRACE_DEST || "stderr");
  const emitter = trace ? createTraceEmitter({ context, dest, sink: traceLines }) : null;
  const server = createServer({ config, emitter: emitter ?? { emit: () => {} } });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const actualPort = server.address().port;
  let closed = false;

  return {
    url: `http://${host}:${actualPort}/v1`,
    port: actualPort,
    config,
    effectiveConfigDigest: context.effectiveConfigDigest,
    run: context.run,
    traceLines,
    async close() {
      if (closed) return;
      closed = true;
      emitter?.close();
      await new Promise((resolve) => {
        // closeAllConnections 必须先于回调等待：SSE / keep-alive 连接不会自己结束，
        // 不主动断开就会留下句柄，让 selftest 与闸门 3 进程无法自然退出。
        server.close(() => resolve());
        server.closeAllConnections?.();
        server.closeIdleConnections?.();
      });
    },
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { port: 0, host: "127.0.0.1", provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL, trace: true };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`参数 ${arg} 缺少取值`);
      return value;
    };
    switch (arg) {
      case "--port": opts.port = Number(next()); break;
      case "--host": opts.host = next(); break;
      case "--provider": opts.route = next(); break;
      case "--model": opts.model = next(); break;
      case "--no-trace": opts.trace = false; break;
      case "--help":
      case "-h": opts.help = true; break;
      default: throw new Error(`未知参数：${arg}`);
    }
  }
  if (!Number.isInteger(opts.port) || opts.port < 0 || opts.port > 65535) {
    throw new Error(`--port 必须是 0–65535 的整数，收到：${opts.port}`);
  }
  return opts;
}

const HELP = `零凭据假网关（统一设计 §6.4）

用法：
  node tools/fake-gateway/server.mjs [选项]

选项：
  --port <n>     监听端口，0 = 自动分配空闲端口（默认 0）
  --host <addr>  监听地址，默认 127.0.0.1（零凭据服务不对外暴露）
  --provider <name> 轨迹里记录的供应商名，默认 fake-gateway
  --model <name> /v1/models 暴露的模型名，默认 fake-model
  --no-trace     不产轨迹
  --help         打印本帮助

端点：
  POST /v1/chat/completions   OpenAI 兼容补全（支持 stream / tools）
  GET  /v1/models             模型列表（确定性）
  GET  /healthz               零凭据健康探针

stdout 只打印一行 base URL；人读提示与统一轨迹 JSONL 走 stderr。`;

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`❌ ${err.message}\n`);
    process.exit(2); // §6.7：用法/参数错误 = 2
  }
  if (opts.help) {
    process.stdout.write(`${HELP}\n`);
    process.exit(0);
  }

  const gw = await startFakeGateway(opts);
  process.stdout.write(`${gw.url}\n`);
  process.stderr.write(`假网关已启动：${gw.url}（零凭据；轨迹走 stderr）\n`);
  process.stderr.write(`可用端点：POST ${gw.url}/chat/completions · GET ${gw.url}/models · GET ${gw.url.replace(/\/v1$/, "")}/healthz\n`);

  const shutdown = async (signal) => {
    process.stderr.write(`收到 ${signal}，关闭假网关…\n`);
    await gw.close();
    process.exit(0);
  };
  process.on("SIGINT", () => { shutdown("SIGINT"); });
  process.on("SIGTERM", () => { shutdown("SIGTERM"); });
}

// 只在被当作 CLI 直接执行时启动服务；被 import 时只暴露 startFakeGateway。
const isCli = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isCli) {
  main().catch((err) => {
    process.stderr.write(`❌ 假网关启动失败：${err?.stack ?? err}\n`);
    process.exit(1);
  });
}

// 再导出协议适配层，方便调用方从一处拿到协议常量（README 里闸门 3 只要求 startFakeGateway）。
export { openai, FAKE_GATEWAY_VERSION, DEFAULT_PROVIDER, DEFAULT_MODEL };
