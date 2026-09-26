// ============================================================================
// 会话内的**受控容器验证**入口（基座不变量 · 进 seed）：`/verify-container`
//
// 它回答的是"**让 AI 自己把容器验证跑起来，但别把 docker 交给它**"（路线图 §30 A2/A6）：
//
//   ① 先摊开**将要执行的参数**（受控入口的干跑输出：镜像、两处只读挂载、网络 none、根只读…）
//      —— 让人审批一个**具体的东西**，而不是一句承诺
//   ② 走 harness 的**人在环审批**（`ctx.ui.confirm`）：放行 / 拒绝 / **无应答者**
//   ③ 把这次决定记进**统一轨迹**（`approval.decision`）⇒ "谁放行了这次容器验证"可回答
//   ④ 只有放行才去调用**受控入口**（`tools/verify-container.mjs`）—— 本扩展**自己绝不拼 docker 参数**，
//      也拿不到任意 docker 权限：入口的参数表是封闭的（见该工具顶部）
//
// ## 三条纪律
//
//   · **fail-closed**：没有应答者（非交互会话、缺 UI）⇒ 记 `unavailable` 并**放弃**，不许默默跑
//   · **不猜路径**：定义目录/闸门目录来自平台变量（`AGENT_DEFINITION_DIR` / `AGENT_GATES_DIR`）；
//     容器会话里没有定义目录 ⇒ 如实报 `unavailable`（容器里不挂定义，产物是烤进去的）
//   · **绝不抛异常**：命令抛异常对用户是"坏了"；最坏情况只是"这次没跑成"，会话照常
// ============================================================================

import { spawnSync } from "node:child_process";
import { TraceWriter, approvalEvent } from "./_trace-emit.mjs";

const COMMAND = "verify-container";
const DIGEST = process.env.AGENT_EFFECTIVE_CONFIG_DIGEST ?? "";

