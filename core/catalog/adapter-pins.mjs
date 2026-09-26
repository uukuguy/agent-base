// ============================================================================
// 适配器 pin 的**唯一读取处**（harness 专有事实的单一真源）
//
// 为什么单独抽出来：`make dev-env --check`（对齐本机运行时版本）与环境一致性检查
// （`make env-check`）都要问"期望的运行时版本是多少"。两处各读一遍 adapters/ 就会漂移，
// 而漂移的表现是"一个说一致、另一个说缺项"—— 正是本仓库反复在收口的那类静默不一致。
//
// 注意：本模块**不写死任何运行时名**，只遍历 `adapters/` 目录（core/ 的层纪律）。
// ============================================================================

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");

/**
 * @returns {Array<{adapter: string, pkg: string, version: string, bin: string}>}
 *          按目录名排序；缺 `package`/`version` 的 adapter 会被跳过（它们无法用来对齐）。
 */
export function readAdapterPins(repoDir = REPO) {
  const dir = path.join(repoDir, "adapters");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name).sort()
    .map((name) => {
      const f = path.join(dir, name, "adapter.yaml");
      if (!fs.existsSync(f)) return null;
      const a = YAML.parse(fs.readFileSync(f, "utf8"));
      if (!a?.package || !a?.version) return null;
      return { adapter: name, pkg: a.package, version: a.version, bin: a.bin ?? name };
    })
    .filter(Boolean);
}
