// ============================================================================
// 能力包（L4）：把**未激活包**的内容从暂存产物里真的摘掉
//
// ## 为什么必须真的摘
//
// 不摘的话，"开了 coding 包"只是一句声明：产物里的连接器照样全部加载，
// 闸门 2 的"集合相等"也就变成"什么都相等"。设计稿 §5 要求 **期望集合 = 声明 ∩ 当前启用**。
//
// ## 为什么这里只认"格式"，不认运行时
//
// 摘法绑定**产物形状**。core 不该知道哪个运行时把连接器写在哪 —— 所以由**清单声明**
// 落点与格式（`connectorSurface`：路径 + `kind`），core 按 kind 处理。
// 目前只实现一种 kind（`json-mcp-servers`：一个 JSON 文件里 `mcpServers` 对象）；
// 没有声明 surface 的产物**不摘**，并在启动结果里如实记 `enforced: false`（不假装已生效）。
//
// ## 一条纪律：只改**暂存副本**（产物只读），且把摘掉了谁原样报出来（别静默少一个）。
// ============================================================================

import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

export const CONNECTOR_SURFACE_KINDS = Object.freeze(["json-mcp-servers"]);
export const SKILL_SURFACE_KINDS = Object.freeze(["skill-dirs"]);
export const PLUGIN_SURFACE_KINDS = Object.freeze(["json-packages"]);

/**
 * @param {{runDir: string, surface: object|null, keep: string[]}} args
 * @returns {{enforced: boolean, kind: string|null, kept: string[], removed: string[], file: string|null, note: string}}
 */
export function enforceConnectorSurface({ runDir, surface = null, keep = [] }) {
  if (!surface || !surface.path) {
    return { enforced: false, kind: null, kept: [], removed: [], file: null,
      note: "产物没有声明连接器落点（connectorSurface）⇒ **未摘除**：未激活包的内容仍会加载" };
  }
  if (!CONNECTOR_SURFACE_KINDS.includes(surface.kind)) {
    return { enforced: false, kind: surface.kind ?? null, kept: [], removed: [], file: null,
      note: `未知的连接器落点格式「${surface.kind}」⇒ **未摘除**（不猜格式，也不假装摘过）` };
  }
  const file = path.join(runDir, surface.path);
  if (!fs.existsSync(file)) {
    return { enforced: false, kind: surface.kind, kept: [], removed: [], file,
      note: `连接器落点不存在（${surface.path}）⇒ 本产物没有连接器配置，无需摘除` };
  }
  let doc;
  try { doc = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (e) { return { enforced: false, kind: surface.kind, kept: [], removed: [], file, note: `落点不是合法 JSON：${e.message}` }; }
  const servers = doc && typeof doc.mcpServers === "object" && doc.mcpServers ? doc.mcpServers : {};
  const keepSet = new Set(keep);
  const kept = [];
  const removed = [];
  const next = {};
  for (const [name, cfg] of Object.entries(servers)) {
    if (keepSet.has(name)) { next[name] = cfg; kept.push(name); } else removed.push(name);
  }
  if (removed.length) fs.writeFileSync(file, JSON.stringify({ ...doc, mcpServers: next }, null, 2) + "\n");
  return { enforced: true, kind: surface.kind, kept: kept.sort(), removed: removed.sort(), file,
    note: removed.length ? `按激活集合摘掉了 ${removed.length} 个未激活连接器：${removed.sort().join(", ")}` : "无需摘除（激活集合覆盖了全部连接器）" };
}

/**
 * 技能落点：把**未激活包**带来的技能目录从暂存产物里删掉（与连接器同一套纪律）。
 * 只认格式（`skill-dirs`：目录下每个子目录是一个技能，名字即技能名），不认运行时。
 * @param {{runDir: string, surface: object|null, keep: string[], ownedByBundles?: string[]}} args
 */
export function enforceSkillSurface({ runDir, surface = null, keep = [], ownedByBundles = [] }) {
  if (!surface || !surface.path) {
    return { enforced: false, kind: null, kept: [], removed: [], note: "产物没有声明技能落点（skillSurface）⇒ 未摘除" };
  }
  if (!SKILL_SURFACE_KINDS.includes(surface.kind)) {
    return { enforced: false, kind: surface.kind ?? null, kept: [], removed: [], note: `未知的技能落点格式「${surface.kind}」⇒ 未摘除（不猜格式）` };
  }
  const dir = path.join(runDir, surface.path);
  if (!fs.existsSync(dir)) {
    return { enforced: false, kind: surface.kind, kept: [], removed: [], note: `技能落点不存在（${surface.path}）` };
  }
  const owned = new Set(ownedByBundles);
  const keepSet = new Set(keep);
  const kept = [];
  const removed = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (!fs.statSync(full).isDirectory()) continue;
    // 属于某个包的技能 ⇒ 只有激活了才留；不属于任何包的 ⇒ 智能体自己的，照留
    if (!owned.has(name) || keepSet.has(name)) { kept.push(name); continue; }
    fs.rmSync(full, { recursive: true, force: true });
    removed.push(name);
  }
  return { enforced: true, kind: surface.kind, kept: kept.sort(), removed: removed.sort(), dir,
    note: removed.length ? `按激活集合摘掉了 ${removed.length} 个未激活技能：${removed.sort().join(", ")}` : "无需摘除（激活集合覆盖了全部技能）" };
}

