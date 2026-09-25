#!/usr/bin/env node
// ============================================================================
// 从 `preinstall.yaml` 生成**镜像构建锁**（统一设计 §10.4 H5 / §12.1）
//
// ## 为什么要有"生成"这一步
//
// 镜像要预装十几个包。**手抄进 Dockerfile 是最容易烂的写法**：
// 清单改了 Dockerfile 没改、或两处版本不一致，而两者都不会报错 ——
// 镜像里装的和清单里写的不是一回事，直到某个智能体在运行时莫名连不上才发现。
//
// 所以：`preinstall.yaml` 是**唯一真源**，本脚本生成 `preinstall.lock.txt`（构建输入），
// `make validate` 里有一项检查二者同步（`--check`）—— 不同步即失败，不静默。
//
// ## 锁的三种行（前缀即类别）
//
//   npm <pkg>@<ver>      → 全局安装 + 预热缓存（离线可用）
//   apt <pkg> <pkg> ...  → 系统工具链（shell 工具、证书等）
//   skill <id>           → 由基座提供的技能文件，**不进镜像层**（未落盘的标 planned）
//
// ## 架构中立（用户明确要求：同时支持 arm64 与 amd64）
//
// 锁里**不允许出现任何架构相关的值**（GOARCH、platform、mirror 之类）。
// 基础镜像与 apt/npm 包都必须是双架构可得的；镜像构建走 buildx 多架构 manifest list。
// 若某条目只能单架构，必须显式标注 `arch: <值>`，让构建期失败而不是静默产出残废镜像。
//
// 用法：
//   node core/image/gen-preinstall-lock.mjs            # 生成/刷新锁
//   node core/image/gen-preinstall-lock.mjs --check    # 只校验是否同步（不同步则非零退出）
// ============================================================================

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EXIT_CODES } from "../gates/index.mjs";
import { loadPreinstall } from "./resolve-preinstall.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const LOCK_PATH = path.join(HERE, "preinstall.lock.txt");

/** 只认这几种 registry；出现别的必须响亮失败，绝不静默跳过（跳过 = 镜像里少装东西而没人知道）。 */
const SUPPORTED_REGISTRIES = new Set(["npm", "system"]);

/**
 * 由清单推出锁内容。**确定性**：各类内部按名字排序。
 * @returns {{lines: string[], counts: {npm: number, apt: number, skill: number, plannedSkills: string[]}}}
 */
export function buildLock(preinstall = loadPreinstall()) {
  const entries = preinstall.list.entries ?? [];
  const npm = [];
  const apt = [];
  const skills = [];
  const planned = [];

  for (const e of entries) {
    if (e.kind === "skill") {
      (e.status === "planned" ? planned : skills).push(e.id);
      continue;
    }
    const inst = e.install;
    if (!inst) throw new Error(`条目 ${e.id}（kind=${e.kind}）既不是 skill 也没有 install —— 清单结构异常`);
    if (!SUPPORTED_REGISTRIES.has(inst.registry)) {
      throw new Error(`条目 ${e.id} 使用未支持的 registry「${inst.registry}」—— 请先扩展本脚本，不要静默跳过`);
    }
    // 架构相关声明一律拒绝：本基座承诺双架构，单架构条目必须先在清单里显式声明并被审查
    if (inst.arch) throw new Error(`条目 ${e.id} 声明了单架构 install.arch=${inst.arch} —— 与「双架构」要求冲突，需专门裁决`);

    if (inst.registry === "npm") {
      if (!inst.package || !inst.version) throw new Error(`条目 ${e.id} 的 install 缺 package 或 version`);
      npm.push(`npm ${inst.package}@${inst.version}`);
    } else {
      if (!Array.isArray(inst.packages) || !inst.packages.length) throw new Error(`条目 ${e.id} 的 system install 缺 packages`);
      apt.push(...inst.packages);
    }
  }

  npm.sort();
  const aptSorted = [...new Set(apt)].sort();
  skills.sort();

  const header = [
    "# 由 core/image/gen-preinstall-lock.mjs 从 preinstall.yaml 生成 —— 不要手改。",
    "# 改了 preinstall.yaml 就重跑 `make image-lock`；`make validate` 会检查二者同步。",
    "# 三种前缀：npm <pkg>@<ver> / apt <pkg...> / skill <id>",
    "# 架构中立：双架构（linux/arm64 + linux/amd64）都必须可构建。",
    `# 统计：npm ${npm.length} · apt ${aptSorted.length} · 技能 ${skills.length}${planned.length ? `（另有 ${planned.length} 个 planned 未落盘：${planned.sort().join(", ")}）` : ""}`,
    "",
  ];
  const body = [
    ...npm,
    ...(aptSorted.length ? [`apt ${aptSorted.join(" ")}`] : []),
    ...skills.map((s) => `skill ${s}`),
  ];
  // 末尾保留一个空行：POSIX 文本文件（也让 `diff` 与生成结果比较时稳定）
  return { lines: [...header, ...body, ""].join("\n"), counts: { npm: npm.length, apt: aptSorted.length, skill: skills.length, plannedSkills: planned.sort() } };
}

function main() {
  const check = process.argv.includes("--check");
  const { lines, counts } = buildLock();
  const exists = fs.existsSync(LOCK_PATH);
  const summary = `npm ${counts.npm} · apt ${counts.apt} · 技能 ${counts.skill}${counts.plannedSkills.length ? ` · planned ${counts.plannedSkills.length}` : ""}`;

  if (check) {
    if (!exists) {
      process.stderr.write(`❌ 缺 ${path.relative(process.cwd(), LOCK_PATH)} —— 跑 make image-lock 生成\n`);
      process.exit(EXIT_CODES.static);
    }
    if (fs.readFileSync(LOCK_PATH, "utf8") !== lines) {
      process.stderr.write(
        "❌ preinstall.lock.txt 与 preinstall.yaml 不同步 —— 跑 make image-lock 刷新\n" +
        "   （不同步意味着：镜像里装的包与清单里写的不是一回事）\n",
      );
      process.exit(EXIT_CODES.static);
    }
    process.stdout.write(`✅ 预装锁与清单同步（${summary}）\n`);
    process.exit(EXIT_CODES.ok);
  }

  fs.writeFileSync(LOCK_PATH, lines);
  process.stdout.write(`✅ 已生成 ${path.relative(process.cwd(), LOCK_PATH)}：${summary}\n`);
  process.exit(EXIT_CODES.ok);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) main();
