// ============================================================================
// 轨迹查看器：把机械轨迹 + 业务附加的标签 → 业务可读时间轴
//
// ## 层次纪律（这是本文件存在的理由）
//
// 本文件**不在 core/**，因为它处理业务语义。基座（core/）**不懂业务语言**，
// 它只做两件事：① 保证轨迹机械上可读（时间戳 / seq / run / callId / type 判别）；
// ② 提供一个**附加协议**，让业务把自己的说法挂上来，然后原样带过去、从不解释。
//
// 于是分工是：
//   基座   = 机械事实 + 附加位（不解释）
//   业务   = 提供一份 `trace-labels.yaml`：`定位符 → 业务说法`
//   查看器 = 做**机械的键查找**（不是语义推断），查不到就退回机械渲染
//
// 查看器之所以不违反纪律，是因为它只做**字符串查找**：它不知道「工单系统」是业务系统，
// 只知道"业务给 `connector:jira` 起了这个名字"。换一个业务、换一套词，这里一行都不用改。
//
// ## 附加协议（基座定义，业务填写）
//
// `trace-labels.yaml`（可选，放在智能体定义根目录，随渲染产物原样带出）：
//
//   apiVersion: agent-base/v1
//   labels:
//     "agent":                      合同条款审阅助手
//     "skill:example":              把想法拆成可验证的断言
//     "connector:jira":             工单系统
//     "tool:mcp__jira__get_issue":  查询工单
//     "log:contract":               合同金额校验
//     "gate:probes":                连通性检查
//
// 定位符语法（基座定义，机械可判定）：
//   agent | model:<route> | skill:<name> | connector:<name> | tool:<raw tool name>
//   log:<日志命名空间> | gate:<name>
//
// 用法：
//   node tools/trace-view/labels.mjs <AGENT_DIR> [--timeline <轨迹 JSONL>]
// ============================================================================

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { digestDirectory, parseArgs } from "../../core/gates/index.mjs";

export const LABELS_FILE = "trace-labels.yaml";

/**
 * 读取业务提供的标签表。**基座/查看器不校验语义**，只校验形状（string → string）。
 * @returns {{labels: Record<string,string>, problems: string[]}}
 */
export function loadLabels(agentDir) {
  const file = path.join(agentDir, LABELS_FILE);
  if (!fs.existsSync(file)) return { labels: {}, problems: [] };
  let doc;
  try {
    doc = YAML.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    return { labels: {}, problems: [`${LABELS_FILE} 不是合法 YAML：${e.message}`] };
  }
  const problems = [];
  const raw = doc?.labels ?? {};
  const labels = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v !== "string") { problems.push(`标签 ${k} 的值不是字符串（业务说法应当是给人看的一句话）`); continue; }
    labels[k] = v;
  }
  return { labels, problems };
}

/** 定位符构造：把轨迹元素映射成协议里的键。纯机械，不含任何业务判断。 */
export const locator = {
  agent: () => "agent",
  model: (route) => `model:${route}`,
  skill: (name) => `skill:${name}`,
  connector: (name) => `connector:${name}`,
  tool: (rawToolName) => `tool:${rawToolName}`,
  log: (namespace) => `log:${namespace}`,
  gate: (name) => `gate:${name}`,
};

/** 解析 harness 约定的 MCP 工具名 `mcp__<server>__<tool>`（§6.6）。不是该形态则返回 null。 */
export function parseMcpToolName(tool) {
  const m = /^mcp__([A-Za-z0-9_-]+)__(.+)$/.exec(String(tool ?? ""));
  return m ? { server: m[1], tool: m[2] } : null;
}

/** 业务说法查表：先查最具体的定位符，再查退一级的。查不到返回 null（交给机械渲染）。 */
function lookup(labels, keys) {
  for (const k of keys) if (labels[k]) return labels[k];
  return null;
}

/**
 * 渲染一条事件。**有标签用标签，没标签用机械事实** —— 永不发明业务含义。
 * @returns {{label: string, source: "business"|"mechanical", kind: string}}
 */
