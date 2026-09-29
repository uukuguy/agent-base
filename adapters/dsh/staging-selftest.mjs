#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { stageRenderDir } from "./run.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-staging-selftest-"));
const agent = path.join(root, "agent");
const artifact = path.join(root, "artifact");
let staged;
try {
  fs.mkdirSync(path.join(agent, "skills", "alpha"), { recursive: true });
  fs.writeFileSync(path.join(agent, "agent.yaml"),
    "apiVersion: agent-base/v1\nname: staging-selftest\ndescription: 暂存路径自检\n"
    + "persona: { instructions: 自检。 }\nmodel: { provider: corp-gateway, name: corp-think }\n");
  fs.writeFileSync(path.join(agent, "skills", "alpha", "SKILL.md"),
    "---\nname: alpha\ndescription: 自检技能\n---\n正文\n");
  const render = spawnSync(process.execPath, [path.join(here, "render.mjs"), agent, "--out", artifact], { encoding: "utf8" });
  assert.equal(render.status, 0, render.stderr);
  staged = stageRenderDir(artifact, "http://127.0.0.1:9/v1", { zeroCredential: true });
  assert.equal(staged.staging, staged.runDir, "staging must identify the run root, not the profile directory");
  assert.ok(fs.existsSync(path.join(staged.staging, "skills", "alpha", "SKILL.md")), "skills must be available below staging");
  assert.equal(staged.configDir, path.join(staged.dshHome, "profiles", "staging-selftest"));
  assert.ok(fs.existsSync(path.join(staged.configDir, "cordis.patch.yml")));
  console.log("✅ dsh-staging-selftest 通过");
} finally {
  if (staged?.runDir) fs.rmSync(staged.runDir, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
}
