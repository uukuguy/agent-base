// ============================================================================
// 能力描述：装载 + 校验 + **按声明调用**（语言无关）
//
// 这是 D-0012/D-0013 落地的核心：业务能力 = ① 描述（本模块读的东西，语言无关）
// ② 可执行体（任意语言，经**进程边界**或**进程内**调用，见下）③ 通用桥（各运行时侧，
// 只按描述注册，不含任何具体能力名）。
//
// ## 双通道（D-0018 决定 A2）
//
//   `execution.kind: module`  → 进程内 `import` 后调 `run(params)`：JS/TS 业务的快速通道
//   `execution.kind: process` → 起子进程，按进程边界协议收发：**任意语言**（Python/Go/…）
//
// 两条通道的**对外语义必须一致**（同样的入参得到同样形状的结果、同样的拒答表示）。
// 一致性不是靠"看起来一样"，而是由 `selftest.mjs` 拿同一份规则的两种实现**对跑**来守。
//
// ## 进程边界协议（`kind: process`）
//
//   stdin  : 一行 JSON —— 工具入参原样
//   stdout : 一行 JSON —— `{ text, details?, refused? }`；`text` 必填（给模型看的文本）
//   退出码 : 0 正常（哪怕 refused=true）· 2 输入不合契约 · 其他非零 = 执行失败
//   stderr : 只放诊断，原样带回来（不解析、不吞）
//   超时   : 杀掉并按失败处理（**不静默降级**）
//
// ## 为什么这些不放各运行时侧
//
// 协议与一致性是**基座**的事（换运行时不该换语义）；各运行时侧只留"怎么把描述翻译成
// 它的工具形状"那一层（`adapters/<h>/seed/…`）。
// ============================================================================

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const SCHEMA_PATH = path.join(HERE, "description.schema.json");
export const CAPABILITY_DIR_NAME = "capabilities";

/** 解释器：**单一真源**（协议只认这几个名字；镜像里有没有由预装清单负责）。 */
export const RUNTIMES = Object.freeze({
  node: { bin: "node", ext: [".mjs", ".cjs", ".js"] },
  python: { bin: "python3", ext: [".py"] },
  shell: { bin: "sh", ext: [".sh"] },
});

/** 读一份描述（YAML）。返回 null 而不是抛：坏文件要变成"问题清单"里的条目。 */
export function readDescription(file, { yamlParse }) {
  try {
    return yamlParse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    return { __parseError: String(e.message ?? e) };
  }
}

/**
 * 装载一个目录下的能力描述（`<dir>/capabilities/*.yaml`）。
 * @returns {{capabilities: Array, problems: string[]}}
 */
export function loadCapabilities(dir, { yamlParse } = {}) {
  const problems = [];
  const capabilities = [];
  const capsDir = path.join(dir, CAPABILITY_DIR_NAME);
  if (!fs.existsSync(capsDir)) return { capabilities, problems, dir: capsDir };
  const names = new Map();
  for (const f of fs.readdirSync(capsDir).filter((n) => /\.ya?ml$/.test(n)).sort()) {
    const file = path.join(capsDir, f);
    const doc = readDescription(file, { yamlParse });
    if (!doc || doc.__parseError) { problems.push(`${f}: 读不出（${doc?.__parseError ?? "空文件"}）`); continue; }
    if (doc.name) {
      if (names.has(doc.name)) problems.push(`${f}: 能力名与 ${names.get(doc.name)} 重复（${doc.name}）—— 同名的两把工具模型会混淆`);
      else names.set(doc.name, f);
    }
    capabilities.push({ ...doc, __file: file, __rel: path.join(CAPABILITY_DIR_NAME, f) });
  }
  return { capabilities, problems, dir: capsDir };
}


/**
 * 描述文档 → **可进 schema 校验**的纯对象。
 *
 * 装载时会挂内部注解（`__file` / `__rel` / `__parseError`），而描述 schema 是
 * `additionalProperties: false`（**故意的**：写错字段名必须报错）。两者相遇时，
 * 内部注解会被 schema 当成"未知字段"判红（本轮实测踩到：正例也红了）。
 * 所以规则是：**内部注解一律 `__` 前缀，且校验前必须剥掉** —— 只此一处实现。
 */
export function toSchemaDocument(cap) {
  const out = {};
  for (const [k, v] of Object.entries(cap ?? {})) if (!k.startsWith("__")) out[k] = v;
  return out;
}

/**
 * 按描述校验"实现是否就位"（形状层面；**行为**由闸门 3/4 与自检负责）。
 * 这些规则是闸门 1 的一部分：`core/gates/*` 不重复实现，直接调这里。
 */
export function checkImplementation(cap) {
  const problems = [];
  const exec = cap?.execution ?? {};
  const base = path.dirname(cap.__file);
  const entryAbs = exec.entry ? path.resolve(base, exec.entry) : null;
  if (!exec.entry) problems.push("execution.entry 缺失");
  else if (!fs.existsSync(entryAbs)) problems.push(`execution.entry 不存在：${exec.entry}`);
  else {
    const ext = path.extname(entryAbs);
    if (exec.kind === "module") {
      const allowed = RUNTIMES.node.ext;
      if (!allowed.includes(ext)) problems.push(`kind=module 的 entry 必须是 ${allowed.join("/")}（收到 ${ext}）—— 其他语言请用 kind=process`);
    } else if (exec.kind === "process") {
      const rt = RUNTIMES[exec.runtime];
      if (!rt) problems.push(`kind=process 必须声明 execution.runtime（可选：${Object.keys(RUNTIMES).join(" / ")}）`);
      else if (!rt.ext.includes(ext)) problems.push(`runtime=${exec.runtime} 与 entry 扩展名不符（${ext}；该解释器认 ${rt.ext.join("/")}）`);
    }
  }
  if (cap?.declaration?.deterministic === false && !cap.declaration.reproducibility) {
    problems.push("declaration.deterministic=false 时必须给 declaration.reproducibility（说清怎么复现，否则闸门无法断言可复算）");
  }
  return problems;
}

