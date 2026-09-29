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
// 启动期要读 overlay.yaml（接入缝）。**镜像里必须能解析到它** —— 见 Dockerfile 的 npm install --prefix
import YAML from "yaml";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

// 能力包（L4/B1）：运行期的**选择**在这一层校验与解析（选择型参数，与环境型分开记账）
import { BUNDLES_ENV, availableIds, bundleDigest, defaultSelection, loadBundles, parseSelection } from "../bundles/index.mjs";
import { enforceConnectorSurface, enforcePluginSurface, enforceSkillSurface } from "../bundles/filter.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
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
/**
 * 读一个"值来源"文件：容忍结尾换行（K8s secret 挂载会带，但文件来源不限于 K8s）。
 * @returns {{ok: true, value: string} | {ok: false, reason: string}}
 */
function readValueFile(file) {
  if (!fs.existsSync(file)) return { ok: false, reason: `文件不存在（${file}）` };
  try {
    return { ok: true, value: fs.readFileSync(file, "utf8").replace(/\r?\n$/, "") };
  } catch (e) {
    return { ok: false, reason: `读 ${file} 失败（${e.code ?? e.message}）` };
  }
}

/**
 * 解析运行期参数。
 *
 * **四种给法，没有哪一种被假定为"标准"**（实际环境很杂：有人直接 docker run、
 * 有人包在编排里、有人在 CI 里跑、有人在机器上手工跑）：
 *
 *   ① 环境变量           NAME=VALUE
 *   ② 指向文件           NAME_FILE=/path/to/file
 *   ③ 凭据目录           AGENT_SECRETS_DIR=/dir   → 取 /dir/NAME 作为值
 *   ④ 中性定义里的默认值（仅当该参数声明了 default）
 *
 * **优先级固定且只有这一处实现**：① > ② > ③ > ④。缺必填项即失败（退出码 2），点名引用名并列出**全部**给法。
 */
