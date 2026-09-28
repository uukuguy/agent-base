// ============================================================================
// 能力包（bundles）：定义装载 + **运行期选择** + 生效集合（L4 / 设计稿 §2）
//
// ## 为什么单独一个模块
//
// "选包"是**选择型运行期参数**，与环境型参数（端点/凭据/模型名/工作区）**规矩不同**：
//   · 环境型：真值在部署期注入，不进制品；
//   · 选择型：**合法取值集合烤在制品里**（`bundles.available`），运行期只许挑子集；
//     激活集合**必须进证据**（轨迹 + `verify --json` + 生效配置摘要）。
// 混在一起记帐，就会让"我开了 coding 包"这件事**没有证据义务**（而那正是设计稿要防的）。
//
// ## 三条硬判据（本模块负责其中两条）
//
//   ① 写一个不存在的包名 ⇒ **响亮失败**（`parseSelection` 返回 problems，调用方必须判死）
//   ② 激活集合参与生效配置摘要（`bundleDigest`；由调用方喂给 computeEffectiveConfigDigest 的 extra）
//   ③ 期望集合 = 声明 ∩ 当前启用（在 startup 把激活结果**物化进暂存产物**，闸门 2 便天然成立）
//
// ## 一条如实边界
//
// 切换**需要重载/重启会话**（技能与 MCP 的加载点在启动期；两侧实测都做不到无感热插拔）。
// 本模块只做"选择与记账"，**不承诺热插拔**。
// ============================================================================

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import YAML from "yaml";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
export const BUNDLES_PATH = path.join(REPO, "core/catalog/bundles.yaml");

/** 选择型参数的**唯一**环境变量名（设计稿 §2 的 `AGENT_BUNDLES`）。 */
export const BUNDLES_ENV = "AGENT_BUNDLES";

/** 装载包定义（基座能力目录的那一节）。 */
export function loadBundles(file = BUNDLES_PATH) {
  const doc = YAML.parse(fs.readFileSync(file, "utf8"));
  const list = Array.isArray(doc?.bundles) ? doc.bundles : [];
  const categories = new Set((doc?.categories ?? []).map((c) => c.id));
  return { doc, bundles: list, categories, file };
}

/** 默认组合（基座给一套；模板/调用方可覆盖）。planned 的包不得进默认。 */
export function defaultSelection({ bundles }) {
  return bundles.filter((b) => b.default === true && b.planned !== true).map((b) => b.id).sort();
}

export function availableIds({ bundles }) {
  return bundles.map((b) => b.id).sort();
}

/**
 * 解析运行期选择。
 * @param {string|null} raw `AGENT_BUNDLES` 的值：逗号分隔的包名；空/未设 ⇒ 用默认组合
 * @returns {{active: string[], explicit: boolean, problems: string[]}}
 */
export function parseSelection(raw, { bundles }) {
  const available = new Set(availableIds({ bundles }));
  const problems = [];
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) return { active: defaultSelection({ bundles }), explicit: false, problems };

  const wanted = [...new Set(value.split(",").map((s) => s.trim()).filter(Boolean))];
  if (!wanted.length) return { active: defaultSelection({ bundles }), explicit: false, problems };

  for (const name of wanted) {
    if (!available.has(name)) {
      problems.push(`未知的包名「${name}」—— 本次产物允许的包只有：${[...available].sort().join(", ")}`
        + `（写错包名**不许静默忽略**：那会让人以为开了包其实没开）`);
    }
  }
  if (problems.length) return { active: [], explicit: true, problems };
  return { active: wanted.sort(), explicit: true, problems };
}

/** 激活集合的摘要（进生效配置摘要；**同一份产物 + 不同组合 ⇒ 不同摘要**）。 */
export function bundleDigest(active) {
  return `bundles:${[...active].sort().join(",")}`;
}

/** 把激活结果**物化**成"这次运行实际生效的声明"（供 startup 改写暂存产物里的清单）。 */
export function materialize({ manifest, bundles, active }) {
  const byId = new Map(bundles.map((b) => [b.id, b]));
  const chosen = active.map((id) => byId.get(id)).filter(Boolean);
  const refNames = new Set();
  const skillNames = new Set();
  const pluginIds = new Set();
  for (const b of chosen) {
    for (const r of b.refs ?? []) refNames.add(String(r).replace(/@.*$/, ""));
    for (const s of b.skills ?? []) skillNames.add(String(s));
    const perHarness = b.plugins?.[manifest.harness] ?? [];
    for (const p of perHarness) pluginIds.add(String(p));
  }
  // 期望集合 = **声明 ∩ 当前启用**：连接器按 refs 过滤（没开的包不带它的连接器进来）
  const connectors = (manifest.connectors ?? []).filter((c) => refNames.has(c.ref ?? c.serverName ?? c.name));
  const skills = (manifest.declaredSkills ?? []).filter((s) => {
    // 基座不变量技能与智能体自带技能始终在；包里的技能按激活过滤
    const fromBundle = bundles.some((b) => (b.skills ?? []).includes(s));
    return !fromBundle || skillNames.has(s);
  });
  return {
    connectors,
    skills,
    plugins: [...pluginIds].sort(),
    bundles: {
      active: [...active].sort(),
      available: availableIds({ bundles }),
      defaults: defaultSelection({ bundles }),
      digest: bundleDigest(active),
    },
  };
}

/** 给人看的一句话（轨迹与报告共用）。 */
export function describeSelection({ active, explicit }) {
  return `包：${active.length ? active.join(" + ") : "（空）"}${explicit ? "" : "（默认组合）"}`;
}
