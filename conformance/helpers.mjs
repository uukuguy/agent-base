// ============================================================================
// conformance 共享工具
//
// 这些函数的共同点：**只通过命令行边界调用被测适配器**，不 import 它的内部函数。
// 理由：conformance 验的是"这个适配器作为一个可交付物合不合规"，
// 绕过 CLI 直接调内部实现，会把"接口坏了但内部还能用"这种问题放过。
// ============================================================================

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, "..");

export function run(args, opts = {}) {
  const r = spawnSync(process.execPath, args, { encoding: "utf8", cwd: REPO, ...opts });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

export function jsonOf(out) {
  try { return JSON.parse(out); } catch { return null; }
}

export const adaptersPresent = () =>
  fs.readdirSync(path.join(REPO, "adapters"), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

export function tmpdir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `conformance-${prefix}-`));
}

/**
 * 造一个**字段尽量填满**的智能体定义（C3 渲染完整性需要"每个非空字段都有表达"）。
 * 刻意不声明连接器：该 harness 原生无 MCP 客户端时，声明连接器会让 render 响亮失败——
 * 那是 C5 的注入场景，不是 C3 的输入。
 */
export function makeFullAgent(dir, { name = "conformance-agent", reasoningEffort = null, enhancements = false } = {}) {
  fs.mkdirSync(path.join(dir, "skills", "alpha"), { recursive: true });
  fs.mkdirSync(path.join(dir, "prompts"), { recursive: true });
  fs.writeFileSync(path.join(dir, "prompts", "system.md"), "你是合规审阅助手，只给可验证的结论。\n");
  fs.writeFileSync(path.join(dir, "agent.yaml"), [
    "apiVersion: agent-base/v1",
    `name: ${name}`,
    "description: conformance 渲染完整性用例",
    "persona:",
    "  instructions: |",
    "    你是合规审阅助手。只做条款风险识别，不做法律意见。",
    "model:",
    "  route: corp-gateway",
    `  name: corp-think${reasoningEffort ? `\n  reasoningEffort: ${reasoningEffort}` : ""}`,
    "tools:",
    "  deny: [bash, write]",
    "skillsDir: skills",
    "connectorsFile: connectors.yaml",
    "",
  ].join("\n"));
  fs.writeFileSync(path.join(dir, "connectors.yaml"), "apiVersion: agent-base/v1\nmcpServers: []\n");
  fs.writeFileSync(path.join(dir, "skills", "alpha", "SKILL.md"),
    "---\nname: alpha\ndescription: 扫描条款风险并分级\nwhenToUse: 用户给出合同文本时\n---\n正文\n");
  fs.mkdirSync(path.join(dir, "skills", "alpha", "scripts"), { recursive: true });
  fs.writeFileSync(path.join(dir, "skills", "alpha", "scripts", "scan.sh"), "#!/bin/sh\necho scan\n");
  if (enhancements) {
    fs.mkdirSync(path.join(dir, "harness", adaptersPresent()[0], "extensions"), { recursive: true });
    fs.writeFileSync(path.join(dir, "harness", adaptersPresent()[0], "enhancements.yaml"),
      "apiVersion: agent-base/v1\nharness: " + adaptersPresent()[0] + "\nenhancements:\n  - kind: tool\n    id: risk-score\n    entry: extensions/risk-score.ts\n");
    fs.writeFileSync(path.join(dir, "harness", adaptersPresent()[0], "extensions", "risk-score.ts"), "export default function () {}\n");
  }
  return dir;
}

export const render = (harness, agentDir, outDir, env = {}) =>
  run([`adapters/${harness}/render.mjs`, agentDir, "--out", outDir, "--json"], { env: { ...process.env, ...env } });

export const doctor = (harness, renderDir, env = {}) =>
  run([`adapters/${harness}/doctor.mjs`, renderDir, "--json"], { env: { ...process.env, ...env } });

export const validate = (agentDir) => run(["tools/validate.mjs", agentDir]);

export function copyDir(from, to) {
  fs.cpSync(from, to, { recursive: true });
  return to;
}

export function readYamlFile(rel) {
  // 这里用 runner 侧的最小 YAML 读法：只支持 conformance 自己写的那些文件形状
  const text = fs.readFileSync(path.join(REPO, rel), "utf8");
  return text;
}
