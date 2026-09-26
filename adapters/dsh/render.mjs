// ============================================================================
// dsh 渲染器：中性定义 → dsh profile（统一设计 §11.2）
//
// ## 产物形态（都由实测确定）
//
//   <out>/dsh-home/profiles/<name>/
//     cordis.patch.yml    ← 我们的 patch 层（顶层 YAML 数组；`!!js` 表达式可用）
//     package.json        ← dsh.profile.bundles
//     cordis.yml          ← 空入口列表（模板要求存在）
//     pnpm-workspace.yaml ← 模板要求存在
//   <out>/workspace/AGENTS.md   ← 人设放这里（Q1）
//   <out>/skills/…              ← 技能
//   <out>/render-manifest.json
//
// ## 三个已裁决的实现问题
//
// **Q1 人设怎么进产物**：`agent-instructions` 的 config **只有 `maxBytes`** —— 它是"工作区
//   指令文件的**发现器**"，会去读工作区的 `AGENTS.md` / `CLAUDE.md`。所以人设必须落在**工作区**，
//   而不是当成配置字符串塞进去。→ 渲染 `workspace/AGENTS.md`，运行期把该目录挂成 cwd。
//
// **Q2 `customSkillDirs` 写什么路径**：写**镜像内固定路径**（不是渲染时的临时路径），
//   与 §11.2「相对引用解析成镜像内固定路径」一致；manifest 记录映射，本地运行期用挂载对齐。
//
// **Q3 bundles 取哪套**：预检时定的是"照抄 shipped web"，**实测推翻**：
//   `web` 模板把 `agent-instructions` / `skill-filesystem` / `tool-skill` / `tool-fs` …
//   **全部禁用**（它由 Web UI 驱动），而 `headless` 全都启用。我们的用法是"跑一个任务看结果"，
//   所以用 `base + dsh-headless`。这正是预检定不了、只能实测的那类问题。
//
// ## 对抗"重述腐化"（failures.md D6）
//
// ① 凡我们覆盖的 row，config 写**完整值**（上游是整体替换，不是深合并）；
// ② 姿态（安全/工具边界）由**我们显式声明**，并由 doctor 对着组合树断言 ——
//    上游改了默认值，conformance 会报出来，而不是悄悄漂移。
// ============================================================================

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { DEFAULT_EXCLUDES, EXIT_CODES, computeEffectiveConfigDigest, digestDirectory, parseArgs, sha256 } from "../../core/gates/index.mjs";
import { PREINSTALL_PATH, loadPreinstall, resolveConnectors } from "../../core/image/resolve-preinstall.mjs";
// 路由目录的解析（可被部署层覆盖）—— 唯一实现，见 core/catalog/routes.mjs
import { findProvider, loadProviders } from "../../core/catalog/providers.mjs";
import { dshRenderInputsDigest } from "./render-inputs.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HARNESS = "dsh";
const log = (m) => process.stderr.write(m + "\n");

/** 技能在**镜像内**的固定路径（Q2）：渲染期路径与运行期路径解耦。 */
const SKILLS_IN_IMAGE = "/opt/agent-base/skills";
/** 工作区在镜像内的固定路径：`agent-instructions` 从这里发现 AGENTS.md（Q1）。 */
const WORKSPACE_IN_IMAGE = "/workspace";
/** 该 harness 的 profile 在镜像内的固定位置（$DSH_HOME 之下）。 */
const DSH_HOME_IN_IMAGE = "/opt/agent-base/dsh-home";
/** 实测：headless 模板启用工具/技能/指令行；web 模板把它们全禁用（见 Q3）。 */
const BUNDLES = ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"];

const readYaml = (f) => YAML.parse(fs.readFileSync(f, "utf8"));
const writeFile = (f, text) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
/** 稳定 JSON：键排序，保证"同输入同产物"（conformance C2）。 */
const stableJson = (o) => JSON.stringify(o, Object.keys(o).sort().reduce((a, k) => (a[k] = o[k], a), {}), 2) + "\n";
function copyTree(from, to) {
  if (!fs.existsSync(from)) return [];
  const copied = [];
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const src = path.join(from, e.name), dst = path.join(to, e.name);
    if (e.isDirectory()) copied.push(...copyTree(src, dst));
    else { fs.copyFileSync(src, dst); copied.push(path.relative(to, dst)); }
  }
  return copied;
}

