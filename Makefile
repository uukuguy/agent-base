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
RENDER_DIR ?=
HARNESS ?= pi
JSON ?=

# 未实现目标的统一失败处理：说清「哪个包会做它」，然后非零退出退出。
NOT_YET = @echo "❌ $@ 尚未实现（包 $(1)）——见 docs/plans/IMPLEMENTATION-ROADMAP.md"; exit 1

.PHONY: help validate validate-selftest gates-selftest trace-selftest emit-selftest trace-view-selftest gateway-selftest render doctor pi-selftest pi-trace-selftest pi-trace-ext-selftest conformance probe smoke verify image debug conformance dev-env run-local new-agent

help: ## 列出可用命令
	@echo "agent-base 命令面（统一设计 §12.3）"
	@echo ""
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'
	@echo ""
	@echo "参数：AGENT_DIR=<智能体目录>  RENDER_DIR=<渲染产物目录>  HARNESS=pi|dsh  JSON=1"

# --- 闸门 1：静态校验（S0 已交付）------------------------------------------
validate: ## 闸门 1：schema + 引用 + 凭据引用 + 命名 + 层纪律
	@node tools/validate.mjs $(AGENT_DIR)

validate-selftest: ## 闸门 1 的注入式负向自检（非法样本必须全部变红）
	@node tools/validate.mjs core/spec/fixtures/valid --selftest

# --- 基座自检（S1 已交付）---------------------------------------------------
gates-selftest: ## 四闸门框架自检：断言语言、短路、退出码、usable、摘要确定性
	@node core/gates/selftest.mjs

trace-selftest: ## 统一轨迹 schema 自检：七类事件通过、未映射只能走 native.raw
	@node core/trace/selftest.mjs

emit-selftest: ## 业务事件发射器自检：业务控制点在轨迹里必须显形
	@node core/trace/emit-selftest.mjs

trace-view-selftest: ## 轨迹查看器自检：业务附加协议 + 查看器源码不含业务词汇
	@node tools/trace-view/selftest.mjs

gateway-selftest: ## 零凭据假网关自检：无 Authorization 可用、流式、tools 计数、轨迹合规
	@node tools/fake-gateway/selftest.mjs

# --- 后续包的目标（显式失败，避免静默通过）----------------------------------
render: ## 确定性渲染 + 输出 digest（需 AGENT_DIR；可选 OUT）
	@node adapters/$(HARNESS)/render.mjs $(AGENT_DIR) $(if $(OUT),--out $(OUT),) --json

doctor: ## 闸门 2：解析自证（需 RENDER_DIR = render 的产物目录）
	@node adapters/$(HARNESS)/doctor.mjs $(RENDER_DIR) $(if $(JSON),--json,)

# --- 适配器自检（S2 验收证据）----------------------------------------------
pi-selftest: ## pi 适配器自检：render 确定性 + doctor 七字段/三条硬断言 + 静默失败必被抓到
	@node adapters/pi/selftest.mjs

pi-trace-selftest: ## pi 事后映射自检：不许丢事件 / 推算值必须标注 / 输出过 schema
	@node adapters/pi/trace-selftest.mjs

pi-trace-ext-selftest: ## 基座轨迹扩展自检（回调式主路径）：真实 tools/stream、配对、判定口径
	@node adapters/pi/trace-ext-selftest.mjs

probe: ## 闸门 3：集成探针（默认零凭据假网关，需 RENDER_DIR）
	@node tools/probe.mjs $(RENDER_DIR) $(if $(JSON),--json,) $(if $(ENDPOINT),--endpoint $(ENDPOINT),)

smoke: ## 闸门 4：端到端冒烟（需 RENDER_DIR）
	@node tools/smoke.mjs $(RENDER_DIR) $(if $(JSON),--json,) $(if $(ENDPOINT),--endpoint $(ENDPOINT),)

verify: ## 四道闸门编排 → §6.7 报告 + usable（需 AGENT_DIR）
	@node tools/verify.mjs $(AGENT_DIR) --harness $(HARNESS) $(if $(OUT),--out $(OUT),) $(if $(JSON),--json,)

image: ## 产出智能体镜像（S3）
	$(call NOT_YET,S3)

debug: ## 构建 debug 变体并进诊断 shell（§8.5 第 ④ 道）（S3）
	$(call NOT_YET,S3)

conformance: ## 对适配器跑合规套 C1–C10（阻断性门槛；C9 待 S3 容器内安全实测）
	@node conformance/run.mjs $(if $(JSON),--json,) $(if $(HARNESS_ONLY),--harness $(HARNESS_ONLY),)

dev-env: ## 按 pin 安装/校验两个 harness 到一致版本（§9.3）（S3）
	$(call NOT_YET,S3)

run-local: ## 本地交互入口（临时 HOME/DSH_HOME 挂 render 产物）（S3）
	$(call NOT_YET,S3)

new-agent: ## 从 template/ 派生（需 NAME=x）（S3）
	$(call NOT_YET,S3)
