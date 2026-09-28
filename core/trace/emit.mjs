// ============================================================================
// 业务级 logger —— 业务打日志，日志落进统一轨迹
//
// ## 一句话
//
// 它就是一个 logger。业务方不需要学什么新协议：
//
//     import { createLogger } from "<基座>/core/trace/emit.mjs";
//     const log = createLogger({ namespace: "contract", run, effectiveConfigDigest });
//
//     log.info("合同扫描完成", { clauses: 12 });
//     log.warn("金额超阈值，转法务复核", { amount: 1200000, threshold: 1000000 });
//     log.error("工单系统不可达", { server: "jira" });
//
// 区别只有一个：它的输出**落进统一轨迹**（JSONL），而不是散在某处文本里。
// 于是「业务判断这一步」在轨迹上显形，事后能回答"为什么走了法务复核"。
//
// ## 为什么是 logger 而不是自创协议
//
// 心智负担。业务方已经会打日志；发明一套"业务事件协议"只会让人先学一遍新东西，
// 然后因为麻烦而干脆不打 —— 那轨迹就永远只有机械语义。
// 熟悉的形状（namespace + level + message + fields）才是会被真正用起来的东西。
//
// ## 层次纪律
//
// 本文件**不懂任何业务语言**：namespace、message、字段值全部原样透传，基座不解释。
// level 是通用的（debug/info/warn/error），不是业务词汇。
// ============================================================================

import fs from "node:fs";
import { createHash } from "node:crypto";

