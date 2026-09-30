// ============================================================================
// 会话内项目自省命令（基座不变量 · 进 seed，不进任何智能体的业务层）
//
//   /project              → 分类目录（避免把所有分类正文一次性叠在一起）
//   /project skills       → 只看某一类
//   /project <Tab>        → **补全**列出分类；再 Tab 补该项目里真实存在的值
//
// 为什么值得常驻：调试时最费时间的不是"改一行看结果"，而是"这个项目现在到底声明了什么、
// 哪一层接管了什么"。这些事实本来就在产物里（渲染清单 + 配置目录），只是没人摊开给你看。
//
// ## 三条纪律
//
//   ① **只读产物，不猜**：读不到就说读不到。这条命令的全部价值在于"说的是真的"。
//   ② **不打印凭据**：产物里只有引用名（`${VAR}`），我们连引用名之外的东西都不碰，
//      也**不读** auth.json（那是登录态，不是项目信息）。
//   ③ **绝不抛异常**：命令抛异常对用户是"坏了"，而这里最坏的情况只是"读不到"——
//      用 notify 说清楚，会话照常。
//
// 数据来源与渲染逻辑在 `_project-info.mjs`（纯逻辑、无运行时依赖）：
// 这样它可以被自检直接 import 断言，也能被将来 dsh 侧的等价入口复用。
// ============================================================================

import { collect, complete, render, renderAll, renderIndex } from "./_project-info.mjs";
// 本运行时的产物读法（渲染器拷进同目录）：自省逻辑运行时无关，读法由各运行时提供
import { projectLayout } from "./_project-layout.mjs";

const COMMAND = "project";

export default function projectInfoExtension(pi) {
  const gather = () =>
    collect({
      productDir: process.env.PI_CODING_AGENT_DIR ?? null,
      artifactDir: process.env.AGENT_ARTIFACT_DIR ?? null,
      gatesDir: process.env.AGENT_GATES_DIR ?? null,
      layout: projectLayout,
    });

  pi.registerCommand(COMMAND, {
    description: "查看当前项目的真实信息（技能/连接器/增强/钩子事件/模型/轨迹）；补全即目录",

    // 补全：一级是分类（"一个项目应该有哪些信息"），二级是该项目里真实存在的值
    getArgumentCompletions: (prefix) => {
      try { return complete(prefix, gather()); } catch { return []; }
    },

    handler: async (args, ctx) => {
      const facts = gather();

      // 读不到产物 ⇒ **响亮失败**，不给半份报告（半真清单比没有更坏：它会让人以为"就这些"）
      if (facts.problems.length) {
        const msg = `读不到这个项目的产物，因此无法报告（不猜）：\n`
          + facts.problems.map((p) => `· ${p}`).join("\n")
          + `\n提示：本命令要在**已渲染的产物**里跑（\`make run-local\` 或容器 entrypoint 均会设置产物目录）。`;
        try { ctx.ui.notify(msg, "error"); } catch { /* 非交互模式没有 UI，忽略 */ }
        return;
      }

      const category = String(args ?? "").trim().split(/\s+/)[0] ?? "";
      const body = category === "all" ? renderAll(facts)
        : category ? render(category, facts) : renderIndex(facts);
      const text = category ? `/${COMMAND} ${category}\n\n${body}` : body;

      try {
        // 送进会话（进记录、可回看、可复制），但**不触发一轮模型调用** —— 查信息不该花钱
        pi.sendMessage({ customType: "agent-base.project-info", content: text, display: true }, { triggerTurn: false });
      } catch (e) {
        try { ctx.ui.notify(text, "info"); }
        catch { ctx.ui.notify(`/project 输出失败：${e instanceof Error ? e.message : String(e)}`, "error"); }
      }
    },
  });
}
