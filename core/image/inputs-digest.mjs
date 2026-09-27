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

/**
 * 指纹覆盖范围 = **镜像内验证真正会用到的东西**：
 *   · `core/`（闸门框架、渲染器共享逻辑、启动期、schema）
 *   · `adapters/`（各运行时的 doctor/render/run/trace —— 镜像内会跑 doctor）
 *   · `tools/` 里**镜像内验证实际执行的那四个**（validate/probe/smoke/verify）
 *
 * 为什么不覆盖整个 `tools/`：那样"改一个开发工具（如 `tools/regression.mjs`、`gen-*.mjs`）"
 * 也会让镜像"过期"并要求重建 —— 指纹从保护变成绊脚石（实测踩到两次）。
 * 这四个工具的 import 只落在 `core/`（已核对），所以这个集合是**完整**的：
 * 凡是能改变镜像内判据的代码都在里面，凡是不在里面的都改不了判据。
 */
export const IMAGE_DIGEST_DIRS = Object.freeze(["core", "adapters"]);

/**
 * **拷进镜像**的目录 —— 与指纹覆盖范围**故意不同**，两者目的不同：
 *   · 拷贝：镜像里要能自己找到"闸门仓库根"（`verify-in-image.mjs` 向上找 `tools/validate.mjs`），
 *     所以整棵 `tools/` 都要进镜像；
 *   · 指纹：只覆盖"能改变镜像内判据"的代码（见上），改开发工具不该要求重建。
 * ⚠️ 曾经把两者合成一个常量 ⇒ 构建不再拷 `tools/` ⇒ 镜像内自证找不到闸门根、退出码 2（实测踩中）。
 */
export const IMAGE_COPY_DIRS = Object.freeze(["core", "tools", "adapters"]);

/** 镜像内验证实际执行的工具（其余 `tools/*` 是开发/自检工具，不参与镜像内判据）。 */
export const IMAGE_VERDICT_TOOLS = Object.freeze(["validate.mjs", "probe.mjs", "smoke.mjs", "verify.mjs"]);

/** 上下文装配时排除的东西（依赖在 Dockerfile 里装；产物/渲染缓存不进镜像）。 */
export const IMAGE_CONTEXT_EXCLUDES = Object.freeze(["node_modules", "dist", ".render", ".git"]);

/**
 * 指纹不覆盖自检与夹具（它们不参与判定，改它们不该要求重建镜像）。
 *
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
  return digestInputs([
    ...IMAGE_DIGEST_DIRS.map((d) => ({
      role: `source:${d}`,
      path: path.join(repoDir, d),
      excludes: IMAGE_CONTEXT_EXCLUDES,
      filter: (rel) => !NOT_A_VERDICT_INPUT.test(rel),
    })),
    ...IMAGE_VERDICT_TOOLS.map((f) => ({
      role: `tool:${f}`,
      path: path.join(repoDir, "tools", f),
      kind: "file",
    })),
  ]);
}