/**
 * 插件落点：把**未激活包**带来的插件（包坐标）从暂存产物里摘掉。
 * 只认格式（`json-packages`：某个 JSON 文件里的字符串/对象数组，按 `source` 比对包坐标）。
 * @param {{runDir: string, surface: object|null, ownedSources: string[], keepSources: string[]}} args
 */
export function enforcePluginSurface({ runDir, surface = null, ownedSources = [], keepSources = [] }) {
  if (!surface || !surface.path) {
    return { enforced: false, kind: null, kept: [], removed: [], note: "产物没有声明插件落点（pluginSurface）⇒ 未摘除" };
  }
  if (!PLUGIN_SURFACE_KINDS.includes(surface.kind)) {
    return { enforced: false, kind: surface.kind ?? null, kept: [], removed: [], note: `未知的插件落点格式「${surface.kind}」⇒ 未摘除（不猜格式）` };
  }
  const file = path.join(runDir, surface.path);
  if (!fs.existsSync(file)) {
    return { enforced: false, kind: surface.kind, kept: [], removed: [], note: `插件落点不存在（${surface.path}）` };
  }
  // 字段支持**点分路径**（各侧把插件列表放在不同深度：一侧是顶层 `packages`，另一侧嵌在 profile 对象里）
  const field = surface.field ?? "packages";
  const keys = String(field).split(".");
  let doc;
  try { doc = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (e) { return { enforced: false, kind: surface.kind, kept: [], removed: [], note: `落点不是合法 JSON：${e.message}` }; }
  const parent = keys.slice(0, -1).reduce((acc, k) => (acc == null ? acc : acc[k]), doc);
  const leaf = keys[keys.length - 1];
  const list = parent && Array.isArray(parent[leaf]) ? parent[leaf] : null;
  if (!list) return { enforced: false, kind: surface.kind, kept: [], removed: [], note: `落点里没有数组字段「${field}」` };
  const owned = new Set(ownedSources);
  const keep = new Set(keepSources);
  const kept = [];
  const removed = [];
  const next = [];
  for (const item of list) {
    const source = typeof item === "string" ? item : item && item.source;
    // 属于某个包的插件 ⇒ 只有激活了才留；不属于任何包的（如基座自带的 MCP 客户端）⇒ 照留
    if (!owned.has(source) || keep.has(source)) { next.push(item); kept.push(source); }
    else removed.push(source);
  }
  if (removed.length) {
    parent[leaf] = next;   // 点分路径：直接改父对象，其余字段原样
    fs.writeFileSync(file, JSON.stringify(doc, null, 2) + "\n");
  }
  return { enforced: true, kind: surface.kind, kept: kept.sort(), removed: removed.sort(), file,
    note: removed.length ? `按激活集合摘掉了 ${removed.length} 个未激活插件：${removed.sort().join(", ")}` : "无需摘除（激活集合覆盖了全部插件）" };
}

/**
 * 连接器落点（YAML 版）：产物把连接器表达成 **insert row**（不是 JSON 对象）时用它。
 *
 * 为什么能做（推翻旧豁免）：早期声明「解析后重写会破坏 `!!js` 插值」，实测**不成立** ——
 * 用 `yaml` 的 Document API 加 `lineWidth: 0`，其余行（含 `!!js` 长标量）**逐字保留**，
 * 语义只少掉被摘的那一条（往返用例在 `core/bundles/selftest.mjs`）。
 * 按纪律撤掉那条豁免（实测推翻 ⇒ 改声明，而不是留着好看）。
 *
 * surface 形状（由清单声明，core 不认运行时）：
 *   { path, kind: "yaml-insert-rows", match: { path: "config.serverName" } }
 *
 * 安全性：写回前做**保真校验** —— 解析改前/改后逐项比对，只要有一处非预期差异就
 * **不写**并响亮失败（宁可不动，也不悄悄改坏别人的产物）。
 *
 * @param {{runDir: string, surface: object|null, keep: string[]}} args
 */
export function enforceYamlInsertRows({ runDir, surface = null, keep = [] }) {
  if (!surface || !surface.path) {
    return { enforced: false, kind: null, kept: [], removed: [], note: "产物没有声明该落点 ⇒ 未摘除" };
  }
  const file = path.join(runDir, surface.path);
  if (!fs.existsSync(file)) {
    return { enforced: false, kind: surface.kind ?? null, kept: [], removed: [], note: `落点不存在（${surface.path}）⇒ 无需摘除` };
  }
  const fieldPath = (surface.match && surface.match.path) || "config.serverName";
  const text = fs.readFileSync(file, "utf8");
  let doc;
  try { doc = YAML.parseDocument(text); }
  catch (e) { return { enforced: false, kind: surface.kind, kept: [], removed: [], note: `落点不是合法 YAML：${e.message}` }; }
  const valueAt = (obj) => fieldPath.split(".").reduce((acc, k) => (acc == null ? acc : acc[k]), obj);
  const keepSet = new Set(keep);
  const kept = [];
  const removed = [];
  const visit = (node) => {
    if (YAML.isSeq(node)) {
      const next = [];
      for (const item of node.items) {
        const plain = item && typeof item.toJSON === "function" ? item.toJSON() : item;
        const name = valueAt(plain);
        if (typeof name === "string" && !keepSet.has(name)) { removed.push(name); continue; }
        if (typeof name === "string") kept.push(name);
        next.push(item);
        visit(item);
      }
      if (next.length !== node.items.length) node.items = next;
    } else if (YAML.isMap(node)) {
      for (const pair of node.items) visit(pair.value);
    }
  };
  visit(doc.contents);
  if (!removed.length) {
    return { enforced: true, kind: surface.kind, kept: kept.sort(), removed: [], file, note: "无需摘除（激活集合覆盖了该落点里的全部条目）" };
  }
  const nextText = doc.toString({ lineWidth: 0 });
  // ---- 保真校验：非预期差异一律不写 ----
  const prune = (v) => (Array.isArray(v)
    ? v.map(prune).filter((x) => !(x && typeof x === "object" && typeof valueAt(x) === "string" && !keepSet.has(valueAt(x))))
    : (v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, prune(x)])) : v));
  const before = prune(YAML.parseDocument(text).toJS());
  const after = YAML.parseDocument(nextText).toJS();
  if (JSON.stringify(after) !== JSON.stringify(before)) {
    return { enforced: false, kind: surface.kind, kept: kept.sort(), removed: [], file,
      note: "**保真校验未通过** ⇒ 拒绝写回（重写后的语义与预期不符；宁可不动，也不悄悄改坏产物）" };
  }
  fs.writeFileSync(file, nextText);
  return { enforced: true, kind: surface.kind, kept: kept.sort(), removed: removed.sort(), file,
    note: `按激活集合摘掉了 ${removed.length} 条 insert row：${removed.sort().join(", ")}（其余内容逐字保留，保真校验通过）` };
}
