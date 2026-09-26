// ============================================================================
// 读环境文件（`.env` 这类）—— 让"密钥放进一个文件"这种最省事的做法真的可用
//
// ## 为什么需要它
//
// 现在的参数注入只认**进程环境变量**，于是用户必须把密钥 export 到 shell 里、或者
// `docker run -e` 一个个传。实际用法里更常见的是"我在项目里放了一份 .env"——
// 那个文件不该被无视。
//
// ## 优先级（一句话）
//
// **真环境变量 > 环境文件**。文件只是"没有真变量时的兜底"，绝不覆盖你已经 export 的值。
//
// ## 找哪几份（按顺序，先找到的先落，后找到的不覆盖）
//
//   ① `AGENT_ENV_FILE=/path`        —— 显式指定（容器里挂一份进去也可以用它）
//   ② `<智能体目录>/.env`            —— 与 agent.yaml 放一起，最贴近用户直觉
//   ③ 当前工作目录 `.env`
//   ④ 仓库根 `.env`
//
// ## 两条纪律
//
//   · **永不打印值**：只报"读了哪个文件、设了哪些名字"。
//   · **失败不致命**：文件不存在/格式不对不报错（它是可选的便利层），但会记进报告。
// ============================================================================

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");

/** 记录"这次读了哪些文件、设了哪些名字"（给报告用；**不含值**）。 */
const lastResult = { files: [], names: [], skipped: [] };

export function lastEnvLoad() {
  return { files: [...lastResult.files], names: [...lastResult.names], skipped: [...lastResult.skipped] };
}

/** 解析一份环境文件的内容（不碰文件系统，便于单测）。 */
export function parseEnvFile(text) {
  const out = {};
  for (const raw of String(text).split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let [, name, value] = m;
    // 去引号；双引号里允许 \n / \t
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      const q = value[0];
      value = value.slice(1, -1);
      if (q === '"') value = value.replace(/\\n/g, "\n").replace(/\\t/g, "\t");
    } else {
      const hash = value.indexOf(" #");
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    out[name] = value;
  }
  return out;
}

/**
 * 把环境文件里的值补进 `process.env`（**不覆盖**已存在的真变量）。
 * @returns {{files: string[], names: string[], skipped: string[]}}
 */
export function loadEnvFiles({ agentDir = null, envFile = null, override = false, env = process.env } = {}) {
  const candidates = [];
  const explicit = envFile ?? env.AGENT_ENV_FILE ?? null;
  if (explicit) candidates.push(path.resolve(explicit));
  if (agentDir) candidates.push(path.join(path.resolve(agentDir), ".env"));
  candidates.push(path.join(process.cwd(), ".env"));
  candidates.push(path.join(REPO, ".env"));

  for (const file of candidates) {
    if (!fs.existsSync(file)) { if (explicit && file === path.resolve(explicit)) lastResult.skipped.push(`${file}（AGENT_ENV_FILE 指定但不存在）`); continue; }
    if (lastResult.files.includes(file)) continue;   // 幂等：同一个文件只读一次
    let parsed;
    try { parsed = parseEnvFile(fs.readFileSync(file, "utf8")); } catch (e) { lastResult.skipped.push(`${file}（读取失败：${e.code ?? e.message}）`); continue; }
    lastResult.files.push(file);
    for (const [name, value] of Object.entries(parsed)) {
      if (!override && env[name] !== undefined && env[name] !== "") continue;   // 真环境变量优先
      env[name] = value;
      if (!lastResult.names.includes(name)) lastResult.names.push(name);
    }
  }
  return lastEnvLoad();
}