export function describeEvent(event, labels = {}) {
  const bizSuffix = event.biz && Object.keys(event.biz).length
    ? `（${Object.entries(event.biz).map(([k, v]) => `${k}=${v}`).join(", ")}）`
    : "";

  switch (event.type) {
    case "run.meta":
      return { kind: "run", source: labels.agent ? "business" : "mechanical",
        label: `${labels.agent ?? "运行"}${event.mode === "debug" ? "（调试模式）" : ""}` };

    case "biz.event": {
      // 业务级日志。渲染成 logger 常见的样子：级别 + 命名空间（可用业务标签替换）+ 消息 + 字段。
      const custom = lookup(labels, [locator.log(event.namespace)]);
      const what = custom ?? event.namespace ?? "";
      const fields = event.data && Object.keys(event.data).length
        ? ` ［${Object.entries(event.data).map(([k, v]) => `${k}=${v}`).join(", ")}］`
        : "";
      const tag = `[${String(event.level ?? "info").toUpperCase()}]`;
      return { kind: "log", source: custom ? "business" : "mechanical",
        label: `${tag} ${what}: ${event.message ?? ""}${fields}` };
    }

    // 技能使用：业务标签按 `skill:<名>` 查表；查不到给机械措辞。
    // 这条事件是**推导**出来的（见 trace schema 的 derivation 字段），所以标签里也说清是推导 ——
    // 别让看轨迹的人把"按路径推导"误读成"运行时原生上报了技能"。
    case "skill.use": {
      const custom = lookup(labels, [locator.skill(event.skill)]);
      const how = event.derivation === "path-pattern" ? "（按路径推导）" : "";
      if (custom) return { kind: "skill", source: "business", label: `${custom}${how}` };
      return { kind: "skill", source: "mechanical", label: `使用技能 ${event.skill}${how}` };
    }

    // 审批决定（人在环）：让"谁放行了这次调用"在轨迹里看得见。
    // `unavailable` 要写得醒目 —— 它意味着**没有应答者**，此时调用方必须按 fail-closed 放弃。
    case "approval.decision": {
      const who = event.answerer ?? "?";
      if (event.decision === "granted") return { kind: "approval", source: "mechanical", label: `放行 ${event.subject}（应答者 ${who}）` };
      if (event.decision === "denied") return { kind: "approval", source: "mechanical", label: `**拒绝** ${event.subject}（应答者 ${who}）` };
      return { kind: "approval", source: "mechanical", label: `⚠️ 无人应答 ${event.subject} ⇒ 按 fail-closed 放弃` };
    }

    case "tool.call": {
      const mcp = parseMcpToolName(event.tool);
      const custom = lookup(labels, [
        locator.tool(event.tool),
        ...(mcp ? [locator.connector(mcp.server)] : []),
      ]);
      if (custom) return { kind: "tool", source: "business", label: `${custom}${mcp ? `（${mcp.tool}）` : ""}${bizSuffix}` };
      // 机械回退：只说事实（调用了哪个工具），不编业务说法
      return { kind: "tool", source: "mechanical", label: `调用工具 ${event.tool}${bizSuffix}` };
    }

    case "tool.result": {
      const mcp = parseMcpToolName(event.tool);
      const custom = lookup(labels, [
        ...(event.tool ? [locator.tool(event.tool)] : []),
        ...(mcp ? [locator.connector(mcp.server)] : []),
      ]);
      const what = custom ?? (event.tool ? `工具 ${event.tool}` : "上一步调用");
      const est = event.msIsEstimated ? "，耗时推算" : "";
      return { kind: "tool", source: custom ? "business" : "mechanical",
        label: `${custom ? "完成" : "完成"}：${what}（${event.ms}ms${est}）${bizSuffix}` };
    }

    case "model.request": {
      const custom = lookup(labels, [locator.model(event.provider)]);
      return { kind: "model", source: custom ? "business" : "mechanical",
        label: `${custom ?? `请求模型 ${event.provider}/${event.model}`}（携带 ${event.tools} 个工具${event.stream ? "，流式" : ""}）` };
    }

    case "model.error":
      return { kind: "model", source: "mechanical", label: `模型调用失败（${event.code}，路由 ${event.provider}）` };

    case "gate": {
      const custom = lookup(labels, [locator.gate(event.name)]);
      return { kind: "gate", source: custom ? "business" : "mechanical",
        label: `${custom ?? `闸门 ${event.name}`}／${event.target}：${event.ok ? "通过" : "失败"}` };
    }

    case "native.raw":
      return { kind: "native", source: "mechanical", label: `未映射的原生事件 ${event.nativeType}（${event.reason}）` };

    default:
      return { kind: "unknown", source: "mechanical", label: `未知事件类型 ${event.type}` };
  }
}

/** 渲染业务可读时间轴。◆ 表示用了业务说法，· 表示机械回退。 */
export function renderTimeline(events, labels = {}) {
  return events
    .map((e) => {
      const { label, source } = describeEvent(e, labels);
      const mark = source === "business" ? "◆" : "·";
      return `${String(e.seq).padStart(5)} ${mark} ${label}`;
    })
    .join("\n") + "\n";
}

/** 统计「业务说法覆盖率」——可视化时一眼看出还有哪些环节业务没给说法。 */
export function coverage(events, labels = {}) {
  let business = 0;
  for (const e of events) if (describeEvent(e, labels).source === "business") business++;
  return { business, mechanical: events.length - business, total: events.length };
}

// ---------------------------------------------------------------------------
function main() {
  // 用统一解析器：手写"跳过旗标值"的索引过滤在本项目里已出错三次（`indexOf` 返回 -1 时
  // 会算成 -1+1=0，把第一个位置参数吞掉）。统一解析器按"旗标吃掉它的值"推进，不会误吞。
  const { values, flags, positionals } = parseArgs(process.argv.slice(2), { valueFlags: ["--timeline"] });
  const args = process.argv.slice(2);
  const timelinePath = values["--timeline"] ?? null;
  const ti = timelinePath ? args.indexOf(timelinePath) : -1;
  const agentDir = positionals[0];
  if (!agentDir || flags.has("--help") || flags.has("-h")) {
    process.stderr.write("用法: node tools/trace-view/labels.mjs <AGENT_DIR> [--timeline <轨迹 JSONL>]\n");
    process.exit(agentDir ? 0 : 2);
  }
  const dir = path.resolve(agentDir);
  if (!fs.existsSync(path.join(dir, "agent.yaml"))) {
    process.stderr.write(`❌ 找不到 ${path.join(dir, "agent.yaml")}\n`);
    process.exit(10);
  }
  const { labels, problems } = loadLabels(dir);
  if (timelinePath) {
    const events = fs.readFileSync(timelinePath, "utf8").split("\n").filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    process.stdout.write(renderTimeline(events, labels));
    const c = coverage(events, labels);
    process.stderr.write(`业务说法覆盖：${c.business}/${c.total}（其余 ${c.mechanical} 条为机械回退）\n`);
  } else {
    process.stdout.write(JSON.stringify({
      definitionDigest: digestDirectory(dir),
      labelCount: Object.keys(labels).length,
      labels,
    }, null, 2) + "\n");
  }
  for (const p of problems) process.stderr.write(`⚠️  ${p}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
