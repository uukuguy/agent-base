// ============================================================================
// 基座轨迹扩展（基座不变量 · 进 seed，不进任何智能体的业务层）
//
// 职责：订阅 harness 的 loop 回调，把**实际发生的事**映射成统一轨迹事件。
// 与 `trace.mjs`（事后解析原生事件流）相比，回调式能拿到两样事后拿不到的东西：
//   · `before_provider_request` 的 `event.payload` —— **实际发出去**的请求体（含真实 tools 数组与 stream 标志）
//   · `tool_call` / `tool_result` 的 `toolCallId` —— 可靠的调用配对
//
// ## 回调纪律（因为业务开发层也会叠加回调，见 trace-mapping.md 第五节）
//
//   ① **只订阅，绝不返回值** —— 事件分通知/变换/替换/取消四类；一旦返回值，就可能覆盖或取消业务扩展的意图
//   ② **绝不抛异常** —— 文档明确「`tool_call` handler 失败会**阻断该工具**」；
//      一个写日志的回调把业务工具调用搞挂，是不可接受的反向依赖。所有 handler 体包 try/catch
//   ③ **幂等** —— `session_shutdown` / reload / session exit 会汇聚到同一路径
//   ④ **自己也在 enhancements.yaml 里声明** —— 基座不给自己开后门（闸门 2 的集合断言同样覆盖它）
//
// ## 宁可不写，也不写假的
//
//   · 拿不到 `effectiveConfigDigest` → **一个事件都不发**并响亮提示（不编一个假摘要污染审计）
//   · 观测不到工具判定 → `decision: "unobserved"`，**不写 `allow`**
//     （写 allow 会让审计把「没记录」误读成「放行了」）
//   · 耗时只能推算 → `msIsEstimated: true`（原生事件没有耗时字段，缺口 G2）
// ============================================================================

// 由渲染器从 core/trace/emit.mjs 拷进产物同目录 —— 发射契约只有一处定义
import { TraceWriter, digestOf } from "./_trace-emit.mjs";

const DIGEST = process.env.AGENT_EFFECTIVE_CONFIG_DIGEST ?? "";
const DIGEST_OK = /^sha256:[0-9a-f]{64}$/.test(DIGEST);
const PROVIDER = process.env.AGENT_MODEL_ROUTE ?? undefined;
const CONTENT_MODE = process.env.AGENT_TRACE_CONTENT === "full" ? "full" : "digest";
const RUN_MODE = process.env.AGENT_RUN_MODE ?? "oneshot";
const RUN_ID = process.env.AGENT_RUN_ID ?? `run-${Date.now()}`;

/** 请求侧记下的"我发了 N 个工具 / 是不是流式"，供响应侧对照（中间的网关动没动手脚）。 */
let lastSent = null;
const callStartedAt = new Map();

/** 网关回显工具数/流式标志时用的头名（只有回显了才对照，不回显就什么都不做——不制造假阳性）。 */
const ECHO_HEADERS = ["x-fake-gateway-tools", "x-gateway-tools", "x-agent-base-tools"];
const ECHO_STREAM = ["x-fake-gateway-stream", "x-gateway-stream", "x-agent-base-stream"];

/**
 * 从工具入参里推导"读了哪个技能"。
 *
 * 为什么是推导：原生轨迹里没有"技能"这个事件，只有工具调用。基座按**路径形状**
 * `skills/<名>/SKILL.md` 判定，并把结果标成 `derivation: "path-pattern"` ——
 * 审计看到的名字必须能追到规则，而不是"系统认为"。
 *
 * 逐值扫描（而不是只认 `input.path`）：不同运行时/不同读工具把路径放在哪个字段并不统一，
 * 扫字符串值比猜字段名稳。扫描有界（深度 3、只看前若干键），避免病态输入拖慢回调。
 */
function skillFromInput(input, depth = 0) {
  if (depth > 3 || input === null || input === undefined) return null;
  if (typeof input === "string") {
    const m = /(?:^|[/\\])skills[/\\]([^/\\]+)[/\\]SKILL\.md$/.exec(input.trim());
    return m ? m[1] : null;
  }
  if (Array.isArray(input)) {
    for (const v of input.slice(0, 20)) {
      const r = skillFromInput(v, depth + 1);
      if (r) return r;
    }
    return null;
  }
  if (typeof input === "object") {
    for (const k of Object.keys(input).slice(0, 20)) {
      const r = skillFromInput(input[k], depth + 1);
      if (r) return r;
    }
  }
  return null;
}

function headerOf(headers, names) {
  if (!headers || typeof headers !== "object") return undefined;
  for (const [k, v] of Object.entries(headers)) {
    if (names.includes(String(k).toLowerCase())) return v;
  }
  return undefined;
}

