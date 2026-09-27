// ============================================================================
// conformance 用例 C1–C10（统一设计 §5.6）
//
// **全为阻断性门槛**（P3 已裁决）：任何一项不通过，这个适配器就不算接入。
// 「部分项仅告警」被明确否决 —— 会被软化的正是 C5/C8 这两类最危险的退化。
//
// 因此：**没实现的用例不算通过**，而是记 `pending` 并让 runner 非零退出。
// 悄悄跳过会让"conformance 全绿"变成一句空话。
// ============================================================================

import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import Ajv2020 from "ajv/dist/2020.js";
import { REPO, adaptersPresent, copyDir, doctor, jsonOf, makeFullAgent, render, run, tmpdir, validate } from "../helpers.mjs";
import { runImageChecks } from "../image-checks.mjs";

/**
 * 在渲染产物里按 glob 找文件（只支持路径段级的 `*`，够用且不引依赖）。
 * 用途：让适配器在 failure-cases.yaml 里声明"注入到哪个产物文件"，而不是把路径写死在检查里。
 */
function globUnder(root, pattern) {
  const parts = String(pattern).split("/").filter(Boolean);
  const walk = (dir, i) => {
    if (i === parts.length) return fs.existsSync(dir) && fs.statSync(dir).isFile() ? [dir] : [];
    const seg = parts[i];
    if (seg === "*") {
      if (!fs.existsSync(dir)) return [];
      return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => walk(path.join(dir, e.name), i + 1));
    }
    return walk(path.join(dir, seg), i + 1);
  };
  return walk(root, 0);
}

const ok = (detail, evidence) => ({ ok: true, detail, evidence });
const bad = (detail, evidence) => ({ ok: false, detail, evidence });
const pending = (detail) => ({ ok: false, pending: true, detail });

/** 能力声明里每项都必须给出取值；这是 §5.2 的必填集合（含本项目新增的 mcpClient，见 H4 连接器轴）。 */
const REQUIRED_CAPABILITIES = [
  "nativeParamInterpolation", "runtimeWritableConfig", "implicitSkillSources",
  "configInclude", "hmr", "childAgents", "osSandbox",
  // commandsHeadless：斜杠命令能不能被**无头驱动**（实测差异见两侧 adapter.yaml 的 Note；
  // 它决定"交互面能否进自动化验证"，与选型相关）
  "permissionModel", "traceEmit", "mcpClient", "commandsHeadless", "runModes",
];
const CAPABILITY_VALUES = ["supported", "partial", "unsupported", "extension"];
// modelApis = 该运行时支持的模型协议形状（provider 里 api: 的合法取值）——
// 放在顶层而不是 capabilities：capabilities 每项是 supported/partial/… 的枚举，
// 而这个是**字符串列表**（早期放错层，被本用例当场拦下）。
const REQUIRED_TOP_KEYS = ["harness", "version", "adapterVersion", "renders", "modelApis", "capabilities", "failures", "exemptions"];

