#!/usr/bin/env node
// ============================================================================
// 生成能力目录文档（docs/03-capability-catalog.md）
//
// ## 为什么要"生成"而不是手写
//
// 这篇文档的内容完全来自三份机器可读真源（`core/catalog/{capabilities,params,routes}.yaml`）。
// 手写的问题不是"写起来累"，而是**它会烂**：真源加了一个字段、文档没跟上，
// 两边都不会报错 —— 于是文档开始骗人，而且没人知道从哪一句开始骗的。
//
// 所以：真源是唯一真源，文档是它的投影；`make validate` 里有一项**同步检查**
// （`--check` 模式），不同步即失败。改了真源就跑 `make gen-docs`。
//
// 用法：
//   node tools/gen-capability-doc.mjs            # 生成/刷新
//   node tools/gen-capability-doc.mjs --check    # 只校验是否同步（不同步则非零退出）
// ============================================================================

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { EXIT_CODES, parseArgs } from "../core/gates/index.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const CATALOG = path.join(REPO, "core/catalog");
export const DOC_PATH = path.join(REPO, "docs/03-capability-catalog.md");

const load = (f) => YAML.parse(fs.readFileSync(path.join(CATALOG, f), "utf8"));

/** 表格单元格：把换行压平、竖线转义，避免把表撑坏。 */
const cell = (v) => String(v ?? "").replace(/\s*\n\s*/g, " ").replace(/\|/g, "\\|").trim() || "—";

/** 支持度 → 一眼能懂的记号。 */
const SUPPORT = { supported: "✅ 支持", partial: "⚠️ 有限制", unsupported: "❌ 不支持", extension: "🧩 靠扩展" };

