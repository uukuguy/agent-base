// ============================================================================
// Provider（供应商）目录的**解析**（唯一一处实现）
//
// ## 为什么需要"可覆盖"
//
// provider 目录写的是"这次部署连哪个端点、端点服务哪些模型"—— 这是**环境属性**，
// 不该只存在于基座源码里。它放在 `core/` 只是**内置默认**（配合自带假网关，开箱能跑）；
// 真实使用时由部署层提供自己的那份，**不必改基座代码**。
//
// 这和参数层是同一个道理：基座给的是**契约与默认**，部署给的是**取值**。
//
// ## 解析顺序（固定，唯一实现）
//
//   ① `AGENT_ROUTES_FILE=/path/to/routes.yaml`   —— 显式指定（最明确）
//   ② `AGENT_CATALOG_DIR=/dir`                    —— 目录形式，取 `/dir/routes.yaml`
//   ③ `<智能体目录>/routes.yaml`                   —— 智能体自带的那份（"就放旁边"，最直觉）
//   ④ 基座内置 `core/catalog/routes.yaml`          —— 默认，配合自带假网关
//
// **设置了①②却没读到文件 ⇒ 报错，不静默回退到内置** —— 否则"我明明配了"与
// "系统其实在用内置"会同时成立，是最难查的一类问题。
// ============================================================================

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 基座**内置的常用 provider**：让"只写一个通行名字就能用"成立（不必建任何文件）。 */
export const BUILTIN_PROVIDERS_PATH = path.join(HERE, "providers.yaml");

// ============================================================================
// Provider（供应商）—— 比"provider"更通行的说法，且**内置常用供应商**
//
// 解析顺序（与provider 目录同一条链，只是多了一层"内置 provider 作为基础层"）：
//   ① `AGENT_PROVIDERS_FILE` / `AGENT_ROUTES_FILE`（显式文件）
//   ② `AGENT_CATALOG_DIR` 下的 providers.yaml / routes.yaml
//   ③ `<智能体目录>/providers.yaml`（或 routes.yaml）
//   ④ 基座内置 providers.yaml ← **基础层**：上面各层按 id **合并覆盖**它
//
// 于是：智能体写 `model.provider: deepseek` 就够；要改端点/模型名，只在自己的
// providers.yaml 里写要改的字段即可 —— 改基座代码是**不需要**的。
// ============================================================================

const prefixOf = (id) => String(id).toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");

function readProvidersFile(file) {
  if (!fs.existsSync(file)) return null;
  try {
    const doc = YAML.parse(fs.readFileSync(file, "utf8"));
    const list = doc?.providers ?? doc?.routes ?? [];
    return Array.isArray(list) ? list : [];
  } catch {
    return null;
  }
}

/** 把一条 provider 补全成渲染器与闸门要用的形状（引用名、默认端点、凭据名、模型名参数）。 */
export function normalizeProvider(entry) {
  const id = String(entry.id ?? "");
  const prefix = prefixOf(id);
  return {
    id,
    displayName: entry.displayName ?? id,
    api: entry.api ?? "openai-completions",
    // 端点：写死用 baseUrl；不写死就用引用名（内部网关那种每环境不同的）
    baseUrl: entry.baseUrl ?? null,
    baseUrlParam: entry.baseUrlParam ?? `${prefix}_BASE_URL`,
    // 凭据引用名：默认按通行约定 `<ID>_API_KEY`（DeepSeek 即 DEEPSEEK_API_KEY）
    credentialParam: entry.credentialEnv ?? entry.credentialParam ?? `${prefix}_API_KEY`,
    modelParam: entry.modelParam ?? `${prefix}_MODEL`,
    models: Array.isArray(entry.models) ? entry.models : [],
    note: entry.note ?? null,
    builtin: entry.builtin === true,
  };
}

/**
 * 读"有效 provider 列表"：内置为基础层，部署层按 id 合并覆盖。
 * @returns {{providers: object[], sources: string[], errors: string[]}}
 */
export function loadProviders({ env = process.env, agentDir = null } = {}) {
  const sources = [];
  const errors = [];

  // 基础层：内置
  const builtin = readProvidersFile(BUILTIN_PROVIDERS_PATH);
  if (builtin === null) errors.push(`基座内置的 providers.yaml 读不到：${BUILTIN_PROVIDERS_PATH}`);
  const byId = new Map();
  for (const e of builtin ?? []) byId.set(e.id, { ...e, builtin: true });
  if (builtin?.length) sources.push(`基座内置（${BUILTIN_PROVIDERS_PATH}）`);

  // 覆盖层：显式文件 > 目录 > 智能体自带（与provider 目录同一条链）
  const candidates = [];
  const explicit = env.AGENT_PROVIDERS_FILE ?? env.AGENT_ROUTES_FILE ?? null;
  if (explicit) {
    const what = env.AGENT_PROVIDERS_FILE ? "AGENT_PROVIDERS_FILE" : "AGENT_ROUTES_FILE（旧名，建议改用 AGENT_PROVIDERS_FILE）";
    candidates.push({ file: path.resolve(explicit), explicit: true, what });
  }
  if (env.AGENT_CATALOG_DIR) {
    const dir = path.resolve(env.AGENT_CATALOG_DIR);
    candidates.push({ file: path.join(dir, "providers.yaml"), what: "AGENT_CATALOG_DIR" });
  }
  if (agentDir) {
    candidates.push({ file: path.join(path.resolve(agentDir), "providers.yaml"), what: "agent-local" });
  }

  for (const c of candidates) {
    if (!fs.existsSync(c.file)) {
      // "显式指定却读不到"要报错；其它层级缺文件是正常的
      if (c.explicit) errors.push(`${c.what} 指向的文件不存在：${c.file}（设置了却读不到 ⇒ 直接失败，不静默回退）`);
      continue;
    }
    const list = readProvidersFile(c.file);
    if (list === null) { errors.push(`${c.file} 解析失败`); continue; }
    for (const e of list) {
      const prev = byId.get(e.id) ?? {};
      // 按字段合并：覆盖层只写要改的，其余继承内置
      byId.set(e.id, { ...prev, ...e, builtin: prev.builtin === true && e.builtin !== false });
    }
    sources.push(`${c.what}（${c.file}）`);
    break;   // 只取**第一个存在**的覆盖层，避免多层无声叠加
  }

  // **有错误就不交列表**：调用方（闸门 1 / 渲染器）只要看到空列表就会失败并报出 errors，
  // 不会出现"我以为用的是自己那份，其实系统在用内置"——那正是本项目一直在治的静默回退。
  if (errors.length) return { providers: [], sources, errors };
  return { providers: [...byId.values()].map(normalizeProvider), sources, errors };
}

/** 取某个 provider；找不到时给出可用取值。 */
export function findProvider(loaded, id) {
  return (loaded.providers ?? []).find((p) => p.id === id) ?? null;
}