/** 归一化一次调用结果（两条通道共用，保证对外语义一致）。 */
export function normalizeResult(raw, { text = null } = {}) {
  if (raw === null || raw === undefined) return { declined: true, text: "（实现没有返回结果）" };
  if (typeof raw === "string") return { text: raw, details: null, refused: false };
  const refused = raw.refused === true;
  return {
    text: typeof raw.text === "string" && raw.text.length ? raw.text : (text ?? (refused ? "（实现拒绝回答）" : "（实现没有给文本）")),
    details: raw.details ?? null,
    refused,
  };
}

/**
 * 调用一个能力。
 * @returns {Promise<{ok: boolean, text: string, details: any, refused: boolean, channel: string, ms: number, error?: string, stderr?: string}>}
 */
export async function invokeCapability(cap, params = {}, { cwd = null, env = process.env, timeoutMs = null } = {}) {
  const started = Date.now();
  const exec = cap.execution ?? {};
  const base = path.dirname(cap.__file);
  const entryAbs = path.resolve(base, exec.entry);
  const limit = timeoutMs ?? exec.timeoutMs ?? 10000;

  if (exec.kind === "module") {
    try {
      const mod = await import(`file://${entryAbs}?t=${Math.random()}`);
      const runner = mod.run ?? mod.default;
      if (typeof runner !== "function") {
        return { ok: false, channel: "module", ms: Date.now() - started, error: `kind=module 的实现必须导出 run(params)（或 default 函数）；${exec.entry} 没有` };
      }
      const out = await runner(params);
      return { ok: true, channel: "module", ms: Date.now() - started, ...normalizeResult(out) };
    } catch (e) {
      return { ok: false, channel: "module", ms: Date.now() - started, error: `进程内调用失败：${String(e.message ?? e)}` };
    }
  }

  // ---- 进程边界 ----
  const rt = RUNTIMES[exec.runtime];
  if (!rt) return { ok: false, channel: "process", ms: Date.now() - started, error: `未知的 execution.runtime：${exec.runtime}` };
  return await new Promise((resolve) => {
    const child = spawn(rt.bin, [entryAbs, ...(exec.argv ?? [])], { cwd: cwd ?? base, env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "", done = false;
    const finish = (r) => { if (!done) { done = true; clearTimeout(timer); resolve({ ms: Date.now() - started, stderr: err.slice(-2000), channel: "process", ...r }); } };
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* 已退出 */ }
      finish({ ok: false, error: `超时（>${limit}ms）—— 已杀掉，按失败处理（不静默降级）` });
    }, limit);
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => finish({ ok: false, error: `起不了进程（${rt.bin}）：${String(e.message ?? e)}` }));
    child.on("close", (code) => {
      if (code === 2) return finish({ ok: false, error: "实现报「输入不合契约」（退出码 2）", text: out.trim() });
      if (code !== 0) return finish({ ok: false, error: `执行失败（退出码 ${code}）`, text: out.trim() });
      const line = out.split("\n").map((l) => l.trim()).filter(Boolean).pop();
      if (!line) return finish({ ok: false, error: "实现没有在 stdout 给出一行 JSON（协议要求 stdout 一行结果）" });
      let parsed;
      try { parsed = JSON.parse(line); } catch { return finish({ ok: false, error: `stdout 不是合法 JSON：${line.slice(0, 200)}` }); }
      finish({ ok: true, ...normalizeResult(parsed) });
    });
    try { child.stdin.end(JSON.stringify(params ?? {}) + "\n"); } catch { /* 已关闭 */ }
  });
}


/**
 * 「两条通道语义一致」的**判据**（单一真源，自检与闸门都用它）。
 *
 * 一致 = `details` 深比较相等 + `refused` 相同 + 两边都有非空 `text`。
 * **文本允许不同**：`text` 是呈现层（给模型看的文案），同一份实现换个语言重写时措辞自然会变；
 * 要求逐字相同等于把两种语言的 JSON 格式也钉死，那不是语义。
 * 真正要一致的是**结构化结果**（`details`，它由描述里的 `result` schema 约束）。
 */
export function sameSemantics(a, b) {
  const reasons = [];
  if (!!a?.refused !== !!b?.refused) reasons.push(`refused 不同（${!!a?.refused} vs ${!!b?.refused}）`);
  if (JSON.stringify(a?.details ?? null) !== JSON.stringify(b?.details ?? null)) {
    reasons.push(`details 不同（${JSON.stringify(a?.details ?? null)} vs ${JSON.stringify(b?.details ?? null)}）`);
  }
  if (!String(a?.text ?? "").length || !String(b?.text ?? "").length) reasons.push("有一边没给 text（模型看不到任何说明）");
  return { same: reasons.length === 0, reasons };
}

/** 描述 → 该运行时工具表的"中性形状"（各运行时桥把它翻成自己的形状）。 */
export function toNeutralTool(cap) {
  return {
    name: cap.name,
    label: cap.label ?? cap.name,
    description: cap.description,
    promptSnippet: cap.promptSnippet ?? null,
    parameters: cap.parameters,
    result: cap.result,
    declaration: cap.declaration,
    execution: { kind: cap.execution.kind, runtime: cap.execution.runtime ?? null, entry: cap.execution.entry },
  };
}