// --- YAML 输出 -------------------------------------------------------------------
// 自己写而不是用库的自定义标签：实测库没能把 !!js 输出成表达式，出来的是 `!!js [object Object]`，
// 而 dsh 不会把它当表达式求值 —— 配置会静默变成错的。patch 结构简单，自写反而可控且确定。

/** 需要输出成 `!!js <表达式>` 的值。 */
class JsExpr {
  constructor(value) { this.value = value; }
}

/**
 * 裸标量是否安全（YAML plain scalar 的限制）。
 *
 * 踩过的坑：`!!js (…) === 'danger-full-access' ? 'never' : 'ask'` 里有 **`: `（冒号+空格）**，
 * 而 YAML 的 plain scalar **不允许** 出现它 —— 于是表达式被当成嵌套映射，配置静默变成
 * `{'[object Object]': ask}`。表达式里出现冒号、井号、或首尾空白时，必须加引号。
 */
const plainSafe = (t) => t.length > 0 && !/[:#]\s|^\s|\s$|\n/.test(t) && !/^[?&*!|>%@`"'[\]{},-]/.test(t);

/** 标量 → YAML 文本。安全裸串不加引号，其余用 JSON 双引号（JSON 字符串是合法 YAML）。 */
function scalar(v) {
  if (v instanceof JsExpr) {
    // 标签必须在引号**外面**：`!!js "表达式"` —— 这样 YAML 才把它当标签 + 一个字符串标量
    return `!!js ${plainSafe(v.value) ? v.value : JSON.stringify(v.value)}`;
  }
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean" || typeof v === "number") return String(v);
  const t = String(v);
  return plainSafe(t) && /^[A-Za-z0-9_./@+-]+$/.test(t) ? t : JSON.stringify(t);
}

const isPlainObject = (v) => v !== null && typeof v === "object" && !(v instanceof JsExpr) && !Array.isArray(v);

/** 递归输出成行（数组元素与映射的缩进规则集中在这里）。 */
function lines(value, indent) {
  const pad = " ".repeat(indent);
  if (Array.isArray(value)) {
    if (!value.length) return [`${pad}[]`];
    return value.flatMap((item) => {
      if (isPlainObject(item)) {
        const inner = lines(item, indent + 2);
        inner[0] = `${pad}- ${inner[0].slice(indent + 2)}`;   // 首个键内联到 "- " 之后
        return inner;
      }
      return [`${pad}- ${scalar(item)}`];
    });
  }
  if (isPlainObject(value)) {
    return Object.entries(value).flatMap(([k, v]) => {
      if (Array.isArray(v) && v.length === 0) return [`${pad}${k}: []`];
      if (isPlainObject(v) || Array.isArray(v)) return [`${pad}${k}:`, ...lines(v, indent + 2)];
      return [`${pad}${k}: ${scalar(v)}`];
    });
  }
  return [`${pad}${scalar(value)}`];
}

const dumpPatch = (patch, header) => header + lines(patch, 0).join("\n") + "\n";

// --- patch 构造 ------------------------------------------------------------------

/**
 * 中性工具名 → 该 harness 的 tool row id。
 *
 * **粒度不同**：中性定义的 `read` / `write` / `edit` 在这边是**同一个 row**（`tool-fs`），
 * 所以禁掉其中一个会连带禁掉另外两个。这是真实的语义差异，已写进 exemptions.yaml。
 */
const TOOL_ROW = {
  bash: "tool-bash",
  read: "tool-fs",
  write: "tool-fs",
  edit: "tool-fs",
  search: "tool-fs-search",
};

function buildPatch({ agent, connectors, enhancements, route }) {
  const p = [];

  // ① 模型：完整 config（不是增量）
  // 模型名是**环境属性**（同一份制品在不同环境常要指向不同模型名），因此本体写成 `!!js` 表达式：
  // 没被覆盖时回落到定义里的默认值。本 harness 原生支持表达式求值 ⇒ **不需要启动期渲染**。
  const modelExpr = () => new JsExpr(`(process.env.${route.modelParam} ?? ${JSON.stringify(agent.model.name)})`);
  p.push({ id: "agent-default-model", config: { provider: route.id, model: modelExpr() } });

  // ①b **把路由本身配出来** —— 这一步不能省。
  //     只写 `agent-default-model.provider: <route>` 只是"选了哪个路由"；路由**存不存在**由
  //     provider 适配器决定。本 harness 的自定义路由走 `llm-pi-ai` 的 `providers` 字典
  //     （键=路由名，值声明 api 形状 / 端点 / 凭据引用名 / 模型目录）。
  //     不配这一步的后果很隐蔽：`--dump-config` 依然成功（组合树里就是选了个不存在的路由），
  //     直到真跑才报错 —— 而这正属 failures.md 要治的"静默失败"。
  if (route) {
    p.push({
      id: "llm-pi-ai",
      config: {
        providers: {
          [route.id]: {
            displayName: route.id,
            api: route.api,                              // 协议形状（与 pi 的 models.json.api 同名）
            // 凭据引用名：**只写名字**（配置文件绝不包含密钥），真值由部署期经凭据 seam 解析。
            // native（订阅登录）时不写这个字段 —— 凭据在运行时自己的凭据存储里。
            ...(route.credentialParam ? { apiKeyEnv: route.credentialParam } : {}),
            // 端点：provider 给了字面值就用它兜底，环境变量仍可覆盖（部署层照旧能改）
            ...(route.endpointNative ? {} : {
              baseURL: route.baseUrl
                ? new JsExpr(`(process.env.${route.baseUrlParam} ?? ${JSON.stringify(route.baseUrl)})`)
                : new JsExpr(`process.env.${route.baseUrlParam}`),
            }),
            // 模型列表**全带**（默认那个排第一）：两个运行时里都能切换模型，而不是只认一个名字
            models: [...new Set([agent.model.name, ...(route.models ?? [])])]
              .map((m) => (m === agent.model.name ? { id: modelExpr(), name: modelExpr() } : { id: m, name: m })),
          },
        },
      },
    });
  }

  // ② 人设：启用"工作区指令文件发现器"（人设本身在 workspace/AGENTS.md，见 Q1）
  p.push({ id: "agent-instructions", disabled: false, config: { maxBytes: 65536 } });

  // ③ 技能：启用技能文件系统 + 技能工具，目录指向镜像内固定路径（Q2）
  p.push({ id: "skill-filesystem", disabled: false, config: { customSkillDirs: [SKILLS_IN_IMAGE] } });
  p.push({ id: "tool-skill", disabled: false });

  // ④ 安全姿态：显式声明、默认 fail closed（不依赖上游默认值，doctor 会对着组合树断言）
  //    审批无应答者时 ask 会 fail closed；只有显式 danger-full-access 才是 never。
  p.push({
    id: "sandbox-policy",
    config: {
      mode: new JsExpr("process.env.AGENT_PERMISSION_MODE ?? 'workspace-write'"),
      workspaceRoot: new JsExpr(`process.env.AGENT_WORKSPACE_ROOT ?? '${WORKSPACE_IN_IMAGE}'`),
    },
  });
  p.push({
    id: "approval",
    config: { policy: new JsExpr("(process.env.AGENT_PERMISSION_MODE ?? 'workspace-write') === 'danger-full-access' ? 'never' : 'ask'") },
  });

  // ⑤ 工具边界：tools.deny → 禁掉对应 row
  const denyRows = [...new Set((agent.tools?.deny ?? []).map((t) => TOOL_ROW[t]).filter(Boolean))].sort();
  for (const row of denyRows) p.push({ id: row, disabled: true });

  // ⑥ 连接器：该 harness **原生支持** MCP（与另一个 harness 相反）——每服务器一条 insert
  for (const c of connectors) {
    // serverName 有硬约束 [A-Za-z0-9_-]{1,32}；不合法就响亮失败，不要悄悄改名
    // （改名会让模型看到的工具名与业务预期不一致）。
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(c.name)) {
      throw new Error(`连接器名「${c.name}」不符合该 harness 的 serverName 约束 [A-Za-z0-9_-]{1,32} —— 请改名，不要悄悄改写`);
    }
    const config = { serverName: c.name, transport: c.transport };
    if (c.transport === "stdio") {
      config.command = c.command;
      if (c.args?.length) config.args = c.args;
    } else {
      // 端点与凭据走**参数下放**：渲染成对参数层环境变量的引用，不写死真值
      config.url = new JsExpr(`process.env.${c.urlRef}`);
      if (c.credentialRef) config.headers = { Authorization: new JsExpr(`\`Bearer \${process.env.${c.credentialRef}}\``) };
    }
    p.push({ insert: [{ id: `mcp-${c.name}`, name: "@deepseek-ai/dsh-mcp-client", config }] });
  }

  // ⑦ 业务级增强：dsh 的形态是"cordis 插件（npm 包或相对路径）+ insert row"（§4.5）
  for (const e of enhancements) {
    // **不许静默跳过**：声明里既没有 package 也没有可解析的入口 ⇒ 响亮失败。
    // 早先这里 `if (!e.package) continue;` —— 写错一个字就"声明了但什么都没发生"，
    // 而产物照旧渲染成功（闸门 1 只看顶层 key，闸门 2 只看 dsh 组合树里有没有那行）。
    if (!e.package) {
      throw new Error(`dsh 增强「${e.id ?? "(缺 id)"}」没有 package —— 本运行时的增强必须是 cordis 插件`
        + `（npm 包名或以 . 开头的相对路径）。要么写对，要么删掉；静默跳过是不允许的。`);
    }
    if (!e.id) {
      throw new Error(`dsh 增强缺少 id（package=${e.package}）—— 组合树靠 id 索引，没有它无法展开`);
    }
    p.push({ insert: [{ id: e.id, name: e.package, ...(e.config ? { config: e.config } : {}) }] });
  }

  return { patch: p, denyRows };
}

