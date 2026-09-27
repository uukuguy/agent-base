// ============================================================================
// **开放命名空间**：中性定义与增强声明里"基座不解释"的字段（路线图 §25 O1/O3）
//
// 口径（O2 的落点）：**基座保证它自己声明的字段；其余允许存在，但不在保证范围内**。
// 具体规则：
//   · `x-*` 开头的键（任何层级上的顶层键）⇒ 允许，**原样透传**进产物与清单
//   · `customizations:`（一个自由对象）⇒ 同上（企业/团队自己的约定可以放这里）
//   · 增强的 `kind: x-*` ⇒ 允许（自定义增强种类；基座按"非钩子/非命令"处理）
//   · 其他未知键 ⇒ **仍然硬错误**（`additionalProperties: false` 不动）——
//     因为"拼错一个已知字段名"必须响，而 `x-` 前缀是作者**显式**表示"这是自定义"的标记
//
// 为什么要有它：不允许任何扩展字段时，团队只能把私有约定塞进 `description` 或干脆改基座；
// 允许一切又会让"拼错字段"静默通过。`x-` 前缀 + 显式收集 + 报告里标"未验证"是两者的折中。
//
// 本模块是**唯一实现**：闸门 1 的报告、渲染器的清单、`/project` 的展示都调它，
// 免得三处各写一遍"哪些算自定义字段"。
// ============================================================================

/** 自定义字段的键形状：`x-` 前缀（O1 的显式标记）。 */
export const OPEN_KEY_RE = /^x-[A-Za-z0-9_-]+$/;

/** 显式登记的开放字段（不是 `x-` 前缀，但语义上就是"自定义容器"）。 */
export const OPEN_KEYS = Object.freeze(["customizations"]);

/** 自定义增强 kind 的形状。 */
export const OPEN_KIND_RE = /^x-[a-z0-9-]+$/;

const isOpen = (k) => OPEN_KEY_RE.test(k) || OPEN_KEYS.includes(k);

/** 值的一句话摘要（报告里用；不打印全部内容，避免把密钥类东西抄进日志）。 */
function summarize(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return `array(${v.length})`;
  if (typeof v === "object") return `object(${Object.keys(v).length} 个键)`;
  return typeof v;
}

/**
 * 收集所有"基座不解释"的声明。
 *
 * @param {{agent?: object, connectors?: object, enhancements?: object[]}} docs
 * @returns {Array<{file: string, path: string, note: string}>}
 */
export function collectOpenNamespace({ agent = null, connectors = null, enhancements = [] } = {}) {
  const found = [];
  const scanTopLevel = (file, doc) => {
    if (!doc || typeof doc !== "object") return;
    for (const k of Object.keys(doc).sort()) {
      if (!isOpen(k)) continue;
      found.push({
        file,
        path: k,
        note: `${file} 的顶层字段 \`${k}\`（${summarize(doc[k])}）—— 基座不解释、原样透传；**未验证声明**，不在基座保证范围内`,
      });
    }
  };
  scanTopLevel("agent.yaml", agent);
  scanTopLevel("connectors.yaml", connectors);

  for (const e of enhancements ?? []) {
    if (!e || typeof e !== "object") continue;
    const at = `enhancements.yaml:${e.id ?? "(缺 id)"}`;
    for (const k of Object.keys(e).sort()) {
      if (!isOpen(k)) continue;
      found.push({
        file: "enhancements.yaml",
        path: `${e.id ?? "(缺 id)"}.${k}`,
        note: `${at} 的字段 \`${k}\`（${summarize(e[k])}）—— 基座不解释、原样透传；**未验证声明**`,
      });
    }
    if (typeof e.kind === "string" && OPEN_KIND_RE.test(e.kind)) {
      found.push({
        file: "enhancements.yaml",
        path: `${e.id ?? "(缺 id)"}.kind`,
        note: `${at} 使用了**自定义 kind** \`${e.kind}\` —— 基座按"非钩子/非命令"处理（不做钩子留痕断言）；**未验证声明**`,
      });
    }
  }
  return found;
}

/** 报告里的一句话（没有人用自定义字段时就诚实说"无"，而不是不显示这一节）。 */
export function summarizeOpenNamespace(found) {
  if (!found.length) return "本定义没有使用自定义字段/自定义 kind（基座声明的字段之外没有别的）";
  return `有 ${found.length} 条**未验证声明**（基座不解释、原样透传）；`
    + `如：「${found[0].note.split("——")[0].trim()}」${found.length > 1 ? " 等" : ""}`;
}
