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
import os from "node:os";
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

/**
 * 基座**平台层**的环境变量名（扫源码得到）。
 * 为什么要这个集合：README 里会同时提到两类名字 ——
 *   · 产品参数（由产物契约声明，例如 DEEPSEEK_BASE_URL）→ 必须在 runtimeParams 里
 *   · 基座平台变量（例如 AGENT_SECRETS_DIR / AGENT_PROVIDERS_FILE）→ 不属于产物契约
 * 不区分就会假阳性，而假阳性会被人用"关掉检查"来绕过，比没有检查更糟。
 */
let platformEnvNames = null;
function platformEnvVars() {
  if (platformEnvNames) return platformEnvNames;
  const names = new Set();
  const scan = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) { if (!/node_modules|dist|\.git/.test(e.name)) scan(f); continue; }
      if (!/\.(mjs|js|ts|json|yaml|md|sh|yml)$/.test(e.name)) continue;
      const t = fs.readFileSync(f, "utf8");
      for (const m of t.matchAll(/\b(AGENT_[A-Z0-9_]+)/g)) names.add(m[1]);
    }
  };
  for (const d of ["core", "tools", "adapters", "conformance"]) scan(path.join(REPO, d));
  platformEnvNames = names;
  return names;
}

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

    // 示例的 README 是**交付物的一部分**，不是装饰：别人 clone 下来要靠它把示例跑起来。
    // 所以这里把"必须讲清构建与验证过程"变成可执行的检查 —— 缺节 / 太空的 README 直接红。
    {
      const readme = path.join(dir, "README.md");
      const REQUIRED = ["## 它解决什么问题", "## 结构", "## 构建与验证过程", "## 改它", "## 已知边界"];
      if (!fs.existsSync(readme)) {
        line(false, "README.md 存在（示例必须能被人照着跑起来）");
      } else {
        const text = fs.readFileSync(readme, "utf8");
        const missing = REQUIRED.filter((h) => !text.includes(h));
        line(missing.length === 0, `README 必备小节齐备（缺：${missing.join(" / ") || "无"}）`);
        // 构建与验证过程必须是"能照着做"的：含真实命令、含期望结果
        const howto = text.slice(text.indexOf("## 构建与验证过程"), text.indexOf("## 改它"));
        const hasCommand = /```(bash|sh)?[\s\S]*?\b(make|node|docker)\b/.test(howto);
        const hasExpectation = /期望|应该看到|退出码|→|可用/.test(howto);
        line(hasCommand && howto.length > 400, `构建与验证过程写了可执行命令（${howto.length} 字）`);
        line(hasExpectation, "构建与验证过程写了期望结果（不是只说'跑一下'）");

        // README 里出现的**参数名**必须真的存在于产物契约里（`runtimeParams`）。
        // 为什么：这类名字最容易漂 —— 供应商改名/换供应商后，README 还在教一个已不存在的变量，
        // 照着做的人第一步就卡住（`routes-init` 那次就是这么坏的）。
        {
          // 判定"像运行期参数"：以 _URL/_KEY/_TOKEN/_ENDPOINT/_MODEL/_FILE 结尾的**大写**名字。
          // 早先只认 `_BASE_URL|_API_KEY|_MODEL` 三种后缀 —— 于是"把名字改成 DEEPSEEK_ENDPOINT_URL"
          // 这种错法根本不被检查（检查通过了，但它检查的是错的东西）。
          // 兼容 `<参数名>_FILE`（参数层支持的"从文件读值"写法）：比对时剥掉 _FILE。
          const mentioned = [...new Set([...text.matchAll(/`([A-Z][A-Z0-9_]{2,})`/g)].map((m) => m[1]))]
            .filter((n) => /_(URL|KEY|TOKEN|ENDPOINT|MODEL|FILE)$/.test(n))
            .map((n) => ({ raw: n, base: n.replace(/_FILE$/, "") }));
          if (mentioned.length) {
            const out = fs.mkdtempSync(path.join(os.tmpdir(), "ex-readme-params-"));
            const r = run([path.join(REPO, "adapters/pi/render.mjs"), dir, "--out", out]);
            let known = [];
            try {
              const m = JSON.parse(fs.readFileSync(path.join(out, "render-manifest.json"), "utf8"));
              known = (m.runtimeParams ?? []).map((x) => x.name);
            } catch { /* 渲染失败由上面的闸门报，这里不重复报 */ }
            const platform = platformEnvVars();
            const unknown = known.length
              ? mentioned.filter((m) => !known.includes(m.base) && !platform.has(m.base) && !platform.has(m.raw)).map((m) => m.raw)
              : [];
            line(known.length > 0 && unknown.length === 0,
              `README 里的参数名都在产物契约里（提到 ${mentioned.length} 个；既不是产品参数也不是平台变量：${unknown.join(", ") || "无"}）`);
          }
        }
      }
      // 结构清单里的文件必须真的存在（README 不许描述不存在的东西）
      // 注意：这一段的输入是 README，所以**必须**先确认它存在 —— 否则缺 README 的示例
      // 会让整个检查以未捕获 ENOENT 崩掉（那样连"缺 README"这条结论都拿不到）。
      if (fs.existsSync(readme)) {
      const listed = [...fs.readFileSync(readme, "utf8").matchAll(/`([A-Za-z0-9_.\/-]+\.(yaml|md|mjs|json))`/g)].map((m) => m[1]);
      // 相对示例目录、相对仓库根都算"存在"：README 里引用 docs/… 或 core/… 是合理的
      const ghost = [...new Set(listed)].filter((f) => !f.includes("..")
        && !fs.existsSync(path.join(dir, f)) && !fs.existsSync(path.join(REPO, f)));
        line(ghost.length === 0, `README 里提到的文件都存在（缺：${ghost.join(", ") || "无"}）`);
      }
    }

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

  // ---- 示例 Makefile 引用的基座脚本必须存在 ----
  // 为什么加这条：`routes` 改名 `provider` 之后，两个示例的 `make routes-init` 变成了
  // **调一个不存在的脚本**（另三个写出的默认文件名也还是旧的）——
  // 而当时的检查只看 README 与闸门，没人敲那条命令就发现不了。断链要在检查里拦住。
  process.stderr.write("\n── 示例 Makefile → 基座脚本的引用必须有效 ──\n");
  {
    const broken = [];
    for (const dir of fs.readdirSync(EXAMPLES, { withFileTypes: true }).filter((e) => e.isDirectory())) {
      const mf = path.join(EXAMPLES, dir.name, "Makefile");
      if (!fs.existsSync(mf)) { broken.push(`${dir.name}/Makefile 不存在`); continue; }
      const text = fs.readFileSync(mf, "utf8");
      for (const m of text.matchAll(/\$\(AGENT_BASE_DIR\)\/([A-Za-z0-9._\/-]+\.mjs)/g)) {
        if (!fs.existsSync(path.join(REPO, m[1]))) broken.push(`${dir.name}: 引用了不存在的 ${m[1]}`);
      }
    }
    line(broken.length === 0, `所有示例 Makefile 引用的脚本都存在${broken.length ? `（${broken.join("；")}）` : ""}`);
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
