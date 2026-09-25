// ============================================================================
// 断言语言（统一设计 §6）
//
// 为什么需要一门「语言」而不是直接写 if：断言集要能被**序列化**——
//   · `conformance/` 的每个用例是「输入 + 期望断言」（§5.6）
//   · 冒烟断言集要能在两个 harness 间比对是否相同（§6.6）
//   · 闸门 3 的 `tools=N>0` 必须是一条可声明的断言，而不是埋在探针代码里的魔法值（§6.4）
//
// 约定（刻意保持无歧义）：
//   · `actual`   —— **总是** context 里的路径。路径不存在 = 断言失败（响亮失败，不是 undefined）。
//   · `expected` —— **总是**字面量；需要拿 context 里的另一个值来比时用 `expectedPath`。
//     这样「输入 + 期望断言」的用例才能自解释：期望值写在用例里，不用去猜。
//
// 初始集合刻意小：只放四道闸门与 conformance/C1–C10 确实要用的种类。加新种类前，
// 先确认它是「现有种类表达不了」，而不是懒得组合。
// ============================================================================

/** 支持的断言种类。 */
export const ASSERTION_KINDS = Object.freeze([
  "equals", // 深比较相等
  "set-equals", // 数组集合相等（忽略顺序）——§6.3 三条硬断言的形状
  "subset-of", // actual 的每个元素都在 expected 里——「未出现未声明工具」
  "contains", // 字符串包含 / 数组含某元素
  "not-contains",
  "non-empty", // 非空数组 / 非空字符串
  "truthy",
  "falsy",
  "at-least", // 数值 >= expected（§6.4 的 tools=N>0 即 at-least 1）
  "exit-code", // 数值相等
  "digest-equal", // 两个 sha256 摘要相等，且两边的格式都合法
  "fails", // **被观察的动作必须响亮地失败**——C5/C8 的灵魂
]);

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

/** 从 context 按点分路径取值。路径不存在返回 `{found:false}`（而不是 undefined）。 */
export function resolvePath(ctx, path) {
  const parts = String(path).split(".").filter(Boolean);
  let cur = ctx;
  for (const p of parts) {
    if (cur == null || typeof cur !== "object") return { found: false };
    if (Array.isArray(cur)) {
      const i = Number(p);
      if (!Number.isInteger(i) || i < 0 || i >= cur.length) return { found: false };
      cur = cur[i];
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(cur, p)) return { found: false };
    cur = cur[p];
  }
  return { found: true, value: cur };
}

function brief(v) {
  if (typeof v === "string") return v.length > 120 ? `${JSON.stringify(v.slice(0, 117))}…` : JSON.stringify(v);
  const s = JSON.stringify(v);
  if (s === undefined) return String(v);
  return s.length > 200 ? `${s.slice(0, 197)}…` : s;
}

const isArray = Array.isArray;
const asSet = (a) => new Set(a.map((x) => (typeof x === "object" ? JSON.stringify(x) : x)));

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (isArray(a) !== isArray(b)) return false;
  if (typeof a !== "object") return false;
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false;
  return ka.every((k) => deepEqual(a[k], b[k]));
}

/**
 * 「响亮地失败」的判定。
 *
 * 这是把 §5.4「禁止静默降级」和 §5.6 的 C5/C8 变成可执行断言的唯一入口。
 * 判据：只有**明确的失败信号**才算失败；exit 0 / ok:true / 什么都没有，都不算。
 */
export function isLoudFailure(v) {
  if (typeof v === "number") return v !== 0;
  if (typeof v === "boolean") return v === false;
  if (v && typeof v === "object") {
    if ("exitCode" in v) return v.exitCode !== 0;
    if ("ok" in v) return v.ok === false;
    if ("threw" in v) return typeof v.threw === "string" && v.threw.length > 0;
  }
  return false;
}

/**
 * 评估一条断言。
 * @returns {{id: string, ok: boolean, detail: string}}
 */
