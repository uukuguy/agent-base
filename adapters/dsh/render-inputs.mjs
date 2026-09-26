// ============================================================================
// **渲染输入**清单：产物是由哪些东西一起决定的
//
// 这份清单是"还能不能复用已有产物"的判据。只比定义摘要是不够的 ——
// 产物同样取决于基座（seed 扩展、渲染器本身、目录/参数表），
// 而基座变了、定义没动时，定义摘要一模一样 ⇒ 旧产物被复用 ⇒ **"改了没生效"**。
// 本轮实际踩中：新增一条基座扩展（会话内自省命令）后，示例目录里的旧产物照旧复用，
// 于是交互会话里根本没有那条命令。
//
// 判据必须由**渲染器与复用方共用同一份实现**（这里），而不是各写一份路径列表：
// 两份列表迟早不一致，那时失败方式是"某次改动不触发重渲"，而且没有任何报错。
// ============================================================================

import path from "node:path";
import { fileURLToPath } from "node:url";
import { digestInputs } from "../../core/gates/index.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");

/** 决定 dsh 产物内容的输入（顺序无关，digestInputs 会按 role 排序）。 */
export function dshRenderInputs(agentDir) {
  return [
    { role: "definition", path: path.resolve(agentDir) },
    { role: "seed", path: path.join(HERE, "seed"), optional: true },   // dsh 目前没有 seed 目录
    { role: "renderer", path: path.join(HERE, "render.mjs"), kind: "file" },
    { role: "adapter-decl", path: path.join(HERE, "adapter.yaml"), kind: "file" },
    { role: "catalog", path: path.join(REPO, "core/catalog") },
    { role: "preinstall", path: path.join(REPO, "core/image/preinstall.yaml"), kind: "file", optional: true },
  ];
}

export function dshRenderInputsDigest(agentDir) {
  return digestInputs(dshRenderInputs(agentDir));
}

/** 与 harness 无关的名字：复用方（`tools/run-local.mjs`）按这个名字取，不必知道是哪个运行时。 */
export const renderInputsDigest = dshRenderInputsDigest;
