// ============================================================================
// 镜像**输入指纹**：决定镜像内容的那些东西，算一个 sha256。
//
// 为什么单独成一个模块：**构建端与检查端必须用同一份实现**。
// 构建端（core/image/build.mjs）把它烤进镜像的 LABEL；
// 检查端（conformance 的 C9 与 `make verify-container` 的前置检查）重算并比对
// —— 于是"镜像是否与当前源码同源"成了机器可判的事实。
//
// ## 覆盖范围为什么是"闸门源码整棵树"（D13 的修法）
//
// 早先只哈希 6 个上下文文件（Dockerfile/entrypoint/startup/lock…）——**漏掉了被烤进镜像的
// 闸门源码**（`gates/{core,tools,adapters}`）。后果是一次真实的假绿：改了闸门判据（闸门 3 的钩子自证）
// 之后，镜像 LABEL 一字未变 ⇒ "同源"照样成立 ⇒ 直到 `make verify-container` 出现
// 「容器挂、本地过」的假差异才暴露出来。
//
// 所以现在按**源码树**算，覆盖范围 = 真正被拷进镜像的那几棵树（与 build.mjs 的拷贝清单同源）：
//   · `core/`（含 `core/image/*`：Dockerfile、entrypoint.sh、startup.mjs、verify-in-image.mjs…）
//   · `tools/`、`adapters/`
// 宁可**过覆盖**（多算几个不参与镜像的文件 ⇒ 最多多重建一次），也不漏算（漏算 = 假绿）。
// 生成物（`harnesses.lock.json`、`preinstall.lock.txt`）由上述源派生，已在覆盖内。
//
// 纯函数、无副作用 —— 可以被 import 而不触发任何构建。
// ============================================================================

import path from "node:path";
import { fileURLToPath } from "node:url";
import { digestInputs } from "../gates/digest.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");

/** 拷进镜像源码树的目录（与 build.mjs 的上下文装配**同一份清单**）。 */
export const IMAGE_SOURCE_DIRS = Object.freeze(["core", "tools", "adapters"]);

/** 上下文装配时排除的东西（依赖在 Dockerfile 里装；产物/渲染缓存不进镜像）。 */
export const IMAGE_CONTEXT_EXCLUDES = Object.freeze(["node_modules", "dist", ".render", ".git"]);

/**
 * 指纹**只覆盖能影响判据的代码**：自检与夹具不算。
 *
 * 理由（实测踩中）：如果连 `*-selftest.mjs` 都进指纹，那么"改一个自检"就会让镜像变成
 * "过期"，`make verify-container` 会拒绝执行并要求重建镜像 —— 指纹从保护变成了绊脚石。
 * 自检与夹具**不参与**闸门判定，排除它们不会让任何"结论不可比"的情形漏掉。
 */
const NOT_A_VERDICT_INPUT = /(^|\/)([a-z0-9-]*selftest[a-z0-9-]*\.mjs|fixtures\/)/;

/**
 * @param {string} [repoDir] 仓库根（默认本文件所在仓库）
 * @returns {string} `sha256:<hex>`
 */
export function imageInputsDigest(repoDir = REPO) {
  return digestInputs(IMAGE_SOURCE_DIRS.map((d) => ({
    role: `source:${d}`,
    path: path.join(repoDir, d),
    excludes: IMAGE_CONTEXT_EXCLUDES,
    filter: (rel) => !NOT_A_VERDICT_INPUT.test(rel),
  })));
}
