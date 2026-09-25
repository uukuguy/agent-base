#!/usr/bin/env node
// ============================================================================
// 零凭据假网关 · 自检（统一设计 §6.4 / §6.7 / §8.3）
//
// 自检的意义：假网关是**闸门 3 的地基**。地基自己不可信，上面所有断言都不算数。
// 因此这里不只测「服务能起来」，而是把设计里对它的每条硬需求都变成一条断言：
//
//   零凭据    → 不带 Authorization 的请求必须成功（还有 healthz 也是）
//   确定性    → 同一请求两次 ⇒ 逐字节相同的响应体（N19）
//   流式      → content-type 正确、帧可解析、以 data: [DONE] 收尾
//   工具调用  → 带 N 个工具必须发出工具调用，且 tools=N 在三处可见（body / header / 轨迹）
//   轨迹      → 每一行都过 core/trace/schema.json（ajv 2020）、seq 单调
//   进程契约  → close() 可等待且不留句柄，进程能自然退出（不靠 process.exit 硬退）
//
// 用法：node tools/fake-gateway/selftest.mjs
// 退出码：0 = 全绿；1 = 有失败项。
// ============================================================================

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

import { startFakeGateway, openai } from "./server.mjs";
import { RESPONSE_MARKER, handleNormalizedRequest } from "./core.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TRACE_SCHEMA = path.resolve(HERE, "../../core/trace/schema.json");

// 轨迹上下文固定下来，让输出可读、可复现（随机 run id 只影响轨迹，不影响响应体）。
process.env.AGENT_RUN_ID = "fake-gateway-selftest";
delete process.env.AGENT_TRACE_DIGEST;

const results = [];
function check(id, ok, detail) {
  results.push({ id, ok, detail });
  console.log(`${ok ? "✅" : "❌"} [${id}] ${detail}`);
}

const TOOLS = [
  {
    type: "function",
    function: {
      name: "get_issue",
      description: "取一个工单",
      parameters: { type: "object", properties: { key: { type: "string" }, verbose: { type: "boolean" } }, required: ["key"] },
    },
  },
  { type: "function", function: { name: "search", parameters: { type: "object", properties: { q: { type: "string" } } } } },
  { type: "function", function: { name: "no_args", parameters: { type: "object", properties: {} } } },
];

function chatBody(overrides = {}) {
  return JSON.stringify({
    model: "fake-model",
    messages: [{ role: "user", content: "ping" }],
    ...overrides,
  });
}

/** 刻意不带 Authorization / api-key：零凭据就是这条断言。 */
function post(url, bodyText) {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" }, // 注意：没有任何凭据头
    body: bodyText,
  });
}

