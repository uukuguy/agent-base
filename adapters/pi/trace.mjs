#!/usr/bin/env node
// ============================================================================
// pi 适配器 · trace（统一设计 §5.3 SPI、§8.3）
//
// 职责：把 harness 的**原生事件流**映射成统一轨迹（`core/trace/schema.json`）。
// 规格见 `trace-mapping.md`，本文件是它的实现。
//
// 三条纪律：
//   ① **不许丢事件** —— 映射不了就输出 `native.raw` 并写明 reason（P1 决策）。
//      丢掉的往往正是排障最需要的那条。
//   ② **不许把推算值当实测值** —— 原生事件没有耗时字段（缺口 G2），算出来的 ms 必须带
//      `msIsEstimated: true`。
//   ③ **不许假装知道了不知道的事** —— 原生流里没有 wire 级的 tools 计数与 stream 标志
//      （缺口 G1）。这里给的 `tools` 是 **harness 侧声明的工具数**，`stream` 由是否出现
//      增量块推断；两者都不是发往端点那一份。要验网关有没有吞 tools，只能靠链路观测。
//
// 用法：
//   node adapters/pi/trace.mjs --in <原生事件 JSONL> --out <统一轨迹 JSONL> --ctx <ctx.json>
//   （--out 省略则写 stdout；--ctx 提供 run / effectiveConfigDigest / definitionDigest 等）
//
// 退出码：0 成功 / 2 用法错误 / 10 输入不可解析。
// ============================================================================

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EXIT_CODES, sha256 } from "../../core/gates/index.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 统一 schema 里没有对应形状、因而必须走 native.raw 的原生事件（写明理由）。 */
const NATIVE_RAW_REASONS = {
  agent_start: "统一 schema 无 run 生命周期事件类型（run.meta 已表达运行开始）",
  agent_end: "统一 schema 无 run 生命周期事件类型",
  agent_settled: "统一 schema 无 run 生命周期事件类型",
  turn_start: "统一 schema 无 turn 粒度事件类型",
  turn_end: "统一 schema 无 turn 粒度事件类型",
  message_start: "消息生命周期由 model.request / tool.* 表达；非 assistant 或不含可映射信息时保留原样",
  // reason 必须**自解释**：轨迹文件的读者看不到"同上"，所以这里不能偷懒写"同上"
  message_end: "消息本体不单独映射（内容由 contentMode 与会话文件承载）；保留原始记录以便回溯角色与停止原因",
  message_update: "增量块（text/thinking delta）尚无统一事件类型；需要内容可视化时应先扩展 schema，而不是悄悄丢弃",
  queue_update: "统一 schema 无队列事件类型",
  entry_appended: "扩展自定义会话条目，统一 schema 无对应类型",
  session_info_changed: "统一 schema 无会话元信息变更事件",
  thinking_level_changed: "统一 schema 无该事件类型（但它正是 F5 静默钳位检测的依据，值得后续升格为正式类型）",
  compaction_start: "统一 schema 无压缩事件类型",
  compaction_end: "统一 schema 无压缩事件类型",
  auto_retry_start: "统一 schema 无重试事件类型",
  auto_retry_end: "统一 schema 无重试事件类型",
  summarization_retry_scheduled: "统一 schema 无重试事件类型",
  summarization_retry_attempt_start: "统一 schema 无重试事件类型",
};

const isoOf = (rec) => {
  if (typeof rec?.timestamp === "string") return rec.timestamp;                       // session 头
  if (typeof rec?.message?.timestamp === "number") return new Date(rec.message.timestamp).toISOString();
  if (typeof rec?.timestamp === "number") return new Date(rec.timestamp).toISOString();
  return null;
};

/**
 * 映射一条原生事件流。
 * @param {object[]} records  原生 JSONL 记录
 * @param {object} ctx        {run, effectiveConfigDigest, agent, harness, harnessVersion, definitionDigest, mode, contentMode}
 * @param {{arrivals?: number[]}} [opts]  arrivals[i] = 第 i 条记录的到达时刻（epoch ms）。
 *        现场流水线能提供它，于是 `ms` 是真实推算值；离线解析文件时拿不到，ms 记 0 并标注推算。
 * @returns {{events: object[], stats: object}}
 */
