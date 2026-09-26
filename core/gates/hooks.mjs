// ============================================================================
// 闸门 3 的**钩子逐条自证**判据（路线图 §23 E2b）
//
// E2 只做到"发射路径在工作"：轨迹里有钩子当场发出的事件 ⇒ 过。
// 那证明不了**每个声明的钩子**都跑了 —— 声明了 3 个，只有 1 个在发事件，照样绿。
//
// 这里的判据是：**每条声明的钩子，要么留下带自己 id 的痕迹，要么红并点名。**
//   · 痕迹 = `emitter: hook` 且 `enhancement === <该钩子的声明 id>` 的事件
//   · 事后映射的运行时（轨迹不是钩子写的）**如实报"不适用"**，不假装通过
//
// 纯函数，便于自检直接断言（`tools/probe-selftest.mjs`）。
// ============================================================================

/**
 * @param {{declaredHooks?: string[], events?: object[]}} input
 * @returns {{status: "none-declared"|"evidenced"|"silent"|"not-applicable"|"no-hook-events",
 *            evidenced: string[], silent: string[], attributed: number, unattributed: number, detail: string}}
 */
export function hookEvidence({ declaredHooks = [], events = [] } = {}) {
  const hooks = [...new Set(declaredHooks.filter(Boolean))];
  const hookEvents = events.filter((e) => e?.emitter === "hook");
  const postHoc = events.some((e) => e?.emitter === "post-hoc");
  const byEnh = new Map();
  for (const e of hookEvents) {
    const id = e?.enhancement;
    if (id) byEnh.set(id, (byEnh.get(id) ?? 0) + 1);
  }
  const attributed = [...byEnh.values()].reduce((a, b) => a + b, 0);
  const unattributed = hookEvents.length - attributed;

  if (!hooks.length) {
    return { status: "none-declared", evidenced: [], silent: [], attributed, unattributed,
      detail: "本产物未声明钩子型增强 ⇒ 无可断言（不把它算成通过，也不假装验过）" };
  }
  if (!hookEvents.length) {
    return postHoc
      ? { status: "not-applicable", evidenced: [], silent: hooks, attributed, unattributed,
          detail: "本运行时的轨迹为**事后映射**（emitter=post-hoc），无法证明钩子当场触发 ⇒ 该断言在此运行时不适用"
            + "（不假装通过；需要各自的验证手段 —— 见路线图 §23 的 E2）" }
      : { status: "no-hook-events", evidenced: [], silent: hooks, attributed, unattributed,
          detail: `声明了钩子（${hooks.join(", ")}）却没有任何钩子发出的轨迹事件，也无法区分"轨迹不是钩子写的" ⇒ 无法证明它生效` };
  }

  const evidenced = hooks.filter((id) => byEnh.has(id));
  const silent = hooks.filter((id) => !byEnh.has(id));
  if (!silent.length) {
    return { status: "evidenced", evidenced, silent, attributed, unattributed,
      detail: `${hooks.length} 个声明的钩子**各自留痕**：`
        + hooks.map((id) => `${id}(${byEnh.get(id)} 条)`).join(" · ")
        + (unattributed ? `；另有 ${unattributed} 条钩子事件没有写归属（enhancement）` : "") };
  }
  const fix = `写事件时用 new TraceWriter({ enhancement: "<声明 id>" }) 标上是谁写的`;
  const hint = unattributed
    ? `其中 ${unattributed} 条钩子事件没写归属 ⇒ ${fix}`
    : `修法：让这个钩子留下痕迹 —— ${fix}；若它订阅的事件在本场景不会发生，就在加载期或首个必然发生的回调里留一条`;
  return { status: "silent", evidenced, silent, attributed, unattributed,
    detail: `声明的 ${hooks.length} 个钩子里有 ${silent.length} 个**没有留痕**：${silent.join(", ")}`
      + `（已留痕：${evidenced.join(", ") || "无"}）。${hint} —— "配了但没人知道生没生效"正是这条要消灭的` };
}