export default function verifyContainerExtension(pi) {
  // 没有生效配置摘要 ⇒ 不写轨迹（宁可不写，也不写假的 —— 与 trace 扩展同一条纪律）
  const writer = /^sha256:[0-9a-f]{64}$/.test(DIGEST)
    ? new TraceWriter({
        run: process.env.AGENT_RUN_ID ?? `run-${Date.now()}`,
        effectiveConfigDigest: DIGEST,
        agent: process.env.AGENT_NAME ?? null,
        harness: "pi",
        harnessVersion: process.env.AGENT_HARNESS_VERSION ?? null,
        dest: process.env.AGENT_TRACE_DEST || null,
        validate: false,
      })
    : null;

  /** 记一条审批决定。失败静默丢弃这一条本地记录（轨迹绝不能影响审批本身）。 */
  const record = (decision, detail) => {
    if (!writer) return;
    try {
      const { event } = approvalEvent({ decision, subject: `verify-container ${definitionDir ?? "?"}`, answerer, detail });
      if (event) writer.write(event);
    } catch { /* 纪律：写轨迹失败不影响动作 */ }
  };

  const definitionDir = process.env.AGENT_DEFINITION_DIR ?? null;
  const gatesDir = process.env.AGENT_GATES_DIR ?? null;
  let answerer = "none";

  const entry = () => `${gatesDir}/tools/verify-container.mjs`;

  /** 干跑：拿到"将要执行的参数"，让人审具体的东西。 */
  const dryRun = () => {
    const r = spawnSync(process.execPath, [entry(), definitionDir, "--dry-run", "--json"], { encoding: "utf8", timeout: 120000 });
    try { return JSON.parse(r.stdout); } catch { return null; }
  };

  pi.registerCommand(COMMAND, {
    description: "请求在容器里验证当前项目（会先给你看将要执行的参数，再问你放行还是拒绝）",
    handler: async (args, ctx) => {
      const say = (text, level = "info") => {
        try { pi.sendMessage({ customType: "agent-base.verify-container", content: text, display: true }, { triggerTurn: false }); }
        catch { try { ctx.ui.notify(text, level); } catch { /* 非交互 */ } }
      };

      // ---- fail-closed 的前置检查：缺哪一样就如实说，并且**不跑** ----
      if (!definitionDir || !gatesDir) {
        record("unavailable", `缺少 ${!definitionDir ? "AGENT_DEFINITION_DIR" : "AGENT_GATES_DIR"}（容器会话里没有定义目录，属正常）`);
        say(`⚠️ 这次**没有跑**容器验证：缺少 ${!definitionDir ? "定义目录（AGENT_DEFINITION_DIR）" : "闸门目录（AGENT_GATES_DIR）"}。\n`
          + `容器会话里没有定义目录是正常的（产物是烤进去的）——此时请由宿主侧执行 \`make verify-container\`。`, "warn");
        return;
      }

      const plan = dryRun();
      if (!plan) {
        record("unavailable", "受控入口干跑失败（拿不到将要执行的参数）");
        say(`⚠️ 这次**没有跑**：受控入口没能给出将要执行的参数（干跑失败）。请先在宿主上跑 \`make verify-container … DRY=1\` 看原因。`, "error");
        return;
      }

      const mountLines = (plan.mounts ?? []).map((m) => `  · ${m.src} → ${m.dst}（${m.mode}，${m.role}）`).join("\n");
      const brief = [
        `将执行：${plan.image}（arch=${plan.arch}）`,
        `绑定面（全部只读，落点固定）：`,
        mountLines,
        `网络 none · 根只读 · 只有 /tmp 可写 · 能力全丢 · 不允许提权`,
      ].join("\n");

      // ---- 人在环审批：拿不到 UI ⇒ fail-closed ----
      const confirm = ctx?.ui?.confirm;
      if (typeof confirm !== "function") {
        record("unavailable", "当前会话没有可用的审批应答者（非交互）");
        say(`${brief}\n\n⚠️ 当前会话**没有可用的审批应答者**（非交互模式）⇒ 按 fail-closed 放弃，没有执行。`, "warn");
        return;
      }

      let granted = false;
      try {
        answerer = "human";
        granted = await confirm("容器内验证", `${brief}\n\n放行这次验证？`);
      } catch {
        record("unavailable", "审批应答者报错");
        say(`${brief}\n\n⚠️ 审批环节出错 ⇒ 按 fail-closed 放弃，没有执行。`, "error");
        return;
      }

      if (!granted) {
        record("denied", "用户在会话里明确拒绝");
        say(`${brief}\n\n🚫 已拒绝，**没有执行**。这次决定已记进轨迹（\`approval.decision\`）。`);
        return;
      }
      record("granted", `${plan.image} @ ${String(plan.imageDigest ?? "").slice(0, 19)}…`);

      // ---- 放行：**只**调用受控入口（参数表封闭，本扩展不拼 docker 参数） ----
      const run = spawnSync(process.execPath, [entry(), definitionDir, "--json"], { encoding: "utf8", timeout: 1800000 });
      let doc = null;
      try { doc = JSON.parse(run.stdout); } catch { /* 下面按失败报 */ }
      if (!doc) {
        record("granted", "受控入口没有给出可解析结论（看 stderr）");
        say(`▶ 已放行并执行，但拿不到结构化结论（退出码 ${run.status}）：\n${String(run.stderr ?? "").split("\n").slice(-6).join("\n")}`, "error");
        return;
      }

      const steps = (doc.steps ?? []).map((s) => `  ${s.ok ? "✅" : "❌"} ${s.label} —— ${s.verdict}`).join("\n");
      const attr = doc.attribution
        ? `\n\n失败归因：\n${(doc.attribution.items ?? []).map((i) => `  · ${i.id} ⇒ ${i.verdict}`).join("\n")}`
        : "";
      say([
        `▶ 容器内验证（已放行，出处=container，镜像 ${String(doc.imageDigest ?? "").slice(0, 19)}…）`,
        steps,
        doc.usable ? "✅ 可用：容器内四道闸门全过（离线、零凭据、只读绑定）" : `❌ 未通过（退出码 ${run.status}）`,
        `本次未覆盖：${(doc.notCovered ?? []).join(" · ")}`,
      ].join("\n") + attr);
    },
  });
}
