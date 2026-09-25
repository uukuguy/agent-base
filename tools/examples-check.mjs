#!/usr/bin/env node
// ============================================================================
// 示例自检（§13 N5 / S4）
//
// 对 `examples/` 下每个示例逐项验：
//   ① 闸门 1 静态校验
//   ② 四道闸门（= `verify`，必须给出「可用」）
//   ③ 标签表形状（基座不解释业务词，但形状要合法）
//   ④ 技能脚本的自检（脚本是示例的一部分，它自己也得能被验证）
//
// **并且**验证不变量 N5：`examples/` 整个删掉后，基座仍能 `make validate` + `conformance`。
// 本条不是空话 —— 基座工具从不扫描 `examples/`，这个自检顺带把它钉住（见 N5 检查）。
//
// 用法：node tools/examples-check.mjs [--fast]（--fast 跳过四道闸门，只跑结构与脚本自检）
// 退出码：0 全部通过 / 1 有失败
// ============================================================================

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { EXIT_CODES, parseArgs } from "../core/gates/index.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const EXAMPLES = path.join(REPO, "examples");

/** 仓库里当前接入的运行时（按目录发现，不写死）。 */
function harnessesPresent() {
  return fs.readdirSync(path.join(REPO, "adapters"), { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(REPO, "adapters", e.name, "adapter.yaml")))
    .map((e) => e.name).sort();
}

const run = (args, opts = {}) => spawnSync(process.execPath, args, { encoding: "utf8", cwd: REPO, timeout: 900000, ...opts });

/** 递归找出技能目录下的脚本（技能脚本落点：skills/<name>/scripts/）。 */
function skillScripts(dir, acc = []) {
  const skills = path.join(dir, "skills");
  if (fs.existsSync(skills)) {
    for (const name of fs.readdirSync(skills)) {
      const scripts = path.join(skills, name, "scripts");
      if (!fs.existsSync(scripts)) continue;
      for (const f of fs.readdirSync(scripts)) if (/\.(mjs|js)$/.test(f)) acc.push(path.join(scripts, f));
    }
  }
  return acc;
}

const main = () => {
  const { flags } = parseArgs(process.argv.slice(2));
  const fast = flags.has("--fast");

  if (!fs.existsSync(EXAMPLES)) {
    process.stderr.write("examples/ 不存在 —— 无示例可查（基座不依赖它，这不是错误）\n");
    process.exit(EXIT_CODES.ok);
  }
  const examples = fs.readdirSync(EXAMPLES, { withFileTypes: true })
    .filter((e) => e.isDirectory()).map((e) => e.name).sort();
  if (!examples.length) {
    process.stderr.write("examples/ 下没有示例目录\n");
    process.exit(EXIT_CODES.ok);
  }

  let failures = 0;
  const line = (ok, msg) => { if (!ok) failures++; process.stderr.write(`  ${ok ? "✅" : "❌"} ${msg}\n`); };

  for (const name of examples) {
    const dir = path.join(EXAMPLES, name);
    process.stderr.write(`\n── examples/${name} ──\n`);

    const v = run([path.join(HERE, "validate.mjs"), dir]);
    line(v.status === 0, `闸门 1 静态校验（退出码 ${v.status}）`);
    if (v.status !== 0) process.stderr.write((v.stderr ?? "").split("\n").filter((l) => l.includes("❌")).slice(0, 5).join("\n") + "\n");

    const labels = run([path.join(REPO, "tools/trace-view/labels.mjs"), dir]);
    line(labels.status === 0, `标签表形状（退出码 ${labels.status}）`);

    for (const script of skillScripts(dir)) {
      const s = run([script, "--selftest"]);
      line(s.status === 0, `技能脚本自检 ${path.relative(dir, script)}（退出码 ${s.status}）`);
      if (s.status !== 0) process.stderr.write((s.stderr ?? "").slice(-300) + "\n");
    }

    if (!fast) {
      // **每个示例都要在每个运行时上给出「可用」** —— 这正是"可移植"这句承诺的可执行形态。
      // 只验一个运行时，等于把"可移植"留成口号。
      for (const h of harnessesPresent()) {
        const out = path.join(REPO, "dist", h, name);
        const vf = run([path.join(HERE, "verify.mjs"), dir, "--harness", h, "--out", out]);
        const usable = /可用：四道闸门全过/.test(`${vf.stdout}${vf.stderr}`);
        line(vf.status === 0 && usable, `${h}：四道闸门 → ${usable ? "可用" : "**不可用**"}（退出码 ${vf.status}）`);
        if (!usable) process.stderr.write((vf.stderr ?? "").split("\n").slice(-12).join("\n") + "\n");
      }

      // 多运行时下再比一次等价性：三组集合一致、差异都有声明（不许沉默不等价）
      const hs = harnessesPresent();
      if (hs.length > 1) {
        const cmp = run([path.join(HERE, "compare.mjs"), dir]);
        const equivalent = /等价性通过/.test(`${cmp.stdout}${cmp.stderr}`);
        line(cmp.status === 0 && equivalent, `跨运行时等价性 → ${equivalent ? "通过" : "**未通过**"}（${hs.join(" / ")}）`);
        if (!equivalent) process.stderr.write((cmp.stderr ?? cmp.stdout ?? "").split("\n").slice(-12).join("\n") + "\n");
      }
    }
  }

  // ---- N5：examples/ 可整体删除，基座仍绿 ----
  process.stderr.write("\n── 不变量 N5：基座不依赖 examples/ ──\n");
  const baseValidate = run([path.join(HERE, "validate.mjs")]);
  line(baseValidate.status === 0, "基座自洽（make validate，不含任何智能体定义）");

  // 静态确认：core/ 与 tools/ 里没有任何对 examples/ 的引用
  const refs = [];
  const scan = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (!/node_modules|dist/.test(e.name)) scan(p); continue; }
      if (!/\.(mjs|js|json|yaml)$/.test(e.name)) continue;
      // 检查器自身当然会提到 examples/ —— 它不是基座工具，而是"查示例"的工具，排除掉
      if (path.resolve(p) === path.resolve(fileURLToPath(import.meta.url))) continue;
      if (fs.readFileSync(p, "utf8").includes("examples/")) refs.push(path.relative(REPO, p));
    }
  };
  scan(path.join(REPO, "core"));
  scan(path.join(REPO, "tools"));
  scan(path.join(REPO, "adapters"));
  line(refs.length === 0, `core/ tools/ adapters/ 里没有对 examples/ 的引用${refs.length ? `（发现：${refs.join(", ")}）` : ""}`);

  process.stderr.write(`\n${failures === 0 ? "示例自检：全绿" : `示例自检：失败 ${failures} 项`}\n`);
  process.exit(failures === 0 ? EXIT_CODES.ok : 1);
};

main();
