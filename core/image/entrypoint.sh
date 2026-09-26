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
# **产物根**（渲染输出整体：清单 + 各运行时的产物目录）的挂载点。
# 注意它不再是"某个运行时的配置目录" —— 配置目录由启动脚本按运行期布局契约暂存后决定。
ARTIFACT_DIR="${AGENT_ARTIFACT_DIR:-/opt/agent-base/artifact}"
TRACE="${AGENT_TRACE_DEST:-}"
TAIL_LINES="${AGENT_CRASH_TAIL_LINES:-30}"
HARNESS_JSON="${AGENT_BASE_HARNESSES:-/opt/agent-base/harnesses.json}"
# 启动期准备脚本（参数下放 + 可写暂存的落地点）
STARTUP="${AGENT_BASE_STARTUP:-/opt/agent-base/startup.mjs}"

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
    echo "  variant=$VARIANT  harness=${HARNESS:-（未指定）}  artifact=$ARTIFACT_DIR"
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
  # 配置自检：只校验运行期参数与产物，不跑模型。生产里当就绪探针用。
  config-check) shift; exec node "$STARTUP" config-check --artifact "$ARTIFACT_DIR" "$@" ;;
  # 镜像内自证：闸门 2/3/4（有定义时连闸门 1）—— 离线、零凭据，适合 CI 里当验收步骤
  verify) shift; exec node "${AGENT_GATES_DIR:-/opt/agent-base/gates}/verify-in-image.mjs" "$@" ;;
  *) exec "$@" ;;
esac

# ---- ③ 运行时：只装了一个就不必强迫调用方指定 ----
# 实际环境很杂（有人直接 docker run、有人包在编排里、有人在 CI 里）：只装了一个运行时的时候，
# 要求调用方再传一次是没意义的。**但要把假定说出来** —— 有多个候选时仍然必须显式指定，
# 而且绝不替调用方挑一个（那会让跨运行时结论失真）。
if [ -z "$HARNESS" ] && [ -f "$HARNESS_JSON" ]; then
  HARNESS="$(node -e '
    const j = require(process.argv[1]);
    const list = (j.harnesses || []).filter((h) => h && h.bin);
    process.stdout.write(list.length === 1 ? list[0].bin : "");
  ' "$HARNESS_JSON" 2>/dev/null || echo "")"
  if [ -n "$HARNESS" ]; then
    echo "ℹ️  未指定 HARNESS；镜像里只装了一个运行时，按 $HARNESS 运行（如需明确请显式传入）" >&2
  fi
fi
[ -n "$HARNESS" ] || usage_exit "未指定 HARNESS，且镜像里装了不止一个（或读不到 $HARNESS_JSON）—— 请显式传入，基座不会替你挑一个。"
if ! command -v "$HARNESS" >/dev/null 2>&1; then
  echo "❌ 镜像里没有可执行文件「$HARNESS」。镜像内已安装的运行时包：" >&2
  if [ -f "$HARNESS_JSON" ]; then
    node -e 'for (const h of require(process.argv[1]).harnesses||[]) console.error("   - "+h.package+"@"+h.version)' "$HARNESS_JSON" >&2 || cat "$HARNESS_JSON" >&2
  else
    echo "   （$HARNESS_JSON 不存在）" >&2
  fi
  usage_exit "不会用别的 harness 替代 —— 那会让跨 harness 的结论失真。"
fi

if [ ! -d "$ARTIFACT_DIR" ]; then
  usage_exit "找不到渲染产物：$ARTIFACT_DIR。把渲染输出（含 render-manifest.json 与各运行时目录）拷进去或挂到 \$AGENT_ARTIFACT_DIR。"
fi

# ---- ④ 启动期准备 + 运行 ----
# 参数（端点/凭据/模型名）与"可写暂存"都由 startup.mjs 处理：它读产物清单里的运行期契约，
# 按需渲染、原子写盘、缺什么就报错退出（退出码 2）。这里只负责把运行时与参数串交给它。
# 参数串由调用方给，本脚本不解释它们（各运行时的参数形态由适配器决定）。
# shellcheck disable=SC2086  # 故意按空格拆分：AGENT_HARNESS_ARGS 是"参数串"，不是单个参数
set -- ${AGENT_HARNESS_ARGS:-}
# shellcheck disable=SC2086
exec node "$STARTUP" run --artifact "$ARTIFACT_DIR" -- "$HARNESS" "$@"
