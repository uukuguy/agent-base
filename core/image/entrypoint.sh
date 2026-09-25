#!/bin/sh
# ============================================================================
# 基座镜像入口（统一设计 §10.1 ③ / §6.7 退出码）
#
# ## 这个脚本**不认识任何 harness**
#
# 它按数据驱动：执行哪个可执行文件由 `HARNESS` 决定，参数由 `AGENT_HARNESS_ARGS` 传入。
# 为什么这样切：不同 harness 的启动参数形态根本不同（这是 §4.5 说的"必然 harness 专有"），
# 那份知识属于 `adapters/<h>/`，不属于基座镜像。镜像里写死 `case pi) ...` 就等于把
# harness 专有知识塞进了基座 —— 加第三个 harness 时又得改镜像。
#
# 于是本脚本只负责三件事，每件对应一条设计契约：
#
#   ① **生产变体拒绝调试模式**（退出码 2）。调试能力在 `-debug` 变体里（第 ④ 道调试手段）。
#      必须明确拒绝 —— 而不是"没这功能所以照跑"，后者会让人误以为自己在一个可调试的环境里。
#   ② **崩溃要留下证据**（退出码 50）：把轨迹末 N 行与生效配置摘要打到 stderr。
#      否则容器崩了只剩一个退出码，等于黑箱。
#   ③ **不静默降级**：要求了没装的 harness 时，列出镜像里实际装了什么，而不是换一个跑。
# ============================================================================
set -eu

VARIANT_FILE="${AGENT_BASE_VARIANT_FILE:-/etc/agent-base-variant}"
VARIANT="$(cat "$VARIANT_FILE" 2>/dev/null || echo unknown)"
MODE="${AGENT_RUN_MODE:-oneshot}"
HARNESS="${HARNESS:-}"
AGENT_DIR="${PI_CODING_AGENT_DIR:-/opt/agent-base/agent-dir}"
TRACE="${AGENT_TRACE_DEST:-}"
TAIL_LINES="${AGENT_CRASH_TAIL_LINES:-30}"
HARNESS_JSON="${AGENT_BASE_HARNESSES:-/opt/agent-base/harnesses.json}"

# 退出码语义与 core/gates/exit-codes.mjs 一致
EXIT_USAGE=2
EXIT_CRASH=50

usage_exit() { echo "❌ $1" >&2; exit "$EXIT_USAGE"; }

# ---- ① 生产变体拒绝调试模式 ----
if [ "$MODE" = "debug" ] && [ "$VARIANT" != "debug" ]; then
  usage_exit "本镜像是生产变体（variant=$VARIANT），不接受 AGENT_RUN_MODE=debug。需要交互式调试请用 -debug 变体。"
fi

if [ "$MODE" = "debug" ] && [ "$VARIANT" = "debug" ]; then
  {
    echo "── 调试变体诊断 shell ──"
    echo "  variant=$VARIANT  harness=${HARNESS:-（未指定）}  agent-dir=$AGENT_DIR"
    if [ -n "$TRACE" ] && [ -f "$TRACE" ]; then
      echo "  轨迹末 $TAIL_LINES 行："
      tail -n "$TAIL_LINES" "$TRACE"
    fi
  } >&2
  exec /bin/bash
fi

# ---- 非 agent 子命令直接透传（便于调试与自检）----
case "${1:-agent}" in
  agent) ;;
  shell) shift; exec /bin/sh "$@" ;;
  *) exec "$@" ;;
esac

# ---- ③ 不静默降级：harness 必须在场 ----
[ -n "$HARNESS" ] || usage_exit "未指定 HARNESS —— 由调用方（基座工具）按智能体与运行时决定后传入。"
if ! command -v "$HARNESS" >/dev/null 2>&1; then
  echo "❌ 镜像里没有可执行文件「$HARNESS」。镜像内已安装的运行时包：" >&2
  if [ -f "$HARNESS_JSON" ]; then
    node -e 'for (const h of require(process.argv[1]).harnesses||[]) console.error("   - "+h.package+"@"+h.version)' "$HARNESS_JSON" >&2 || cat "$HARNESS_JSON" >&2
  else
    echo "   （$HARNESS_JSON 不存在）" >&2
  fi
  usage_exit "不会用别的 harness 替代 —— 那会让跨 harness 的结论失真。"
fi

if [ ! -d "$AGENT_DIR" ]; then
  usage_exit "找不到渲染产物：$AGENT_DIR。构建智能体镜像时要把渲染产物拷进去（或挂载）。"
fi

# ---- 运行：参数由调用方给，本脚本不解释它们 ----
# shellcheck disable=SC2086  # 故意按空格拆分：AGENT_HARNESS_ARGS 是"参数串"，不是单个参数
set -- ${AGENT_HARNESS_ARGS:-}
set +e
"$HARNESS" "$@"
code=$?
set -e

# ---- ② 崩溃留证据 ----
if [ "$code" -ge 128 ]; then
  {
    echo "❌ 未预期崩溃：退出码 $code（信号 $((code - 128))）"
    echo "  variant=$VARIANT harness=$HARNESS agent-dir=$AGENT_DIR"
    echo "  effectiveConfigDigest=${AGENT_EFFECTIVE_CONFIG_DIGEST:-（未设置）}"
    if [ -n "$TRACE" ] && [ -f "$TRACE" ]; then
      echo "  轨迹末 $TAIL_LINES 行（$TRACE）："
      tail -n "$TAIL_LINES" "$TRACE"
    else
      echo "  （没有轨迹文件：AGENT_TRACE_DEST 未设置或未产出）"
    fi
  } >&2
  exit "$EXIT_CRASH"
fi

exit "$code"
