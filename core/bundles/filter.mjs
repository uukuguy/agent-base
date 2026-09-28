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

export const CONNECTOR_SURFACE_KINDS = Object.freeze(["json-mcp-servers"]);

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
