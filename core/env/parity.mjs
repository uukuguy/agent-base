// ============================================================================
// 环境一致性：**已声明差异**的清单与归类（路线图 §28 Q1/Q2）
//
// 为什么需要：本地（宿主）与容器是两个环境，结论可能不一致。**差异本身不可怕，未声明才可怕**
// —— 未声明的差异会让"本地过、容器挂"，而 AI/人都不知道那是环境还是缺陷（§30 A4 的归因前提）。
//
// 纪律（沿用 `exemptions.yaml` 那一套）：**可以不一样，但不许悄悄不一样**。
//   · 已知差异 → 在本文件声明，并写清"为什么必须差"与"本地能否预检"
//   · 未声明的差异 → 判据直接红（见 `classify`）
//
// 本文件的容器断言部分**不另列一份**：直接来自 `core/introspect/_container-only.mjs`
// （那份已经被 `project-info-selftest` 盯着与 C9 实现一致）。两份清单必然漂移，这里不要第二份。
// ============================================================================

import { CONTAINER_ONLY } from "../introspect/_container-only.mjs";

/**
 * 已知差异分类。
 * `precheckable`：本地能不能在动手前就查出来（能 ⇒ 归入"本地预检"，别留到容器里才发现）。
 */
export const DIFFERENCE_CLASSES = [
  // ① 只能在容器里成立的断言：本地做不了，但**已声明**（不算"未知"）
  ...CONTAINER_ONLY.map((c) => ({
    id: `container-only:${c.id}`,
    label: c.label,
    why: c.why,
    precheckable: false,
  })),
  // ② 宿主工具链：容器用 apt 装，本地用宿主提供的同名工具 —— 来源不同，版本可能不同
  {
    id: "host-toolchain",
    label: "宿主工具链（容器由 apt 装，本地由宿主提供）",
    why: "同一份预装清单，容器里由 apt 保证；本机只有「宿主恰好有」这回事",
    precheckable: true,
  },
  // ③ 预装 npm 包：镜像里构建期装齐；本机靠 .local-packages（可能缺项）
  {
    id: "preinstall-npm-local",
    label: "预装 npm 包在本机的镜像（可能缺项）",
    why: "镜像构建期按锁装齐；本机用 .local-packages 作为对应物，缺项属已知差异而非缺陷",
    precheckable: true,
  },
  // ④ 宿主 node_modules 不进容器：依赖来源不同（macOS 原生模块进 Linux 会炸）
  {
    id: "host-node-modules",
    label: "宿主 node_modules 不挂进容器",
    why: "宿主是 macOS 构建的原生模块，进 Linux 容器会炸 ⇒ 容器用镜像自带的依赖",
    precheckable: false,
  },
  // ⑤ 候选运行时在容器内跑不起来：镜像里那份缺 **Linux 版原生插件二进制**
  //
  // 实测（2026-09-28，业务方/文档走查顺带撞到，容器内直接调用该运行时）：
  //   容器内报 `Cannot find module .../node-addon-require-builtin/build/napi/napi-v9-linux-arm64-gnu/require_builtin.node`
  //   ⇒ 它在**容器里根本起不来**，于是该侧的闸门 3/4 在容器内无法成立（本地正常，实测 tools=19）。
  //
  // **对照实验**：把能力包选择换成"不摘任何内容"，容器内**同样** tools=0 ⇒
  //   与本轮的能力包改动无关，是一处**既有的**未声明差异（此前从没在容器里真跑过这一侧的智能体）。
  //
  // 影响与结论口径：**"容器内可用"这条结论目前只对主运行时成立**；候选运行时容器内的结论**未验**。
  // 解除条件：镜像里把该原生的 Linux 版装齐（构建期按容器平台装/重建），并让容器内的探针/冒烟通过。
  {
    id: "candidate-runtime-native-addon-missing",
    label: "候选运行时在容器内缺 Linux 版原生插件二进制（起不来）",
    why: "镜像是 Linux、安装时随包带的原生二进制没有对应 Linux 变体 ⇒ 容器内该运行时无法启动；本地（macOS）正常",
    precheckable: false,
  },
];

export const DECLARED_IDS = DIFFERENCE_CLASSES.map((c) => c.id);

/**
 * 闸门 → 已声明差异类（供失败归因用，见 `core/verify/attribution.mjs`）。
 *
 * **现在有一条**：候选运行时的原生二进制缺失 ⇒ 该侧闸门 3/4 在容器内必然失败
 * （已声明为 `candidate-runtime-native-addon-missing`；主运行时不适用）。
 * 除此之外仍为空 —— 空缺意味着"容器挂、本地过"时归因会落到 `unknown` 并**响亮上报**，
 * 而不是被一句含糊的"环境差异"糊过去。
 * 这一点很重要 —— 空缺意味着"容器挂、本地过"时归因会落到 `unknown` 并**响亮上报**，
 * 而不是被一句含糊的"环境差异"糊过去。等真遇到并搞清楚了，就在**这里**登记它和理由。
 */
export const GATE_DIFFERENCE_CLASS = {
  // 候选运行时的探针/冒烟在容器内必然失败：它起不来（缺 Linux 版原生二进制）
  probes: "candidate-runtime-native-addon-missing",
  smoke: "candidate-runtime-native-addon-missing",
};

/**
 * 把"发现"归类成 已声明 / 未声明。
 *
 * @param {Array<{id: string, classId: string, detail: string}>} findings
 *        `classId` 指向 `DIFFERENCE_CLASSES` 里的分类；对不上就是**未声明**。
 * @returns {{declared: object[], undeclared: object[], ok: boolean}}
 */
export function classify(findings = []) {
  const declared = [];
  const undeclared = [];
  for (const f of findings) {
    (DECLARED_IDS.includes(f.classId) ? declared : undeclared).push(f);
  }
  return { declared, undeclared, ok: undeclared.length === 0 };
}

/** 本地可预检的差异分类（用于"动手前先查一遍"）。 */
export function precheckableClasses() {
  return DIFFERENCE_CLASSES.filter((c) => c.precheckable);
}
