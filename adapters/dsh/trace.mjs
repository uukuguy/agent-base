// ============================================================================
// dsh 轨迹映射：原生事件 → 统一 schema（统一设计 §5.3 / §8.3）
//
// ## 映射源的选择（实测决定）
//
// 该 harness 有两条原生轨迹通道：
//   ① **`--json` 的 run events**（每行一个 JSON）—— 机器可读，**带 callId**，事件种类少而稳
//   ② 会话文件 `$DSH_HOME/sessions/--<cwd>--/<id>/session.v4.jsonl.zstd` —— zstd 压缩 JSONL v4，
//      记录骨架 `{type, seq, time, data}`，type 用 `/` 命名空间；但 `tool/result` **没有 callId**
//
// 本映射器取 **①**：它带 `callId` 可直接配对，且不需要 zstd 解码（少一个依赖、少一处失真）。
// 会话文件留作离线复盘的次要来源（需要时再补，且要显式记录"没有 callId、只能按 step 顺序配对"）。
//
// ## 一对一是硬约束（conformance C7）
//
// 输入多少条原生事件，就输出多少条统一事件；**不许丢弃**（P1 决策）。
// 没有对应类型的记录一律进 `native.raw`，且 `reason` 必须**自足**（不能写"同上"这类废话）。
//
// ## 诚实标注的不对称
//
// **本通道里没有模型请求记录** —— 也就是 dsh 的 run events **不告诉你"实际发出去几个工具/是否流式"**。
// 因此闸门 3 的 tools/stream 断言对本 harness 改从**端点侧**取证（零凭据假网关记录它收到了什么），
// 而不是从轨迹里读。这条差异必须写进 exemptions/trace-mapping，不许假装两边一样。
// ============================================================================

import { digestOf } from "../../core/trace/emit.mjs";

/** `native.raw` 的 reason 必须自足：读的人只看这一条也要明白为什么没映射。 */
const RAW_REASONS = {
  status: "该 harness 的 status 是「相位/用量」通知（turn_start、step_start/end、turn_end + usage），统一 schema 没有对应事件类型；原始记录完整保留在 native 字段里",
  text: "该 harness 的 text 是助手增量文本，统一 schema 没有「助手消息」类型（轨迹只记机械事实，文本正文按 contentMode 决定是否保留）；原始记录完整保留",
  final: "该 harness 的 final 是本次运行的最终答复，统一 schema 没有对应事件类型；原始记录完整保留",
  unknown: "该 harness 出现了一个统一 schema 里没有对应类型的原生事件；按 P1「不许丢弃」保留原始记录",
};

/**
 * @param {object[]} records  原生 run events（每行一个对象）
 * @param {object} ctx        { run, agent, harness, harnessVersion, effectiveConfigDigest, mode, contentMode }
 * @param {{arrivals?: number[]}} [opts] 各记录的到达时刻（毫秒）；原生事件**没有时间戳**，只能这样估
 * @returns {{events: object[], stats: {dropped: number, byType: Record<string, number>}}}
 */
export function mapEventStream(records, ctx, opts = {}) {
  const events = [];
  const byType = {};
  const arrivals = opts.arrivals ?? [];
  const toolByCallId = new Map();
  let seq = 0;

  const base = (record, i) => ({
    // 原生事件没有时间戳 ⇒ 用到达时刻估算，并明确标注是估算值
    ts: new Date(arrivals[i] ?? opts.now ?? Date.now()).toISOString(),
    seq: seq++,
    // 本运行时这条路径是**事后**从会话文件映射的（钩子/插件当场发出的那条由写入器标 hook）
    emitter: "post-hoc",
    run: ctx.run,
    effectiveConfigDigest: ctx.effectiveConfigDigest,
    ...(ctx.agent ? { agent: ctx.agent } : {}),
  });
  const done = (e) => { events.push(e); byType[e.type] = (byType[e.type] ?? 0) + 1; return e; };

  records.forEach((r, i) => {
    switch (r?.type) {
      case "session":
        done({ ...base(r, i), type: "run.meta", mode: ctx.mode ?? "oneshot", contentMode: ctx.contentMode ?? "digest" });
        return;

      case "tool_call": {
        // 原生带 callId，可直接配对（这一条是本通道优于会话文件的关键）
        const callId = String(r.callId ?? "");
        toolByCallId.set(callId, String(r.tool ?? "unknown"));
        done({
          ...base(r, i),
          type: "tool.call",
          callId,
          tool: String(r.tool ?? "unknown"),
          inputDigest: digestOf(r.input ?? null),   // 只存 digest，不存明文（§8.3）
          // 本通道里看不到审批/阻断的结果 ⇒ 如实写 unobserved，**不写 allow**
          decision: "unobserved",
        });
        return;
      }

      case "tool_result": {
        const callId = String(r.callId ?? "");
        done({
          ...base(r, i),
          type: "tool.result",
          callId,
          // 原生 tool_result **不带工具名** ⇒ 靠 callId 回填（拿不到就如实标 unknown）
          tool: toolByCallId.get(callId) ?? "unknown",
          ok: r.status !== "error",
          ms: 0,
          msIsEstimated: true,   // 原生没有耗时字段（缺口 G2），这里给 0 并标注为估算
          outputDigest: digestOf(r.result ?? null),
        });
        return;
      }

      case "status":
      case "text":
      case "final":
        done({ ...base(r, i), type: "native.raw", nativeType: String(r.type), reason: RAW_REASONS[r.type], raw: r });
        return;

      default:
        done({ ...base(r, i), type: "native.raw", nativeType: String(r?.type ?? "unknown"), reason: RAW_REASONS.unknown, raw: r });
    }
  });

  return { events, stats: { dropped: records.length - events.length, byType } };
}

export const HARNESS_ID = "dsh";
