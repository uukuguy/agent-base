// ============================================================================
// 会话内项目自省命令（基座不变量 · 本运行时侧）：`/project`
//
//   与另一个运行时的同名命令**同一套判据、同一份逻辑**：
//   · 自省逻辑在 `core/introspect/project-info.mjs`（运行时无关，渲染器拷进同目录）
//   · 产物读法由 `_project-layout.mjs` 提供（本运行时的 profile 形状）
//   · 本文件只做"把结果交回会话"这一层
//
// ## 一处**如实声明**的不对称（写进 `adapters/dsh/exemptions.yaml`）
//
// 另一个运行时的命令带**动态补全**（`getArgumentCompletions` ⇒ "补全列表就是项目信息的目录"）。
// 本运行时的命令注册接口只提供 `input.hint`（一句话提示），**没有动态补全回调**
// ⇒ 这里把分类清单写进 hint 作为最接近的等价物，并在豁免里声明"做不到"（不假装等价）。
//
// ## 两条纪律（与另一个侧一致）
//
//   · 读不到产物 ⇒ **响亮失败**，不给半份报告（半真清单比没有更坏）
//   · 绝不抛异常：命令抛异常对用户是"坏了"，最坏情况只是"读不到"
// ============================================================================

import fs from "node:fs";

import { collect, render, renderIndex, CATEGORIES } from "./_project-info.mjs";
import { projectLayout } from "./_project-layout.mjs";

const readJson = (file) => {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
};

export const name = "agent-base-project-info";
export const inject = ["commands"];

const DIGEST = process.env.AGENT_EFFECTIVE_CONFIG_DIGEST ?? "";

/** 从产物根 + 布局推出"从哪儿读事实"（各运行时的形状不同，由布局回答）。 */
export function contextFromEnv(env = process.env, readJson) {
  const artifactDir = env.AGENT_ARTIFACT_DIR ?? null;
  const manifest = artifactDir ? readJson(`${artifactDir}/render-manifest.json`) : null;
  const productDir = manifest && typeof projectLayout.configDir === "function"
    ? projectLayout.configDir({ artifact: artifactDir, env: manifest.runtimePlan?.env ?? {}, agent: manifest.agent })
    : null;
  return { artifactDir, manifest, productDir };
}

export function apply(ctx) {
  ctx.commands.register({
    definitionId: "agent-base.project-info",
    name: "project",
    description: "查看当前项目的真实信息（技能/连接器/增强/钩子事件/模型/轨迹/可移植性/验证计划）",
    // 本运行时的接口只有"提示"，没有动态补全 ⇒ 把分类清单放在这里（最接近的等价物）
    input: { hint: `分类：${CATEGORIES.map((c) => c.name).join(" | ")}（留空看分类目录）` },
    handler: ({ rawInput }) => {
      const { artifactDir, manifest, productDir } = contextFromEnv(process.env, readJson);
      void manifest;
    const facts = collect({ productDir, artifactDir, gatesDir: process.env.AGENT_GATES_DIR ?? null, layout: projectLayout });

    // 读不到产物 ⇒ 响亮失败，不给半份报告
    if (facts.problems.length) {
      return {
        kind: "error",
        text: `读不到这个项目的产物，因此无法报告（不猜）：\n`
          + facts.problems.map((p) => `· ${p}`).join("\n")
          + `\n提示：本命令要在**已渲染的产物**里跑（会话进入时会设置产物目录）。`,
      };
    }

    const category = String(rawInput ?? "").trim().split(/\s+/)[0] ?? "";
    const known = CATEGORIES.map((c) => c.name);
    if (category && category !== "all" && !known.includes(category)) {
      return { kind: "error", text: `未知分类「${category}」—— 可用：${known.join(" | ")}` };
    }
    const body = category && category !== "all" ? render(category, facts) : renderIndex(facts);
    const text = category && category !== "all" ? `/project ${category}\n\n${body}` : body;
      return { kind: "success", text };
    },
  });
}
