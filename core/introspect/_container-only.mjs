// ============================================================================
// 「**只能在容器里成立**」的断言清单（声明式）
//
// 为什么要有这份声明：验证计划（`verify-plan`）必须能回答"哪些必须在容器里验、为什么"，
// 而且**加一条容器断言时要自动出现**，不能靠人去改文档。C9 的检查是**命令式**写的
// （`add("uid-non-root", …)`），没法直接当清单用，所以这里把"归属哪一类、为什么宿主做不到"
// 显式声明出来，并让 `project-info-selftest` 盯住它与 C9 实现一致：
//   · 声明里有的 id，必须在 `conformance/image-*.mjs` 里真的存在（防改名/删掉后声明过期）
//   · C9 里写出来的 id（`add("字面量"` 形态），必须都能在声明里找到归属（防"加了检查但没归类"）
//
// ⚠️ 诚实标注这条判据的强度：第二条只覆盖**字面量**写法（`add("…")`）。用变量拼 id 的检查
// 扫不到 ⇒ 那种写法要么改成字面量，要么在此显式登记进 `NOT_DECLARED` 并写明理由。
// ============================================================================

/** 实现这些检查的文件（自检会扫它们取 id）。 */
export const IMAGE_CHECK_SOURCES = [
  "conformance/image-checks.mjs",
  "conformance/image-capability-checks.mjs",
];

/**
 * 四类容器断言。`why` 是"宿主为什么做不到" —— 它同时是失败归因的依据：
 * 命中这里的失败**不是缺陷**，而是环境差异；`unknown` 才是要追的。
 */
export const CONTAINER_ONLY = [
  {
    id: "in-image-verify",
    label: "镜像内自证（闸门 2/3/4，离线零凭据）",
    why: "闸门与运行时都在镜像里；宿主上跑的是另一套路径（本地入口），两者不可互证",
    checks: [
      "offline-harness-usable",
      "offline-mcp-resolvable",
      "agent-runs-with-injected-llm-config",
      "container-endpoint-received-request",
      "container-model-name-from-runtime",
      "container-artifact-untouched",
      "container-missing-credential-fails-fast",
    ],
  },
  {
    id: "security-floor",
    label: "容器安全下限（非 root / 只读根 / 能力全丢 / 声明一致）",
    why: "本机没有等价机制（macOS 无 OS 级沙箱）⇒ 宿主的结论里**本来就不含**这一项",
    checks: [
      "uid-non-root",
      "rootfs-readonly",
      "capabilities-dropped",
      "declared-vs-measured",
      "production-refuses-debug",
      "debug-variant-usable",
    ],
  },
  {
    id: "dual-arch",
    label: "双架构可构建 / 可运行",
    why: "只有构建侧与容器有；宿主只跑一个架构",
    checks: ["dual-arch-image", "multiarch-manifest"],
  },
  {
    id: "same-source",
    label: "镜像与源码同源（LABEL 指纹复算）",
    why: "要比的是镜像里的 LABEL，只有镜像有",
    checks: ["images-same-source"],
  },
];

/** 声明覆盖的全部检查 id。 */
export const CONTAINER_CHECKS = CONTAINER_ONLY.flatMap((c) => c.checks);

/**
 * 已知**未归类**的 C9 检查（诚实登记用）。
 * 目前为空：`agent-runs-with-injected-llm-config` 已归入 `in-image-verify`。
 */
export const NOT_DECLARED = [];

/** 一个具体的 C9 检查 id 属于哪一类（归因用）。 */
export function containerClaimOf(checkId) {
  return CONTAINER_ONLY.find((c) => c.checks.includes(checkId)) ?? null;
}
