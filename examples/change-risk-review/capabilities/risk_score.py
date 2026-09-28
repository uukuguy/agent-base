#!/usr/bin/env python3
# ============================================================================
# 业务实现：企业风险评分（Python）
#
# 这是 `corp-risk-score.yaml` 说的那个"可执行体"。协议（基座定义，见 core/capabilities/registry.mjs）：
#
#   stdin  : 一行 JSON —— 工具入参原样
#   stdout : 一行 JSON —— { text, details?, refused? }；text 必填（给模型看的文本）
#   退出码 : 0 正常（哪怕 refused=true）· 2 输入不合契约 · 其他非零 = 执行失败
#   stderr : 只放诊断（原样带回，不解析）
#
# ## 两条纪律（与迁移前的 JS 实现完全一致）
#
#   ① **零依赖**：只用标准库。业务规则不该把运行时或第三方包拖进来。
#   ② **确定性**：同样入参永远同样结果 —— 不随机、不读时钟、不访问网络，审计要能复算。
#
# 这个文件的存在本身就是 D-0012 的判据：**用 Python 写的业务能力，不加任何运行时胶水，
# 两个运行时都能注册并调用它**（自检 `make capabilities-selftest` 与两侧的桥自检都盯着这一点）。
# ============================================================================

import json
import sys

# 规则版本：改权重/阈值就要改它（与描述里的 declaration.version 一致）
RULE_VERSION = "2026-09-1"

# 权重表：改这里就要改 RULE_VERSION（分数必须可解释）
WEIGHTS = {
    "touchedSurfaces": 12,   # 每个受影响面
    "environments": 8,       # 每多一个环境
    "dataMigration": 20,     # 含数据迁移
    "noRollback": 22,        # 没有回滚方案
    "peakWindow": 10,        # 高峰期执行
    "unowned": 12,           # 没有明确负责人
}


def missing_facts(params):
    """关键事实缺失时**拒绝算分** —— 编一个分数比不给分数更糟。"""
    missing = []
    if not isinstance(params.get("touchedSurfaces"), list) or len(params["touchedSurfaces"]) == 0:
        missing.append("touchedSurfaces（这次变更动了什么）")
    if not isinstance(params.get("environments"), list) or len(params["environments"]) == 0:
        missing.append("environments（要在哪些环境执行）")
    if "rollback" not in params:
        missing.append("rollback（回滚方案：none / scripted / feature-flag）")
    return missing


def score(params):
    """确定性评分。纯函数：同样入参永远同样出参。"""
    touched = params.get("touchedSurfaces") if isinstance(params.get("touchedSurfaces"), list) else []
    envs = params.get("environments") if isinstance(params.get("environments"), list) else []
    factors = []
    total = 0

    def add(name, value):
        nonlocal total
        factors.append({"factor": name, "value": value, "weight": value})
        total += value

    add("受影响面数量", min(3, len(touched)) * WEIGHTS["touchedSurfaces"])
    if len(envs) > 1:
        add("多环境执行", (len(envs) - 1) * WEIGHTS["environments"])
    if params.get("dataMigration") is True:
        add("含数据迁移", WEIGHTS["dataMigration"])
    # 与迁移前的 JS 实现逐字对齐：**缺字段**或显式 "none" 都算没有回滚方案
    if "rollback" not in params or params["rollback"] == "none":
        add("无回滚方案", WEIGHTS["noRollback"])
    if params.get("window") == "peak":
        add("高峰期执行", WEIGHTS["peakWindow"])
    if not params.get("owner"):
        add("无明确负责人", WEIGHTS["unowned"])

    bounded = max(0, min(100, total))
    level = "high" if bounded >= 60 else ("medium" if bounded >= 30 else "low")
    return {"score": bounded, "level": level, "factors": factors, "ruleVersion": RULE_VERSION}


def run(params):
    """工具的统一执行语义（两个运行时的桥都调它）。"""
    missing = missing_facts(params)
    if missing:
        return {
            "refused": True,
            "text": "拒答：关键事实不全 —— 缺 " + "；".join(missing) + "。补齐后再调用；不要猜。",
            "details": {"refused": True, "missing": missing},
        }
    result = score(params)
    return {"refused": False, "text": json.dumps(result, ensure_ascii=False, indent=2), "details": result}


def main():
    raw = sys.stdin.read()
    try:
        params = json.loads(raw or "{}")
    except Exception as exc:                      # noqa: BLE001 —— 输入不合契约 ⇒ 退出码 2
        print(f"入参不是合法 JSON：{exc}", file=sys.stderr)
        return 2
    if not isinstance(params, dict):
        print("入参必须是对象", file=sys.stderr)
        return 2
    print(json.dumps(run(params), ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
