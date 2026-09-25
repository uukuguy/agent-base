#!/usr/bin/env node
// ============================================================================
// 零凭据假网关 · 协议无关核心（统一设计 §6.4 / §2.4）
//
// 本层纪律（§12.1 的目录纪律，同 README.md）：
//   放：把「一次性模型调用」规范化成中性请求，再确定性地生成中性响应结果。
//   不放：HTTP、协议名（openai/anthropic…）、harness 名、任何凭据概念。
//
// 为什么必须纯逻辑：假网关的**唯一价值**是让闸门 3 在零凭据下可跑（N14）。
// 一旦核心沾上 HTTP 或协议细节，协议适配就没法独立演进而核心无法被单测。
// 因此本文件只依赖 node:crypto，不做 I/O、不读环境变量、不用随机数与时间。
//
// 确定性（N19）：同一份规范化请求 ⇒ 逐字节相同的响应载荷。
//   · 响应 id / created 由**请求摘要**派生，不用时间戳、不用自增计数
//   · 工具调用入参由工具 schema 确定性生成（排序后逐字段给占位值）
//   · 唯一的不确定量（ts / run id）只出现在轨迹里，永不进响应体
// ============================================================================

import crypto from "node:crypto";

/** 假网关自身版本。进配置摘要，便于事后归因「当时生效的是哪个假网关」。 */
export const FAKE_GATEWAY_VERSION = "0.1.0";

/** 默认路由名（对应 §6.7 verify 输出与 §8.3 轨迹里的 model.route）。 */
export const DEFAULT_ROUTE = "fake-gateway";

/** 默认模型名。假网关不校验模型名——零配置是它的存在理由。 */
export const DEFAULT_MODEL = "fake-model";

/** 响应正文里的确定性标记：闸门 3 可用它断言「有返回」（§6.4 probe/model）。 */
export const RESPONSE_MARKER = "FAKE_GATEWAY_OK";

/**
 * 请求层错误：带机器可读 code，供协议适配层映射成 HTTP 状态码，
 * 并原样写进轨迹的 model.error（§8.3：路由名写错、请求不合法必须留痕）。
 */
export class FakeGatewayRequestError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "FakeGatewayRequestError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// 摘要与规范化 JSON
// ---------------------------------------------------------------------------

/** 统一的摘要格式：sha256:<64 hex>，与 core/trace/schema.json 的 digest 一致。 */
export function sha256Digest(text) {
  return `sha256:${crypto.createHash("sha256").update(String(text), "utf8").digest("hex")}`;
}

/**
 * 规范化 JSON：对象键排序后序列化。
 *
 * 这是「同一份请求 ⇒ 同一份响应」的地基——普通 JSON.stringify 依赖键的插入顺序，
 * 同一个请求换个字段顺序就会得到不同摘要（也就得到不同响应体），那是不可复现的。
 */
export function canonicalJson(value) {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
}

/** 假网关的确定性配置对象。进配置摘要的只有这些「基座选择」，不含任何凭据。 */
export function gatewayConfig({ route = DEFAULT_ROUTE, model = DEFAULT_MODEL, protocol = "openai" } = {}) {
  return {
    name: "fake-gateway",
    version: FAKE_GATEWAY_VERSION,
    protocol,
    route,
    model,
  };
}

/** 配置摘要 = H(确定性配置)。AGENT_TRACE_DIGEST 未设置时就是它（见 server.mjs）。 */
export function configDigest(config) {
  return sha256Digest(canonicalJson(config));
}

// ---------------------------------------------------------------------------
// 规范化请求
// ---------------------------------------------------------------------------

