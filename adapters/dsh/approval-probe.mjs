#!/usr/bin/env node
// ============================================================================
// dsh 审批接缝探针（路线图 §30 A6b 的"先量"步骤，可重跑）
//
// 它回答三个问题，每一条都**真跑**而不是读声明：
//   ① 本运行时原生 `--json` 事件流里有没有审批记录？（我们统一的轨迹映射读的就是这条流）
//   ② 它的会话文件里有没有审批审计事件？
//   ③ 基座能不能用**相对路径 insert row** 加载自己的插件？（A6b 落地的前提）
//
// 结论会写进 `docs/design/2026-09-25-dsh-harness-design.md` 的实测章节；本脚本是那条结论的证据，
// 让下一个人（或下一个会话）不必重新踩一遍。
//
// 用法：node adapters/dsh/approval-probe.mjs [--json]   （或 make dsh-approval-probe）
// 退出码：0 探针跑完（**不代表**结论是"有审批"）· 2 用法错 · 50 崩溃
// ============================================================================

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { EXIT_CODES, parseArgs } from "../../core/gates/index.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const { flags } = parseArgs(process.argv.slice(2), { booleanFlags: ["--json"] });
const asJson = flags.has("--json");
const log = (s) => process.stderr.write(`${s}\n`);

/** 造一个最小定义（探针不依赖仓库里的示例，示例一改这里就红）。 */
function makeAgent() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-probe-agent-"));
  const agent = path.join(root, "agent");
  fs.mkdirSync(path.join(agent, "skills", "alpha"), { recursive: true });
  fs.writeFileSync(path.join(agent, "agent.yaml"),
    "apiVersion: agent-base/v1\nname: dsh-approval-probe\ndescription: 审批探针\n"
    + "persona: { instructions: 探针。 }\nmodel: { provider: corp-gateway, name: corp-think }\nconnectorsFile: connectors.yaml\n");
  fs.writeFileSync(path.join(agent, "connectors.yaml"), "apiVersion: agent-base/v1\nmcpServers: []\n");
  fs.writeFileSync(path.join(agent, "skills", "alpha", "SKILL.md"), "---\nname: alpha\ndescription: 一句话\n---\n正文\n");
  return agent;
}

const PROBE_PLUGIN = `import fs from "node:fs";
export const name = "ab-probe-plugin";
export const inject = ["commands"];
export function apply(ctx) {
  fs.appendFileSync(process.env.AB_PROBE_MARKER, "apply\\n");
  const dispose = ctx.commands.register({ name: "ab-probe", description: "probe", handler: () => {} });
  fs.appendFileSync(process.env.AB_PROBE_MARKER, "registered:" + (typeof dispose) + "\\n");
}
`;

/** 会话文件（zstd JSONL）里的事件类型分布。 */
function sessionTypes(staging) {
  const out = [];
  const walk = (dir, depth = 0) => {
    if (depth > 6 || !fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.name.endsWith(".jsonl.zstd")) out.push(p);
    }
  };
  walk(path.join(staging, "dsh-home", "sessions"));
  const perFile = [];
  for (const f of out) {
    try {
      const raw = zlib.zstdDecompressSync(fs.readFileSync(f)).toString("utf8");
      const types = {};
      for (const line of raw.trim().split("\n").filter(Boolean)) {
        try { const o = JSON.parse(line); types[o.type ?? "(无)"] = (types[o.type ?? "(无)"] ?? 0) + 1; } catch { /* 跳过坏行 */ }
      }
      perFile.push(types);
    } catch { perFile.push({ "(解压失败)": 1 }); }
  }
  return { files: out.length, perFile };
}

