# ============================================================================
# 由 agent-base 的 template/ 生成（tools/new-agent.mjs）。
# 这是**薄转发层**：业务开发者不需要改它，改定义就好。
#
# 需要理解的概念只有一个：HARNESS（用哪个运行时）。其余命令都是"跑某道闸门"。
# ============================================================================

AGENT_BASE_DIR ?= {{AGENT_BASE_DIR}}
HARNESS ?= pi

# 能力包（L4）：**新智能体的初始组合由模板决定**（设计稿 §7 未决项 3）。
# 默认带 `coding`（编码辅助：filesystem/git/repomix + 三个编码技能）—— 开箱就能读改代码。
# 想要"纯验证"环境：make verify BUNDLES=verify-baseline
BUNDLES ?= coding
export AGENT_BUNDLES := $(BUNDLES)

# 智能体自己的**供应商配置**（可选）：旁边有 providers.yaml 就自动用它，
# **不必改基座代码**、也不必记环境变量。没有就退回基座内置的常用供应商。
#
# **必须导出绝对路径**：基座工具会切自己的工作目录（verify 的子进程在仓库里跑），
# 相对路径一过进程边界就指向别处 —— 实测导致 `make validate` 过、`make verify` 挂。
PROVIDERS_FILE := $(wildcard ./providers.yaml)
ifneq ($(PROVIDERS_FILE),)
  AGENT_PROVIDERS_FILE := $(abspath $(PROVIDERS_FILE))
  export AGENT_PROVIDERS_FILE
endif
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
	@echo "参数：HARNESS=pi|dsh   BUNDLES=$(BUNDLES)   AGENT_PROVIDERS_FILE=<你的 provider 目录>   RENDER_DIR=<渲染输出>   JSON=1"
	@echo "      能力包默认 coding（编码辅助）；纯验证用 BUNDLES=verify-baseline"

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

compare: check-base ## 跨运行时等价性比对（同一份定义在两个运行时里是否等价）
	@node $(AGENT_BASE_DIR)/tools/compare.mjs . $(if $(HARNESSES),--harnesses $(HARNESSES),) $(if $(JSON),--json,)

run-local: check-base ## 本地真跑一次（ENDPOINT=https://… API_KEY=… [MODEL=…] [PROMPT="…"]）
	@node $(AGENT_BASE_DIR)/tools/run-local.mjs . --harness $(HARNESS) \
	  $(if $(ENDPOINT),--endpoint "$(ENDPOINT)",) $(if $(API_KEY),--api-key "$(API_KEY)",) \
	  $(if $(MODEL),--model "$(MODEL)",) $(if $(PROMPT),--prompt "$(PROMPT)",) \
	  $(if $(RENDER_DIR),--render-dir $(RENDER_DIR),)

providers-init: ## 问端点有哪些模型，写成 providers.yaml（ENDPOINT=https://… [API_KEY=…] [PROVIDER=…]）
	@node $(AGENT_BASE_DIR)/tools/providers-init.mjs --endpoint "$(ENDPOINT)" \
	  $(if $(API_KEY),--api-key "$(API_KEY)",) $(if $(PROVIDER),--provider "$(PROVIDER)",) \
	  $(if $(OUT),--out "$(OUT)",--out ./providers.yaml)

walkthrough: ## 开发场景演练（在基座工作区跑：派生→闸门→渲染→真跑→容器→比对）
	@node $(AGENT_BASE_DIR)/tools/walkthrough.mjs $(if $(LIVE),--live,)

verify: check-base ## 四道闸门全跑 → 给出「可用 / 不可用」（LIVE=1 打真实端点；ENDPOINT=URL 指定端点）
	@node $(AGENT_BASE_DIR)/tools/verify.mjs . --harness $(HARNESS) --out $(RENDER_DIR) $(if $(LIVE),--live,) $(if $(ENDPOINT),--endpoint $(ENDPOINT),) $(if $(JSON),--json,)

clean: ## 清掉渲染产物
	@rm -rf $(RENDER_DIR)
