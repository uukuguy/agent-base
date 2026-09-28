// ============================================================================
// 能力探针（闸门 3 用）：**按描述逐条真调用**，并核对它声明的结果形状
//
// 为什么必须有这一条：桥的自检证明了"工具被提供给了模型"，但那只到**注册**；
// 描述里 `result` 是"返回形状没变"的判据 —— 没有真调用，它只是纸面承诺。
// 这里做三件事（都按描述，不看实现代码）：
//   ① 按 `parameters` schema 造一份**最小合法入参**，真调一次
//   ② 断言 `details` 符合描述里的 `result`（用同一份 JSON Schema 校验）
//   ③ `declaration.deterministic: true` ⇒ 同入参再调一次，`details` 必须一致（可复算）
//
// 造不出合法入参的能力**不算通过**：如实报 `skipped` 并写清缺什么（不让它看起来是绿的）。
// ============================================================================

import fs from "node:fs";
import path from "node:path";

import { RUNTIMES, invokeCapability } from "./registry.mjs";

/** 依据 JSON Schema 造一份最小合法入参（只覆盖业务能力描述里实际用得到的形状）。 */
export function sampleArguments(schema = {}) {
  const type = schema.type ?? (schema.properties ? "object" : null);
  if (schema.enum?.length) return schema.enum[0];
  if (Array.isArray(schema.oneOf) && schema.oneOf.length) return sampleArguments(schema.oneOf[0]);
  if (Array.isArray(schema.anyOf) && schema.anyOf.length) return sampleArguments(schema.anyOf[0]);
  switch (type) {
    case "object": {
      const out = {};
      for (const name of schema.required ?? []) {
        if (!schema.properties?.[name]) return { __missing: name };        // 声明了 required 却没给形状
      }
      // **必填 + 可选都造**：只造必填时，像"缺回滚方案就拒答"这类规则会让探针永远只走到拒答分支，
      // 于是 `result` 形状这条判据永远没被验到（本轮实测踩到）。可选字段按它们自己的 schema 造。
      for (const name of Object.keys(schema.properties ?? {})) out[name] = sampleArguments(schema.properties[name]);
      return out;
    }
    case "array": return [sampleArguments(schema.items ?? { type: "string" })];
    case "string": return "sample";
    case "integer": return (schema.minimum ?? 1);
    case "number": return (schema.minimum ?? 1);
    case "boolean": return false;
    default: return null;
  }
}

/**
 * 读产物里的能力清单（构建期生成的 JSON —— 探针不需要 YAML 解析）。
 * 落点**由清单声明**（`capabilitiesPath`）：各运行时的产物形状不同，
 * 猜目录形状的代价是静默得到"没有能力"（本轮实测：某个运行时的探针一度报"未声明任何能力"，
 * 因为它的能力落点不在产物根 —— 这类错会静默，所以落点必须由清单回答）。
 */
export function readCapabilityIndex(renderDir, rel = null) {
  let base = rel;
  if (!base) {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(renderDir, "render-manifest.json"), "utf8"));
      base = m.capabilitiesPath ?? null;
    } catch { base = null; }
  }
  if (!base) return [];
  const file = path.join(renderDir, base, "index.json");
  if (!fs.existsSync(file)) return [];
  try {
    const doc = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(doc?.capabilities) ? doc.capabilities : [];
  } catch {
    return [];
  }
}

/**
 * 逐条探测。
 * @returns {Promise<{results: Array, reachable: number, total: number, skipped: number}>}
 */
export async function probeCapabilities(renderDir, { validate = null, timeoutMs = null } = {}) {
  const rel = (() => {
    try { return JSON.parse(fs.readFileSync(path.join(renderDir, "render-manifest.json"), "utf8")).capabilitiesPath ?? null; }
    catch { return null; }
  })();
  const capsDir = rel ? path.join(renderDir, rel) : path.join(renderDir, "capabilities");
  const entries = readCapabilityIndex(renderDir, rel);
  const results = [];
  for (const entry of entries) {
    const cap = {
      name: entry.name, description: entry.description, parameters: entry.parameters,
      result: entry.result, declaration: entry.declaration, execution: entry.execution,
      __file: path.join(capsDir, `${entry.name}.yaml`),
    };
    const args = sampleArguments(entry.parameters ?? {});
    if (args && typeof args === "object" && args.__missing) {
      results.push({ name: entry.name, ok: false, skipped: true, why: `造不出合法入参：required 字段 ${args.__missing} 在 properties 里没有形状` });
      continue;
    }
    const rt = RUNTIMES[entry.execution?.runtime];
    if (entry.execution?.kind === "process" && !rt) {
      results.push({ name: entry.name, ok: false, skipped: true, why: `未知 execution.runtime：${entry.execution.runtime}` });
      continue;
    }
    const first = await invokeCapability(cap, args, { cwd: capsDir, timeoutMs });
    if (!first.ok) { results.push({ name: entry.name, ok: false, why: `调用失败：${first.error}`, args }); continue; }
    // 结果形状：描述里的 `result` 是判据。
    // **拒答是描述允许的行为**（业务主动拒绝），所以拒答时不校验 result 形状 —— 但要**如实分类**：
    // 拒答的能力这一轮**没验到** result 形状（不是"验过了"）。
    if (first.refused === true) {
      results.push({ name: entry.name, ok: true, refused: true, args, channel: first.channel, ms: first.ms,
        note: "以合成入参被业务拒答（拒答本身合法）；这一轮因此没验到 result 形状" });
      continue;
    }
    let shapeProblem = null;
    if (validate && entry.result) {
      const okShape = validate(entry.result, first.details);
      if (!okShape) shapeProblem = `details 不符合描述里的 result schema（${JSON.stringify(first.details).slice(0, 120)}）`;
    }
    // 确定性：声明为真就必须复算一致
    let determinism = null;
    if (entry.declaration?.deterministic === true) {
      const second = await invokeCapability(cap, args, { cwd: capsDir, timeoutMs });
      determinism = second.ok && JSON.stringify(second.details) === JSON.stringify(first.details) ? "same" : "different";
      if (determinism !== "same") shapeProblem = shapeProblem ?? "声明确定性，但两次调用结果不一致";
    }
    results.push({
      name: entry.name, ok: !shapeProblem, why: shapeProblem, args,
      channel: first.channel, ms: first.ms, refused: first.refused === true, determinism,
    });
  }
  return {
    results,
    total: results.length,
    reachable: results.filter((r) => r.ok).length,
    skipped: results.filter((r) => r.skipped).length,
    refused: results.filter((r) => r.refused === true).length,
    shapeChecked: results.filter((r) => r.ok && r.refused !== true).length,
  };
}
