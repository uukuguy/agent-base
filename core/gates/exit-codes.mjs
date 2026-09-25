// ============================================================================
// 退出码（统一设计 §6.7）
//
// 「验证工具与运行时共用同一套语义」（§8.2）——所以这张表只有一个定义处，
// 所有工具（validate / doctor / probe / smoke / verify / entrypoint）都从这里取。
// ============================================================================

export const EXIT_CODES = Object.freeze({
  ok: 0,
  /** 用法 / 参数错误 */
  usage: 2,
  /** 闸门 1 静态校验失败 */
  static: 10,
  /** 闸门 2 解析自证失败（含集合不符） */
  resolution: 20,
  /** 闸门 3 集成探针失败 */
  probes: 30,
  /** 闸门 4 冒烟失败 */
  smoke: 40,
  /** harness 未预期崩溃 / 无法解析其输出 */
  crash: 50,
});

/** 四道闸门的固定顺序（§6.1）。 */
export const GATE_IDS = Object.freeze(["static", "resolution", "probes", "smoke"]);

/** 闸门 id → 该闸门失败时的退出码。 */
export function exitCodeForGate(gateId) {
  if (!(gateId in EXIT_CODES)) {
    throw new Error(`未知闸门 id：${gateId}（合法值：${GATE_IDS.join(", ")}）`);
  }
  return EXIT_CODES[gateId];
}

export const EXIT_MEANINGS = Object.freeze({
  0: "通过",
  2: "用法/参数错误",
  10: "闸门 1 静态校验失败",
  20: "闸门 2 解析自证失败（含集合不符）",
  30: "闸门 3 集成探针失败",
  40: "闸门 4 冒烟失败",
  50: "harness 未预期崩溃 / 无法解析其输出",
});
