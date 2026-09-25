// ============================================================================
// 预装清单解析器（统一设计 §4.3 设计点 4）
//
// 职责：把中性定义里的连接器声明，解析成**与 harness 无关的中间表示**。
//   · 完整形态 → 原样采用（开发者自己写的实现细节）
//   · ref 形态 → 从 core/image/preinstall.yaml 取出实现（包、精确 pin、transport、凭据引用名）
//
// 为什么放在基座而不是适配器里：
//   ① 「有哪些预装能力、pin 在哪个版本」是基座的能力，不是某个 harness 的机制；
//   ② 两个适配器必须解析出**同一份**结果，否则「同一份定义」这句话就不成立了；
//   ③ 适配器因此保持薄 —— 只做「中间表示 → 该 harness 原生形态」的翻译（§5.1）。
//
// 本文件必须保持 harness 无关（core/ 纪律）：不得出现任何 harness 名字。
// ============================================================================

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PREINSTALL_PATH = path.join(HERE, "preinstall.yaml");

/** kind 为 system 的条目不是连接器（如 shell 工具链），不能被 ref 引用。 */
const REFABLE_KINDS = new Set(["mcp"]);

/**
 * 读取预装清单。
 * @returns {{list: object, named: Record<string,string>, byId: Map<string, object>, byRefName: Map<string, object>}}
 */
export function loadPreinstall(file = PREINSTALL_PATH) {
  const list = YAML.parse(fs.readFileSync(file, "utf8"));
  const entries = list.entries ?? [];
  const byId = new Map(entries.map((e) => [e.id, e]));
  const byRefName = new Map(entries.filter((e) => e.refName).map((e) => [e.refName, e]));
  return { list, named: list.namedReferences ?? {}, byId, byRefName };
}

/** 开发者可见的引用名列表（用于错误信息里给出可用值）。 */
export function refNames(preinstall) {
  return Object.keys(preinstall.named).sort();
}

/**
 * 从预装条目推出 stdio 启动方式。
 * npm 形态 → `npx -y <pkg>@<version>`（版本来自清单的精确 pin，不由开发者写）。
 * system 形态不是连接器，调用方应先过滤。
 */
export function deriveStdioCommand(entry) {
  const install = entry.install ?? {};
  if (install.registry === "npm") {
    if (!install.package || !install.version) return null;
    return { command: "npx", args: ["-y", `${install.package}@${install.version}`] };
  }
  if (install.registry === "python") {
    if (!install.package) return null;
    return { command: install.command ?? "uvx", args: [install.package] };
  }
  return null;
}

/**
 * 解析一条连接器声明。
 * @returns {{server: object|null, problems: Array<{code:string, detail:string}>}}
 */
export function resolveConnector(decl, preinstall) {
  const problems = [];
  const enabled = decl.enabled !== false;
  const fallbackName = decl.name ?? decl.ref;

  // ---- ref 形态 ----
  if (decl.ref) {
    const entryId = preinstall.named[decl.ref];
    if (!entryId) {
      return {
        server: null,
        problems: [{
          code: "unknown-ref",
          detail: `ref「${decl.ref}」不在预装清单里；可用名字：${refNames(preinstall).join(", ") || "（无）"}`,
        }],
      };
    }
    const entry = preinstall.byId.get(entryId);
    if (!entry) {
      return { server: null, problems: [{ code: "dangling-ref-name", detail: `namedReferences.${decl.ref} 指向不存在的条目 ${entryId}` }] };
    }
    if (!REFABLE_KINDS.has(entry.kind)) {
      return { server: null, problems: [{ code: "ref-not-a-connector", detail: `ref「${decl.ref}」指向 kind=${entry.kind} 的条目，不是连接器` }] };
    }

    const server = {
      name: decl.name ?? decl.ref,
      ref: decl.ref,
      origin: "ref",
      transport: entry.transport,
      enabled,
      description: decl.description ?? entry.devUse ?? "",
      credentialRef: entry.credentialRef ?? null,
      urlRef: null,
      command: null,
      args: [],
      pin: entry.install?.registry ? { ...entry.install } : null,
    };

    if (server.transport === "stdio") {
      const cmd = deriveStdioCommand(entry);
      if (!cmd) {
        problems.push({ code: "ref-underivable-install", detail: `ref「${decl.ref}」的 install 无法推出启动命令（registry=${entry.install?.registry ?? "未写"}）` });
      } else {
        server.command = cmd.command;
        server.args = cmd.args;
      }
    } else if (server.transport === "streamable-http") {
      // 远程形态：端点必须来自参数层，但清单没写引用名 → 显式记为问题，而不是渲染出个空 URL
      problems.push({ code: "ref-remote-without-endpoint", detail: `ref「${decl.ref}」是远程形态，但预装条目没声明端点引用名（urlRef）` });
    }
    if (entry.credentials === "required" && !server.credentialRef) {
      problems.push({ code: "entry-missing-credential-ref", detail: `ref「${decl.ref}」要求凭据，但条目没写 credentialRef` });
    }
    return { server, problems };
  }

  // ---- 完整形态 ----
  const server = {
    name: fallbackName,
    ref: null,
    origin: "inline",
    transport: decl.transport,
    enabled,
    description: decl.description ?? "",
    credentialRef: decl.credentialRef ?? null,
    urlRef: decl.urlRef ?? null,
    command: decl.command ?? null,
    args: decl.args ?? [],
    pin: null,
  };
  return { server, problems };
}

/**
 * 解析整份 connectors 文档。
 * @returns {{servers: object[], problems: Array<{code:string,detail:string,server?:string}>, paramNames: string[]}}
 */
export function resolveConnectors(connectorsDoc, preinstall) {
  const servers = [];
  const problems = [];
  for (const decl of connectorsDoc?.mcpServers ?? []) {
    const { server, problems: p } = resolveConnector(decl, preinstall);
    for (const x of p) problems.push({ ...x, server: decl.name ?? decl.ref ?? "(未命名)" });
    if (server) servers.push(server);
  }
  const paramNames = [
    ...servers.filter((s) => s.urlRef).map((s) => s.urlRef),
    ...servers.filter((s) => s.credentialRef).map((s) => s.credentialRef),
  ];
  return { servers, problems, paramNames: [...new Set(paramNames)].sort() };
}
