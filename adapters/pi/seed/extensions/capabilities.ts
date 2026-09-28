// ============================================================================
// 能力的**通用桥**（本运行时侧）—— D-0013 的落地
//
// 它只做一件事：读产物里的能力清单（构建期由描述生成），把每个能力按**本运行时的工具形状**
// 注册进去；调用时交给 `core/capabilities/registry.mjs` 的 `invokeCapability`（两条通道都在那里）。
//
// ## 硬约束：本文件**不许出现任何具体能力的名字**
//
// 出现一个名字，桥就退化成"每能力一份接入件"，D-0013 的收益当场归零。
// 这不是自觉问题 —— `make capabilities-selftest` 会拿一个真产物逐条比对：
// 桥的源码里若出现该智能体的任何能力名，自检**当场判红**。
//
// ## 为什么清单是 JSON 而不是直接读 YAML
//
// 产物里的模块**不许裸导入**（`yaml` 在产物里解析不到 —— 本仓库踩过两次）。
// 所以 YAML 在**构建期**解析成 `capabilities/index.json`，运行期只读 JSON。
//
// ## 两条通道的区别只在这里体现
//
//   kind=module  → 进程内 import（快；JS/TS 业务）
//   kind=process → 起子进程（任意语言；协议在 registry 里，单一真源）
// 桥不需要知道差别 —— 调用入口是同一个 `invokeCapability`。
// ============================================================================

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { invokeCapability } from "./_capabilities.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** 产物根 = extensions/ 的父目录；能力清单在 `<产物根>/capabilities/index.json`。 */
const PRODUCT = path.resolve(HERE, "..");
const INDEX = path.join(PRODUCT, "capabilities", "index.json");

/** 读清单；读不到就返回空（没有声明能力是正常情况，不是错误）。 */
export function readCapabilityIndex(indexFile = INDEX) {
  try {
    const doc = JSON.parse(fs.readFileSync(indexFile, "utf8"));
    return Array.isArray(doc?.capabilities) ? doc.capabilities : [];
  } catch {
    return [];
  }
}

/** 清单条目 → registry 认的"能力"形状（`__file` 指向它自己的描述位置，供相对定位实现文件）。 */
export function toCapability(entry, capsDir) {
  return {
    name: entry.name,
    label: entry.label,
    description: entry.description,
    promptSnippet: entry.promptSnippet,
    parameters: entry.parameters,
    result: entry.result,
    declaration: entry.declaration,
    execution: entry.execution,
    __file: path.join(capsDir, `${entry.name}.yaml`),   // 只用于算实现文件的基准目录
  };
}

export default function (pi) {
  const capsDir = path.join(PRODUCT, "capabilities");
  const entries = readCapabilityIndex();
  for (const entry of entries) {
    const cap = toCapability(entry, capsDir);
    pi.registerTool({
      name: cap.name,
      label: cap.label,
      description: cap.description,
      ...(cap.promptSnippet ? { promptSnippet: cap.promptSnippet } : {}),
      parameters: cap.parameters,
      async execute(_toolCallId, params) {
        const r = await invokeCapability(cap, params, { cwd: capsDir });
        if (!r.ok) {
          // **响亮失败**：把原因交给模型（它才能改参数或换做法），不让它看起来像成功
          return {
            content: [{ type: "text", text: `能力 ${cap.name} 执行失败：${r.error}${r.stderr ? `\n${r.stderr}` : ""}` }],
            details: { ok: false, error: r.error, channel: r.channel },
            isError: true,
          };
        }
        return { content: [{ type: "text", text: r.text }], details: r.details ?? undefined };
      },
    });
  }
}
