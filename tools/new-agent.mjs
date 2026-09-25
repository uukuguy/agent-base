#!/usr/bin/env node
// ============================================================================
// 从模板派生一个智能体（统一设计 §12.2 / §12.3）
//
// 派生出来的东西**在基座之外**（§1.2：应用派生到基座之外，且不回头改基座）。
// 所以默认落在基座仓库的**同级目录**，而不是仓库内部。
//
// 「开箱可跑」的判据（§12.2）由 `make new-agent-selftest` 实际验证：
//   派生后立刻 `make validate && make render && make doctor` 全绿；
//   `grep -rn TODO` 为空；无 `package.json`；无绝对路径。
//
// 用法：node tools/new-agent.mjs NAME=my-agent [--out DIR] [--description "..."]
// 退出码：0 成功 / 2 用法错误 / 10 目标已存在或写入失败
// ============================================================================

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EXIT_CODES } from "../core/gates/index.mjs";
import { parseArgs } from "../core/gates/cli.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const TEMPLATE = path.join(REPO, "template");
const NAME_RE = /^[a-z][a-z0-9-]{1,30}$/;

const USAGE = [
  "用法: node tools/new-agent.mjs NAME=<my-agent> [--out DIR] [--description \"一句话说明\"]",
  "",
  "  NAME         智能体名：小写字母开头，仅含小写字母/数字/连字符，2–31 字符",
  "  --out        派生到哪（默认：基座仓库的同级目录 —— 应用在基座之外）",
  "  --description 一句话说明；不给就用占位说明，之后自己改 agent.yaml",
].join("\n") + "\n";

/** 环境变量里给的名字（`make new-agent NAME=x` 走这条路）。 */
function envName() {
  return process.env["NAME"];
}

/**
 * 解析符号链接后的真实路径（目标可能还不存在，那就解析它的父目录）。
 *
 * 为什么必须做：macOS 上 `/tmp` 与 `/var` 都是符号链接。若用未解析的路径去算相对路径，
 * 会得到一个"算式正确、实际指错"的结果 —— 因为 `make` 会规范化 CWD，
 * 于是从真实位置往上爬的级数对不上，基座路径整段错位（实测踩到：解析成了 /private/Users/...）。
 */
function realpath(p) {
  try { return fs.realpathSync(p); } catch { return path.join(fs.realpathSync(path.dirname(p)), path.basename(p)); }
}

/** 递归复制并把 {{占位符}} 替换掉；文本文件才替换，其余原样拷。 */
function materialize(from, to, vars) {
  const TEXT = /\.(yaml|yml|md|json|txt|mk)$|Makefile$|\.gitignore$/;
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const src = path.join(from, e.name);
    const dst = path.join(to, e.name);
    if (e.isDirectory()) { materialize(src, dst, vars); continue; }
    if (TEXT.test(e.name)) {
      let text = fs.readFileSync(src, "utf8");
      for (const [k, v] of Object.entries(vars)) text = text.split(`{{${k}}}`).join(v);
      fs.writeFileSync(dst, text);
    } else {
      fs.copyFileSync(src, dst);
    }
  }
}

/** 派生目录里不得残留任何占位符 —— 残留说明模板与生成器脱节了。 */
function findPlaceholders(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { findPlaceholders(p, acc); continue; }
    const text = fs.readFileSync(p, "utf8");
    const m = text.match(/\{\{[A-Z_]+\}\}/g);
    if (m) acc.push(`${path.relative(dir, p)}: ${[...new Set(m)].join(", ")}`);
  }
  return acc;
}

function main() {
  const { values, flags, positionals, errors } = parseArgs(process.argv.slice(2), {
    valueFlags: ["--out", "--description"],
  });
  if (flags.has("--help") || flags.has("-h")) { process.stderr.write(USAGE); process.exit(EXIT_CODES.ok); }
  if (errors.length) { process.stderr.write(errors.join("；") + "\n" + USAGE); process.exit(EXIT_CODES.usage); }

  // 名字的来源：--name > 位置参数 > 环境变量（`make new-agent NAME=x` 走环境变量，见 Makefile）。
  // 给了位置参数就当作名字来校验 —— 否则非法名字会被误报成"缺 NAME"。
  const name = values["--name"] ?? positionals[0] ?? envName();
  if (!name) { process.stderr.write("缺 NAME\n" + USAGE); process.exit(EXIT_CODES.usage); }
  if (!NAME_RE.test(name)) {
    process.stderr.write(`❌ NAME「${name}」不合法：需小写字母开头、仅含小写字母/数字/连字符、2–31 字符\n`);
    process.exit(EXIT_CODES.usage);
  }

  // 默认派生到**基座仓库之外**（同级目录）—— 应用不是基座的一部分
  const target = path.resolve(values["--out"] ?? path.join(REPO, "..", name));
  const relToBase = path.relative(realpath(target), realpath(REPO)).split(path.sep).join("/") || ".";
  const description = values["--description"] ?? "（一句话说明这个智能体做什么；请改成你自己的）";

  if (fs.existsSync(target) && fs.readdirSync(target).length) {
    process.stderr.write(`❌ ${target} 已存在且非空 —— 换一个名字或先清空\n`);
    process.exit(EXIT_CODES.static);
  }

  materialize(TEMPLATE, target, {
    NAME: name,
    DESCRIPTION: description,
    // 用**相对路径**而不是绝对路径：派生目录里不留绝对路径（§12.2），
    // 也便于把「基座 + 智能体」整体搬到一个新位置。
    AGENT_BASE_DIR: relToBase,
  });

  const leftovers = findPlaceholders(target);
  if (leftovers.length) {
    process.stderr.write(`❌ 模板占位符未全部替换：${leftovers.join("；")}\n`);
    process.exit(EXIT_CODES.static);
  }

  const steps = [
    `cd ${target}`,   // 给人看的提示就用绝对路径：相对链条（../../../../tmp/...）没人愿意读
    "make validate      # 先确认定义合法",
    "make verify        # 四道闸门，给出「可用 / 不可用」",
  ];
  process.stdout.write([
    `✅ 已派生：${target}`,
    `   基座位置（写进 Makefile 的相对路径）：${relToBase}`,
    "",
    "下一步：",
    ...steps.map((s, i) => `  ${i + 1}. ${s}`),
    "",
    "要改的东西都在这个目录里；基座不需要动。",
    "",
  ].join("\n"));
  process.exit(EXIT_CODES.ok);
}

main();
