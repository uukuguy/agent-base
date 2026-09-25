# ============================================================================
# 由 agent-base 的 template/ 生成（tools/new-agent.mjs）。
# 这是**薄转发层**：业务开发者不需要改它，改定义就好。
#
# 需要理解的概念只有一个：HARNESS（用哪个运行时）。其余命令都是"跑某道闸门"。
# ============================================================================

AGENT_BASE_DIR ?= {{AGENT_BASE_DIR}}
HARNESS ?= pi
RENDER_DIR ?= .render/$(HARNESS)
JSON ?=

.DEFAULT_GOAL := help
.PHONY: help check-base validate render doctor probe smoke verify clean

# 找不到基座时给一句人话，而不是让 node 抛 MODULE_NOT_FOUND
# （最常见的原因：把智能体目录挪走了，相对路径失效 → 用 AGENT_BASE_DIR=... 覆盖）
check-base:
	@test -f $(AGENT_BASE_DIR)/tools/validate.mjs || (echo "❌ 找不到基座：$(AGENT_BASE_DIR)"; echo "   若移动过目录，用 AGENT_BASE_DIR=/path/to/agent-base make <目标> 覆盖"; exit 2)

help: ## 列出可用命令
	@echo "智能体：$(notdir $(CURDIR))"
	@echo ""
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-10s\033[0m %s\n", $$1, $$2}'
	@echo ""
	@echo "参数：HARNESS=pi|dsh   RENDER_DIR=<渲染输出>   JSON=1"

validate: check-base ## 闸门 1：检查定义（改完先跑这个）
	@node $(AGENT_BASE_DIR)/tools/validate.mjs .

render: check-base ## 把定义渲染成运行时用的形态
	@node $(AGENT_BASE_DIR)/adapters/$(HARNESS)/render.mjs . --out $(RENDER_DIR) --json

doctor: check-base ## 闸门 2：让运行时自证「实际加载了什么」
	@node $(AGENT_BASE_DIR)/adapters/$(HARNESS)/doctor.mjs $(RENDER_DIR) $(if $(JSON),--json,)

probe: check-base ## 闸门 3：集成探针（零凭据假网关）
	@node $(AGENT_BASE_DIR)/tools/probe.mjs $(RENDER_DIR) $(if $(JSON),--json,)

smoke: check-base ## 闸门 4：端到端冒烟
	@node $(AGENT_BASE_DIR)/tools/smoke.mjs $(RENDER_DIR) $(if $(JSON),--json,)

verify: check-base ## 四道闸门全跑 → 给出「可用 / 不可用」（ENDPOINT=URL 可针对真实端点跑闸门 3/4）
	@node $(AGENT_BASE_DIR)/tools/verify.mjs . --harness $(HARNESS) --out $(RENDER_DIR) $(if $(ENDPOINT),--endpoint $(ENDPOINT),) $(if $(JSON),--json,)

clean: ## 清掉渲染产物
	@rm -rf $(RENDER_DIR)