/** 中性工具定义：只留「名字 + 参数 schema」，其余字段由协议适配层负责消化。 */
function normalizeTool(tool) {
  if (!tool || typeof tool !== "object") {
    throw new FakeGatewayRequestError("BAD_TOOLS", "tools 数组的元素必须是对象");
  }
  const fn = (tool.function && typeof tool.function === "object") ? tool.function : tool;
  const name = typeof fn.name === "string" && fn.name.trim() ? fn.name.trim() : "";
  if (!name) throw new FakeGatewayRequestError("BAD_TOOLS", "tools 元素的 function.name 必须是非空字符串");
  const parameters = (fn.parameters && typeof fn.parameters === "object" && !Array.isArray(fn.parameters))
    ? fn.parameters
    : {};
  return { name, parameters };
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * 协议适配层抽出的「准中性形状」→ 规范化请求。
 *
 * 入参形状（各协议适配层负责把原生请求映射到这里）：
 *   { model, messages, tools?, stream?, route? }
 * 只做**中性**校验：model 必填、messages 必填非空、tools 必须是数组。
 * 不校验模型名、不校验路由、不看任何凭据字段——零凭据是硬需求。
 */
export function normalizeRequest(input, { route = DEFAULT_ROUTE } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new FakeGatewayRequestError("BAD_BODY", "请求体必须是 JSON 对象");
  }
  const model = nonEmptyString(input.model);
  if (!model) throw new FakeGatewayRequestError("MISSING_MODEL", "请求缺少非空 model 字段");

  if (!Array.isArray(input.messages) || input.messages.length === 0) {
    throw new FakeGatewayRequestError("MISSING_MESSAGES", "请求缺少非空 messages 数组");
  }
  const messages = input.messages.map((m) => (m && typeof m === "object" ? m : { role: "user", content: String(m) }));

  const rawTools = input.tools === undefined || input.tools === null ? [] : input.tools;
  if (!Array.isArray(rawTools)) throw new FakeGatewayRequestError("BAD_TOOLS", "tools 必须是数组");
  const tools = rawTools.map(normalizeTool);

  return {
    route: nonEmptyString(input.route) ?? route,
    model,
    messages,
    tools,
    stream: input.stream === true,
  };
}

/** 规范化请求的摘要。响应体内容全部由它派生 ⇒ 同请求同响应。 */
export function requestDigest(normalized) {
  return sha256Digest(canonicalJson(normalized));
}

// ---------------------------------------------------------------------------
// 确定性响应
// ---------------------------------------------------------------------------

/**
 * 由工具 schema 生成确定性占位入参。
 *
 * 目的不是「像真模型」，而是让闸门 3 能断言「工具调用真的回来了」且**可复现**：
 * 键按字典序，值按声明类型给固定占位。永远不引入随机数或时间。
 */
function placeholderFor(schema) {
  const s = (schema && typeof schema === "object") ? schema : {};
  if (Array.isArray(s.enum) && s.enum.length) return s.enum[0];
  const t = Array.isArray(s.type) ? s.type[0] : s.type;
  switch (t) {
    case "integer":
    case "number": return 0;
    case "boolean": return false;
    case "array": return [];
    case "object": return {};
    case "null": return null;
    default: return "fake";
  }
}

function buildToolArguments(parameters) {
  const props = (parameters && typeof parameters === "object" && !Array.isArray(parameters))
    ? parameters.properties
    : null;
  if (!props || typeof props !== "object" || Array.isArray(props)) return {};
  const out = {};
  for (const key of Object.keys(props).sort()) out[key] = placeholderFor(props[key]);
  return out;
}

/**
 * 规范化请求 → 中性响应结果。
 *
 * 返回的是**协议无关**的结果形状；序列化成 OpenAI / Anthropic 响应由适配层负责。
 * `toolCalls` 非空当且仅当请求携带 tools（§6.4：必须能发工具调用，且 tools 计数必须可见）。
 */
export function respond(normalized) {
  const digest = requestDigest(normalized);
  const tools = normalized.tools.length;
  const stream = normalized.stream;

  // 内容里带标记 + 计数，闸门 3 可以直接 grep「有返回」，也可以核对计数。
  const content = `${RESPONSE_MARKER} request=${digest} tools=${tools} stream=${stream}`;

  // 会话终止语义：真实模型在拿到工具结果后会继续说话，而不是无限再发工具调用。
  // 少了这条，任何带工具的运行都会无限循环（实测：pi 连发 1184 次请求），
  // 于是闸门 3/4 的探针永远不收敛 —— 一个不会结束的假端点没法用来验证。
  const alreadyHasToolResult = (normalized.messages ?? []).some(
    (m) => m && (m.role === "tool" || (Array.isArray(m.content) && m.content.some((c) => c && c.type === "tool_result"))),
  );

  const toolCalls = tools > 0 && !alreadyHasToolResult
    ? [{
        id: `call_${digest.slice("sha256:".length, "sha256:".length + 24)}`,
        name: normalized.tools[0].name,
        arguments: canonicalJson(buildToolArguments(normalized.tools[0].parameters)),
      }]
    : [];

  // token 数由内容长度确定性推导：不调用 tokenizer，也不引入随机性。
  const promptTokens = Math.max(1, Math.ceil(canonicalJson(normalized.messages).length / 4));
  const completionTokens = Math.max(1, Math.ceil(content.length / 4));

  return {
    requestDigest: digest,
    content,
    toolCalls,
    finishReason: toolCalls.length ? "tool_calls" : "stop",
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
}

/** 一步到位：规范化 + 生成结果。协议适配层用它，selftest 也用它。 */
export function handleNormalizedRequest(input, options) {
  const normalized = normalizeRequest(input, options);
  return { normalized, result: respond(normalized) };
}
