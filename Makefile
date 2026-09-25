# ============================================================================
# agent-base —— 全部命令的唯一边界（统一设计 §12.3）
#
# 业务开发者只通过 make 触达基座；harness 只作为一个**参数取值**出现（HARNESS=pi|dsh），
# 不是一个需要理解的概念（§1.3：需要理解的 harness 概念数 = 0）。
#
# 已实现（包 S0）：validate / validate-selftest
# 未实现：下面各目标会**显式失败并指出所属包**，不会静默通过。
#         「未实现」必须是响亮的失败，否则就正是 §5.5 在治的那种静默失败。
# ============================================================================

SHELL := /bin/bash
.DEFAULT_GOAL := help

AGENT_DIR ?=
HARNESS ?= pi

# 未实现目标的统一失败处理：说清「哪个包会做它」，然后非零退出退出。
NOT_YET = @echo "❌ $@ 尚未实现（包 $(1)）——见 docs/plans/IMPLEMENTATION-ROADMAP.md"; exit 1

.PHONY: help validate validate-selftest render doctor probe smoke verify image debug conformance dev-env run-local new-agent

help: ## 列出可用命令
	@echo "agent-base 命令面（统一设计 §12.3）"
	@echo ""
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'
	@echo ""
	@echo "参数：AGENT_DIR=<智能体目录>  HARNESS=pi|dsh"

# --- 闸门 1：静态校验（S0 已交付）------------------------------------------
validate: ## 闸门 1：schema + 引用 + 凭据引用 + 命名 + 层纪律
	@node tools/validate.mjs $(AGENT_DIR)

validate-selftest: ## 闸门 1 的注入式负向自检（非法样本必须全部变红）
	@node tools/validate.mjs core/spec/fixtures/valid --selftest

# --- 后续包的目标（显式失败，避免静默通过）----------------------------------
render: ## 确定性渲染 + 输出 digest（S2）
	$(call NOT_YET,S2)

doctor: ## 闸门 2：解析自证（S2）
	$(call NOT_YET,S2)

probe: ## 闸门 3：集成探针（默认假网关，零凭据）（S3）
	$(call NOT_YET,S3)

smoke: ## 闸门 4：端到端冒烟（S3）
	$(call NOT_YET,S3)

verify: ## 四闸门 + 等价性比对 → --json（S2/S5）
	$(call NOT_YET,S2/S5)

image: ## 产出智能体镜像（S3）
	$(call NOT_YET,S3)

debug: ## 构建 debug 变体并进诊断 shell（§8.5 第 ④ 道）（S3）
	$(call NOT_YET,S3)

conformance: ## 对适配器跑合规套 C1–C10（S2）
	$(call NOT_YET,S2)

dev-env: ## 按 pin 安装/校验两个 harness 到一致版本（§9.3）（S3）
	$(call NOT_YET,S3)

run-local: ## 本地交互入口（临时 HOME/DSH_HOME 挂 render 产物）（S3）
	$(call NOT_YET,S3)

new-agent: ## 从 template/ 派生（需 NAME=x）（S3）
	$(call NOT_YET,S3)
