#!/usr/bin/env node
// ============================================================================
// 启动期准备：把「运行期注入的参数」变成「可运行的产物」
//
//   node startup.mjs prepare   --artifact <产物目录> [--json]
//   node startup.mjs run       --artifact <产物目录> -- <运行时> [参数…]
//   node startup.mjs config-check --artifact <产物目录> [--json]
//
// ## 为什么需要它
//
// 「行为烤、参数下放」里**下放的那一半**必须有东西去接。需要接的有两类：
//
//   ① **端点 / 凭据 / 模型名**：环境属性，运行期注入。有的运行时原生会插值（走 `!!js`），
//      有的不会（配置里的 baseUrl 只能是字面量）⇒ 后者必须在启动期渲染一次。
//   ② **可写暂存**：产物按只读挂载，而运行时要往自己的配置目录里写会话/缓存 ⇒
//      复制一份可写副本再跑。**产物本身永不改写**（它是有摘要的，改了摘要就不成立了）。
//
// ## 这份脚本为什么是"机械的"
//
// 它**不认识任何具体运行时**：拷什么、设哪个环境变量、cwd 放哪、要不要渲染，
// 全部来自产物清单里的 `runtimePlan`（由各自的渲染器产出）。
// 于是"运行时的形状知识"留在适配器，启动脚本只做执行 —— 加第三个运行时不必改这里。
//
// ## 失败即失败
//
// 缺端点 / 缺凭据 / 模型名不在路由名单内 ⇒ **退出码 2**，信息里写清缺哪个引用名、
// 怎么提供（环境变量或 `…_FILE`）。静默降级（比如"没有凭据就换一个模型"）在这里是被禁止的。
// 凭据值**永不打印**。
// ============================================================================

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const EXIT_USAGE = 2;
const die = (msg) => { process.stderr.write(`❌ ${msg}\n`); process.exit(EXIT_USAGE); };

// --------------------------------------------------------------------------
// 参数解析（统一走 core/gates/cli.mjs 的写法不可能用在这里：镜像里不带 core/，
// 所以这里是最小实现 —— 仍然**不做**"跳过旗标值"的索引过滤，那正是本项目错过三次的坑）
// --------------------------------------------------------------------------
function parseArgs(argv) {
  const out = { artifact: null, runDir: null, json: false, rest: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--") { out.rest = argv.slice(i + 1); return out; }
    else if (a === "--artifact") { out.artifact = argv[i + 1]; i += 1; }
    else if (a === "--run-dir") { out.runDir = argv[i + 1]; i += 1; }
    else if (a === "--json") out.json = true;
    else out.rest.push(a);
  }
  return out;
}

const mask = (v) => (v === undefined || v === null || v === "" ? "(空)" : "***");

// --------------------------------------------------------------------------
// ① 参数解析：环境变量 → `…_FILE` 指向的文件 → 清单里的默认值 → 失败
// --------------------------------------------------------------------------
function resolveParams(manifest) {
  const declared = manifest.runtimeParams ?? [];
  const resolved = {};
  const problems = [];
  for (const p of declared) {
    let value;
    let source = null;
    const fromEnv = process.env[p.name];
    if (fromEnv !== undefined && fromEnv !== "") { value = fromEnv; source = "env"; }
    if (value === undefined) {
      const fileVar = process.env[`${p.name}_FILE`];
      if (fileVar) {
        if (!fs.existsSync(fileVar)) {
          problems.push(`${p.name}：${p.name}_FILE 指向的文件不存在（${fileVar}）`);
          continue;
        }
        try {
          // 兼容 secret 文件常见的结尾换行（K8s secret 挂载默认带）
          value = fs.readFileSync(fileVar, "utf8").replace(/\r?\n$/, "");
          source = `file:${fileVar}`;
        } catch (e) {
          problems.push(`${p.name}：读 ${fileVar} 失败（${e.code ?? e.message}）`);
          continue;
        }
      }
    }
    if (value === undefined && p.default !== undefined) { value = p.default; source = "definition-default"; }
    if (value === undefined && !p.required) { continue; }   // 非必填且无默认 ⇒ 不注入
    if (value === undefined) {
      problems.push(
        `${p.name} 未提供。两种给法：① 环境变量 ${p.name}=… ② 环境变量 ${p.name}_FILE=/path/to/secret（挂载文件，推荐给凭据）`);
      continue;
    }
    if (p.validate === "in-route-models") {
      const allowed = manifest.modelRouteModels ?? [];
      if (allowed.length && !allowed.includes(value)) {
        problems.push(
          `${p.name}「${value}」不在路由 ${manifest.modelRoutes?.[0] ?? "?"} 声明的模型名单内。该路由提供：${allowed.join(", ")}`);
        continue;
      }
    }
    resolved[p.name] = { value, source, secret: p.secret === true };
  }
  return { declared, resolved, problems };
}