function resolveParams(manifest) {
  const declared = manifest.runtimeParams ?? [];
  const resolved = {};
  const problems = [];
  const secretsDir = process.env.AGENT_SECRETS_DIR || null;
  for (const p of declared) {
    let value;
    let source = null;
    const fromEnv = process.env[p.name];
    if (fromEnv !== undefined && fromEnv !== "") { value = fromEnv; source = "env"; }
    if (value === undefined) {
      const fileVar = process.env[`${p.name}_FILE`];
      if (fileVar) {
        const r = readValueFile(fileVar);
        if (!r.ok) { problems.push(`${p.name}：${p.name}_FILE ${r.reason}`); continue; }
        value = r.value; source = `file:${fileVar}`;
      }
    }
    if (value === undefined && secretsDir) {
      const inDir = path.join(secretsDir, p.name);
      if (fs.existsSync(inDir)) {
        const r = readValueFile(inDir);
        if (!r.ok) { problems.push(`${p.name}：AGENT_SECRETS_DIR 下的文件 ${r.reason}`); continue; }
        value = r.value; source = `secrets-dir:${inDir}`;
      }
    }
    if (value === undefined && p.default !== undefined) { value = p.default; source = "definition-default"; }
    if (value === undefined && !p.required) { continue; }   // 非必填且无默认 ⇒ 不注入
    if (value === undefined) {
      problems.push(
        `${p.name} 未提供。给法（任选其一）：` +
        `① 环境变量 ${p.name}=…　② 环境变量 ${p.name}_FILE=/path/to/value　` +
        `③ 凭据目录 AGENT_SECRETS_DIR=/dir（读 /dir/${p.name}）`);
      continue;
    }
    if (p.validate === "in-provider-models") {
      const allowed = manifest.modelProviderModels ?? [];
      if (allowed.length && !allowed.includes(value)) {
        problems.push(
          `${p.name}「${value}」不在供应商 ${manifest.modelProviders?.[0] ?? "?"} 声明的模型名单内。它提供：${allowed.join(", ")}`);
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

/**
 * 应用"接入缝"（上层镜像带进来的业务代码与钩子）。
 *
 * 为什么需要（P3）：扩展必须在**产物**里才会被加载，而派生镜像里没有渲染器 ——
 * "上层加钩子"这条路被实际挡住。做法：overlay 目录按**产物同构**的布局摆文件，
 * 启动期**只改暂存副本**：
 *   ① 拷 `extensions/**` 与 `business/**` 进副本
 *   ② 把 `enhancements` 并进副本的 `enhancements.yaml`（闸门 2 的集合断言因此覆盖它）
 *   ③ 把扩展路径追加进 `settings.json.extensions`（该运行时从这里加载扩展）
 * 产物本身一个字节都不动。
 */
function applyOverlay(runDir, harnessName, overlayDir, hookEvents = null) {
  if (!overlayDir || !fs.existsSync(overlayDir)) return null;
  const manifestFile = path.join(overlayDir, "overlay.yaml");
  if (!fs.existsSync(manifestFile)) {
    die(`overlay 目录存在但缺 overlay.yaml：${overlayDir}（无法判断要带什么进来；不猜）`);
  }
  let doc;
  try { doc = YAML.parse(fs.readFileSync(manifestFile, "utf8")); }
  catch (e) { die(`overlay.yaml 解析失败：${e.message}`); }

  const want = doc?.harness ?? null;
  if (want && want !== harnessName) {
    die(`overlay.yaml 声明 harness=${want}，当前运行时是 ${harnessName} —— 不匹配（不猜、不静默跳过）`);
  }
  // 接入缝的**装载方式由该运行时的产物布局决定**：当前只实现了"扩展目录 + settings.extensions"
  // 这一种形态（`settings.json` 里登记扩展路径）。换一个装载形态（例如把插件写成组合树里的行）
  // 需要各自适配器声明并实现 —— 见路线图 P3。
  const settingsFile0 = path.join(runDir, "settings.json");
  if (!fs.existsSync(settingsFile0)) {
    die(`接入缝暂不支持该运行时的装载形态：暂存副本里没有 settings.json（找不到登记扩展的地方）`
      + ` —— 这不是"跳过"，是没实现；见路线图 P3`);
  }

  const copied = [];
  for (const sub of ["extensions", "business"]) {
    const src = path.join(overlayDir, sub);
    if (!fs.existsSync(src)) continue;
    fs.cpSync(src, path.join(runDir, sub), { recursive: true });
    for (const f of fs.readdirSync(src)) copied.push(`${sub}/${f}`);
  }

  const declared = Array.isArray(doc?.enhancements) ? doc.enhancements : [];
  const enhFile = path.join(runDir, "enhancements.yaml");
  if (declared.length) {
    if (!fs.existsSync(enhFile)) die("overlay 声明了增强，但暂存副本里没有 enhancements.yaml（产物不完整？）");

    // ---- 钩子事件名：**接入缝这条路径也要对名字**（路线图 §23 E1b）----
    // 产物清单里带着该运行时的可订阅事件集合（E1 的契约面）。overlay 是"上层镜像在镜像内加钩子"
    // 的主要路径，写错事件名的后果同样是"配了但永远不会触发" —— 在这里当场拦住，别等到线上看行为。
    // enumerated=false（该运行时还没穷举集合）时**不做假校验**，但要如实提示一次。
    const hookSet = hookEvents ?? null;
    for (const e of declared.filter((x) => x?.kind === "hook")) {
      const names = Array.isArray(e.events) ? e.events : [];
      if (!names.length) die(`overlay 的钩子增强 ${e.id} 没写 events —— 钩子必须说明订阅哪些事件`);
      if (hookSet?.enumerated === true) {
        const bad = names.filter((n) => !(hookSet.events ?? []).includes(n));
        if (bad.length) {
          die(`overlay 的钩子增强 ${e.id} 订阅了该运行时不存在的 ${bad.length} 个事件：${bad.join(", ")}`
            + `（产物清单里声明的 ${hookSet.events?.length ?? 0} 个可订阅事件里没有 —— 写错事件名的钩子永远不会触发）`);
        }
      } else if (hookSet?.enumerated === false) {
        process.stderr.write(`ℹ️  overlay 钩子 ${e.id} 的事件名未校验（该运行时的可订阅集合未穷举）⇒ 按「未验证」处理\n`);
      }
    }

    const cur = YAML.parse(fs.readFileSync(enhFile, "utf8")) ?? {};
    const byId = new Map((cur.enhancements ?? []).map((e) => [e.id, e]));
    for (const e of declared) byId.set(e.id, e);      // 同 id 以 overlay 为准（它就是最后写入者）
    fs.writeFileSync(enhFile, YAML.stringify({
      ...cur,
      note: `${cur.note ?? ""} + overlay`.trim(),
      enhancements: [...byId.values()],
    }));
  }

  const settingsFile = settingsFile0;
  if (fs.existsSync(settingsFile)) {
    const settings = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
    const list = new Set(settings.extensions ?? []);
    for (const rel of copied.filter((c) => c.startsWith("extensions/")).map((c) => c.replace(/^extensions\//, ""))) {
      if (rel !== "_trace-emit.mjs") list.add(`extensions/${rel}`);
    }
    settings.extensions = [...list].sort();
    fs.writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`);
  }

  return { dir: overlayDir, copied, declared: declared.length };
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

  // ---- 能力包（L4/B1）：运行期**选择**的校验 ----
  // 合法取值集合烤在制品里（清单的 `bundles.available`）；写一个不存在的包名 ⇒ **响亮失败**，
  // 不许静默忽略（那会让人以为开了包其实没开）。解析结果进 env，供运行期与轨迹取证。
  const bundleSelection = (() => {
    const doc = loadBundles();
    const sel = parseSelection(process.env[BUNDLES_ENV] ?? null, doc);
    return { ...sel, doc };
  })();
  if (bundleSelection.problems.length) {
    process.stderr.write("❌ 包选择不合法，启动中止（不静默忽略）：\n");
    for (const p of bundleSelection.problems) process.stderr.write(`   · ${p}\n`);
    process.exit(EXIT_USAGE);
  }

  const copied = stage(artifact, plan, effectiveRunDir);

  // ---- 能力包（L4）：把**未激活包**带来的连接器从暂存产物里真的摘掉 ----
  // 不摘的话"开了 coding 包"只是一句声明（产物里照样全量加载），闸门 2 的集合相等也变成空话。
  // 期望集合 = **声明 ∩ 当前启用**（设计稿 §5）：这里算"该留哪些服务器"，摘法按**清单声明的落点与格式**
  // 交给 core/bundles/filter.mjs（core 不认运行时；没声明落点就**不摘**并如实记 enforced=false）。
  const bundleApplied = (() => {
    const byId = new Map(bundleSelection.doc.bundles.map((b) => [b.id, b]));
    const activeRefs = new Set(bundleSelection.active.flatMap((id) => byId.get(id)?.refs ?? []).map(String));
    const ownedBySomeBundle = new Set(bundleSelection.doc.bundles.flatMap((b) => b.refs ?? []).map(String));
    const keep = [];
    for (const c of manifest.connectors ?? []) {
      const ref = String(c.ref ?? c.serverName ?? "");
      // 属于某个包 ⇒ 只有激活了才留；不属于任何包 ⇒ 那是智能体自己声明的，照留
      if (!ownedBySomeBundle.has(ref) || activeRefs.has(ref)) keep.push(c.serverName ?? ref);
    }
    const res = enforceConnectorSurface({ runDir: effectiveRunDir, surface: manifest.connectorSurface ?? null, keep });

    // ---- 自研连接器（业务代码）：把产物里的**相对路径**解析成**暂存后的绝对路径** ----
    // 为什么必须做：产物里写的是 `mcp-servers/corpus/index.js`（相对、可搬），运行时起服务器时
    // cwd 不是那个目录 ⇒ **服务器静默起不来、工具不出现**，而闸门当时只说「包就位」。
    // 本轮业务方走查实测到这一条：相对路径时端点侧没有 `mcp__corpus`，改成绝对路径立刻出现。
    // 放在启动期（而不是渲染期）有三个好处：产物保持可搬、本地与容器同一条路径、只有一处实现。
    const selfConnectors = (() => {
      const surface = manifest.connectorSurface;
      if (!surface || !surface.path) return { resolved: [] };
      const file = path.join(effectiveRunDir, surface.path);
      if (!fs.existsSync(file)) return { resolved: [] };
      let doc;
      try { doc = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return { resolved: [] }; }
      const servers = doc && typeof doc.mcpServers === "object" && doc.mcpServers ? doc.mcpServers : {};
      const layoutRels = Object.values(plan.env ?? {});
      const stagingRoot = layoutRels.length ? path.join(effectiveRunDir, layoutRels[0]) : effectiveRunDir;
      const resolved = [];
      let changed = false;
      const absolutize = (value) => {
        if (typeof value !== "string" || value.startsWith("/") || value.startsWith("-")) return value;
        // 只解析**确实在暂存产物里存在**的相对路径（不是参数、不是包名、不是 URL）
        const candidate = path.join(stagingRoot, value);
        if (!value.includes("/") || !fs.existsSync(candidate)) return value;
        resolved.push(value);
        return candidate;
      };
      for (const [name, cfg] of Object.entries(servers)) {
        // ⚠️ 判断"是不是 stdio"不能只看 `transport`：产物里的 stdio 条目**只写 command/args**
        // （`transport` 在渲染时就消掉了）—— 第一版按 `transport === "stdio"` 过滤，等于一个都没处理，
        // 表现为"改了代码、行为没变"。以 `command` 有无为准。
        if (!cfg || typeof cfg.command !== "string") continue;
        const before = JSON.stringify(cfg.args ?? []);
        const nextArgs = (cfg.args ?? []).map(absolutize);
        if (JSON.stringify(nextArgs) !== before) { servers[name] = { ...cfg, args: nextArgs }; changed = true; }
      }
      if (changed) fs.writeFileSync(file, JSON.stringify({ ...doc, mcpServers: servers }, null, 2) + "\n");
      return { resolved };
    })();
    // 技能同一条纪律：属于某个包的技能，只有该包激活才留（技能是纯目录，两侧都能真的摘）
    const activeSkills = new Set(bundleSelection.active.flatMap((id) => byId.get(id)?.skills ?? []).map(String));
    const ownedSkills = new Set(bundleSelection.doc.bundles.flatMap((b) => b.skills ?? []).map(String));
    // ⚠️ keep = 定义声明的技能 **∪ 激活包带来的技能**。只写前者会把激活包自己的技能也删掉
    // （本轮实测踩到：开了 coding 包，三个技能照样被删 ⇒ 闸门 2 报「少 3 项」）。
    const keepSkills = [...new Set([
      ...(manifest.declaredSkills ?? []).filter((name) => !ownedSkills.has(name)),
      ...[...activeSkills],
    ])].sort();
    const skillRes = enforceSkillSurface({
      runDir: effectiveRunDir, surface: manifest.skillSurface ?? null, keep: keepSkills, ownedByBundles: [...ownedSkills],
    });
    // 插件同一条纪律：属于某个包的插件坐标，只有该包激活才留（不属于任何包的照留，如基座自带的 MCP 客户端）
    // ⚠️ 包定义里记的是**条目 id**，settings 里写的是**包坐标** —— 必须翻译一次（清单给映射）。
    // 不翻译就永远对不上，表现为"两种组合都留着"（本轮实测踩到）。
    const pkgById = manifest.bundles?.pluginPackages ?? {};
    const toSources = (ids) => ids.map((id) => (typeof pkgById[id] === "string" ? pkgById[id] : pkgById[id]?.source) ?? id).filter(Boolean);
    // **本地运行**：镜像内绝对路径在本机不存在 ⇒ 改写成 .local-packages 里那份（与 MCP 客户端同一套做法）。
    // 找不到就**响亮失败**（不静默产出一个"插件没加载"的运行）。
    const pluginLocalRoot = process.env.AGENT_PLUGIN_LOCAL_ROOT
      ?? path.join(path.dirname(HERE), "..", ".local-packages/node_modules");
    const rewritePluginPath = (p) => {
      if (typeof p !== "string" || !p.startsWith("/")) return p;
      if (fs.existsSync(p)) return p;                          // 容器里：镜像路径真实存在 ⇒ 不动
      const meta = Object.values(pkgById).find((v) => (typeof v === "object" ? v.source : v) === p);
      const localPkg = meta && typeof meta === "object" ? meta.localPackage : null;
      if (!localPkg) return p;
      const localPath = path.join(pluginLocalRoot, ...localPkg.split("/"));
      if (!fs.existsSync(localPath)) {
        process.stderr.write(`❌ 插件 ${localPkg} 在本机找不到（${localPath}）—— 跑一次 \`make dev-env\` 装齐本地预装包后再试。\n`);
        process.exit(EXIT_USAGE);
      }
      return localPath;
    };
    const activeSources = new Set(toSources(bundleSelection.active.flatMap((id) => byId.get(id)?.plugins?.[manifest.harness] ?? []).map(String)));
    const ownedSources = new Set(toSources(bundleSelection.doc.bundles.flatMap((b) => b.plugins?.[manifest.harness] ?? []).map(String)));
    const pluginRes = enforcePluginSurface({
      runDir: effectiveRunDir, surface: manifest.pluginSurface ?? null,
      ownedSources: [...ownedSources], keepSources: [...activeSources],
    });
    // ⚠️ **先摘除、后改写路径**：摘除按清单里的包坐标比对，改写会把坐标换成本机路径 ⇒
    // 顺序反了就永远比不中（实测：两种组合都留着）。
    const pluginRewrite = (() => {
      const sp = manifest.pluginSurface;
      if (!sp || !sp.path) return { rewrote: [] };
      const f = path.join(effectiveRunDir, sp.path);
      if (!fs.existsSync(f)) return { rewrote: [] };
      const field = sp.field ?? "packages";
      const doc = JSON.parse(fs.readFileSync(f, "utf8"));
      if (!Array.isArray(doc[field])) return { rewrote: [] };
      const rewrote = [];
      doc[field] = doc[field].map((item) => {
        const cur = typeof item === "string" ? item : item?.source;
        const next = rewritePluginPath(cur);
        if (next !== cur) { rewrote.push(`${cur} → ${next}`); return typeof item === "string" ? next : { ...item, source: next }; }
        return item;
      });
      if (rewrote.length) fs.writeFileSync(f, JSON.stringify(doc, null, 2) + "\n");
      return { rewrote };
    })();
    return {
      active: [...bundleSelection.active].sort(), keep: [...keep].sort(),
      selfConnectors: selfConnectors.resolved,
      skills: { keep: keepSkills.sort(), ...skillRes },
      plugins: { keep: [...activeSources].sort(), ...pluginRes, localRewrite: pluginRewrite.rewrote },
      ...res,
    };
  })();

  const values = Object.fromEntries(Object.entries(resolved).map(([k, v]) => [k, v.value]));
  const render = manifest.rendersParams ? renderParams(effectiveRunDir, values) : { written: [], problems: [] };
  if (render.problems.length) {
    process.stderr.write("❌ 启动期渲染失败（产物里有无法解析的占位）：\n");
    for (const p of render.problems) process.stderr.write(`   · ${p}\n`);
    process.exit(EXIT_USAGE);
  }

  // 接入缝：上层镜像带进来的业务代码与钩子（**只改暂存副本**；产物仍然只读）。
  // 落点是**该运行时的配置目录** —— 它由 runtimePlan 的 env 声明（例如某运行时是 `<运行目录>/agent-dir`），
  // 不是运行目录根。写错根目录的表现是"overlay 生效了但产物里找不到 enhancements.yaml"。
  const stagingRel = Object.values(plan.env ?? {})[0] ?? null;
  const stagingDir = stagingRel ? path.join(effectiveRunDir, stagingRel) : effectiveRunDir;
  const overlay = applyOverlay(stagingDir, manifest.harness, process.env.AGENT_OVERLAY_DIR ?? "/opt/agent-base/overlay", manifest.hookEvents ?? null);

  // 运行时环境：清单声明"哪个环境变量指向运行目录里的哪个相对路径"
  const env = {};
  for (const [name, rel] of Object.entries(plan.env ?? {})) env[name] = path.join(effectiveRunDir, rel);
  // 解析后的激活集合：**基座算一次**（含默认组合的展开），运行期（轨迹/摘要）直接用，
  // 免得各处再解释一遍 `AGENT_BUNDLES`（那正是"两处真源必然漂移"的经典起点）。
  env.AGENT_BUNDLES_ACTIVE = bundleSelection.active.join(",");
  env.AGENT_BUNDLES_AVAILABLE = availableIds(bundleSelection.doc).join(",");
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
    ...(overlay ? { overlay } : {}),
    env,
    cwd,
    // 本次运行的**包组合**（证据自带组合：轨迹、verify --json、摘要都用它）
    bundles: {
      active: bundleSelection.active,
      explicit: bundleSelection.explicit,
      available: availableIds(bundleSelection.doc),
      defaults: defaultSelection(bundleSelection.doc),
      digest: bundleDigest(bundleSelection.active),
      // 摘除结果：**真的摘了谁**（没声明落点时 enforced=false —— 不假装已生效）
      selfConnectors: bundleApplied.selfConnectors ?? null,
      filter: {
        connectors: { enforced: bundleApplied.enforced, kind: bundleApplied.kind, kept: bundleApplied.kept, removed: bundleApplied.removed, note: bundleApplied.note },
        skills: { enforced: bundleApplied.skills?.enforced ?? false, kept: bundleApplied.skills?.kept ?? [], removed: bundleApplied.skills?.removed ?? [], note: bundleApplied.skills?.note ?? null },
        plugins: { enforced: bundleApplied.plugins?.enforced ?? false, kept: bundleApplied.plugins?.kept ?? [], removed: bundleApplied.plugins?.removed ?? [], note: bundleApplied.plugins?.note ?? null },
      },
    },
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
    // 接入缝是否生效（上层镜像带的业务代码/钩子）：让日志与自检看得见，而不是"悄悄合了"
    ...(r.overlay ? { overlay: r.overlay } : {}),
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
  // 产物声明的"前置运行参数"（如工具边界）—— 由清单驱动，不在启动脚本里写 case。
  // 顺序：argvPrefix → prependArgs → 调用方参数（调用方仍可覆盖/追加）。
  const prepend = r.plan?.prependArgs ?? [];
  const child = spawn(exe, [...prefix, ...prepend, ...rest], { stdio: "inherit", env, cwd: r.cwd });
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