export function evaluateAssertion(assertion, ctx) {
  const id = assertion.id ?? assertion.assert ?? "unnamed";
  const kind = assertion.assert;
  const note = assertion.detail ? `${assertion.detail}｜` : "";

  if (!ASSERTION_KINDS.includes(kind)) {
    return { id, ok: false, detail: `未知断言种类「${kind}」（合法值：${ASSERTION_KINDS.join(", ")}）` };
  }
  if (typeof assertion.actual !== "string") {
    return { id, ok: false, detail: `${note}actual 必须是 context 路径字符串` };
  }

  const got = resolvePath(ctx, assertion.actual);
  if (!got.found) {
    return { id, ok: false, detail: `${note}context 缺少路径「${assertion.actual}」——缺失即失败，不按 undefined 处理` };
  }
  const actual = got.value;

  let expected = assertion.expected;
  if (assertion.expectedPath) {
    const exp = resolvePath(ctx, assertion.expectedPath);
    if (!exp.found) return { id, ok: false, detail: `${note}context 缺少路径「${assertion.expectedPath}」` };
    expected = exp.value;
  }

  switch (kind) {
    case "equals":
      return deepEqual(actual, expected)
        ? { id, ok: true, detail: `${note}${assertion.actual} == ${brief(expected)}` }
        : { id, ok: false, detail: `${note}${assertion.actual} = ${brief(actual)}，期望 ${brief(expected)}` };

    case "set-equals": {
      if (!isArray(actual) || !isArray(expected)) {
        return { id, ok: false, detail: `${note}set-equals 需要两边都是数组（actual=${brief(actual)}, expected=${brief(expected)}）` };
      }
      const A = asSet(actual);
      const B = asSet(expected);
      const missing = [...B].filter((x) => !A.has(x));
      const extra = [...A].filter((x) => !B.has(x));
      if (!missing.length && !extra.length) {
        return { id, ok: true, detail: `${note}集合相等（${A.size} 项）` };
      }
      const parts = [];
      if (missing.length) parts.push(`少 ${missing.length} 项：${missing.join(", ")}`);
      // 「多一个也不行」：多出来的说明隐式加载源没隔离干净（§6.3 硬断言 1）
      if (extra.length) parts.push(`多 ${extra.length} 项：${extra.join(", ")}`);
      return { id, ok: false, detail: `${note}集合不等，${parts.join("；")}` };
    }

    case "subset-of": {
      if (!isArray(actual) || !isArray(expected)) {
        return { id, ok: false, detail: `${note}subset-of 需要两边都是数组` };
      }
      const B = asSet(expected);
      const extra = actual.filter((x) => !B.has(typeof x === "object" ? JSON.stringify(x) : x));
      return extra.length
        ? { id, ok: false, detail: `${note}出现了未声明的项：${extra.join(", ")}` }
        : { id, ok: true, detail: `${note}全部 ${actual.length} 项都在声明集合内` };
    }

    case "contains": {
      const hit = isArray(actual) ? asSet(actual).has(typeof expected === "object" ? JSON.stringify(expected) : expected)
        : typeof actual === "string" && actual.includes(String(expected));
      return hit
        ? { id, ok: true, detail: `${note}包含 ${brief(expected)}` }
        : { id, ok: false, detail: `${note}${brief(actual)} 中不含 ${brief(expected)}` };
    }

    case "not-contains": {
      const hit = isArray(actual) ? asSet(actual).has(typeof expected === "object" ? JSON.stringify(expected) : expected)
        : typeof actual === "string" && actual.includes(String(expected));
      return hit
        ? { id, ok: false, detail: `${note}不应包含 ${brief(expected)}，但出现了` }
        : { id, ok: true, detail: `${note}未出现 ${brief(expected)}` };
    }

    case "non-empty": {
      const empty = isArray(actual) ? actual.length === 0 : typeof actual === "string" ? actual.length === 0 : actual == null;
      return empty
        ? { id, ok: false, detail: `${note}${assertion.actual} 为空` }
        : { id, ok: true, detail: `${note}${assertion.actual} 非空（${isArray(actual) ? `${actual.length} 项` : brief(actual)}）` };
    }

    case "truthy":
      return actual === true || (actual !== false && actual !== 0 && actual != null && actual !== "")
        ? { id, ok: true, detail: `${note}${assertion.actual} 为真` }
        : { id, ok: false, detail: `${note}${assertion.actual} = ${brief(actual)}，期望真` };

    case "falsy":
      return !actual
        ? { id, ok: true, detail: `${note}${assertion.actual} 为假` }
        : { id, ok: false, detail: `${note}${assertion.actual} = ${brief(actual)}，期望假` };

    case "at-least":
      return typeof actual === "number" && actual >= expected
        ? { id, ok: true, detail: `${note}${assertion.actual} = ${actual} >= ${expected}` }
        : { id, ok: false, detail: `${note}${assertion.actual} = ${brief(actual)}，期望 >= ${expected}` };

    case "exit-code":
      return actual === expected
        ? { id, ok: true, detail: `${note}退出码 ${actual}` }
        : { id, ok: false, detail: `${note}退出码 ${brief(actual)}，期望 ${expected}` };

    case "digest-equal": {
      if (typeof actual !== "string" || !DIGEST_RE.test(actual)) {
        return { id, ok: false, detail: `${note}${assertion.actual} 不是合法摘要：${brief(actual)}` };
      }
      if (typeof expected !== "string" || !DIGEST_RE.test(expected)) {
        return { id, ok: false, detail: `${note}期望摘要格式非法：${brief(expected)}` };
      }
      return actual === expected
        ? { id, ok: true, detail: `${note}摘要一致（确定性成立）` }
        : { id, ok: false, detail: `${note}摘要不一致：${actual} ≠ ${expected}——不确定的输出不能叫可复现（N19）` };
    }

    case "fails":
      return isLoudFailure(actual)
        ? { id, ok: true, detail: `${note}如预期响亮失败（${brief(actual)}）` }
        : { id, ok: false, detail: `${note}**静默通过**：观察到 ${brief(actual)}——注入场景必须报错，静默通过即判失败（§5.6 C5/C8）` };

    default:
      return { id, ok: false, detail: `未实现的断言种类：${kind}` };
  }
}

/**
 * 运行一组断言并把结果记进报告。
 * @returns {{passed:number, failed:number}}
 */
export function runAssertions(assertions, ctx, { gate, report }) {
  let passed = 0;
  let failed = 0;
  for (const a of assertions ?? []) {
    const res = evaluateAssertion(a, ctx);
    if (res.ok) {
      passed++;
      report.pass(gate, res.id, res.detail);
    } else {
      failed++;
      report.fail(gate, res.id, res.detail, { assertion: a });
    }
  }
  return { passed, failed };
}
