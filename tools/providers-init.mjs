#!/usr/bin/env node
// ============================================================================
// 从**端点自己**问出"有哪些模型可用"，写成一份供应商目录。
//
// 解决的问题：`providers.yaml` 里的 `models` 名单如果靠人手填，就必然与实际端点漂移 ——
// 于是出现"我写了这个名字，闸门 1 说可用，运行时端点说不认识"。
// 让端点自己回答，名单就是**实测的**，不是记来的。
//
// 用法：
//   node tools/providers-init.mjs --endpoint https://gw.internal/v1 [--api-key …] \
//        [--provider corp-gateway] [--out providers.yaml] [--dry-run] [--json]
//
// 端点约定：OpenAI 兼容的 `GET <endpoint>/models`（本仓库自带的零凭据假网关也实现了它，
// 所以这条路径可以离线自测）。返回体依次尝试几种常见形状：
//   { data: [{ id }] } · { models: [{ name | id }] } · ["a","b"]
//
// 输出：默认写到 `--out`；没给就看 `AGENT_ROUTES_FILE`；再没有就写 `./providers.yaml`。
// 写出来的那份用 `AGENT_ROUTES_FILE=<路径>` 指给基座即可 —— **不需要改基座代码**。
// ============================================================================

import fs from "node:fs";
import path from "node:path";
import { EXIT_CODES, parseArgs } from "../core/gates/index.mjs";

const { values, flags, errors } = parseArgs(process.argv.slice(2), {
  valueFlags: ["--endpoint", "--api-key", "--provider", "--out", "--timeout"],
});
if (errors.length || !values["--endpoint"]) {
  process.stderr.write(
    "用法: node tools/providers-init.mjs --endpoint <baseUrl> [--api-key …] [--provider corp-gateway] [--out providers.yaml] [--dry-run] [--json]\n" +
    "     --endpoint 是供应商的 baseUrl（形如 https://gw.internal/v1）；本工具会去问 <endpoint>/models\n");
  process.exit(EXIT_CODES.usage);
}

const endpoint = values["--endpoint"].replace(/\/+$/, "");
const providerId = values["--provider"] ?? "corp-gateway";
const timeoutMs = Number(values["--timeout"] ?? 15000);
const asJson = flags.has("--json");
const dryRun = flags.has("--dry-run");

/** 与闸门 1 同一条命名规则：供应商名 → 引用名前缀。 */
const prefixOf = (id) => String(id).toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");

/** 从几种常见形状里取出模型名。 */
function extractModelIds(body) {
  if (Array.isArray(body)) return body.map((x) => (typeof x === "string" ? x : x?.id ?? x?.name)).filter(Boolean);
  if (Array.isArray(body?.data)) return body.data.map((x) => x?.id ?? x?.name).filter(Boolean);
  if (Array.isArray(body?.models)) return body.models.map((x) => (typeof x === "string" ? x : x?.id ?? x?.name)).filter(Boolean);
  return [];
}

/** 试一个 URL：成功返回 {ids}，失败返回 {error}。 */
async function fetchOne(url) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const headers = values["--api-key"] ? { Authorization: `Bearer ${values["--api-key"]}` } : {};
    const r = await fetch(url, { headers, signal: ac.signal });
    const text = await r.text();
    if (!r.ok) return { error: `GET ${url} → HTTP ${r.status}：${text.slice(0, 200)}` };
    let body;
    try { body = JSON.parse(text); } catch { return { error: `GET ${url} 的响应不是 JSON（前 200 字节：${text.slice(0, 200)}）` }; }
    const ids = extractModelIds(body);
    if (!ids.length) return { error: `GET ${url} 成功，但没解析出模型名（响应形状不认识：${JSON.stringify(body).slice(0, 200)}）` };
    return { ids: [...new Set(ids)].sort() };
  } catch (e) {
    return { error: `GET ${url} 失败：${e.name === "AbortError" ? `超时（${timeoutMs}ms）` : e.message}` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 端点约定不统一：有的把模型列表放在 `<base>/models`（官方 DeepSeek 就是），
 * 有的放在 `<base>/v1/models`（把 /v1 写在 base 里的那些客户端）。
 * 依次试，并把**哪个 URL 成功**说出来 —— 免得用户以为自己写错了 base。
 */
async function fetchModels() {
  const candidates = [`${endpoint}/models`, `${endpoint}/v1/models`];
  const tried = [];
  for (const url of candidates) {
    const r = await fetchOne(url);
    if (r.ids) return { ...r, url };
    tried.push(r.error);
    // 只有"路径不对"才值得换一个试；认证/网络问题换了也一样
    if (!/HTTP (404|405)/.test(r.error)) return { error: r.error };
  }
  return { error: tried.join("；") };
}

const got = await fetchModels();
if (got.error) {
  process.stderr.write(`❌ 问不到端点的模型列表：${got.error}\n`);
  process.stderr.write(
    "   排查：① 端点是否 OpenAI 兼容（有没有 GET /models）② 是否要凭据（--api-key 或 CORP_GATEWAY_API_KEY）\n" +
    "   ③ 这个环境是否根本拿不到端点（那也可以先手写 providers.yaml，用 AGENT_ROUTES_FILE 指过去）\n");
  process.exit(EXIT_CODES.probes);
}

if (asJson) process.stdout.write(JSON.stringify({ endpoint, modelsUrl: got.url, route: providerId, models: got.ids }, null, 2) + "\n");
else {
  process.stderr.write(`▶ ${got.url} 报告 ${got.ids.length} 个模型：\n`);
  for (const m of got.ids) process.stderr.write(`   · ${m}\n`);
}

if (dryRun) {
  process.stderr.write("（--dry-run：只问不写）\n");
  process.exit(EXIT_CODES.ok);
}

const out = path.resolve(values["--out"] ?? process.env.AGENT_ROUTES_FILE ?? "providers.yaml");
const prefix = prefixOf(providerId);
const doc = `apiVersion: agent-base/v1

# 由 tools/providers-init.mjs 从端点实测得到（${new Date().toISOString()}）
# 端点：${endpoint}
# 用法：AGENT_ROUTES_FILE=${out} make validate AGENT_DIR=<你的智能体>
routes:
  - id: ${providerId}
    description: ${endpoint}
    api: openai-completions
    baseUrlParam: ${prefix}_BASE_URL
    credentialParam: ${prefix}_API_KEY
    modelParam: ${prefix}_MODEL
    # 下面这份名单是**问端点问来的**，不是手填的 —— 名单与实际端点不会漂移
    models:
${got.ids.map((m) => `      - ${m}`).join("\n")}
`;
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, doc);
process.stderr.write(`\n✅ 已写入 ${out}\n   用它：AGENT_ROUTES_FILE=${out} make validate AGENT_DIR=<你的智能体>\n`);
process.exit(EXIT_CODES.ok);
