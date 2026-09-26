// ============================================================================
// 失败归因（路线图 §30 A4）
//
// 容器里失败 ≠ 代码有 bug。四种可能必须分开，否则 AI/人会去追错的线索：
//
//   ① `local-reproducible`       本地也能复现 ⇒ **真缺陷**，回本地修
//   ② `declared-env-difference`  本地过、容器挂，且这个差异**已在声明里登记过** ⇒ 不是缺陷
//   ③ `container-only-failure`   失败的是**只有容器能验**的断言（如安全下限）⇒ **真缺陷**，
//                                但本地复现不了 —— 改的是镜像/运行参数，不是业务代码
//   ④ `unknown`                  既非已声明差异、本地也不复现 ⇒ **响亮上报，不许猜**
//                                （"unknown" 才是需要人看的：它意味着存在未声明的差异）
//
// 本模块只做纯逻辑（给定失败清单 + 本地复现结果 + 声明 ⇒ 归类），便于自检直接断言。
// ============================================================================

/** 闸门名（容器内自证打印的中文标签）→ 闸门 id。 */
export const GATE_LABELS = {
  "闸门 1：静态校验": "static",
  "闸门 2：解析自证": "resolution",
  "闸门 3：集成探针": "probes",
  "闸门 4：端到端冒烟": "smoke",
};

export const VERDICTS = Object.freeze([
  "local-reproducible",
  "declared-env-difference",
  "container-only-failure",
  "local-unverified",
  "unknown",
]);

/**
 * @param {object} input
 * @param {string[]} input.failing            容器里失败的项（闸门 id 或容器断言 id）
 * @param {Set<string>|string[]} input.containerOnly  只有容器能验的断言 id
 * @param {string[]} input.hostRan            本地那次**实际跑到了**哪些闸门
 * @param {string[]} input.hostFailed         本地那次失败的项
 * @param {Record<string,string|null>} input.gateDifferenceClass 闸门 → 已声明差异类（没有就 null/缺省）
 * @returns {{items: Array<{id: string, verdict: string, why: string}>, ok: boolean, unknown: string[]}}
 */
export function attributeFailure({ failing = [], containerOnly = [], hostRan = [], hostFailed = [], gateDifferenceClass = {} } = {}) {
  const containerOnlySet = new Set(containerOnly);
  const hostRanSet = new Set(hostRan);
  const hostFailedSet = new Set(hostFailed);
  const items = failing.map((id) => {
    if (containerOnlySet.has(id)) {
      return { id, verdict: "container-only-failure", why: "这条断言只有容器能验（本地没有等价机制）⇒ 真缺陷，但修的是镜像/运行参数" };
    }
    // ⚠️ 顺序要紧：**"本地没跑到"不等于"本地通过"**。
    // 宿主 `verify` 是**首败即停**的（前一道红了就不跑后面的），所以拿"不在 hostFailed 里"
    // 当"本地过"会凭空造出"容器专有失败"（本轮实测踩中：容器里闸门 2 红、本地其实压根没跑到）。
    if (!hostRanSet.has(id)) {
      return { id, verdict: "local-unverified", why: "本地那次**没跑到**这道闸门（更早的闸门先失败了）⇒ 先修前面那条，再回来看它；不要当成环境差异" };
    }
    if (hostFailedSet.has(id)) {
      return { id, verdict: "local-reproducible", why: "本地跑同一道闸门也失败 ⇒ 真缺陷，回本地修" };
    }
    const declared = gateDifferenceClass[id];
    if (declared) {
      return { id, verdict: "declared-env-difference", why: `已声明的环境差异（${declared}）⇒ 不是缺陷；若该差异本应能被本地预检，那是预检漏了` };
    }
    return { id, verdict: "unknown", why: "本地跑到了这道闸门且通过、容器里却挂，而这个差异**没有声明过** ⇒ 不许猜：要么消差，要么在 core/env/parity.mjs 里声明它（带理由）" };
  });
  const unknown = items.filter((i) => i.verdict === "unknown").map((i) => i.id);
  return { items, unknown, ok: unknown.length === 0 };
}

/** 归因 → 给人看的一段话（与 JSON 同一份数据）。 */
export function renderAttribution(attr) {
  const label = {
    "local-reproducible": "真缺陷（本地也能复现）",
    "declared-env-difference": "已声明差异（不是缺陷）",
    "container-only-failure": "容器专有断言失败（真缺陷，改镜像/参数）",
    "local-unverified": "本地没跑到（先修前面那条）",
    "unknown": "未声明的差异（必须查清，不许猜）",
  };
  return attr.items.length
    ? attr.items.map((i) => `· ${i.id} ⇒ ${label[i.verdict]}\n    ${i.why}`).join("\n")
    : "（没有失败项 ⇒ 无需归因）";
}