export function mapEventStream(records, ctx, opts = {}) {
  const events = [];
  const stats = { input: records.length, mapped: 0, nativeRaw: 0, dropped: 0 };
  let seq = 0;
  let lastTs = null;
  let toolsAddedCount = 0;
  let currentRequest = null;      // assistant message 累积信息
  let deltaSeen = false;
  const toolStartAt = new Map();

  const push = (rec, event) => {
    const ts = isoOf(rec) ?? lastTs ?? new Date(0).toISOString();
    lastTs = ts;
    events.push({
      ts,
      seq: seq++,
      run: ctx.run,
      agent: ctx.agent,
      harness: ctx.harness,
      harnessVersion: ctx.harnessVersion,
      effectiveConfigDigest: ctx.effectiveConfigDigest,
      ...event,
    });
  };

  records.forEach((rec, i) => {
    const arrival = opts.arrivals?.[i];

    // ---- 会话头 → run.meta ----
    if (rec.type === "session") {
      push(rec, {
        type: "run.meta",
        mode: ctx.mode ?? "oneshot",
        contentMode: ctx.contentMode ?? "digest",
        ...(ctx.definitionDigest ? { definitionDigest: ctx.definitionDigest } : {}),
      });
      stats.mapped++;
      return;
    }

    // ---- 工具集合（harness 侧声明的工具数；注意不是 wire 级计数，缺口 G1）----
    if (rec.message?.toolsAdded) {
      toolsAddedCount = rec.message.toolsAdded.length;
    }

    // ---- assistant 消息：开始累积，结束产出 model.request ----
    if (rec.type === "message_start" && rec.message?.role === "assistant") {
      currentRequest = { provider: rec.message.provider, model: rec.message.model, api: rec.message.api };
      deltaSeen = false;
      push(rec, {
        type: "model.request",
        route: rec.message.provider ?? "unknown",
        model: rec.message.model ?? "unknown",
        tools: toolsAddedCount,
        stream: false, // 尚不知；在 message_end 处按是否见到增量块修正
      });
      // 修正：先占位，message_end 时更新
      currentRequest.eventIndex = events.length - 1;
      stats.mapped++;
      return;
    }

    if (rec.type === "message_update") {
      const t = rec.assistantMessageEvent?.type;
      if (t === "text_delta" || t === "thinking_delta" || t === "toolcall_delta") deltaSeen = true;
      if (t === "error") {
        push(rec, { type: "model.error", code: String(rec.assistantMessageEvent.reason ?? "PROVIDER_ERROR"), route: currentRequest?.provider ?? "unknown" });
        stats.mapped++;
        return;
      }
    }

    if (rec.type === "message_end" && rec.message?.role === "assistant") {
      if (currentRequest && currentRequest.eventIndex !== undefined) {
        events[currentRequest.eventIndex].stream = deltaSeen;   // 推断值：见到增量块即流式
      }
      currentRequest = null;
      stats.nativeRaw++;   // 消息本体不单独映射（内容走 contentMode / 会话文件）
      push(rec, { type: "native.raw", nativeType: rec.type, reason: NATIVE_RAW_REASONS.message_end, raw: { role: rec.message.role, stopReason: rec.message.stopReason ?? null } });
      return;
    }

    // ---- 工具执行 ----
    if (rec.type === "tool_execution_start") {
      if (arrival !== undefined) toolStartAt.set(rec.toolCallId, arrival);
      push(rec, {
        type: "tool.call",
        callId: rec.toolCallId,
        tool: rec.toolName,
        inputDigest: sha256(JSON.stringify(rec.args ?? {})),   // 只存 digest，不存明文（§8.3）
        decision: "allow",                                     // 缺口 G3：原生无审批字段，执行了即放行（进 exemptions）
      });
      stats.mapped++;
      return;
    }

    if (rec.type === "tool_execution_end") {
      const startedAt = toolStartAt.get(rec.toolCallId);
      const est = arrival !== undefined && startedAt !== undefined ? arrival - startedAt : 0;
      push(rec, {
        type: "tool.result",
        callId: rec.toolCallId,
        tool: rec.toolName,
        ok: !rec.isError,
        ms: Math.max(0, est),
        msIsEstimated: true,                                   // 缺口 G2：耗时是推算值
        outputDigest: sha256(JSON.stringify(rec.result ?? {})),
      });
      stats.mapped++;
      return;
    }

    // ---- 其余：兜底，绝不丢弃 ----
    push(rec, {
      type: "native.raw",
      nativeType: String(rec.type ?? "unknown"),
      reason: NATIVE_RAW_REASONS[rec.type] ?? "统一 schema 尚无对应形状（上游可能新增了事件类型）",
      raw: rec,
    });
    stats.nativeRaw++;
  });

  // 自证：进来多少条，出去多少条（不许丢）
  const expected = stats.mapped + stats.nativeRaw;
  stats.dropped = records.length - expected;
  return { events, stats };
}

// ---------------------------------------------------------------------------
function main() {
  const args = process.argv.slice(2);
  const val = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
  if (args.includes("--help") || args.includes("-h")) {
    process.stderr.write("用法: node adapters/pi/trace.mjs --in <原生 JSONL> [--out <统一轨迹 JSONL>] [--ctx <ctx.json>]\n");
    process.exit(EXIT_CODES.ok);
  }
  const inFile = val("--in");
  if (!inFile) {
    process.stderr.write("用法: node adapters/pi/trace.mjs --in <原生 JSONL> [--out <统一轨迹 JSONL>] [--ctx <ctx.json>]\n");
    process.exit(EXIT_CODES.usage);
  }
  const ctxFile = val("--ctx");
  const ctx = ctxFile ? JSON.parse(fs.readFileSync(ctxFile, "utf8")) : {};
  ctx.harness = ctx.harness ?? "pi";
  ctx.run = ctx.run ?? `run-${Date.now()}`;

  let records;
  try {
    records = fs.readFileSync(inFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch (e) {
    process.stderr.write(`❌ 输入不可解析：${e.message}\n`);
    process.exit(EXIT_CODES.static);
  }

  const { events, stats } = mapEventStream(records, ctx);
  const out = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  const outFile = val("--out");
  if (outFile) fs.writeFileSync(outFile, out);
  else process.stdout.write(out);

  process.stderr.write(`映射完成：输入 ${stats.input} → 统一 ${events.length}（直接映射 ${stats.mapped}，native.raw ${stats.nativeRaw}，丢弃 ${stats.dropped}）\n`);
  if (stats.dropped !== 0) {
    process.stderr.write("❌ 有事件被丢弃 —— 违反 P1 决策（不许丢）\n");
    process.exit(EXIT_CODES.static);
  }
  process.exit(EXIT_CODES.ok);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