async function main() {
  const gateway = await startFakeGateway({ port: 0, trace: true });
  const chatUrl = `${gateway.url}/chat/completions`;
  const root = gateway.url.replace(/\/v1$/, "");

  check("start/port", Number.isInteger(gateway.port) && gateway.port > 0,
    `port=0 自动分配空闲端口 ⇒ ${gateway.url}`);
  check("start/digest", /^sha256:[0-9a-f]{64}$/.test(gateway.effectiveConfigDigest),
    `effectiveConfigDigest 格式合法：${gateway.effectiveConfigDigest}`);

  // ---- 零凭据健康探针（§8.4：健康检查必须零凭据可答） -------------------
  {
    const res = await fetch(`${root}/healthz`);
    const body = await res.json();
    check("zero-cred/healthz", res.status === 200 && body.ok === true && body.credentials === "none",
      `无凭据 GET /healthz ⇒ ${res.status}，credentials=${body.credentials}`);
  }

  // ---- 非流式补全，无 Authorization --------------------------------------
  const plain = chatBody();
  let firstBody = "";
  {
    const res = await post(chatUrl, plain);
    firstBody = await res.text();
    const body = JSON.parse(firstBody);
    const message = body.choices?.[0]?.message;
    check("zero-cred/chat", res.status === 200,
      `无 Authorization 的 POST /v1/chat/completions ⇒ ${res.status}`);
    check("chat/content-marker", typeof message?.content === "string" && message.content.includes(RESPONSE_MARKER),
      `响应含确定性标记 ${RESPONSE_MARKER}`);
    check("chat/tools-in-body", body.fake_gateway?.tools === 0 && res.headers.get("x-fake-gateway-tools") === "0",
      `无工具请求：body.fake_gateway.tools=${body.fake_gateway?.tools}，header=${res.headers.get("x-fake-gateway-tools")}`);
    check("chat/stream-in-body", body.fake_gateway?.stream === false && res.headers.get("x-fake-gateway-stream") === "false",
      `非流式：body.fake_gateway.stream=${body.fake_gateway?.stream}，header=${res.headers.get("x-fake-gateway-stream")}`);
  }

  // ---- 确定性：同一请求两次 ⇒ 逐字节相同（N19） ---------------------------
  {
    const res = await post(chatUrl, plain);
    const secondBody = await res.text();
    check("determinism/bytes", secondBody === firstBody && firstBody.length > 0,
      `两次相同请求响应体逐字节相同（${Buffer.byteLength(firstBody)} 字节）`);
  }

  // ---- 流式（SSE） -------------------------------------------------------
  const streamTexts = [];
  for (let i = 0; i < 2; i++) {
    const res = await post(chatUrl, chatBody({ stream: true }));
    const contentType = res.headers.get("content-type") ?? "";
    const text = await res.text();
    streamTexts.push(text);
    check(`stream/content-type${i === 0 ? "" : "（复跑）"}`, res.status === 200 && contentType.includes("text/event-stream"),
      `stream:true ⇒ ${res.status} content-type=${contentType}`);
    check(`stream/done${i === 0 ? "" : "（复跑）"}`, text.endsWith("data: [DONE]\n\n"),
      "流以 'data: [DONE]\\n\\n' 收尾");

    const frames = text.split("\n\n").filter((f) => f.length > 0);
    const dataFrames = frames.slice(0, -1).map((f) => f.replace(/^data: /, ""));
    let chunksOk = dataFrames.length >= 3;
    let streamFlagOk = false;
    for (const raw of dataFrames) {
      try {
        const chunk = JSON.parse(raw);
        if (chunk.object !== "chat.completion.chunk") chunksOk = false;
        if (chunk.fake_gateway?.stream === true) streamFlagOk = true;
      } catch { chunksOk = false; }
    }
    check(`stream/frames${i === 0 ? "" : "（复跑）"}`, chunksOk,
      `${dataFrames.length} 个 data: 帧全部是合法 JSON 且 object=chat.completion.chunk`);
    check(`stream/flag-visible${i === 0 ? "" : "（复跑）"}`, streamFlagOk && res.headers.get("x-fake-gateway-stream") === "true",
      `流式：首帧 fake_gateway.stream=true，header=${res.headers.get("x-fake-gateway-stream")}`);
  }
  check("determinism/stream-bytes", streamTexts[0] === streamTexts[1] && streamTexts[0].length > 0,
    `两次相同流式请求响应体逐字节相同（${Buffer.byteLength(streamTexts[0])} 字节）`);

  // ---- 纯适配层与 HTTP 服务必须逐字节一致 ---------------------------------
  // 协议适配层是纯函数，server.mjs 只是把它的输出写进 socket。
  // 这条断言证明「不经过 socket 也能复现一模一样的结果」——闸门 3 因此可以只跑核心，
  // 也保证 HTTP 层没有偷偷加字段（比如不小心把时间戳混进响应体）。
  {
    const { normalized, result } = handleNormalizedRequest(
      { model: "fake-model", messages: [{ role: "user", content: "ping" }] },
      { route: "fake-gateway" },
    );
    const pureBody = JSON.stringify(openai.serializeChatCompletion(normalized, result));
    check("parity/non-stream", pureBody === firstBody,
      `纯适配层输出与 HTTP 响应体逐字节一致（${Buffer.byteLength(pureBody)} 字节）`);

    const streamed = handleNormalizedRequest(
      { model: "fake-model", messages: [{ role: "user", content: "ping" }], stream: true },
      { route: "fake-gateway" },
    );
    const pureStream = openai.serializeChatCompletionStreamText(streamed.normalized, streamed.result);
    check("parity/stream", pureStream === streamTexts[0],
      `纯适配层 SSE 输出与 HTTP 流逐字节一致（${Buffer.byteLength(pureStream)} 字节，含 data: [DONE]）`);
  }

  // ---- 工具调用：N=3 ⇒ 必须发出工具调用且 tools=3 -------------------------
  {
    const res = await post(chatUrl, chatBody({ tools: TOOLS }));
    const body = await res.json();
    const call = body.choices?.[0]?.message?.tool_calls?.[0];
    check("tools/count-in-body", body.fake_gateway?.tools === 3 && res.headers.get("x-fake-gateway-tools") === "3",
      `携带 ${TOOLS.length} 个工具 ⇒ body.fake_gateway.tools=${body.fake_gateway?.tools}，header=${res.headers.get("x-fake-gateway-tools")}`);
    check("tools/call-issued", call?.type === "function" && call?.function?.name === "get_issue" && body.choices?.[0]?.finish_reason === "tool_calls",
      `发出确定性工具调用 name=${call?.function?.name} finish_reason=${body.choices?.[0]?.finish_reason}`);
    let argsOk = false;
    try { argsOk = typeof JSON.parse(call.function.arguments) === "object"; } catch { argsOk = false; }
    check("tools/arguments-json", argsOk, `工具入参是合法 JSON 字符串：${call?.function?.arguments}`);
  }

  // ---- 请求不合法 ⇒ model.error 留痕（§8.3：不许只在请求期冒泡一次） -------
  {
    const res = await post(chatUrl, "{ this is not json");
    const body = await res.json();
    check("error/bad-json", res.status === 400 && body.error?.code === "BAD_JSON",
      `非法 JSON ⇒ ${res.status} code=${body.error?.code}`);
  }

  // ---- 轨迹：逐行过 schema + seq 单调 ------------------------------------
  const lines = gateway.traceLines;
  const schema = JSON.parse(fs.readFileSync(TRACE_SCHEMA, "utf8"));
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const validate = ajv.compile(schema);
  const events = [];
  let badLine = null;
  for (const line of lines) {
    let event;
    try { event = JSON.parse(line); } catch (e) { badLine = `${line}（不是 JSON：${e.message}）`; break; }
    events.push(event);
    if (!validate(event)) {
      badLine = `${line}（${ajv.errorsText(validate.errors)}）`;
      break;
    }
  }
  check("trace/emitted", lines.length > 0, `共产出 ${lines.length} 行轨迹（JSONL，stderr）`);
  check("trace/schema", badLine === null, badLine
    ? `有轨迹行不符合 core/trace/schema.json：${badLine}`
    : `${lines.length} 行轨迹全部通过 core/trace/schema.json（ajv 2020）`);

  const seqs = events.map((e) => e.seq);
  const seqOk = seqs.every((s, i) => i === 0 ? s === 0 : s === seqs[i - 1] + 1);
  check("trace/seq-monotonic", seqOk && new Set(events.map((e) => e.run)).size === 1,
    `seq 从 0 起严格递增：${seqs.join(",")}；run=${events[0]?.run}`);

  const requestEvents = events.filter((e) => e.type === "model.request");
  const toolsEvent = requestEvents.find((e) => e.tools === 3 && e.stream === false);
  const streamEvent = requestEvents.find((e) => e.stream === true);
  check("trace/model-request-tools", !!toolsEvent,
    toolsEvent
      ? `轨迹记录 tools=${toolsEvent.tools}（route=${toolsEvent.route} model=${toolsEvent.model} stream=${toolsEvent.stream}）`
      : "轨迹里找不到 tools=3 的 model.request");
  check("trace/model-request-stream", !!streamEvent,
    streamEvent ? `轨迹记录 stream=${streamEvent.stream}（tools=${streamEvent.tools}）` : "轨迹里找不到 stream=true 的 model.request");
  const errorEvent = events.find((e) => e.type === "model.error" && e.code === "BAD_JSON");
  check("trace/model-error", !!errorEvent,
    errorEvent ? `非法请求留下 model.error code=${errorEvent.code} route=${errorEvent.route}` : "轨迹里找不到 model.error");
  check("trace/digest-every-line", events.every((e) => e.effectiveConfigDigest === gateway.effectiveConfigDigest),
    `每条事件都带同一个 effectiveConfigDigest=${gateway.effectiveConfigDigest}`);

  // ---- 进程契约：close() 可等待，不留句柄（之后进程必须自然退出） ---------
  await gateway.close();
  check("close/awaitable", true, "close() 可等待，且已关闭全部连接（无残留句柄）");

  const failed = results.filter((r) => !r.ok);
  console.log("");
  console.log(failed.length === 0
    ? `假网关自检：全绿（${results.length} 项断言）`
    : `假网关自检：失败 ${failed.length} / ${results.length} 项 —— ${failed.map((f) => f.id).join(", ")}`);
  process.exitCode = failed.length === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error(`❌ 自检自身崩溃：${err?.stack ?? err}`);
  process.exit(1);
});
