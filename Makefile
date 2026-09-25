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

.PHONY: help new-agent new-agent-selftest validate validate-selftest gates-selftest trace-selftest emit-selftest trace-view-selftest gateway-selftest render doctor pi-selftest pi-trace-selftest pi-trace-ext-selftest conformance probe smoke verify image debug conformance dev-env run-local new-agent

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
startup-selftest: ## 启动期准备（参数下放/暂存/渲染）自检
	@node core/image/startup-selftest.mjs

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
	@node tools/verify.mjs $(AGENT_DIR) --harness $(HARNESS) $(if $(OUT),--out $(OUT),) $(if $(ENDPOINT),--endpoint $(ENDPOINT),) $(if $(JSON),--json,)

compare: ## 跨运行时等价性比对（AGENT_DIR=… ：三组集合是否一致、差异是否都有声明）
	@node tools/compare.mjs $(AGENT_DIR) $(if $(HARNESSES),--harnesses $(HARNESSES),) $(if $(JSON),--json,)

gen-docs: ## 从 core/catalog 真源刷新生成的文档（改了 catalog 就跑）
	@node tools/gen-capability-doc.mjs

image-builder: ## 确保多架构 builder 就绪**并设为当前**（这样手敲 buildx 多平台命令才可用）
	@node core/image/build.mjs --ensure-builder

image-lock: ## 从 preinstall.yaml 刷新镜像预装锁（改了清单就跑这个）
	@node core/image/gen-preinstall-lock.mjs

image: ## 构建基座镜像（当前架构原生；ARCH=arm64|amd64 指定，DEBUG=1 连调试变体）
	@node core/image/build.mjs $(if $(ARCH),--arch $(ARCH),) $(if $(DEBUG),--debug,)

image-all: ## 每架构分别构建（原生优先，失败隔离），再合并成多架构 manifest
	@node core/image/build.mjs --all $(if $(DEBUG),--debug,)
	@node core/image/build.mjs --manifest

image-push: ## 构建并推送多架构镜像到 registry（需 IMAGE_REF=host/ns/name:tag）—— 本机标准路径
	@test -n "$(IMAGE_REF)" || { echo "需要 IMAGE_REF，例如 IMAGE_REF=registry.example.com/ns/agent-base:0.1.0"; exit 2; }
	@node core/image/build.mjs --push $(IMAGE_REF)

image-manifest: ## 只产出多架构 manifest list（OCI 归档落盘，不推 registry）
	@node core/image/build.mjs --manifest

image-debug: ## 构建调试变体（FROM 基座同 digest，只加调试工具）
	@node core/image/build.mjs $(if $(ARCH),--arch $(ARCH),) --debug

debug: ## 进诊断 shell（先构建调试变体；需 RENDER_DIR 指向渲染产物）
	@node core/image/build.mjs $(if $(ARCH),--arch $(ARCH),) --debug >/dev/null
	@docker run --rm -it 	  -e AGENT_RUN_MODE=debug -e HARNESS=$(HARNESS) 	  -e PI_CODING_AGENT_DIR=/opt/agent-base/agent-dir 	  -v "$(abspath $(RENDER_DIR))/agent-dir:/opt/agent-base/agent-dir:ro" 	  agent-base:$(shell node -p "require('./package.json').version")-debug-$(shell uname -m | sed 's/x86_64/amd64/;s/arm64/arm64/')

conformance: ## 对适配器跑合规套 C1–C10（阻断性门槛；C9 待 S3 容器内安全实测）
	@node conformance/run.mjs $(if $(JSON),--json,) $(if $(HARNESS_ONLY),--harness $(HARNESS_ONLY),)

dev-env: ## 按 pin 校验/安装 harness 到一致版本（CHECK=1 只校验不改动本机）
	@node tools/dev-env.mjs $(if $(CHECK),--check,)

run-local: ## 本地交互入口（先渲染，再用临时 HOME 跑制品；PROMPT=... 走一次性）
	@test -n "$(AGENT_DIR)" || { echo "需要 AGENT_DIR（智能体定义目录）"; exit 2; }
	@node tools/run-local.mjs $(AGENT_DIR) --harness $(HARNESS) $(if $(PROMPT),--prompt "$(PROMPT)",) $(if $(ENDPOINT),--endpoint $(ENDPOINT),) $(if $(OUT),--render-dir $(OUT),)

new-agent: ## 从 template/ 派生一个智能体（需 NAME=x；默认派生到基座之外的同级目录）
	@NAME=$(NAME) node tools/new-agent.mjs $(if $(DESCRIPTION),--description "$(DESCRIPTION)",) $(if $(OUT),--out $(OUT),)

examples-check: ## 逐个校验 examples/：结构 + 四道闸门 + 技能脚本自检 + 不变量 N5
	@node tools/examples-check.mjs $(if $(FAST),--fast,)

local-selftest: ## 本地开发环境自检：dev-env 版本一致 + run-local 隔离与跑通
	@node tools/local-selftest.mjs

new-agent-selftest: ## 模板「开箱可跑」自检：派生 → 跑生成出来的 Makefile → 四道闸门全绿
	@node tools/new-agent-selftest.mjs
