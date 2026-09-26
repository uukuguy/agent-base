// ============================================================================
// 会话内的**受控容器验证**入口（基座不变量 · dsh 侧）：`/verify-container`
//
// 与另一个运行时的同名命令**同一套判据**（路线图 §30 A6）：
//   ① 先摊开**将要执行的参数**（受控入口的干跑输出：镜像、两处只读挂载、网络 none…）
//   ② 走本运行时的**人在环审批**：`ctx.approval.request(...)`（waterfall answerers）
//   ③ 把这次决定记进**统一轨迹**（`approval.decision`）
//   ④ 只有放行才调用**受控入口**（`tools/verify-container.mjs`）—— 本插件**绝不自己拼 docker 参数**
//
// ## 本侧的实测事实（见 docs/design/2026-09-25-dsh-harness-design.md §3.8.1）
//
//   · `ctx.approval.request(req) → 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'`
//     —— **`unavailable` = 没有应答者 ⇒ fail-closed**（与基座的三态语义天然对齐）
//   · **审批审计事件不在我们读的轨迹通道里**（实测：两种权限模式下 `--json` 事件流都是 0 条
//     审批记录，会话文件也只有 session 引导事件）⇒ "谁放行了"只能由**本插件当场写入**，
//     不能指望事后映射。这正是它必须自己写 `approval.decision` 的原因。
//
// ## 纪律（与另一个运行时的扩展一致）
//
//   · fail-closed：没有审批服务 / 没有应答者 / 缺定义目录 ⇒ 记 `unavailable` 并**放弃**
//   · 不猜路径：定义与闸门目录来自平台变量；容器会话里没有定义目录 ⇒ 如实说明并放弃
//   · 绝不抛异常：命令抛异常对用户是"坏了"；最坏只是"这次没跑成"
// ============================================================================

import { spawnSync } from "node:child_process";
import { TraceWriter, approvalEvent } from "./_trace-emit.mjs";

export const name = "agent-base-verify-container";
export const inject = ["commands"];

const DIGEST = process.env.AGENT_EFFECTIVE_CONFIG_DIGEST ?? "";

/**
 * 本运行时的审批结果 → 基座三态（**纯函数**，自检直接断言）。
 * `rejected` / `cancelled` 都算"明确拒绝"；其余（含未知取值）一律 `unavailable` ⇒ fail-closed。
 */
export function mapOutcome(outcome) {
  if (outcome === "allowed-once") return "granted";
  if (outcome === "rejected" || outcome === "cancelled") return "denied";
  return "unavailable";
}

