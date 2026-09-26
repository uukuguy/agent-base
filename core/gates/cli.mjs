// ============================================================================
// 基座工具的 CLI 参数解析（统一设计 §12.3 命令面）
//
// ## 为什么值得单独一个模块
//
// 同一个 bug 在本项目里出现过**两次**：
//
//     const positional = args.filter((a, i) => !a.startsWith("--") && i !== args.indexOf("--out") + 1);
//
// 当 `--out` **不存在**时 `indexOf` 返回 -1，于是 `-1 + 1 === 0` ——
// 第一个位置参数被当成"--out 的值"过滤掉，命令直接报用法错误。
// 单独看这行很难发现；出现两次说明"手写索引过滤"这种写法本身就是坑。
//
// 所以这里给出唯一实现，并配自检（`make gates-selftest`）：
// **凡是"取值旗标"必须显式声明**，解析器按"旗标吃掉它的值"推进，位置参数永远不会被误吞。
// ============================================================================

// 环境文件（如 .env）在这里补一次：所有 CLI 都从本模块拿 parseArgs，
// 于是"用户把密钥放进一个文件"这件事只需在一处支持。
import { loadEnvFiles } from "../config/dotenv.mjs";

/**
 * @param {string[]} argv
 * @param {{valueFlags?: string[], boolFlags?: string[]}} [spec]
 *         `valueFlags` = 后面跟一个值的旗标（如 `--out`）；`boolFlags` = 不跟值的开关（如 `--json`）。
 *         未声明的 `--x` 一律按开关处理，不会吞掉下一个参数。
 * @returns {{values: Record<string,string>, flags: Set<string>, positionals: string[], errors: string[]}}
 */
export function parseArgs(argv, { valueFlags = [], boolFlags = [] } = {}) {
  // 幂等：**真环境变量优先**，文件只作兜底
  loadEnvFiles();
  const values = {};
  const flags = new Set();
  const positionals = [];
  const errors = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (valueFlags.includes(a)) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) {
        errors.push(`旗标 ${a} 需要跟一个值`);
        continue;
      }
      values[a] = v;
      i++; // 吃掉它的值 —— 这就是不会误吞位置参数的机制
      continue;
    }
    if (a.startsWith("--")) {
      flags.add(a);
      continue;
    }
    positionals.push(a);
  }
  // 显式声明的开关若未出现，也能从 flags 里查
  for (const b of boolFlags) if (argv.includes(b)) flags.add(b);
  return { values, flags, positionals, errors };
}
