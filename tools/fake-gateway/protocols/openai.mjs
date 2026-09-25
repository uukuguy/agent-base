#!/usr/bin/env node
// ============================================================================
// 零凭据假网关 · OpenAI 兼容协议适配（统一设计 §6.4 / §2.4）
//
// 本层纪律：
//   放：OpenAI 兼容协议的**请求解析**（原生 → 中性）、**响应序列化**（中性 → 原生）、
//       以及 SSE 流式帧的生成。只有本层知道 "chat.completion" / "tool_calls" / "data: [DONE]"。
//   不放：判定逻辑（在 core.mjs）、HTTP 服务（在 server.mjs）、凭据校验（哪里都不放）。
//
// 本层不碰 HTTP：它接收已解析的 body 对象与 headers 映射，返回**纯数据 / 纯字符串**。
// 这样协议可以脱离 socket 被单测，server.mjs 也可以换任何传输。
//
// 请求头扩展（唯一一个，文档在 README）：
//   x-fake-gateway-route: <route>   —— 覆盖本次调用的 model.route，
//   让闸门 3 能把轨迹里的 route 对齐到自己正在断言的那条路由。
// ============================================================================

import {
  FakeGatewayRequestError,
  RESPONSE_MARKER,
} from "../core.mjs";

/** 协议 id。进假网关配置摘要，也进响应体的 fake_gateway 元数据。 */
export const PROTOCOL_ID = "openai";

/** SSE 终止帧。缺了它，客户端会一直等——这正是「流式降级」故障的一种表现。 */
export const SSE_DONE = "data: [DONE]\n\n";

function headerValue(headers, name) {
  if (!headers || typeof headers !== "object") return null;
  const wanted = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() !== wanted) continue;
    const value = headers[key];
    if (Array.isArray(value)) return value.length ? String(value[0]) : null;
    return value == null ? null : String(value);
  }
  return null;
}

// ---------------------------------------------------------------------------
// 请求解析：OpenAI Chat Completions → 中性形状
// ---------------------------------------------------------------------------

/**
 * 原生请求 → core.normalizeRequest 的输入。
 *
 * 刻意**不读 Authorization**、不读 api-key、不读任何凭据头：
 * 假网关的整个存在理由就是零凭据（N14）。多读一个字段就多一处拒绝合法请求的可能。
 */
