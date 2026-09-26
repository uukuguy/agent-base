// ============================================================================
// core/gates —— 四道闸门框架的唯一入口
//
// 适配器提供 render / doctor / probe / smoke；**编排、断言语言与报告格式属于基座**
// （§5.1：适配器是翻译层 + 自证层，不是决策层）。
// ============================================================================

export { EXIT_CODES, EXIT_MEANINGS, GATE_IDS, exitCodeForGate } from "./exit-codes.mjs";
export { GateReport, computeEffectiveConfigDigest, sha256 } from "./report.mjs";
export {
  ASSERTION_KINDS,
  evaluateAssertion,
  isLoudFailure,
  resolvePath,
  runAssertions,
} from "./assertions.mjs";
export { runGates } from "./orchestrator.mjs";
export { parseArgs } from "./cli.mjs";
export { hookEvidence } from "./hooks.mjs";
export { DEFAULT_EXCLUDES, digestCanonical, digestDirectory, digestFile, digestInputs } from "./digest.mjs";
