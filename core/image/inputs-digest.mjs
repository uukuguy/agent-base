// ============================================================================
// 镜像**输入指纹**：构建上下文里真正决定镜像内容的文件，算一个 sha256。
//
// 为什么单独成一个模块：**构建端与检查端必须用同一份实现**。
// 构建端（core/image/build.mjs）把它烤进镜像的 LABEL；
// 检查端（conformance 的 C9）重算并比对 —— 于是"镜像是否与当前源码同源"成了机器可判的事实。
//
// 没有它会发生什么（真实发生过）：改了入口脚本与启动脚本却不重建镜像，
// 镜像里跑的还是旧行为，而所有检查只看"镜像存在 + 平台对"，于是全绿。
//
// 纯函数、无副作用 —— 可以被 import 而不触发任何构建。
// ============================================================================

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

/** 决定镜像内容的上下文文件（顺序固定，参与哈希）。 */
export const IMAGE_INPUT_FILES = Object.freeze([
  "Dockerfile",
  "Dockerfile.debug",
  "entrypoint.sh",
  "startup.mjs",
  "harnesses.lock.json",
  "preinstall.lock.txt",
]);

/**
 * @param {string} ctx 构建上下文目录（通常 dist/image/context）
 * @returns {string} `sha256:<hex>`；缺文件也参与哈希（写成 "(missing)"），这样"少了个文件"同样会变
 */
export function imageInputsDigest(ctx) {
  const h = createHash("sha256");
  for (const f of IMAGE_INPUT_FILES) {
    const p = path.join(ctx, f);
    h.update(`${f}\0`);
    h.update(fs.existsSync(p) ? fs.readFileSync(p) : Buffer.from("(missing)"));
    h.update("\0");
  }
  return `sha256:${h.digest("hex")}`;
}
