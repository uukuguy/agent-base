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
//   ① `AGENT_PROVIDERS_FILE=/path/to/providers.yaml` —— 显式指定（最明确）
//   ② `AGENT_CATALOG_DIR=/dir`                      —— 目录形式，取 `/dir/providers.yaml`
//   ③ `<智能体目录>/providers.yaml`                 —— 智能体自带的那份（「就放旁边」，最直觉）
//   ④ 基座内置 `core/catalog/providers.yaml`        —— 常用供应商，开箱能用
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
//   ① `AGENT_PROVIDERS_FILE`（显式文件）
//   ② `AGENT_CATALOG_DIR` 下的 providers.yaml
//   ③ `<智能体目录>/providers.yaml`
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

/**
 * 把一条 provider 补全成渲染器与闸门要用的形状。
 *
 * 两个正交的概念：
 *   · `harnesses`  —— **作用域**：这家供应商在哪些运行时可用。缺省 = 所有运行时都行；
 *                    只写某一个运行时名就是「只有它能用」——各运行时原生认识的家数不同，
 *                    这是**允许的差异**，不是必须处处相同。
 *   · `auth`       —— **凭据来源**：
 *                    `env`    = 从环境/变量文件读（默认，引用名见 credentialParam）；
 *                    `none`   = **根本不产生凭据参数**（本地模型服务：Ollama / vLLM / LM Studio 等不校验密钥）；
 *                    `native` = **基座不注入任何密钥**，交给运行时自己的凭据库
 *                               （各运行时的凭据库位置见适配器的 `credentialDirEnv`；
 *                                订阅登录一次即落在那个目录里，基座不碰密钥）。
 *                    免密钥的 provider 不产生"必填凭据"参数。
 */
export function normalizeProvider(entry) {
  const id = String(entry.id ?? "");
  const prefix = prefixOf(id);
  const auth = entry.auth === "native" ? "native" : entry.auth === "none" ? "none" : "env";
  // 端点也可以"交给运行时原生解析"：既没给 baseUrl、也没给引用名时为真（订阅型/原生型 provider 就是这样，
  // 端点由运行时自己的供应商表提供）。此时不产生端点参数，也不往产物里写端点。
  const endpointNative = entry.endpointNative === true
    || (auth === "native" && !entry.baseUrl && !entry.baseUrlParam);
  const harnesses = Array.isArray(entry.harnesses) && entry.harnesses.length ? [...entry.harnesses] : null;
  return {
    id,
    displayName: entry.displayName ?? id,
    api: entry.api ?? "openai-completions",
    baseUrl: entry.baseUrl ?? null,
    baseUrlParam: endpointNative ? null : (entry.baseUrlParam ?? `${prefix}_BASE_URL`),
    endpointNative,
    auth,
    // `env` 与 `none` 都产生凭据引用名；差别在**默认值与是否必填**：
    //   env  → 必填（真密钥，基座从环境/变量文件/凭据目录取）
    //   none → 不必填，默认一个**占位值**（本地服务不校验密钥，但各运行时的 OpenAI 兼容
    //          客户端都要求该字段存在：缺了会表现为"模型解析不出来"或"No API key"这类看不懂的错）
    // `native` → 不产生（凭据在运行时自己的凭据库里，如订阅登录）
    credentialParam: auth === "native" ? null : (entry.credentialEnv ?? entry.credentialParam ?? `${prefix}_API_KEY`),
    credentialDefault: auth === "none" ? (entry.credentialDefault ?? "local-no-key-needed") : null,
    modelParam: entry.modelParam ?? `${prefix}_MODEL`,
    models: Array.isArray(entry.models) ? entry.models : [],
    harnesses,
    note: entry.note ?? null,
    builtin: entry.builtin === true,
    // 哪些引用名是**显式声明**的：显式声明以它为准（厂商通行名，如 ZAI_API_KEY / MOONSHOT_API_KEY），
    // 没声明的才要求等于 `<ID 大写>_…` 约定名。
    declared: {
      credentialEnv: entry.credentialEnv !== undefined || entry.credentialParam !== undefined,
      baseUrlParam: entry.baseUrlParam !== undefined,
      modelParam: entry.modelParam !== undefined,
    },
  };
}

/** 这家供应商能不能在某个运行时上跑（作用域判定）。 */
export function providerSupports(provider, harness) {
  return !provider.harnesses || provider.harnesses.includes(harness);
}

/**
 * 运行时自己的凭据/配置目录覆盖：让"环境里登录一次"这件事对容器与本地都成立。
 * 各运行时的变量名不同 —— 由适配器声明（见 adapters/<h>/adapter.yaml 的 credentialDirEnv）。
 */
export function credentialDirEnvFor(adapterYaml, harness) {
  return adapterYaml?.credentialDirEnv ?? null;
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
  const explicit = env.AGENT_PROVIDERS_FILE ?? null;
  if (explicit) candidates.push({ file: path.resolve(explicit), explicit: true, what: "AGENT_PROVIDERS_FILE" });
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
