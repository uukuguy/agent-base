// ============================================================================
// 能力包（L4 / B1）自检：选择型参数的判据 —— 未知包名、默认组合、物化过滤、摘要
//
// 判据来自账本 B1：① 同一份定义 + 不同组合 ⇒ **行为不同且各自标明组合**
// ② 不存在的包名 ⇒ **响亮失败**（不静默忽略）③ 期望集合 = 声明 ∩ 当前启用 ④ 切换可留痕
//
// 用法：node core/bundles/selftest.mjs
// ============================================================================

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  BUNDLES_ENV, availableIds, bundleDigest, defaultSelection, describeSelection,
  loadBundles, materialize, parseSelection,
} from "./index.mjs";
import { enforcePluginSurface } from "./filter.mjs";

let failures = 0;
const check = (name, cond, extra = "") => {
  if (!cond) failures++;
  console.log(`${cond ? "✅" : "❌"} ${name}${cond || !extra ? "" : `\n      ${String(extra).slice(0, 400)}`}`);
};

const loaded = loadBundles();
const available = availableIds(loaded);

console.log("── A. 包定义与默认组合 ──");
check("基座目录里的包都装进来了", available.length >= 2, JSON.stringify(available));
check("默认组合里有验证基线", defaultSelection(loaded).includes("verify-baseline"), JSON.stringify(defaultSelection(loaded)));
check("`coding` **不在**默认组合里（验证要纯净）", !defaultSelection(loaded).includes("coding"), JSON.stringify(defaultSelection(loaded)));
check("planned 的包不进默认组合", !defaultSelection(loaded).includes("browser"), JSON.stringify(defaultSelection(loaded)));

console.log("── B. 运行期选择：未知包名必须响亮失败 ──");
{
  const none = parseSelection(null, loaded);
  check("没给选择 ⇒ 用默认组合（并标明是默认）", none.active.length > 0 && none.explicit === false && none.problems.length === 0, JSON.stringify(none));
  const ok = parseSelection("coding", loaded);
  check("给了合法包名 ⇒ 只激活它（不叠加默认）", JSON.stringify(ok.active) === JSON.stringify(["coding"]) && ok.explicit === true, JSON.stringify(ok));
  const multi = parseSelection("coding, verify-baseline", loaded);
  check("多个包名（带空格）⇒ 都激活且排序稳定", JSON.stringify(multi.active) === JSON.stringify(["coding", "verify-baseline"]), JSON.stringify(multi));
  const dup = parseSelection("coding,coding", loaded);
  check("重复包名 ⇒ 去重", JSON.stringify(dup.active) === JSON.stringify(["coding"]), JSON.stringify(dup));
  const bad = parseSelection("coding,typo-bundle", loaded);
  check("**未知包名 ⇒ problems 非空、active 为空**（不静默忽略、不「部分生效」）",
    bad.problems.length === 1 && bad.active.length === 0 && /未知的包名/.test(bad.problems[0]), JSON.stringify(bad));
  check("错误信息里列出**允许的包名**（让人一眼改对）", available.every((n) => bad.problems[0].includes(n)), bad.problems[0]);
}