const main = async () => {
  const agent = makeAgent();
  const renderDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-probe-render-"));
  const r = spawnSync(process.execPath, [path.join(REPO, "adapters/dsh/render.mjs"), agent, "--out", renderDir], { encoding: "utf8", cwd: REPO });
  if (r.status !== 0) { log(`❌ 渲染失败：${(r.stderr ?? "").slice(-300)}`); process.exit(EXIT_CODES.crash); }

  const { startFakeGateway } = await import(`file://${path.join(REPO, "tools/fake-gateway/server.mjs")}`);
  const runner = await import(`file://${path.join(HERE, "run.mjs")}`);
  const gateway = await startFakeGateway({ silent: true });

  const result = { harness: "dsh", channels: {}, pluginRow: {}, notes: [] };

  try {
    // ---- ① 原生事件流里有没有审批记录（两种权限模式各跑一次）----
    for (const mode of ["danger-full-access", "ask"]) {
      const run = await runner.runAgent({
        renderDir, endpoint: gateway.url, prompt: "read the file AGENTS.md and tell me the first line",
        timeoutMs: 120000, zeroCredential: true, env: { AGENT_PERMISSION_MODE: mode },
      });
      const types = {};
      for (const e of run.native) types[e?.type ?? "(无 type)"] = (types[e?.type ?? "(无 type)"] ?? 0) + 1;
      const approvalRecords = run.native.filter((e) => /approval|permission/i.test(String(e?.type ?? "")));
      result.channels[mode] = { exitCode: run.exitCode, nativeTypes: types, approvalRecords: approvalRecords.length };
      // ② 会话文件（通道②）
      if (mode === "ask") result.channels.sessionFiles = sessionTypes(run.staging ?? "");
    }

    // ---- ③ 相对路径 insert row 能不能加载基座自己的插件 ----
    const profileDir = path.join(renderDir, "dsh-home", "profiles", JSON.parse(fs.readFileSync(path.join(renderDir, "render-manifest.json"), "utf8")).agent);
    const patchFile = path.join(profileDir, "cordis.patch.yml");
    const original = fs.readFileSync(patchFile, "utf8");
    const pluginDir = path.join(profileDir, "plugins", "ab-probe");
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(path.join(pluginDir, "package.json"), JSON.stringify({ name: "ab-probe", version: "0.0.0", main: "index.js", type: "module" }) + "\n");
    fs.writeFileSync(path.join(pluginDir, "index.js"), PROBE_PLUGIN);

    for (const [variant, name] of [["dir", "./plugins/ab-probe"], ["entryFile", "./plugins/ab-probe/index.js"]]) {
      const marker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dsh-probe-marker-")), "marker.txt");
      fs.writeFileSync(marker, "");
      fs.writeFileSync(patchFile, `${original}\n- insert:\n    - id: ab-probe\n      name: ${name}\n`);
      const run = await runner.runAgent({
        renderDir, endpoint: gateway.url, prompt: "hi", timeoutMs: 120000, zeroCredential: true,
        env: { AB_PROBE_MARKER: marker, AGENT_PERMISSION_MODE: "danger-full-access" },
      });
      const text = fs.readFileSync(marker, "utf8");
      result.pluginRow[variant] = {
        rowName: name,
        exitCode: run.exitCode,
        applyRan: /apply/.test(text),
        commandsRegistered: /registered:function/.test(text),
        imported: !new RegExp(`${path.basename(name)}.*failed to import`).test(String(run.stderr ?? "")),
        marker: text.trim().split("\n").filter(Boolean),
      };
    }
    fs.writeFileSync(patchFile, original); // 还原渲染产物（探针不该留下改动）
  } finally {
    await gateway.close?.();
  }

  const noApprovalInStream = ["danger-full-access", "ask"].every((m) => result.channels[m].approvalRecords === 0);
  const sessionOnly = (result.channels.sessionFiles?.perFile ?? []).every((t) => Object.keys(t).every((k) => k === "session"));
  result.verdict = {
    approvalInRunEvents: !noApprovalInStream ? "有" : "没有（两种模式都没有）",
    approvalInSessionFile: sessionOnly ? "没有（本次运行只有 session 引导事件）" : "有",
    pluginRowEntryFileWorks: result.pluginRow.entryFile?.commandsRegistered === true,
    pluginRowDirectoryFails: result.pluginRow.dir?.applyRan === false,
  };
  result.notes = [
    "审批接缝本身存在（`ctx.approval.request` → allowed-once | rejected | cancelled | unavailable，fail-closed）；缺的是**基座侧的插件落地**。",
    "相对路径 row 必须指向**入口文件**（ESM 没有目录解析）：指向目录会「failed to import」。",
    "因此另一侧的审批门 = 建基座不变量插件脚手架（seed 插件 + 渲染器 insert row + 事件写入），见路线图 §30 A6b。",
  ];

  if (asJson) process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  else {
    log("── dsh 审批接缝探针 ──");
    for (const m of ["danger-full-access", "ask"]) {
      const c = result.channels[m];
      log(`  ${m}: 退出码 ${c.exitCode} · 原生事件类型 ${JSON.stringify(c.nativeTypes)} · 审批记录 ${c.approvalRecords} 条`);
    }
    log(`  会话文件：${result.channels.sessionFiles?.files ?? 0} 个 · 类型 ${JSON.stringify((result.channels.sessionFiles?.perFile ?? []).map((t) => Object.keys(t).join("+")))}`);
    for (const [k, v] of Object.entries(result.pluginRow)) log(`  插件 row(${k}) name=${v.rowName} ⇒ apply 跑了=${v.applyRan} 注册成功=${v.commandsRegistered}`);
    log("  结论：");
    for (const [k, v] of Object.entries(result.verdict)) log(`    · ${k}: ${v}`);
  }
  process.exit(EXIT_CODES.ok);
};

await main();
