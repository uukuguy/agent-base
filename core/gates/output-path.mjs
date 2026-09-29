import os from "node:os";
import path from "node:path";

/** Refuse output roots whose recursive cleanup could destroy the host workspace. */
export function assertSafeOutputRoot(root, { repoRoot = process.cwd() } = {}) {
  const resolved = path.resolve(root);
  const home = path.resolve(os.homedir());
  const repo = path.resolve(repoRoot);
  const filesystemRoot = path.parse(resolved).root;
  if (resolved === filesystemRoot) throw new Error(`拒绝使用文件系统根目录作为渲染输出：${resolved}`);
  if (resolved === home) throw new Error(`拒绝使用 HOME 作为渲染输出：${resolved}`);
  if (resolved === repo) throw new Error(`拒绝使用仓库根目录作为渲染输出：${resolved}`);
  return resolved;
}