export function parseChatCompletionRequest(body, headers = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new FakeGatewayRequestError("BAD_BODY", "请求体必须是 JSON 对象");
  }
  return {
    model: body.model,
    messages: body.messages,
    tools: body.tools,
    stream: body.stream,
    route: headerValue(headers, "x-fake-gateway-route") ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// 可观测元数据：tools 计数与 stream 标记必须能被调用方看见（§6.4）
// ---------------------------------------------------------------------------

/**
 * 把「本次请求携带了几个工具、是不是流式」暴露给调用方。
 *
 * 两处都放：① 响应体 `fake_gateway` 字段；② HTTP 响应头 `x-fake-gateway-*`（server.mjs 落）。
 * 轨迹里第三次出现（model.request）。企业网关最常见的故障是**吞掉 tools 或降级流式**，
 * 所以这个计数必须在三个地方都能被独立看到——只留一处就会被那一处的实现缺陷掩盖。
 */
export function observabilityMeta(normalized, result) {
  return {
    protocol: PROTOCOL_ID,
    route: normalized.route,
    model: normalized.model,
    tools: normalized.tools.length,
    stream: normalized.stream,
    requestDigest: result.requestDigest,
    marker: RESPONSE_MARKER,
  };
}

/** 响应头形式的同一份元数据（流式 / 非流式都会带上）。 */
export function observabilityHeaders(normalized, result) {
  return {
    "x-fake-gateway-protocol": PROTOCOL_ID,
    "x-fake-gateway-route": normalized.route,
    "x-fake-gateway-model": normalized.model,
    "x-fake-gateway-tools": String(normalized.tools.length),
    "x-fake-gateway-stream": String(normalized.stream),
    "x-fake-gateway-request-digest": result.requestDigest,
  };
}

// ---------------------------------------------------------------------------
// 响应序列化
// ---------------------------------------------------------------------------

/** 响应 id 由请求摘要派生：同一请求永远同一个 id（不用计数器，才能跨进程复现）。 */
function responseId(digest) {
  return `chatcmpl-${digest.slice("sha256:".length, "sha256:".length + 24)}`;
}

/**
 * `created` 固定为 0——**响应载荷里不放时间戳**。
 * 真网关这里放 epoch 秒；假网关要的是 N19 可复现（同请求 ⇒ 逐字节同响应），
 * 所以宁可牺牲这一点点「像」，也不引入一个会让 golden 比对漂移的字段。
 */
const DETERMINISTIC_CREATED = 0;

function assistantMessage(result) {
  const message = { role: "assistant", content: result.content };
  if (result.toolCalls.length) {
    message.tool_calls = result.toolCalls.map((call) => ({
      id: call.id,
      type: "function",
      function: { name: call.name, arguments: call.arguments },
    }));
  }
  return message;
}

/** 中性结果 → OpenAI 非流式响应体。纯数据，可 JSON.stringify 后直接当 HTTP body。 */
export function serializeChatCompletion(normalized, result) {
  return {
    id: responseId(result.requestDigest),
    object: "chat.completion",
    created: DETERMINISTIC_CREATED,
    model: normalized.model,
    choices: [{
      index: 0,
      message: assistantMessage(result),
      finish_reason: result.finishReason,
    }],
    usage: result.usage,
    fake_gateway: observabilityMeta(normalized, result),
  };
}

function sseFrame(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function chunkShell(normalized, result, delta, finishReason) {
  return {
    id: responseId(result.requestDigest),
    object: "chat.completion.chunk",
    created: DETERMINISTIC_CREATED,
    model: normalized.model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

/**
 * 中性结果 → SSE 帧序列（每个元素是一个完整的 `data: …\n\n` 帧，最后追加 `data: [DONE]`）。
 *
 * 帧结构（OpenAI 兼容）：
 *   ① role 帧（带 fake_gateway 元数据：流式请求同样要能看见 tools / stream）
 *   ② content 帧
 *   ③ tool_calls 帧（有工具时；index 从 0 起，按 core 的确定性顺序）
 *   ④ finish 帧（finish_reason 在此出现）
 *   ⑤ data: [DONE]
 *
 * 同样确定性：帧数与每帧内容只取决于规范化请求，客户端连读两次结果一致。
 */
export function serializeChatCompletionStream(normalized, result) {
  const frames = [];
  frames.push(sseFrame({
    ...chunkShell(normalized, result, { role: "assistant", content: "" }, null),
    fake_gateway: observabilityMeta(normalized, result),
  }));
  frames.push(sseFrame(chunkShell(normalized, result, { content: result.content }, null)));
  result.toolCalls.forEach((call, index) => {
    frames.push(sseFrame(chunkShell(normalized, result, {
      tool_calls: [{
        index,
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: call.arguments },
      }],
    }, null)));
  });
  frames.push(sseFrame(chunkShell(normalized, result, {}, result.finishReason)));
  frames.push(SSE_DONE);
  return frames;
}

/** SSE 响应头。server.mjs 写流之前用它，保证 content-type 不会被漏掉。 */
export function streamHeaders() {
  return {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    "connection": "keep-alive",
  };
}

/**
 * 把整段流式响应合成一个字符串。给 selftest 与「不需要真流式」的 client 用；
 * 也保证「流式内容的确定性」是可以被逐字节断言的。
 */
export function serializeChatCompletionStreamText(normalized, result) {
  return serializeChatCompletionStream(normalized, result).join("");
}