// --------------------------------------------------------------------------
// ② 暂存可写副本（产物只读；改的永远是副本）
// --------------------------------------------------------------------------
function stage(artifactDir, plan, runDir) {
  fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const copied = [];
  for (const rel of plan.copy ?? []) {
    const src = path.join(artifactDir, rel);
    if (!fs.existsSync(src)) die(`产物里缺 ${rel}（清单的 runtimePlan.copy 声明了它）—— 产物不完整`);
    const dst = path.join(runDir, rel);
    fs.rmSync(dst, { recursive: true, force: true });
    fs.cpSync(src, dst, { recursive: true });
    copied.push(rel);
  }
  // 把产物里写死的**镜像内路径**改写成运行目录下的实际路径（只改副本）
  for (const rw of plan.pathRewrites ?? []) {
    const to = path.isAbsolute(rw.to) ? rw.to : path.join(runDir, rw.to);
    rewriteInTree(runDir, rw.from, to);
  }
  return copied;
}

function rewriteInTree(root, from, to) {
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    const f = path.join(root, e.name);
    if (e.isDirectory()) { rewriteInTree(f, from, to); continue; }
    let text;
    try { text = fs.readFileSync(f, "utf8"); } catch { continue; }   // 二进制跳过
    if (!text.includes(from)) continue;
    fs.writeFileSync(f, text.split(from).join(to));
  }
}

// --------------------------------------------------------------------------
// ③ 渲染参数（只在该运行时的产物确实需要时）
// --------------------------------------------------------------------------
/** 把 JSON 里的 `${NAME}` 占位换掉；替换后仍有占位 ⇒ 失败（不许留下半个配置）。 */
function renderJsonValue(node, values, problems, where) {
  if (typeof node === "string") {
    const exact = /^\$\{([A-Z][A-Z0-9_]*)\}$/.exec(node);
    if (exact) {
      if (!(exact[1] in values)) { problems.push(`${where}: 占位 \${${exact[1]}} 没有对应的运行期参数`); return node; }
      return values[exact[1]];
    }
    return node.replace(/\$\{([A-Z][A-Z0-9_]*)\}/g, (m, n) => {
      if (!(n in values)) { problems.push(`${where}: 占位 \${${n}} 没有对应的运行期参数`); return m; }
      return values[n];
    });
  }
  if (Array.isArray(node)) return node.map((x) => renderJsonValue(x, values, problems, where));
  if (node && typeof node === "object") {
    const o = {};
    for (const [k, v] of Object.entries(node)) o[k] = renderJsonValue(v, values, problems, where);
    return o;
  }
  return node;
}

function atomicWrite(file, text) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function renderParams(runDir, values) {
  const written = [];
  const problems = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) { walk(f); continue; }
      if (e.name.endsWith(".tmpl")) {
        const target = f.slice(0, -".tmpl".length);
        const raw = fs.readFileSync(f, "utf8");
        if (!raw.includes("${")) continue;                 // 不含占位就不必产出同名文件
        let parsed;
        try { parsed = JSON.parse(raw); } catch (err) {
          problems.push(`${path.relative(runDir, f)}: 模板不是合法 JSON（${err.message}）`);
          continue;
        }
        const rendered = renderJsonValue(parsed, values, problems, path.relative(runDir, f));
        atomicWrite(target, `${JSON.stringify(rendered, null, 2)}\n`);
        written.push(path.relative(runDir, target));
      } else if (e.name.endsWith(".json")) {
        const raw = fs.readFileSync(f, "utf8");
        if (!raw.includes("${")) continue;
        let parsed;
        try { parsed = JSON.parse(raw); } catch { continue; }   // 不是配置就别动
        const rendered = renderJsonValue(parsed, values, problems, path.relative(runDir, f));
        const text = `${JSON.stringify(rendered, null, 2)}\n`;
        if (text !== raw) { atomicWrite(f, text); written.push(path.relative(runDir, f)); }
      }
    }
  };
  walk(runDir);
  return { written, problems };
}