/** 本地实现，避免 emit.mjs 依赖基座其它模块 —— 它会被**原样拷进智能体产物**（见各适配器的 seed 目录）。 */
const sha256 = (text) => `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;

/** 日志级别（通用，与任何业务无关）。 */
export const LEVELS = Object.freeze(["debug", "info", "warn", "error"]);

const NAMESPACE_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;
const SCALAR = new Set(["string", "number", "boolean"]);

/**
 * 构造一条业务日志事件。纯函数，便于单测与先构造后决定。
 * @returns {{event: object|null, problems: string[]}}
 */
export function logEvent(namespace, level, message, data = {}) {
  const problems = [];
  if (typeof namespace !== "string" || !NAMESPACE_RE.test(namespace)) {
    problems.push(`namespace 必须是点分小写标识（如 contract 或 contract.amount），收到：${JSON.stringify(namespace)}`);
  }
  if (!LEVELS.includes(level)) problems.push(`level 必须是 ${LEVELS.join(" | ")} 之一，收到：${JSON.stringify(level)}`);
  if (typeof message !== "string" || !message.trim()) problems.push("message 必须是非空字符串（这条日志说了什么）");
  if (typeof message === "string" && message.length > 2000) problems.push("message 过长（>2000）");
  for (const [k, v] of Object.entries(data)) {
    if (!SCALAR.has(typeof v)) problems.push(`data.${k} 必须是标量（string/number/boolean）——日志字段要可 diff、可渲染成表格`);
    if (typeof v === "string" && v.length > 2000) problems.push(`data.${k} 过长（>2000）`);
  }
  if (problems.length) return { event: null, problems };
  return { event: { type: "biz.event", namespace, level, message, ...(Object.keys(data).length ? { data } : {}) }, problems: [] };
}

/**
 * 构造一条**审批决定**事件（人在环）。纯函数，便于先构造再决定要不要落盘。
 *
 * 为什么要有专门的事件类型：只记一句 `allow` 回答不了"**谁**放行了这次调用"。
 * 有的运行时有原生审批事件、另一个原先没有对应物 —— 这正是既有的不对称
 * （见各适配器 `exemptions.yaml` 里那条 `approval-trace-available`）；本事件给两边一个共同落点。
 *
 * `unavailable` = **没有可用的应答者**（非交互会话等）。它按 **fail-closed** 语义处理：
 * 调用方必须放弃这次动作，不许默默继续。
 */
export function approvalEvent({ decision, subject, answerer, detail } = {}) {
  const problems = [];
  if (!["granted", "denied", "unavailable"].includes(decision)) {
    problems.push(`decision 必须是 granted | denied | unavailable，收到：${JSON.stringify(decision)}`);
  }
  if (typeof subject !== "string" || !subject.trim()) problems.push("subject 必须是非空字符串（被审批的动作 + 可归因身份）");
  if (typeof answerer !== "string" || !answerer.trim()) problems.push("answerer 必须是非空字符串（human | policy | none）");
  if (detail !== undefined && typeof detail !== "string") problems.push("detail 必须是字符串");
  if (problems.length) return { event: null, problems };
  return { event: { type: "approval.decision", decision, subject, answerer, ...(detail ? { detail } : {}) }, problems: [] };
}

/**
 * 受保护的钩子（E7）：把业务钩子的回调包起来，失败**显式留痕**并按声明处置。
 *
 * ## 为什么需要它（实测，不是设计洁癖）
 *
 * 业务钩子抛异常时，运行时**静默吞掉**：本次运行照常退出 0，轨迹里一个字都没有。
 * 于是"钩子写错了"与"钩子没触发"在证据上无法区分 —— 与 D1/D2 是同一类缺陷（配了没生效无人知道）。
 *
 * ## 用法（业务侧只多一层包装，不用学新协议）
 *
 *     import { guardedHook } from "./_trace-emit.mjs";
 *     on("tool_call", guardedHook({ id: "contract-check", event: "tool_call", policy }, () => { ... }));
 *
 * `policy` 来自定义里的 `hooks.onFailure`（渲染器生成 `_hook-policy.mjs`，业务钩子 import 它，不手抄）：
 *   · `record`（默认）—— 记录 `hook.error` 后**继续**：一个业务钩子出错不该让整场会话崩掉
 *   · `block`          —— 记录后**抛出**：要求"钩子失败即运行失败"的场景（审计严格的业务）
 *
 * 两条路都**先留痕**再决定 —— 这是本函数存在的全部意义。
 */
export function guardedHook({ id, event = null, policy = "record", writer = null } = {}, fn) {
  // 默认写入器：业务侧的自然写法是 `guardedHook({id, policy}, fn)`，**不该**要求它自己造写入器。
  // 复用 TraceWriter 与运行期环境（与基座轨迹扩展同一套）—— 于是"留痕"不靠业务记着传参数。
  const sink = writer ?? (() => {
    const w = new TraceWriter({
      run: process.env.AGENT_RUN_ID || "hook-guard",
      effectiveConfigDigest: process.env.AGENT_EFFECTIVE_CONFIG_DIGEST || `sha256:${"0".repeat(64)}`,
      agent: process.env.AGENT_NAME ?? null,
      enhancement: id,
      harness: process.env.AGENT_HARNESS ?? null,
      harnessVersion: process.env.AGENT_HARNESS_VERSION ?? null,
      dest: process.env.AGENT_TRACE_DEST || null,
    });
    return (rec) => w.write(rec);
  })();
  if (typeof fn !== "function") throw new TypeError("guardedHook 需要一个函数");
  if (typeof id !== "string" || !id.trim()) throw new TypeError("guardedHook 需要 declaration id（哪个钩子）");
  if (!["record", "block"].includes(policy)) throw new TypeError(`policy 必须是 record | block，收到 ${policy}`);
  return async (...args) => {
    try {
      return await fn(...args);
    } catch (e) {
      const message = String(e?.message ?? e);
      const stack = typeof e?.stack === "string" ? e.stack.split("\n").slice(0, 6).join("\n").slice(0, 1200) : undefined;
      const rec = { type: "hook.error", enhancement: id, message, policy, ...(event ? { event } : {}), ...(stack ? { stack } : {}) };
      // 留痕优先：写入器坏了也**不许**吞掉原始错误（那时至少让 block 语义生效）
      try { sink(rec); } catch { /* 写入器不可用：下面按 policy 处置，绝不吞掉原始错误 */ }
      if (policy === "block") throw e;
      return undefined;
    }
  };
}

/** 无依赖的形状自检（不引 ajv：业务代码要在任何环境里都能跑）。权威校验仍是 schema.json。 */
export function validateShape(rec) {
  const problems = [];
  for (const k of ["ts", "seq", "run", "type", "effectiveConfigDigest"]) {
    if (rec[k] === undefined) problems.push(`缺公共字段 ${k}`);
  }
  if (rec.ts && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/.test(rec.ts)) problems.push(`ts 必须是以 Z 结尾的 UTC 时间：${rec.ts}`);
  if (rec.effectiveConfigDigest && !/^sha256:[0-9a-f]{64}$/.test(rec.effectiveConfigDigest)) problems.push("effectiveConfigDigest 格式非法");
  if (rec.type === "biz.event") {
    problems.push(...logEvent(rec.namespace, rec.level, rec.message, rec.data ?? {}).problems);
  }
  if (rec.type === "hook.error") {
    if (typeof rec.enhancement !== "string" || !rec.enhancement.trim()) problems.push("hook.error 缺 enhancement（哪个钩子失败了）");
    if (typeof rec.message !== "string" || !rec.message.trim()) problems.push("hook.error 缺 message");
    if (!["record", "block"].includes(rec.policy)) problems.push(`hook.error 的 policy 必须是 record | block，收到 ${rec.policy}`);
  }
  return problems;
}

/**
 * 轨迹写入器：补齐每条事件都必须带的公共字段（ts / seq / run / effectiveConfigDigest）。
 * 适配器与 logger 都走它，保证公共字段只有一处定义。
 */
export class TraceWriter {
  /**
   * @param {{run:string, effectiveConfigDigest:string, agent?:string, harness?:string,
   *          harnessVersion?:string, enhancement?:string, dest?:string|null,
   *          stream?:{write:Function}, validate?:boolean}} opts
   */
  constructor(opts) {
    if (!opts?.run) throw new Error("TraceWriter 需要 run");
    if (!/^sha256:[0-9a-f]{64}$/.test(opts.effectiveConfigDigest ?? "")) {
      throw new Error("TraceWriter 需要合法的 effectiveConfigDigest（sha256:<64 hex>）");
    }
    this.run = opts.run;
    this.effectiveConfigDigest = opts.effectiveConfigDigest;
    this.agent = opts.agent ?? null;
    this.harness = opts.harness ?? null;
    this.harnessVersion = opts.harnessVersion ?? null;
    // **哪个已声明的增强在写**：让闸门 3 能逐条核对"声明的钩子各自留痕"（§23 E2b），
    // 而不是笼统地"有钩子事件就算过"。
    this.enhancement = opts.enhancement ?? null;
    this.dest = opts.dest ?? process.env.AGENT_TRACE_DEST ?? null;
    this.stream = opts.stream ?? process.stderr;
    this.validate = opts.validate !== false; // 默认自检：宁可这里报错，也不让坏事件进审计流
    this.seq = 0;
    this.problems = [];
  }

  /** 写一条事件（自动补 ts / seq / 公共字段）。返回写入的记录，或 null（被自检拦下）。 */
  write(event) {
    const rec = {
      ts: new Date().toISOString().replace(/(\.\d{3})\d*Z$/, "$1Z"),
      seq: this.seq++,
      // 发射者形态：写入器只在**事件发生时由扩展/插件回调**里被调用，
      // 所以它写出的每条事件都标记为 hook（事后映射的路径另行标记 post-hoc）。
      emitter: "hook",
      run: this.run,
      effectiveConfigDigest: this.effectiveConfigDigest,
      ...(this.agent ? { agent: this.agent } : {}),
      ...(this.harness ? { harness: this.harness } : {}),
      ...(this.harnessVersion ? { harnessVersion: this.harnessVersion } : {}),
      ...(this.enhancement ? { enhancement: this.enhancement } : {}),
      ...event,
    };
    if (this.validate) {
      const problems = validateShape(rec);
      if (problems.length) {
        this.problems.push(...problems);
        return null;
      }
    }
    const line = JSON.stringify(rec) + "\n";
    if (this.dest) fs.appendFileSync(this.dest, line);
    else this.stream.write(line);
    return rec;
  }
}

/**
 * 业务级 logger。业务代码只需要这一句：
 *
 *     const log = createLogger({ namespace: "contract", run, effectiveConfigDigest });
 *     log.warn("金额超阈值，转法务复核", { amount: 1200000 });
 */
export function createLogger({ namespace, human = false, ...writerOpts }) {
  const writer = new TraceWriter(writerOpts);
  const emit = (level, message, data) => {
    const { event, problems } = logEvent(namespace, level, message, data);
    if (!event) {
      // 日志写坏了也要说话 —— 静默丢日志正是"轨迹变黑箱"的起点
      writer.problems.push(...problems.map((p) => `logger(${namespace}).${level}：${p}`));
      return null;
    }
    const rec = writer.write(event);
    // human 模式：额外给人读的一行（仍在 stderr，不污染路径无关的产物）
    if (human && rec) {
      const fields = data && Object.keys(data).length ? ` ［${Object.entries(data).map(([k, v]) => `${k}=${v}`).join(", ")}］` : "";
      process.stderr.write(`[${level.toUpperCase()}] ${namespace}: ${message}${fields}\n`);
    }
    return rec;
  };
  return {
    namespace,
    writer,
    debug: (m, d) => emit("debug", m, d),
    info: (m, d) => emit("info", m, d),
    warn: (m, d) => emit("warn", m, d),
    error: (m, d) => emit("error", m, d),
    get problems() { return writer.problems; },
  };
}

/** 内容摘要，供希望按 digest 关联外部工件的业务使用。 */
export const digestOf = (value) => sha256(typeof value === "string" ? value : JSON.stringify(value));
