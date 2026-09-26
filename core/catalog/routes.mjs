// ============================================================================
// 路由目录的**解析**（唯一一处实现）
//
// ## 为什么需要"可覆盖"
//
// 路由目录写的是"这次部署连哪个端点、端点服务哪些模型"—— 这是**环境属性**，
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

/** 基座内置的路由目录路径。 */
export const BUILTIN_ROUTES_PATH = path.join(HERE, "routes.yaml");

/**
 * 解析"这次该读哪份路由目录"。
 * @param {Record<string,string|undefined>} [env]
 * @returns {{path: string, source: "AGENT_ROUTES_FILE"|"AGENT_CATALOG_DIR"|"base-builtin", builtin: boolean}}
 */
export function resolveRoutesSource({ env = process.env, agentDir = null } = {}) {
  if (env.AGENT_ROUTES_FILE) {
    return { path: path.resolve(env.AGENT_ROUTES_FILE), source: "AGENT_ROUTES_FILE", builtin: false };
  }
  if (env.AGENT_CATALOG_DIR) {
    return { path: path.join(path.resolve(env.AGENT_CATALOG_DIR), "routes.yaml"), source: "AGENT_CATALOG_DIR", builtin: false };
  }
  // 智能体自带：把 routes.yaml 与 agent.yaml 放一起即可 —— 不必记环境变量、不必改基座。
  // 这一级很关键：工具会切工作目录，靠 Makefile 里的 wildcard+export 只能覆盖"从 Makefile 走"的路径。
  if (agentDir) {
    const p = path.join(path.resolve(agentDir), "routes.yaml");
    if (fs.existsSync(p)) return { path: p, source: "agent-local", builtin: false };
  }
  return { path: BUILTIN_ROUTES_PATH, source: "base-builtin", builtin: true };
}

/**
 * 读路由目录。
 * @returns {{path: string, source: string, builtin: boolean, routes: object[], error: string|null}}
 */
export function loadRoutes({ env = process.env, agentDir = null } = {}) {
  const src = resolveRoutesSource({ env, agentDir });
  if (!fs.existsSync(src.path)) {
    return {
      ...src,
      routes: [],
      error: src.builtin
        ? `基座内置路由目录缺失：${src.path}`
        : `${src.source} 指向的文件不存在：${src.path}（设置了却读不到 ⇒ 直接失败，不静默回退到内置）`,
    };
  }
  let doc;
  try {
    doc = YAML.parse(fs.readFileSync(src.path, "utf8"));
  } catch (e) {
    return { ...src, routes: [], error: `${src.path} 解析失败：${e.message}` };
  }
  const routes = doc?.routes ?? [];
  if (!routes.length) return { ...src, routes: [], error: `${src.path} 里没有声明任何路由` };
  return { ...src, routes, error: null };
}

/** 方便调用方拼提示语：说明这份目录是从哪来的。 */
export function describeSource(loaded) {
  return loaded.builtin ? `基座内置（${loaded.path}）` : `${loaded.source}（${loaded.path}）`;
}