// --------------------------------------------------------------------------
// 主流程
// --------------------------------------------------------------------------
function prepare({ artifact, runDir }) {
  if (!artifact) die("缺 --artifact <产物目录>");
  if (!fs.existsSync(artifact)) die(`找不到产物目录：${artifact}`);
  const manifestFile = path.join(artifact, "render-manifest.json");
  if (!fs.existsSync(manifestFile)) die(`找不到产物清单：${manifestFile}（产物不完整？）`);
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  const plan = manifest.runtimePlan ?? {};

  const { declared, resolved, problems } = resolveParams(manifest);
  if (problems.length) {
    process.stderr.write("❌ 运行期配置不完整，启动中止（不做静默降级）：\n");
    for (const p of problems) process.stderr.write(`   · ${p}\n`);
    process.exit(EXIT_USAGE);
  }

  const work = runDir ?? process.env.AGENT_RUN_DIR ?? "/run/agent-base";
  let effectiveRunDir = work;
  try { fs.mkdirSync(effectiveRunDir, { recursive: true, mode: 0o700 }); } catch {
    effectiveRunDir = path.join(os.tmpdir(), "agent-base-run");
    fs.mkdirSync(effectiveRunDir, { recursive: true, mode: 0o700 });
  }

  const copied = stage(artifact, plan, effectiveRunDir);
  const values = Object.fromEntries(Object.entries(resolved).map(([k, v]) => [k, v.value]));
  const render = manifest.rendersParams ? renderParams(effectiveRunDir, values) : { written: [], problems: [] };
  if (render.problems.length) {
    process.stderr.write("❌ 启动期渲染失败（产物里有无法解析的占位）：\n");
    for (const p of render.problems) process.stderr.write(`   · ${p}\n`);
    process.exit(EXIT_USAGE);
  }

  // 运行时环境：清单声明"哪个环境变量指向运行目录里的哪个相对路径"
  const env = {};
  for (const [name, rel] of Object.entries(plan.env ?? {})) env[name] = path.join(effectiveRunDir, rel);
  const cwd = plan.cwd ? path.join(effectiveRunDir, plan.cwd) : process.cwd();

  return {
    manifest,
    plan,
    declared,
    resolved,
    values,
    runDir: effectiveRunDir,
    copied,
    rendered: render.written,
    env,
    cwd,
    effectiveConfigDigest: manifest.effectiveConfigDigest ?? null,
  };
}

function summarize(r) {
  const lines = [];
  lines.push(`产物：${r.manifest.agent ?? "(未知智能体)"}（${r.manifest.harness ?? "?"} ${r.manifest.harnessVersion ?? ""}）`);
  lines.push(`运行目录：${r.runDir}${r.copied.length ? `（暂存：${r.copied.join(", ")}）` : ""}`);
  for (const [k, v] of Object.entries(r.env)) lines.push(`  ${k} = ${v}`);
  lines.push(`工作目录：${r.cwd}`);
  lines.push("运行期参数：");
  for (const p of r.declared) {
    const got = r.resolved[p.name];
    const shown = p.secret ? mask(got?.value) : (got?.value ?? "(未提供)");
    lines.push(`  ${p.name} = ${shown}${got ? `  [来源 ${got.source}]` : ""}`);
  }
  if (r.rendered.length) lines.push(`启动期渲染：${r.rendered.join(", ")}`);
  if (r.effectiveConfigDigest) lines.push(`生效配置摘要：${r.effectiveConfigDigest}`);
  return lines.join("\n");
}

function jsonOut(r) {
  // 凭据**绝不**进 JSON：只报"是否有值"与来源
  const params = {};
  for (const p of r.declared) {
    const got = r.resolved[p.name];
    params[p.name] = got ? { provided: true, source: got.source, secret: p.secret === true, ...(p.secret ? {} : { value: got.value }) } : { provided: false };
  }
  return JSON.stringify({
    agent: r.manifest.agent, harness: r.manifest.harness,
    runDir: r.runDir, cwd: r.cwd, env: r.env,
    copied: r.copied, rendered: r.rendered,
    effectiveConfigDigest: r.effectiveConfigDigest,
    params,
  }, null, 2);
}

function resolveExecutable(bin) {
  if (bin.includes("/")) return fs.existsSync(bin) ? bin : null;
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (!dir) continue;
    const p = path.join(dir, bin);
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* 继续找 */ }
  }
  return null;
}

// --------------------------------------------------------------------------
// 入口
// --------------------------------------------------------------------------
const argv = process.argv.slice(2);
const sub = argv[0];
const args = parseArgs(argv.slice(1));

if (sub === "config-check") {
  // 只校验，不写盘、不暂存 —— 就绪探针用（K8s readinessProbe / 部署前的自检）
  const r = prepare({ artifact: args.artifact, runDir: null });
  // 校验通过后把刚建的运行目录清掉：config-check 不应有副作用
  try { fs.rmSync(r.runDir, { recursive: true, force: true }); } catch { /* 尽力而为 */ }
  process.stdout.write((args.json ? jsonOut(r) : summarize(r)) + "\n");
  // 结论行走 stderr：stdout 是**机器通道**（`--json` 时必须是纯 JSON），
  // 把人类可读的确认混进去会让下游解析失败。
  process.stderr.write("✅ 配置自检通过：运行期参数齐备，产物可运行\n");
  process.exit(0);
}