function build() {
  const caps = load("capabilities.yaml");
  const params = load("params.yaml");
  const routes = load("routes.yaml");
  const harnesses = [...new Set(caps.groups.flatMap((g) => (g.fields ?? []).flatMap((f) => Object.keys(f.harnesses ?? {}))))].sort();

  const L = [];
  L.push("# 03 · 能力目录：有哪些东西可配");
  L.push("");
  L.push("> **本文件由脚本生成，不要手改。** 真源是 `core/catalog/{capabilities,params,routes}.yaml`；");
  L.push("> 改了真源就跑 `make gen-docs`。`make validate` 会检查二者同步 —— 不同步即失败。");
  L.push("> 之所以这样安排：手写文档不会报错地过期，然后开始骗人。");
  L.push("");
  L.push(caps.description ?? "");
  L.push("");
  L.push("## 所属层是什么意思");
  L.push("");
  for (const [layer, meaning] of Object.entries(caps.layerSemantics ?? {})) {
    L.push(`- **${cell(layer)}** —— ${cell(typeof meaning === "string" ? meaning : meaning.doc ?? meaning)}`);
  }
  L.push("");
  L.push("判据一句话：**这个字段改了，同一个输入会不会得到不同行为？** 会 → 制品层（烤进产物）；不会 → 参数层。");
  L.push("");

  for (const g of caps.groups ?? []) {
    L.push(`## ${cell(g.id)}${g.title ? ` · ${cell(g.title)}` : ""}`);
    L.push("");
    if (g.doc) { L.push(cell(g.doc)); L.push(""); }
    L.push(`| 字段 | 类型 | 所属层 | 必填 | 取值 | ${harnesses.map((h) => cell(h)).join(" | ")} | 说明 |`);
    L.push(`|---|---|---|---|---|${harnesses.map(() => "---").join("|")}|---|`);
    for (const f of g.fields ?? []) {
      const values = f.values
        ? (f.values.const ? `\`${f.values.const}\`` : (f.values.enum ? f.values.enum.map((v) => `\`${v}\``).join(" / ") : (f.values.pattern ? `\`${f.values.pattern}\`` : "—")))
        : (f.valueRef === "parameter" ? "（参数层）" : "—");
      const sup = harnesses.map((h) => {
        const s = f.harnesses?.[h];
        if (!s) return "—";
        return `${SUPPORT[s.support] ?? s.support}${s.verified === false ? "（未实测）" : ""}`;
      });
      L.push(`| \`${cell(f.path)}\` | ${cell(f.type)} | ${cell(f.layer)} | ${f.required ? "是" : "否"} | ${values} | ${sup.join(" | ")} | ${cell(f.doc)} |`);
    }
    L.push("");
    L.push(`<sub>来源：${cell((g.fields ?? [])[0]?.source)}</sub>`);
    L.push("");
  }

  L.push("## 参数层：哪些可以运行期注入，哪些禁止");
  L.push("");
  L.push(cell(params.description));
  L.push("");
  const nd = params.nameDerivation ?? {};
  L.push("**名字怎么来的**（两个运行时共用，`make validate` 会校验）：");
  L.push("");
  L.push("```");
  for (const line of String(nd.rule ?? "").split("\n")) L.push(line);
  L.push("```");
  if (nd.examples) {
    L.push("");
    for (const [k, v] of Object.entries(nd.examples)) L.push(`- ${cell(k)} → \`${cell(v)}\``);
  }
  L.push("");
  L.push("### 允许（allowed）");
  L.push("");
  L.push("| id | 种类 | 名字模式 | 含密钥 | 支撑哪些字段 | 说明 |");
  L.push("|---|---|---|---|---|---|");
  for (const a of params.allowed ?? []) {
    L.push(`| \`${cell(a.id)}\` | ${cell(a.kind)} | \`${cell(a.pattern)}\` | ${a.secret ? "是" : "否"} | ${(a.backs ?? []).map((b) => `\`${cell(b)}\``).join(" / ")} | ${cell(a.note)} |`);
  }
  L.push("");
  L.push("### 禁止（forbidden）");
  L.push("");
  L.push("这些内容**出现在中性定义里就是错的**（`make validate` 直接拒绝）：");
  L.push("");
  L.push("| id | 种类 | 禁止出现在 | 为什么 | 谁来拦 |");
  L.push("|---|---|---|---|---|");
  for (const f of params.forbidden ?? []) {
    L.push(`| \`${cell(f.id)}\` | ${cell(f.kind)} | ${(f.definitionPaths ?? []).map((p) => `\`${cell(p)}\``).join(" / ")} | ${cell(f.reason)} | ${cell(f.enforcedBy)} |`);
  }
  L.push("");

  L.push("## 模型路由目录");
  L.push("");
  L.push("`model.route` 写的必须是这里声明的路由（基座层能力，业务只选、不定义）。");
  L.push("");
  L.push("| 路由 | 协议形状 | 端点引用名 | 凭据引用名 | 说明 |");
  L.push("|---|---|---|---|---|");
  for (const r of routes.routes ?? []) {
    L.push(`| \`${cell(r.id)}\` | \`${cell(r.api)}\` | \`${cell(r.baseUrlParam)}\` | \`${cell(r.credentialParam)}\` | ${cell(r.description)} |`);
  }
  L.push("");
  L.push("换环境只改参数、不改定义；写错路由名 `make validate` 会当场拦下并列出可用取值。");
  L.push("");

  L.push("## 不变量");
  L.push("");
  for (const inv of caps.invariants ?? []) {
    L.push(`- ${cell(typeof inv === "string" ? inv : inv.doc ?? JSON.stringify(inv))}`);
  }
  L.push("");
  return L.join("\n");
}

function main() {
  const { flags } = parseArgs(process.argv.slice(2));
  const check = flags.has("--check");
  const generated = build();
  const exists = fs.existsSync(DOC_PATH);

  if (check) {
    if (!exists) {
      process.stderr.write("❌ 缺 docs/03-capability-catalog.md —— 跑 `make gen-docs` 生成\n");
      process.exit(EXIT_CODES.static);
    }
    if (fs.readFileSync(DOC_PATH, "utf8") !== generated) {
      process.stderr.write("❌ docs/03-capability-catalog.md 与 catalog 真源不同步 —— 跑 `make gen-docs` 刷新\n" +
        "   （不同步意味着：文档写的能力与机器实际认的不是一回事）\n");
      process.exit(EXIT_CODES.static);
    }
    process.stdout.write("✅ 能力目录文档与真源同步\n");
    process.exit(EXIT_CODES.ok);
  }

  fs.mkdirSync(path.dirname(DOC_PATH), { recursive: true });
  fs.writeFileSync(DOC_PATH, generated);
  process.stdout.write(`✅ 已生成 ${path.relative(REPO, DOC_PATH)}（${generated.split("\n").length} 行）\n`);
  process.exit(EXIT_CODES.ok);
}

main();