console.log("── C. 物化：期望集合 = 声明 ∩ 当前启用 ──");
{
  const fakeManifest = {
    harness: "h1",   // 中立占位：core/ 不许出现运行时名（闸门 1 的 core/harness-name 会查）
    connectors: [{ serverName: "filesystem", ref: "filesystem" }, { serverName: "playwright", ref: "playwright" }],
    declaredSkills: ["always-here", "code-navigation"],
  };
  const base = materialize({ manifest: fakeManifest, bundles: loaded.bundles, active: ["verify-baseline"] });
  check("验证基线：**不含** coding 包里的连接器", base.connectors.length === 0, JSON.stringify(base.connectors));
  const coding = materialize({ manifest: fakeManifest, bundles: loaded.bundles, active: ["coding"] });
  check("开了 coding：filesystem 进来、playwright（别的包）不进来",
    coding.connectors.map((c) => c.ref).join(",") === "filesystem", JSON.stringify(coding.connectors));
  check("两个组合的**期望集合确实不同**（这就是「行为不同」的结构面）",
    JSON.stringify(base.connectors) !== JSON.stringify(coding.connectors));
  check("物化结果里带上激活集合与可用集合（证据自带组合）",
    coding.bundles.active.join(",") === "coding" && coding.bundles.available.length === available.length, JSON.stringify(coding.bundles));
  check("摘要随组合变（同一产物、不同组合 ⇒ 不同摘要）", bundleDigest(["coding"]) !== bundleDigest(["verify-baseline"]));
  check("摘要与顺序无关（同集合同摘要）", bundleDigest(["coding", "verify-baseline"]) === bundleDigest(["verify-baseline", "coding"]));
  check("不该被过滤的技能留下（没有包拥有它）", coding.skills.includes("always-here"), JSON.stringify(coding.skills));
}

console.log("── D. 可读描述（轨迹与 `verify --json` 共用同一句话）──");
{
  check("默认组合的措辞标明「默认」", /默认组合/.test(describeSelection({ active: ["verify-baseline"], explicit: false })));
  check("显式组合不带「默认」", !/默认组合/.test(describeSelection({ active: ["coding"], explicit: true })));
  check("空组合也能说清（不产出空字符串）", describeSelection({ active: [], explicit: true }).length > 0);
}

console.log("── E. 一条如实边界：**不承诺热插拔**（写在代码里，别让契约跑偏）──");
{
  const src = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "index.mjs"), "utf8");
  check("模块里写明「切换需重载/重启、不承诺热插拔」", /不承诺热插拔/.test(src) && /重载\/重启/.test(src));
  check("选择型参数有唯一的环境变量名（与环境型参数分开记账）", BUNDLES_ENV === "AGENT_BUNDLES");
}

// ---------------------------------------------------------------------------
// F. 插件落点（L4/C5）：只摘"属于未激活包"的那些，不属于任何包的照留
// ---------------------------------------------------------------------------
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plug-surface-"));
  const file = path.join(dir, "settings.json");
  const seed = () => fs.writeFileSync(file, JSON.stringify({
    packages: [{ source: "base-mcp-adapter", skills: [] }, { source: "plugin-of-b", skills: [] }],
  }, null, 2) + "\n");
  const surface = { path: "settings.json", kind: "json-packages", field: "packages" };
  seed();
  const r1 = enforcePluginSurface({ runDir: dir, surface, ownedSources: ["plugin-of-b"], keepSources: [] });
  const after1 = JSON.parse(fs.readFileSync(file, "utf8")).packages.map((x) => x.source);
  check("未激活包的插件被摘掉，不属于任何包的照留",
    r1.removed.includes("plugin-of-b") && after1.includes("base-mcp-adapter") && !after1.includes("plugin-of-b"),
    JSON.stringify({ removed: r1.removed, after: after1 }));
  seed();
  const r2 = enforcePluginSurface({ runDir: dir, surface, ownedSources: ["plugin-of-b"], keepSources: ["plugin-of-b"] });
  check("激活包的插件留下（enforced 且没摘）", r2.enforced && r2.removed.length === 0, JSON.stringify(r2));
  check("没声明插件落点 ⇒ enforced=false 并说明（不假装摘过）",
    enforcePluginSurface({ runDir: dir, surface: null }).enforced === false,
    enforcePluginSurface({ runDir: dir, surface: null }).note);
  check("未知格式 ⇒ enforced=false（不猜格式）",
    enforcePluginSurface({ runDir: dir, surface: { path: "settings.json", kind: "unknown-kind" } }).enforced === false);
  fs.rmSync(dir, { recursive: true, force: true });
}

void os; void fs;

console.log("");
if (failures) {
  console.log(`❌ 能力包自检：失败 ${failures} 项`);
  process.exit(1);
}
console.log("✅ 能力包自检：全绿");