const cases = [
  // -------------------------------------------------------------------------
  {
    id: "C1",
    title: "声明完整性：adapter.yaml 含全部必填能力项，且无未知项",
    run: () => {
      const problems = [];
      for (const h of adaptersPresent()) {
        const file = path.join(REPO, "adapters", h, "adapter.yaml");
        if (!fs.existsSync(file)) { problems.push(`${h}: 缺 adapter.yaml`); continue; }
        const a = YAML.parse(fs.readFileSync(file, "utf8"));
        for (const k of REQUIRED_TOP_KEYS) if (a[k] === undefined) problems.push(`${h}: 缺顶层字段 ${k}`);
        if (a.harness !== h) problems.push(`${h}: adapter.yaml 的 harness 字段是 ${a.harness}，与目录名不符`);
        for (const k of REQUIRED_CAPABILITIES) {
          if (a.capabilities?.[k] === undefined) { problems.push(`${h}: capabilities 缺 ${k}`); continue; }
          if (k === "runModes") {
            if (!Array.isArray(a.capabilities[k]) || !a.capabilities[k].length) problems.push(`${h}: runModes 必须是非空数组`);
          } else if (!CAPABILITY_VALUES.includes(a.capabilities[k])) {
            problems.push(`${h}: capabilities.${k} 取值非法（${a.capabilities[k]}）`);
          }
        }
        for (const k of Object.keys(a.capabilities ?? {})) {
          if (REQUIRED_CAPABILITIES.includes(k)) continue;
          if (k.endsWith("Note")) continue;           // 允许为每项附说明
          problems.push(`${h}: capabilities 出现未知项 ${k}（无未知项是 C1 的要求）`);
        }
        for (const key of ["failures", "exemptions"]) {
          const f = path.join(REPO, "adapters", h, a[key] ?? "");
          if (!a[key] || !fs.existsSync(f)) problems.push(`${h}: ${key} 指向的文件不存在（${a[key]}）`);
        }
        // 豁免必须未过期、且写明理由
        const exf = path.join(REPO, "adapters", h, a.exemptions ?? "");
        if (fs.existsSync(exf)) {
          for (const e of YAML.parse(fs.readFileSync(exf, "utf8")) ?? []) {
            if (!e.id || !e.scope || !e.reason || !e.reviewBy) problems.push(`${h}: 豁免 ${e.id ?? "(无名)"} 缺 id/scope/reason/reviewBy`);
            else if (new Date(e.reviewBy) < new Date()) problems.push(`${h}: 豁免 ${e.id} 已过复核期限（${e.reviewBy}）`);
          }
        }
      }
      return problems.length ? bad(`声明不完整：${problems.join("；")}`) : ok(`已检查 ${adaptersPresent().length} 个适配器的声明`);
    },
  },

  // -------------------------------------------------------------------------
  {
    id: "C2",
    title: "渲染确定性：同定义渲染两次，产物与 digest 完全一致",
    run: () => {
      const problems = [];
      const seen = [];
      for (const h of adaptersPresent()) {
        const agent = makeFullAgent(path.join(tmpdir("c2"), "agent"), { harness: h });
        const a = path.join(tmpdir("c2"), "out-a");
        const b = path.join(tmpdir("c2"), "out-b");
        const ra = render(h, agent, a);
        const rb = render(h, agent, b);
        if (ra.status !== 0 || rb.status !== 0) { problems.push(`${h}: render 失败（${ra.status}/${rb.status}）${ra.stderr.slice(-200)}`); continue; }
        const ja = jsonOf(ra.stdout), jb = jsonOf(rb.stdout);
        if (!ja || !jb) { problems.push(`${h}: render 未输出可解析 JSON`); continue; }
        if (ja.artifactsDigest !== jb.artifactsDigest) problems.push(`${h}: 两次渲染 digest 不同（${ja.artifactsDigest} vs ${jb.artifactsDigest}）`);
        // 不只比 digest：逐文件比内容，避免"摘要算法漏掉某类文件"
        const filesOf = (dir) => {
          const out = [];
          const walk = (d) => {
            for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((x, y) => x.name.localeCompare(y.name))) {
              const p = path.join(d, e.name);
              if (e.isDirectory()) walk(p); else out.push([path.relative(dir, p), fs.readFileSync(p, "utf8")]);
            }
          };
          walk(dir);
          return out.sort((x, y) => x[0].localeCompare(y[0]));
        };
        const fa = filesOf(a), fb = filesOf(b);
        if (JSON.stringify(fa) !== JSON.stringify(fb)) {
          problems.push(`${h}: 两次渲染的产物内容不同（文件数 ${fa.length} vs ${fb.length}）`);
        }
        seen.push(`${h}:${ja.artifactsDigest.slice(0, 16)}…（${fa.length} 个文件）`);
      }
      return problems.length ? bad(problems.join("；")) : ok(`渲染确定性成立：${seen.join(", ")}`);
    },
  },

  // -------------------------------------------------------------------------
  {
    id: "C3",
    title: "渲染完整性：定义里每个非空字段在产物中有对应表达（或有声明豁免）",
    run: () => {
      const problems = [];
      for (const h of adaptersPresent()) {
        const agent = makeFullAgent(path.join(tmpdir("c3"), "agent"), { reasoningEffort: "medium", enhancements: true, harness: h });
        const out = path.join(tmpdir("c3"), "out");
        const r = render(h, agent, out);
        if (r.status !== 0) { problems.push(`${h}: render 失败 ${r.stderr.slice(-200)}`); continue; }
        const manifest = JSON.parse(fs.readFileSync(path.join(out, "render-manifest.json"), "utf8"));

        // C3 判据已改为**按声明验证**：渲染器在清单里声明「定义字段 → 产物位置」（expresses），
        // 检查只验证这份声明。此前它认死 AGENTS.md / settings.json / extensions 这些**文件名** ——
        // 那等于把第一个 harness 的产物形状当成契约，第二个 harness 必然误判。
        const expresses = manifest.expresses;
        if (!expresses || typeof expresses !== "object") {
          problems.push(`${h}: 清单缺 expresses 声明 —— 无法判断"每个定义字段去了哪里"`);
          continue;
        }
        const readRel = (rel) => (fs.existsSync(path.join(out, rel)) ? fs.readFileSync(path.join(out, rel), "utf8") : null);

        /**
         * @param {string} field        定义字段路径
         * @param {string[]} expectAny  定义里的字面值：必须真的出现在所声明的位置（防"声明敷衍了事"）
         */
        const verify = (field, expectAny = []) => {
          const d = expresses[field];
          if (!d) { problems.push(`${h}: 定义字段 ${field} 未在清单里声明落点`); return; }
          if (d.exempt) {
            if (String(d.exempt).length < 12) problems.push(`${h}: ${field} 声明为豁免，但理由过于简短（等于没写）`);
            return;
          }
          if (!d.at) { problems.push(`${h}: ${field} 的声明缺 at（产物内位置）`); return; }
          const abs = path.join(out, d.at);
          if (!fs.existsSync(abs)) { problems.push(`${h}: ${field} 声明的位置在产物里不存在：${d.at}`); return; }
          // 声明可以指向**目录**（例如技能整包）；但目录不能给 contains，也不能校验字面值
          if (fs.statSync(abs).isDirectory()) {
            if ([].concat(d.contains ?? []).length) problems.push(`${h}: ${field} 的声明指向目录（${d.at}），却给了 contains —— 目录里无法查内容，请声明到具体文件`);
            if (expectAny.length) problems.push(`${h}: ${field} 的声明指向目录（${d.at}），无法校验定义值 —— 请声明到具体文件`);
            return;
          }
          const content = fs.readFileSync(abs, "utf8");
          for (const n of [].concat(d.contains ?? [])) {
            if (n && !content.includes(n)) problems.push(`${h}: ${field} 声明在 ${d.at}，但那里找不到「${n}」`);
          }
          for (const v of expectAny) {
            if (!content.includes(v)) problems.push(`${h}: ${field} 的定义值「${v}」未出现在声明位置 ${d.at} 里`);
          }
        };

        verify("persona.instructions", ["你是合规审阅助手"]);
        verify("model.route", ["corp-gateway"]);
        verify("model.name", ["corp-think"]);
        verify("model.reasoningEffort");          // 允许声明豁免（如该 harness 尚未映射）
        verify("tools.deny");
        verify("skills");
        verify("enhancements", ["risk-score"]);

        // 技能必须**原样打包**（含业务代码 scripts/）：位置来自清单声明，不猜目录名
        const skillsRel = manifest.skillsInProduct;
        if (!skillsRel) problems.push(`${h}: 清单缺 skillsInProduct（技能在产物内的位置）`);
        else {
          for (const rel of ["alpha/SKILL.md", "alpha/scripts/scan.sh"]) {
            if (!fs.existsSync(path.join(out, skillsRel, rel))) problems.push(`${h}: 技能未打包：${skillsRel}/${rel}`);
          }
        }
        if (JSON.stringify([...(manifest.declaredSkills ?? [])].sort()) !== JSON.stringify(["alpha"])) {
          problems.push(`${h}: 声明的技能集合不对（${JSON.stringify(manifest.declaredSkills)}）`);
        }
        if (!(manifest.declaredEnhancements ?? []).includes("risk-score")) {
          problems.push(`${h}: 业务级增强的声明未进产物清单`);
        }
      }
      return problems.length ? bad(problems.join("；")) : ok("定义字段到产物表达无遗漏（按各适配器的 expresses 声明验证）");
    },
  },

  // -------------------------------------------------------------------------
  {
    id: "C4",
    title: "解析自证不变量：doctor 输出七个字段，且三个集合断言成立",
    run: () => {
      const problems = [];
      for (const h of adaptersPresent()) {
        const agent = makeFullAgent(path.join(tmpdir("c4"), "agent"), { enhancements: true, harness: h });
        const out = path.join(tmpdir("c4"), "out");
        if (render(h, agent, out).status !== 0) { problems.push(`${h}: render 失败`); continue; }
        const d = doctor(h, out);
        const payload = jsonOf(d.stdout);
        const doc = payload?.doctor;
        if (!doc) { problems.push(`${h}: doctor 未输出可解析 JSON（退出码 ${d.status}）`); continue; }
        for (const k of ["harness", "version", "definitionPath", "skills", "connectors", "enhancements", "modelProviders", "effectiveConfigDigest"]) {
          if (doc[k] === undefined) problems.push(`${h}: doctor 缺字段 ${k}`);
        }
        const manifest = JSON.parse(fs.readFileSync(path.join(out, "render-manifest.json"), "utf8"));
        if (JSON.stringify(doc.skills) !== JSON.stringify([...(manifest.declaredSkills ?? [])].sort())) {
          problems.push(`${h}: doctor 的 skills 与声明不一致（${JSON.stringify(doc.skills)} vs ${JSON.stringify(manifest.declaredSkills)}）`);
        }
        if (d.status !== 0) problems.push(`${h}: doctor 退出码 ${d.status}（三条硬断言未全过）`);
      }
      return problems.length ? bad(problems.join("；")) : ok("七个字段齐备，三个集合断言成立");
    },
  },

  // -------------------------------------------------------------------------
  {
    id: "C5",
    title: "静默失败检测力：每条已知静默失败注入后**必须报错**（灵魂项）",
    run: () => {
      const problems = [];
      const evidence = [];
      for (const h of adaptersPresent()) {
        const caseFile = path.join(REPO, "adapters", h, "failure-cases.yaml");
        if (!fs.existsSync(caseFile)) { problems.push(`${h}: 缺 failure-cases.yaml（§5.5 要求每条静默失败配一个可执行用例）`); continue; }
        const { cases: injections } = YAML.parse(fs.readFileSync(caseFile, "utf8"));
        for (const c of injections ?? []) {
          const base = tmpdir(`c5-${c.id}`);
          const agent = makeFullAgent(path.join(base, "agent"), { ...(c.agentOptions ?? {}), harness: h });
          const out = path.join(base, "out");
          let result;
          if (c.kind === "render-declares-connectors") {
            fs.writeFileSync(path.join(agent, "connectors.yaml"), "apiVersion: agent-base/v1\nmcpServers:\n  - ref: filesystem\n    enabled: true\n");
            result = render(h, agent, out);
          } else {
            const r = render(h, agent, out);
            if (r.status !== 0) { problems.push(`${h}/${c.id}: 注入前渲染就失败了`); continue; }
            if (c.kind === "leak-undeclared-skill") {
              const p = path.join(out, "agent-dir", "skills", "injected");
              fs.mkdirSync(p, { recursive: true });
              fs.writeFileSync(path.join(p, "SKILL.md"), "---\nname: injected\ndescription: 注入的未声明技能\n---\n正文\n");
              result = doctor(h, out);
            } else if (c.kind === "remove-model-config") {
              fs.rmSync(path.join(out, "agent-dir", "models.json.tmpl"), { force: true });
              result = doctor(h, out);
            } else if (c.kind === "declare-missing-enhancement-entry") {
              // 更精确的注入：改**定义**而不动产物 —— 声明一个没有实体文件的增强入口。
              // 这样产物摘要依然自洽，检测只能靠 enhancement-entries 这条断言成立。
              const enhDir = path.join(agent, "harness", h);
              fs.mkdirSync(enhDir, { recursive: true });
              fs.writeFileSync(path.join(enhDir, "enhancements.yaml"),
                "apiVersion: agent-base/v1\nharness: " + h + "\nenhancements:\n  - kind: tool\n    id: missing-entry\n    entry: extensions/does-not-exist.ts\n");
              const r2 = render(h, agent, out);
              result = r2.status === 0 ? doctor(h, out) : { status: r2.status, stderr: r2.stderr };
            } else if (c.kind === "thinking-clamp") {
              result = doctor(h, out); // agentOptions 里声明了 reasoningEffort
            } else if (c.kind === "connectors-without-client") {
              // 先声明一个连接器并正常渲染，再按 c.inject 摘掉客户端声明
              fs.writeFileSync(path.join(agent, "connectors.yaml"),
                "apiVersion: agent-base/v1\nmcpServers:\n  - ref: filesystem\n    enabled: true\n");
              const r2 = render(h, agent, out);
              if (r2.status !== 0) { problems.push(`${h}/${c.id}: 注入前渲染就失败了`); continue; }
              const inj = c.inject ?? {};
              const files = globUnder(out, inj.file ?? "");
              if (!files.length) { problems.push(`${h}/${c.id}: 注入目标不存在（${inj.file}）`); continue; }
              for (const f of files) {
                const obj = JSON.parse(fs.readFileSync(f, "utf8"));
                delete obj[inj.key];
                fs.writeFileSync(f, JSON.stringify(obj, null, 2) + "\n");
              }
              result = doctor(h, out);
            } else if (c.inject?.file) {
              // **通用注入**：注入位置由适配器在 failure-cases.yaml 里声明（glob + 追加文本），
              // 检查侧只负责执行。这样加第二个 harness 不必再改检查代码 —— 之前的写法
              // 把 pi 的产物路径（agent-dir/...）硬编码在这里，等于把第一个 harness 的形状当契约。
              const targets = globUnder(out, c.inject.file);
              if (!targets.length) { problems.push(`${h}/${c.id}: 注入目标不存在（${c.inject.file}）`); continue; }
              for (const f of targets) fs.appendFileSync(f, c.inject.append ?? "");
              result = doctor(h, out);
            } else {
              problems.push(`${h}/${c.id}: 未知注入类型 ${c.kind}`);
              continue;
            }
          }
          const expect = c.expectExitCode ?? 20;
          if (result.status !== expect) {
            problems.push(`${h}/${c.id}（${c.failure}）：**静默通过** —— 期望退出码 ${expect}，实际 ${result.status}`);
          } else {
            evidence.push(`${c.id}→${result.status}`);
          }
        }
      }
      return problems.length
        ? bad(`有静默失败未被检测到：${problems.join("；")}`)
        : ok(`全部注入场景均被检测到（${evidence.join(", ")}）`);
    },
  },

  // -------------------------------------------------------------------------
  {
    id: "C6",
    title: "零凭据闸门 3/4：假网关下探针与冒烟通过（N14）",
    run: () => {
      const problems = [];
      const evidence = [];
      for (const h of adaptersPresent()) {
        const base = tmpdir(`c6-${h}`);
        const agent = makeFullAgent(path.join(base, "agent"), { harness: h });
        const out = path.join(base, "out");
        const rr = render(h, agent, out);
        if (rr.status !== 0) { problems.push(`${h}: render 失败（${String(rr.stderr).slice(-120)}）`); continue; }
        // 不传 --endpoint ⇒ 探针/冒烟自行起零凭据假网关（N14）
        const probe = run(["tools/probe.mjs", out, "--json", "--harness", h]);
        if (probe.status !== 0) problems.push(`${h}: 闸门 3 未通过（退出码 ${probe.status}）${String(probe.stderr).slice(-200)}`);
        const smoke = run(["tools/smoke.mjs", out, "--json", "--harness", h]);
        if (smoke.status !== 0) problems.push(`${h}: 闸门 4 未通过（退出码 ${smoke.status}）${String(smoke.stderr).slice(-200)}`);
        if (probe.status === 0 && smoke.status === 0) evidence.push(`${h}: 假网关下闸门 3/4 均通过`);
      }
      return problems.length ? bad(problems.join("；")) : ok(evidence.join("；") || "无适配器");
    },
  },

  // -------------------------------------------------------------------------
  {
    id: "C7",
    title: "轨迹合规：原生事件映射后符合统一 schema，且不丢事件",
    run: async () => {
      const problems = [];
      const evidence = [];
      const schema = JSON.parse(fs.readFileSync(path.join(REPO, "core/trace/schema.json"), "utf8"));
      const ajv = new Ajv2020({ allErrors: true, strict: false });
      const validateEvent = ajv.compile(schema);
      for (const h of adaptersPresent()) {
        const mapperPath = path.join(REPO, "adapters", h, "trace.mjs");
        if (!fs.existsSync(mapperPath)) { problems.push(`${h}: 缺 trace.mjs（§5.3 SPI 要求提供轨迹映射）`); continue; }
        const fixture = path.join(REPO, "conformance", "fixtures", `${h}-native-events.jsonl`);
        if (!fs.existsSync(fixture)) { problems.push(`${h}: 缺原生事件样本 conformance/fixtures/${h}-native-events.jsonl`); continue; }
        const records = fs.readFileSync(fixture, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
        const { mapEventStream } = await import(mapperPath);
        const ctx = { run: "c7", agent: "c7", harness: h, harnessVersion: "0.0.0", effectiveConfigDigest: `sha256:${"a".repeat(64)}`, definitionDigest: `sha256:${"b".repeat(64)}`, mode: "oneshot", contentMode: "full" };
        const { events, stats } = mapEventStream(records, ctx);
        if (events.length !== records.length) problems.push(`${h}: 映射丢了事件（输入 ${records.length}，输出 ${events.length}）`);
        if (stats.dropped !== 0) problems.push(`${h}: dropped=${stats.dropped}（P1 决策禁止丢弃）`);
        for (const e of events) if (!validateEvent(e)) problems.push(`${h}: 事件不合 schema（${JSON.stringify(validateEvent.errors?.[0]?.instancePath)} ${validateEvent.errors?.[0]?.message}）`);
        for (const e of events.filter((x) => x.type === "native.raw")) {
          if (!e.reason || e.reason.length <= 6) problems.push(`${h}: native.raw 的 reason 不自解释（${JSON.stringify(e.reason)}）`);
        }
        evidence.push(`${h}:${events.length} 条`);
      }
      return problems.length ? bad(problems.join("；")) : ok(`轨迹映射合规（${evidence.join(", ")}）`);
    },
  },

  // -------------------------------------------------------------------------
  {
    id: "C8",
    title: "参数层隔离：把禁止项当参数注入 → 不得静默生效（灵魂项）",
    run: () => {
      const problems = [];
      const injections = {
        AGENT_MODEL_NAME: "evil-model-marker",
        AGENT_TOOLS_DENY: "evil-tool-marker",
        AGENT_INSTRUCTIONS: "evil-instructions-marker",
        AGENT_CONNECTORS_ENABLED: "evil-connector-marker",
        AGENT_SKILLS: "evil-skills-marker",
      };
      for (const h of adaptersPresent()) {
        const agent = makeFullAgent(path.join(tmpdir("c8"), "agent"), { harness: h });
        const clean = path.join(tmpdir("c8"), "clean");
        const dirty = path.join(tmpdir("c8"), "dirty");
        const rc = render(h, agent, clean);
        const rd = render(h, agent, dirty, injections);
        if (rc.status !== 0 || rd.status !== 0) { problems.push(`${h}: render 失败`); continue; }
        const jc = jsonOf(rc.stdout), jd = jsonOf(rd.stdout);
        if (jc?.artifactsDigest !== jd?.artifactsDigest) {
          problems.push(`${h}: 注入禁止项后产物摘要发生变化 —— 说明禁止项**生效了**（参数层纪律被击穿）`);
        }
        // 更强的一条：注入的标记值不得出现在产物任何文件里
        const walk = (d, acc = []) => {
          for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const p = path.join(d, e.name);
            if (e.isDirectory()) walk(p, acc); else acc.push([path.relative(dirty, p), fs.readFileSync(p, "utf8")]);
          }
          return acc;
        };
        for (const [file, text] of walk(dirty)) {
          for (const marker of Object.values(injections)) {
            if (text.includes(marker)) problems.push(`${h}: 禁止项的值出现在产物 ${file} 里（${marker}）`);
          }
        }
      }
      return problems.length ? bad(problems.join("；")) : ok("禁止项注入后产物无变化、标记值未进入产物");
    },
  },

  // -------------------------------------------------------------------------
  {
    id: "C9",
    title: "安全下限声明一致：声明的安全能力与容器内实测一致（不许夸大）",
    run: () => {
      // 容器内实测（§9.2）。镜像不在时记 pending 而非通过 —— **未实现不算通过**。
      const version = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8")).version;
      const res = runImageChecks({ version });
      if (res.pending) return pending(res.pending);
      const failed = res.checks.filter((c) => !c.ok);
      if (failed.length) return bad(failed.map((c) => `${c.id}: ${c.detail}`).join("；"));
      return ok(`容器下限实测成立（${res.checks.length} 项）：${res.checks.map((c) => c.id).join("、")}`, res.images);
    },
  },

  // -------------------------------------------------------------------------
  {
    id: "C10",
    title: "退出码契约：§6.7 的语义逐条成立",
    run: () => {
      const problems = [];
      const good = makeFullAgent(path.join(tmpdir("c10"), "agent"), { harness: "pi" });
      const goodOut = path.join(tmpdir("c10"), "out");
      const checks = [
        ["闸门 1 通过 = 0", () => validate(good).status === 0],
        ["闸门 1 定义非法 = 10", () => validate(path.join(tmpdir("c10"), "empty")).status === 10],
        ["用法错误 = 2（未知参数）", () => run(["tools/validate.mjs", "--nope"]).status === 2],
        ["用法错误 = 2（render 缺参数）", () => run(["adapters/pi/render.mjs"]).status === 2],
        ["传入不存在的样板目录 = 10（输入非法）", () => run(["adapters/pi/render.mjs", path.join(tmpdir("c10"), "nope")]).status === 10],
        ["doctor 在非渲染产物上 = 10", () => run(["adapters/pi/doctor.mjs", tmpdir("c10")]).status === 10],
        ["正常 render = 0", () => render("pi", good, goodOut).status === 0],
        ["正常 doctor = 0", () => doctor("pi", goodOut).status === 0],
      ];
      for (const [name, fn] of checks) {
        let got;
        try { got = fn(); } catch (e) { got = `抛错 ${e.message}`; }
        if (got !== true) problems.push(`${name} —— 实际 ${got}`);
      }
      return problems.length ? bad(problems.join("；")) : ok(`${checks.length} 条退出码语义全部成立`);
    },
  },
];

export default cases;
