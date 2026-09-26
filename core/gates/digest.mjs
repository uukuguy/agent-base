// ============================================================================
// 摘要工具（统一设计 §6.7 / N19）
//
// 「同一 digest = 同一行为」是可复现性的载体，所以摘要必须：
//   · 确定性：文件列举顺序固定，不依赖文件系统的遍历顺序
//   · 内容敏感：路径也进摘要——文件改名同样是行为变化（相对引用会失效）
//   · 可复算：只依赖输入内容，不掺时间戳
// ============================================================================

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { sha256 } from "./report.mjs";

/** 默认不进摘要的目录：版本控制与依赖安装产物不属于「制品」。 */
export const DEFAULT_EXCLUDES = Object.freeze([
  ".git", "node_modules", ".DS_Store", "_archive",
  // 构建产物：渲染输出若落在定义目录内（如 .render/），把它算进摘要会让摘要**自漂移**——
  // 渲染一次摘要就变，"同输入同 digest"当场不成立。
  ".render", "dist", ".agent-base-build",
]);

function walk(rootDir, excludes) {
  const files = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (excludes.includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) files.push(full);
    }
  };
  visit(rootDir);
  return files;
}

/**
 * 目录内容的确定性摘要。
 * @param {string} dir
 * @param {{excludes?: string[]}} [opts]
 * @returns {string} `sha256:<64 hex>`
 */
export function digestDirectory(dir, { excludes = DEFAULT_EXCLUDES } = {}) {
  const root = path.resolve(dir);
  const hash = createHash("sha256");
  for (const file of walk(root, excludes)) {
    const rel = path.relative(root, file).split(path.sep).join("/");
    hash.update(rel, "utf8");
    hash.update("\0", "utf8");
    hash.update(fs.readFileSync(file));
    hash.update("\0", "utf8");
  }
  return `sha256:${hash.digest("hex")}`;
}

/** 对象/JSON 的规范化摘要（键递归排序，避免键序造成的假差异）。 */
export function digestCanonical(value) {
  const canon = (v) => {
    if (v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map(canon);
    return Object.fromEntries(
      Object.keys(v)
        .sort()
        .map((k) => [k, canon(v[k])]),
    );
  };
  return sha256(JSON.stringify(canon(value)));
}

/** 文件内容的确定性摘要。 */
export function digestFile(file) {
  return `sha256:${createHash("sha256").update(fs.readFileSync(file)).digest("hex")}`;
}

/**
 * **一组带角色的输入**的确定性摘要 —— 用来回答"这个产物还是当前输入渲出来的吗"。
 *
 * 为什么不能只比定义摘要：产物是「定义 + 基座（seed 扩展、渲染器、目录表）」一起决定的。
 * 改了基座、定义没动 ⇒ 定义摘要不变 ⇒ 复用旧产物 ⇒ **"我改了却没生效"**（本仓库已踩中：
 * 新增一条基座扩展后，示例目录里的旧产物照旧被复用，新命令在会话里根本不存在）。
 *
 * 角色（role）进摘要而不是绝对路径：换台机器、换个目录，同一组输入必须得到同一个摘要（N19）。
 * 传 `kind: "file"` 时按文件内容算；否则按目录内容算。
 *
 * @param {Array<{role: string, path: string, kind?: "dir"|"file", optional?: boolean}>} entries
 */
export function digestInputs(entries) {
  const hash = createHash("sha256");
  for (const e of [...entries].sort((a, b) => a.role.localeCompare(b.role))) {
    hash.update(e.role, "utf8");
    hash.update("\0", "utf8");
    const exists = fs.existsSync(e.path);
    // 可选项（如某运行时没有 seed 目录）显式记为 absent，而不是悄悄跳过 ——
    // "没有"和"有但没算"必须是不同的摘要。
    if (!exists) {
      if (!e.optional) throw new Error(`渲染输入不存在：${e.role} → ${e.path}`);
      hash.update("absent", "utf8");
    } else {
      hash.update(e.kind === "file" ? digestFile(e.path) : digestDirectory(e.path), "utf8");
    }
    hash.update("\0", "utf8");
  }
  return `sha256:${hash.digest("hex")}`;
}