// --- 主流程 ----------------------------------------------------------------------

function main() {
  const { values, flags, positionals, errors } = parseArgs(process.argv.slice(2), { valueFlags: ["--out"] });
  const json = flags.has("--json");
  if (flags.has("--help") || flags.has("-h") || !positionals.length) {
    log("用法: node adapters/dsh/render.mjs <AGENT_DIR> [--out <DIR>] [--json]");
    process.exit(positionals.length || flags.has("--help") || flags.has("-h") ? EXIT_CODES.ok : EXIT_CODES.usage);
  }
  if (errors.length) { log(errors.join("；")); process.exit(EXIT_CODES.usage); }

  const agentDir = path.resolve(positionals[0]);
  const agentFile = path.join(agentDir, "agent.yaml");
  if (!fs.existsSync(agentFile)) { log(`❌ 找不到 ${agentFile}`); process.exit(EXIT_CODES.static); }
  const agent = readYaml(agentFile);

  const outRoot = path.resolve(values["--out"] ?? path.join("dist", HARNESS, agent.name));
  fs.rmSync(outRoot, { recursive: true, force: true });
  const profileDir = path.join(outRoot, "dsh-home", "profiles", agent.name);

  // ---- 技能 ----
  const skillsSrc = path.join(agentDir, agent.skillsDir ?? "skills");
  const declaredSkills = fs.existsSync(skillsSrc)
    ? fs.readdirSync(skillsSrc, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()
    : [];
  copyTree(skillsSrc, path.join(outRoot, "skills"));

  // ---- 人设 → 工作区（Q1）----
  const persona = (agent.persona?.instructions ?? "").trim();
  writeFile(path.join(outRoot, "workspace", "AGENTS.md"), [
    `# ${agent.name}`,
    "",
    agent.description ? `> ${agent.description}` : null,
    "",
    "<!-- 由基座渲染器生成：本文件是智能体的人设（该 harness 的 agent-instructions 从工作区发现它）。 -->",
    "",
    persona,
    "",
  ].filter((l) => l !== null).join("\n"));

  // ---- 连接器（原生支持 MCP）----
  const connectorsFile = path.join(agentDir, agent.connectorsFile ?? "connectors.yaml");
  const connectorsDoc = fs.existsSync(connectorsFile) ? readYaml(connectorsFile) : { mcpServers: [] };
  const { servers, problems, paramNames } = resolveConnectors(connectorsDoc, loadPreinstall(PREINSTALL_PATH));
  if (problems.length) {
    log("❌ 连接器解析失败：");
    for (const p of problems) log(`     - ${p.server ?? ""} ${p.code}: ${p.detail}`);
    process.exit(EXIT_CODES.static);
  }
  const enabled = servers.filter((s) => s.enabled !== false);

  // ---- 业务级增强 ----
  const enhFile = path.join(agentDir, "harness", HARNESS, "enhancements.yaml");
  const enhancements = (fs.existsSync(enhFile) ? readYaml(enhFile).enhancements ?? [] : []).filter((e) => e.id);
  copyTree(path.join(agentDir, "harness", HARNESS), path.join(outRoot, "harness", HARNESS));

  // ---- profile 四件套 ----
  // 路由必须由基座声明（闸门 1 已校验）；渲染器据此产出 provider 配置
  // 选 provider：`model.provider` 是通行写法，`model.route` 是旧名（同一个东西）
  const catalog = loadProviders({ agentDir });
  const providerId = agent.model?.provider;
  const route = findProvider(catalog, providerId);
  // 作用域：这家供应商可能只在某些运行时可用（如订阅型/原生 provider 只有 pi 有）
  if (route && route.harnesses && !route.harnesses.includes(HARNESS)) {
    log(`❌ 供应商「${route.id}」只支持 ${route.harnesses.join("/")}，当前运行时是 ${HARNESS}。`);
    log(`   可选：① 改用两个运行时都支持的供应商（model.provider 换一个）② 只在这个运行时上跑该智能体。`);
    process.exit(EXIT_CODES.static);
  }
  if (!route) {
    log(`❌ model.provider「${providerId}」不在 provider 目录里（来源：${(catalog.sources ?? []).join(" + ") || "无"}）。`);
    log(`   可用 provider：${(catalog.providers ?? []).map((r) => r.id).join(", ") || "(空)"} —— 用 AGENT_PROVIDERS_FILE 指到你自己的那份，或改这里列出的名字。`);
    process.exit(EXIT_CODES.static);
  }

  let built;
  try {
    built = buildPatch({ agent, connectors: enabled, enhancements, route });
  } catch (e) {
    log(`❌ ${e.message}`);
    process.exit(EXIT_CODES.static);
  }
  const { patch, denyRows } = built;

  // 可共享的业务代码：与另一个运行时共用 harness/shared/ 这一份。
  // 落在 `<产物>/harness/business/`，于是接入件（`harness/<运行时>/` 里的插件）用
  // **同一个相对路径** `../business/<文件>` 引用它 —— 两个运行时的业务代码真的是同一份。
  copyTree(path.join(agentDir, "harness", "shared"), path.join(outRoot, "harness", "business"));

  writeFile(path.join(profileDir, "cordis.patch.yml"), dumpPatch(patch, [
    "# 由 agent-base 渲染器生成 —— 不要手改（改中性定义后重新渲染）。",
    "# 这是 profile 的 patch 层：在 bundles 之后应用，覆盖/禁用既有 row，或 insert 新 row。",
    "",
  ].join("\n")));
  writeFile(path.join(profileDir, "package.json"), stableJson({
    name: `dsh-profile-${agent.name}`,
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: BUNDLES } },
  }));
  writeFile(path.join(profileDir, "cordis.yml"), [
    "# dsh profile 根 —— 空入口列表。组合树由 patch 构成（bundles → cordis.patch.yml）。",
    "# 改 cordis.patch.yml，不要改这个文件。",
    "[]",
    "",
  ].join("\n"));
  writeFile(path.join(profileDir, "pnpm-workspace.yaml"), "packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n");

  // ---- 业务附加协议：标签表原样带出，基座不解析语义 ----
  const labelsSrc = path.join(agentDir, "trace-labels.yaml");
  const labelsProvided = fs.existsSync(labelsSrc);
  if (labelsProvided) fs.copyFileSync(labelsSrc, path.join(outRoot, "trace-labels.yaml"));

  // ---- 清单 ----
  const adapter = readYaml(path.join(HERE, "adapter.yaml"));
  const manifest = {
    harness: HARNESS,
    harnessVersion: adapter.version,
    agent: agent.name,
    output: "dsh-home + workspace",
    bundles: BUNDLES,
    declaredSkills,
    declaredEnhancements: enhancements.map((e) => e.id).sort(),
    // 哪些声明是钩子：闸门 3 的 probe/hook-fired 靠它判断"要不要断言钩子真的触发"（P4）
    hookEnhancements: [...new Set(enhancements.filter((e) => e.kind === "hook").map((e) => e.id))].sort(),
    connectors: enabled.map((c) => ({ serverName: c.name, transport: c.transport })),
    // 连接器的包坐标：闸门 3 据此断言"运行期能离线启动它"
    connectorPackages: enabled.filter((c) => c.pin).map((c) => `${c.pin.package}@${c.pin.version}`),
    connectorsNote: "该 harness 原生支持 MCP（mcpClient: supported）；每服务器一条 insert row",
    denyTools: agent.tools?.deny ?? [],
    denyRows,
    denyNote: "工具粒度不同：中性的 read/write/edit 在这边是同一个 tool-fs row，禁用其一即禁用三者（见 exemptions.yaml）",
    modelProviders: [providerId],
    modelProviderAuth: route.auth,
    modelProviderApi: route.api,
    // 该路由声明的模型名单：启动期校验运行期覆盖的模型名用
    modelProviderModels: route.models ?? [],
    /**
     * **运行期参数契约**：入口脚本按这份声明解析并校验（不猜名字、不硬编码）。
     * 本 harness 原生支持 `!!js` 求值 ⇒ `rendersParams: false`（不在启动期改写产物），
     * 但**校验仍然做**（模型名须在路由名单内）——「原生能插值」不等于「注入的值不用管」。
     */
    rendersParams: false,
    /**
     * **运行期布局契约**（入口脚本按它暂存 + 设环境变量 + 定 cwd）。
     * 本 harness 原生支持 `!!js` 求值 ⇒ 不需要渲染；但要**暂存可写副本**：
     * 会话与配置写在 DSH_HOME 下，而产物是只读挂载的。
     */
    runtimePlan: {
      // 本 harness 的调用形态是 `dsh <profile> [选项…]` —— profile 名是**运行时的专有知识**，
      // 由产物声明，调用方（入口脚本/编排层）不必知道。`@agent` 会被替换成智能体名。
      argvPrefix: ["@agent"],
      // `harness/` **有才拷**：本运行时的接入件（cordis 插件）与共享业务代码都在那里，
      // 缺了它插件会在运行期 "failed to import"（实测踩过）。
      // 但产物里没有这个目录时**不能**写进计划 —— 声明一个不存在的拷入源会让启动期直接失败
      // （实测：所有不带增强的示例在 dsh 上全红）。
      copy: ["dsh-home", "workspace", "skills", ...(fs.existsSync(path.join(outRoot, "harness")) ? ["harness"] : [])],
      env: { DSH_HOME: "dsh-home" },
      cwd: "workspace",
      pathRewrites: [
        { from: SKILLS_IN_IMAGE, to: "skills" },
        { from: WORKSPACE_IN_IMAGE, to: "workspace" },
        { from: DSH_HOME_IN_IMAGE, to: "dsh-home" },
      ],
    },
    runtimeParams: [
      ...(route.endpointNative ? [] : [{ name: route.baseUrlParam, secret: false, required: !route.baseUrl, ...(route.baseUrl ? { default: route.baseUrl } : {}), backs: "model.provider" }]),
      // 凭据参数：native 不产生；none 带占位默认值且不必填；env 必填
      ...(route.credentialParam
        ? [route.credentialDefault
            ? { name: route.credentialParam, secret: false, required: false, default: route.credentialDefault, backs: "model.provider" }
            : { name: route.credentialParam, secret: true, required: true, backs: "model.provider" }]
        : []),
      {
        name: route.modelParam, secret: false, required: false,
        default: agent.model.name, backs: "model.name", validate: "in-provider-models",
      },
    ],
    // 端点/凭据的**参数引用名**：运行期靠这两个名字注入真值（参数下放）
    modelRouteBaseUrlParam: route.baseUrlParam,
    modelRouteCredentialParam: route.credentialParam,
    mcpClient: adapter.capabilities?.mcpClient ?? "unknown",
    skillsInImage: SKILLS_IN_IMAGE,
    skillsInProduct: "skills",   // 技能在产物内的相对位置（与 skillsInImage 是两回事）
    // **定义字段 → 产物位置的声明**（conformance C3 只验证这份声明，不再认死文件名）
    expresses: (() => {
      const patchRel = `dsh-home/profiles/${agent.name}/cordis.patch.yml`;
      const e = {
        "persona.instructions": { at: "workspace/AGENTS.md", contains: persona.slice(0, 24) },
        "model.route": { at: patchRel, contains: `provider: ${providerId}` },
        // model.name 是默认值（运行期可覆盖）⇒ 落点是清单（默认值 + 引用名），
        // 产物里是 `!!js (process.env.<引用名> ?? "<默认值>")` 表达式。
        "model.name": { at: "render-manifest.json", contains: [agent.model.name, route.modelParam] },
        skills: { at: "skills" },
      };
      if (agent.model?.reasoningEffort) {
        // 诚实标注：本 harness 的 provider 模型条目有 reasoningEfforts 字段，但**本基座尚未映射**
        // model.reasoningEffort（映射形状未实测）。不许猜形状 —— 声明为豁免并记缺口。
        e["model.reasoningEffort"] = { exempt: "本基座尚未映射 model.reasoningEffort 到该 harness（provider 模型条目的 reasoningEfforts 形状未实测）；已记为待补缺口，不静默丢弃" };
      }
      if (agent.tools?.deny?.length) e["tools.deny"] = { at: patchRel, contains: denyRows.map((r) => `- id: ${r}`) };
      if (enhancements.length) e.enhancements = { at: patchRel, contains: enhancements.map((x) => `- id: ${x.id}`) };
      return e;
    })(),
    workspaceInImage: WORKSPACE_IN_IMAGE,
    dshHomeInImage: DSH_HOME_IN_IMAGE,
    labelsProvided,
    definitionDigest: digestDirectory(agentDir),
    // **渲染输入摘要**：复用旧产物前的判据（见 adapters/dsh/render-inputs.mjs）。
    // 只比定义摘要会在"基座变了、定义没变"时错误复用旧产物。
    renderInputsDigest: dshRenderInputsDigest(agentDir),
  };
  const artifactsDigest = digestDirectory(outRoot, { excludes: [...DEFAULT_EXCLUDES, "render-manifest.json"] });
  manifest.artifactsDigest = artifactsDigest;
  // 生效配置摘要：渲染期算好记进清单，运行期直接读（避免镜像里再实现一遍摘要）
  manifest.effectiveConfigDigest = computeEffectiveConfigDigest({
    harnessVersion: manifest.harnessVersion,
    adapterVersion: readYaml(path.join(HERE, "adapter.yaml")).adapterVersion,
    artifactsDigest,
    paramNames: (manifest.runtimeParams ?? []).map((p) => p.name),
  });
  writeFile(path.join(outRoot, "render-manifest.json"), stableJson(manifest));

  const result = {
    harness: HARNESS, agent: agent.name, out: outRoot,
    definitionDigest: manifest.definitionDigest, artifactsDigest,
    declaredSkills, declaredEnhancements: manifest.declaredEnhancements, hookEnhancements: manifest.hookEnhancements,
    connectors: manifest.connectors, denyRows, paramNames,
  };
  if (json) process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  else {
    process.stdout.write(sha256(JSON.stringify(result)) + "\n");
    log(`✅ 渲染完成：${outRoot}`);
    log(`   profile     dsh-home/profiles/${agent.name}（bundles: ${BUNDLES.join(" + ")}）`);
    log(`   技能        ${declaredSkills.length} 个 → ${SKILLS_IN_IMAGE}`);
    log("   人设        workspace/AGENTS.md（agent-instructions 从工作区发现）");
    log(`   连接器      ${enabled.length} 个（原生 MCP）`);
    log(`   工具边界    禁 ${denyRows.length} 个 row${denyRows.length ? `：${denyRows.join(", ")}` : ""}`);
    log(`   patch 条目  ${patch.length} 条`);
  }
  process.exit(EXIT_CODES.ok);
}

main();
