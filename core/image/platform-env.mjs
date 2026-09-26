// ============================================================================
// 平台级运行期变量：**容器入口与本地入口必须给同一套**
//
// 为什么单独成文件：这套变量原先分两处手写 —— 容器由 `core/image/entrypoint.sh` 用默认值兜底，
// 本地由 `tools/run-local.mjs` 自己拼一份。两份必然漂移，而漂移的表现是
// **"容器里能用、本地不能用"**，且没有报错指向这里：
//   实测踩中 —— `/project` 在容器里正常，在 `run-local` 里报"读不到渲染清单"，
//   因为本地那份 env 少了 `AGENT_ARTIFACT_DIR`（**清单在产物根，不在暂存副本里**）。
//
// 纪律：新增一个平台级变量 ⇒ 同时更新 `PLATFORM_ENV_NAMES` 与两个入口；
// `local-selftest` 会对"entrypoint.sh 提到、run-local 没给"的变量直接报错。
// ============================================================================

import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");

/** 平台级变量全集（容器与本地都该有的那些）。 */
export const PLATFORM_ENV_NAMES = [
  "AGENT_ARTIFACT_DIR",
  "AGENT_GATES_DIR",
  "AGENT_RUN_DIR",
  "AGENT_RUN_MODE",
  "AGENT_HARNESS_ARGS",
  "AGENT_TRACE_DEST",
];

/** **镜像专有**：本地没有对应物（或本地另有实现），对照检查时豁免。 */
export const IMAGE_ONLY_ENV_NAMES = [
  "AGENT_BASE_VARIANT_FILE",   // 变体标记文件（本地没有镜像变体）
  "AGENT_BASE_STARTUP",        // 镜像内启动脚本路径（本地用仓库里的同一份）
  "AGENT_BASE_HARNESSES",      // 镜像内 harness 清单（本地用 adapters/）
  "AGENT_CRASH_TAIL_LINES",    // 崩溃尾巴行数（本地直接看输出）
];

/**
 * 本地入口（`tools/run-local.mjs`）要补的平台变量。
 *
 * `renderDir` 是**产物根**（渲染输出的整体：`render-manifest.json` + 各运行时目录）。
 * 注意暂存副本里**只有运行目录那一份**，没有清单 —— 所以任何"读清单"的能力
 * （会话内 `/project`、闸门 2 等）都必须拿到这个变量，而不是去猜 `dirname(配置目录)`。
 */
export function localPlatformEnv({ renderDir, runDir }) {
  return {
    AGENT_ARTIFACT_DIR: path.resolve(renderDir),
    // 本地对应物 = 仓库根（容器里是 /opt/agent-base/gates：core/ + tools/ + adapters/ 都在它下面）
    AGENT_GATES_DIR: REPO,
    ...(runDir ? { AGENT_RUN_DIR: path.resolve(runDir) } : {}),
  };
}