if (sub === "prepare") {
  const r = prepare({ artifact: args.artifact, runDir: args.runDir });
  process.stdout.write((args.json ? jsonOut(r) : summarize(r)) + "\n");
  process.exit(0);
}

if (sub === "run") {
  await (async () => {
  if (!args.rest.length) die("用法：startup.mjs run --artifact <目录> -- <运行时> [参数…]");
  const r = prepare({ artifact: args.artifact, runDir: args.runDir });
  process.stderr.write(summarize(r) + "\n");
  const [bin, ...rest] = args.rest;
  const exe = resolveExecutable(bin);
  if (!exe) die(`镜像里没有可执行文件「${bin}」—— 不会用别的运行时替代（那会让跨运行时结论失真）`);

  // 运行期参数必须进子进程环境：`…_FILE` 形式的凭据要在这里变成真值，
  // 否则原生走 `process.env` 插值的运行时会读到空（"配了没生效"的经典形态）。
  const env = { ...process.env, ...r.env };
  for (const [k, v] of Object.entries(r.values)) env[k] = v;
  if (r.effectiveConfigDigest && !env.AGENT_EFFECTIVE_CONFIG_DIGEST) env.AGENT_EFFECTIVE_CONFIG_DIGEST = r.effectiveConfigDigest;

  // 为什么是 spawn 而不是 execve：**退出码契约要求"崩溃留证据"**（§6.7 / C10）——
  // 被信号杀掉（≥128）要映射成退出码 50，并把轨迹末 N 行 + 生效配置摘要打到 stderr。
  // 真 exec 会把进程交出去，就没人做这件事了。契约优先于"少一层"的优雅。
  // 调用形态由产物的运行期契约声明（`@agent` = 智能体名）—— 这里不猜"谁需要位置参数"。
  // 注意 spawn 的 args **不含程序名**：Node 自己把 exe 设为 argv[0]，对 shebang 脚本内核还会再插一次
  // 脚本路径。若这里再塞一次 exe，参数里就多出一个自身路径 —— 有的运行时容忍（看不出问题），
  // 有的会把它当第一个位置参数（报出「profile 名是 /usr/local/bin/…」这种看不懂的错）。
  const prefix = (r.plan?.argvPrefix ?? []).map((a) => (a === "@agent" ? (r.manifest.agent ?? "") : a));
  const child = spawn(exe, [...prefix, ...rest], { stdio: "inherit", env, cwd: r.cwd });
  // 交互式使用要能 Ctrl-C：转发信号（否则信号只到本进程，子进程变孤儿）
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(sig, () => { try { child.kill(sig); } catch { /* 已退出 */ } });
  }
  const code = await new Promise((res) => {
    child.on("close", (c, signal) => res(signal ? 128 + (os.constants.signals[signal] ?? 0) : (c ?? 0)));
    child.on("error", (e) => { process.stderr.write(`❌ 启动运行时失败：${e.message}\n`); res(EXIT_USAGE); });
  });

  if (code >= 128) {
    // 崩溃留证据：容器里只留一句"退出码 137"等于没留
    const tail = Number(process.env.AGENT_CRASH_TAIL_LINES ?? 30);
    const trace = process.env.AGENT_TRACE_DEST;
    let variant = "unknown";
    try { variant = fs.readFileSync(process.env.AGENT_BASE_VARIANT_FILE ?? "/etc/agent-base-variant", "utf8").trim(); } catch { /* 未知 */ }
    process.stderr.write(
      `❌ 未预期崩溃：退出码 ${code}（信号 ${code - 128}）\n` +
      `  variant=${variant} harness=${bin} artifact=${args.artifact}\n` +
      `  effectiveConfigDigest=${r.effectiveConfigDigest ?? "（未设置）"}\n`);
    if (trace && fs.existsSync(trace)) {
      const lines = fs.readFileSync(trace, "utf8").split("\n").filter(Boolean);
      process.stderr.write(`  轨迹末 ${tail} 行（${trace}）：\n${lines.slice(-tail).join("\n")}\n`);
    } else {
      process.stderr.write("  （没有轨迹文件：AGENT_TRACE_DEST 未设置或未产出）\n");
    }
    process.exit(50);
  }
  process.exit(code);
  })();
}

process.stderr.write("用法：startup.mjs {prepare|run|config-check} --artifact <产物目录> [--run-dir <目录>] [--json]\n");
process.exit(EXIT_USAGE);