export default function (pi) {
  if (!DIGEST_OK) {
    // 宁可不写：没有生效配置摘要的轨迹无法归因，编一个假的比不写更糟
    process.stderr.write(
      "[agent-base/trace] 缺少合法的 AGENT_EFFECTIVE_CONFIG_DIGEST —— 轨迹扩展不发射任何事件（不编假摘要）。\n",
    );
    return;
  }

  const writer = new TraceWriter({
    run: RUN_ID,
    effectiveConfigDigest: DIGEST,
    agent: process.env.AGENT_NAME ?? null,
    // 声明 id：闸门 3 据此逐条核对「声明的钩子各自留痕」（§23 E2b）
    enhancement: "trace",
    harness: "pi",
    harnessVersion: process.env.AGENT_HARNESS_VERSION ?? null,
    dest: process.env.AGENT_TRACE_DEST || null,
    validate: false, // 形状已在单元/集成自检里覆盖；运行时宁可少一点开销，也绝不因自检失败而阻断业务
  });

  const safe = (fn) => {
    try { fn(); } catch { /* 纪律②：轨迹绝不能影响业务执行，失败就静默丢弃这一条本地记录 */ }
  };

  pi.on("session_start", () => safe(() => {
    writer.write({
      type: "run.meta",
      mode: RUN_MODE,
      contentMode: CONTENT_MODE,
      // 会话身份与"是否续跑"：**来自基座的平台变量**（运行时不给钩子这个信息，实测）——
      // 有了它，"这次运行是在续哪一次"在轨迹里可对（E6 续跑留痕）。
      ...(process.env.AGENT_SESSION_ID ? { session: process.env.AGENT_SESSION_ID } : {}),
      ...(process.env.AGENT_RESUMED === "1" ? { resumed: true } : {}),
      // 能力包（L4）：本次激活集合进轨迹 —— 同一份产物、不同组合 ⇒ 行为不同，证据必须自带组合
      ...(process.env.AGENT_BUNDLES_ACTIVE
        ? { bundles: String(process.env.AGENT_BUNDLES_ACTIVE).split(",").filter(Boolean) }
        : {}),
    });
  }));

  pi.on("before_provider_request", (event) => safe(() => {
    const p = (event && event.payload) || {};
    const tools = Array.isArray(p.tools) ? p.tools.length : 0;
    const stream = p.stream === true;
    lastSent = { tools, stream };
    writer.write({
      type: "model.request",
      tools,
      stream,
      ...(typeof p.model === "string" ? { model: p.model } : {}),
      ...(PROVIDER ? { provider: PROVIDER } : {}),
    });
  }));

  pi.on("after_provider_response", (event) => safe(() => {
    if (!lastSent) return;
    const echoedTools = headerOf(event && event.headers, ECHO_HEADERS);
    const echoedStream = headerOf(event && event.headers, ECHO_STREAM);
    if (echoedTools === undefined && echoedStream === undefined) return; // 不回显就不对照
    const mismatch =
      (echoedTools !== undefined && Number(echoedTools) !== lastSent.tools) ||
      (echoedStream !== undefined && String(echoedStream) !== String(lastSent.stream));
    if (mismatch) {
      // 这就是"网关吞了 tools / 降级流式"的可观测信号 —— 进程内即可发现
      writer.write({
        type: "model.error",
        code: "GATEWAY_REQUEST_ALTERED",
        provider: PROVIDER ?? "unknown",
        message: `发出 tools=${lastSent.tools} stream=${lastSent.stream}，响应头回显 tools=${echoedTools} stream=${echoedStream}`,
      });
    }
  }));

  pi.on("tool_call", (event) => safe(() => {
    const id = String((event && event.toolCallId) ?? "");
    const tool = String((event && event.toolName) ?? "unknown");
    callStartedAt.set(id, Date.now());
    writer.write({
      type: "tool.call",
      callId: id,
      tool,
      // 只存 digest，不存明文（§8.3）
      inputDigest: digestOf(event?.input),
      decision: "unobserved", // 纪律：观测不到就不猜；做决策的扩展应自己上报
    });

    // 技能级事件：从**这次工具调用**的入参路径推导（推导规则见 skillFromInput 的注释）。
    // 观测不到就不发 —— 不发不是"技能没用"，而是"这条轨迹里看不到它"。
    const skill = skillFromInput(event?.input);
    if (skill) {
      writer.write({
        type: "skill.use",
        skill,
        callId: id,
        via: tool,
        derivation: "path-pattern",
      });
    }
  }));

  pi.on("tool_result", (event) => safe(() => {
    const id = String((event && event.toolCallId) ?? "");
    const started = callStartedAt.get(id);
    const estimated = started === undefined ? 0 : Math.max(0, Date.now() - started);
    callStartedAt.delete(id);
    writer.write({
      type: "tool.result",
      callId: id,
      tool: String((event && event.toolName) ?? "unknown"),
      ok: !(event && event.isError),
      ms: estimated,
      msIsEstimated: true, // 缺口 G2：耗时是推算值
      outputDigest: digestOf(event?.content),
    });
  }));

  pi.on("session_shutdown", (event) => safe(() => {
    // **结束标记**：没有它，被掐断的轨迹与正常跑完的轨迹在证据上分不开。
    // reason 用运行时给的原话（实测 shutdown 载荷是 { type, reason }），基座不解释。
    writer.write({
      type: "run.end",
      reason: String((event && event.reason) || "unspecified"),
    });
    callStartedAt.clear(); // 幂等：多条清理路径汇聚到这里都不出错
  }));
}