export function apply(ctx) {
  const definitionDir = process.env.AGENT_DEFINITION_DIR ?? null;
  const gatesDir = process.env.AGENT_GATES_DIR ?? null;
  const entry = () => `${gatesDir}/tools/verify-container.mjs`;

  // 没有生效配置摘要 ⇒ 不写轨迹（宁可不写，也不写假的）
  const writer = /^sha256:[0-9a-f]{64}$/.test(DIGEST)
    ? new TraceWriter({
        run: process.env.AGENT_RUN_ID ?? `run-${Date.now()}`,
        effectiveConfigDigest: DIGEST,
        agent: process.env.AGENT_NAME ?? null,
        harness: "dsh",
        harnessVersion: process.env.AGENT_HARNESS_VERSION ?? null,
        dest: process.env.AGENT_TRACE_DEST || null,
        validate: false,
      })
    : null;

  ctx.commands.register({
    definitionId: "agent-base.verify-container",
    name: "verify-container",
    description: "请求在容器里验证当前项目（先给你看将要执行的参数，再等你放行或拒绝）",
    handler: async ({ agent, rawInput, signal }) => {
      const record = (decision, answerer, detail) => {
        if (!writer) return;
        try {
          const { event } = approvalEvent({ decision, subject: `verify-container ${definitionDir ?? "?"}`, answerer, detail });
          if (event) writer.write(event);
        } catch { /* 写轨迹失败不影响审批本身 */ }
      };

      // ---- fail-closed 前置：缺哪样就如实说，且**不跑** ----
      if (!definitionDir || !gatesDir) {
        record("unavailable", "none", `缺少 ${!definitionDir ? "AGENT_DEFINITION_DIR" : "AGENT_GATES_DIR"}（容器会话里没有定义目录，属正常）`);
        return { kind: "error", text: `没有跑容器验证：缺少 ${!definitionDir ? "定义目录（AGENT_DEFINITION_DIR）" : "闸门目录（AGENT_GATES_DIR）"}。`
          + `容器会话里没有定义目录是正常的（产物是烤进去的）——请由宿主侧执行 make verify-container。` };
      }

      const dry = spawnSync(process.execPath, [entry(), definitionDir, "--dry-run", "--json"], { encoding: "utf8", timeout: 120000 });
      let plan = null;
      try { plan = JSON.parse(dry.stdout); } catch { plan = null; }
      if (!plan) {
        record("unavailable", "none", "受控入口干跑失败（拿不到将要执行的参数）");
        return { kind: "error", text: "没有跑：受控入口没能给出将要执行的参数（在宿主上跑 make verify-container … DRY=1 看原因）。" };
      }

      const brief = [
        `将执行：${plan.image}（arch=${plan.arch}）`,
        "绑定面（全部只读，落点固定）：",
        ...(plan.mounts ?? []).map((m) => `  · ${m.src} → ${m.dst}（${m.mode}，${m.role}）`),
        "网络 none · 根只读 · 只有 /tmp 可写 · 能力全丢 · 不允许提权",
      ].join("\n");

      // ---- 人在环审批：拿不到审批服务 ⇒ fail-closed ----
      const approval = typeof ctx.get === "function" ? ctx.get("approval") : null;
      if (!approval || typeof approval.request !== "function") {
        record("unavailable", "none", "当前会话没有可用的审批服务（fail-closed）");
        return { kind: "error", text: `${brief}\n\n当前会话没有可用的审批服务 ⇒ 按 fail-closed 放弃，没有执行。` };
      }

      let outcome;
      try {
        outcome = await approval.request({ agent, toolName: "verify-container", reason: brief, ...(signal ? { signal } : {}) });
      } catch (e) {
        record("unavailable", "none", `审批环节报错：${e?.message ?? String(e)}`);
        return { kind: "error", text: `${brief}\n\n审批环节出错 ⇒ 按 fail-closed 放弃，没有执行。` };
      }

      const decision = mapOutcome(outcome);
      const answerer = decision === "granted" ? "human" : (outcome === "unavailable" ? "none" : "human");
      if (decision !== "granted") {
        record(decision, answerer, `审批结果 ${outcome}`);
        return { kind: "error", text: `${brief}\n\n${decision === "denied" ? "已拒绝" : "无可用应答者（unavailable）"} ⇒ 没有执行。这次决定已记进轨迹（approval.decision）。` };
      }
      record("granted", "human", `${plan.image}（审批结果 ${outcome}）`);

      // ---- 放行：只调用受控入口 ----
      const run = spawnSync(process.execPath, [entry(), definitionDir, "--json"], { encoding: "utf8", timeout: 1800000 });
      let doc = null;
      try { doc = JSON.parse(run.stdout); } catch { doc = null; }
      if (!doc) {
        return { kind: "error", text: `已放行并执行，但拿不到结构化结论（退出码 ${run.status}）：\n${String(run.stderr ?? "").split("\n").slice(-6).join("\n")}` };
      }
      const steps = (doc.steps ?? []).map((s) => `  ${s.ok ? "✅" : "❌"} ${s.label} —— ${s.verdict}`).join("\n");
      const attr = doc.attribution
        ? `\n\n失败归因：\n${(doc.attribution.items ?? []).map((i) => `  · ${i.id} ⇒ ${i.verdict}`).join("\n")}`
        : "";
      return {
        kind: "success",
        text: [
          `▶ 容器内验证（已放行，出处=container，镜像 ${String(doc.imageDigest ?? "").slice(0, 19)}…）`,
          steps,
          doc.usable ? "✅ 可用：容器内四道闸门全过（离线、零凭据、只读绑定）" : `❌ 未通过（退出码 ${run.status}）`,
          `本次未覆盖：${(doc.notCovered ?? []).join(" · ")}`,
        ].join("\n") + attr,
      };
    },
  });
}
