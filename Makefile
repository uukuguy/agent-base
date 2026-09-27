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

.PHONY: help new-agent new-agent-selftest validate validate-selftest gates-selftest trace-selftest emit-selftest trace-view-selftest gateway-selftest render doctor pi-selftest pi-trace-selftest pi-trace-ext-selftest pi-project-info-selftest project-info project-info-selftest verify-plan env-check env-check-selftest verify-container verify-container-selftest unattended-selftest pi-verify-container-selftest dsh-approval-probe dsh-verify-container-selftest probe-selftest selfcheck regression gen-docs gen-selection-facts conformance probe smoke verify image debug conformance dev-env run-local new-agent

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
walkthrough: ## 开发场景演练（LIVE=1 打真实端点）
	@node tools/walkthrough.mjs

providers-selftest: ## provider 目录自检（解析优先级 / 覆盖失效要报错 / 从端点问模型）
	@node tools/providers-selftest.mjs

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

pi-project-info-selftest: ## 会话内自省命令自检（/project）：内容随项目变、补全即目录、事件名真核对
	@node adapters/pi/project-info-selftest.mjs

project-info: ## 项目自省（命令行出口，与 /project 同一份逻辑；JSON=1 出机器可读）
	@node tools/project-info.mjs $(AGENT_DIR) $(if $(HARNESS),--harness $(HARNESS),) $(if $(RENDER_DIR),--render-dir $(RENDER_DIR),) $(if $(CATEGORY),--category $(CATEGORY),) $(if $(JSON),--json,)

verify-plan: ## 验证计划：要验什么、哪些只能在容器验、为什么（JSON=1 给 AI 读）
	@node tools/project-info.mjs $(AGENT_DIR) --plan $(if $(HARNESS),--harness $(HARNESS),) $(if $(RENDER_DIR),--render-dir $(RENDER_DIR),) $(if $(JSON),--json,)

project-info-selftest: ## 自省逻辑与验证计划自检（CLI 出口 · 计划分区 · 容器断言声明一致）
	@node tools/project-info-selftest.mjs

env-check: ## 环境一致性：本地与容器差在哪、哪些本地查不了（未声明的差异 ⇒ 红）
	@node tools/env-check.mjs $(if $(JSON),--json,)

verify-container: ## 受控容器验证：绑定面=当前项目（只读），docker 参数由基座生成（DRY=1 只看参数）
	@node tools/verify-container.mjs $(AGENT_DIR) $(if $(HARNESS),--harness $(HARNESS),) $(if $(ARCH),--arch $(ARCH),) $(if $(DRY),--dry-run,) $(if $(JSON),--json,)

selfcheck: ## 能力 → 判据清单（§24 O4）：每条能力都要落到真实判据或显式降级（JSON=1 给 AI）
	@node tools/selfcheck.mjs $(if $(JSON),--json,)

probe-selftest: ## 闸门 3 钩子逐条自证自检（纯函数分支 + 真跑正/负两个夹具）
	@node tools/probe-selftest.mjs

dsh-verify-container-selftest: ## dsh 侧 /verify-container 自检（审批四走向 · 事件过 schema · 不拼 docker · 真跑无导入失败）
	@node adapters/dsh/verify-container-selftest.mjs

dsh-approval-probe: ## 探针：另一侧原生流/会话文件里有没有审批记录、相对路径插件 row 能不能加载
	@node adapters/dsh/approval-probe.mjs $(if $(JSON),--json,)

pi-verify-container-selftest: ## /verify-container 命令自检（审批放行/拒绝/无应答者 · 事件过 schema · 不自己拼 docker）
	@node adapters/pi/verify-container-ext-selftest.mjs

unattended-selftest: ## 无人值守端到端：改定义 → 本地闸门 → 计划 → 预检 → 受控容器验证 → 归因
	@node tools/unattended-selftest.mjs

verify-container-selftest: ## 受控容器验证自检（逃逸面断言 · 绑定面 · 危险目录 · 真跑一次）
	@node tools/verify-container-selftest.mjs

env-check-selftest: ## 环境一致性自检（声明与归类 · 每个 apt 包要么可查要么明确标不可查）
	@node tools/env-check-selftest.mjs

probe: ## 闸门 3：集成探针（默认零凭据假网关，需 RENDER_DIR）
	@node tools/probe.mjs $(RENDER_DIR) $(if $(JSON),--json,) $(if $(ENDPOINT),--endpoint $(ENDPOINT),)

smoke: ## 闸门 4：端到端冒烟（需 RENDER_DIR）
	@node tools/smoke.mjs $(RENDER_DIR) $(if $(JSON),--json,) $(if $(ENDPOINT),--endpoint $(ENDPOINT),)

regression: ## 收尾回归一条命令：镜像过期就先重建 → 全部自检 → 两侧 conformance → examples-check → selfcheck
	@node tools/regression.mjs

verify: ## 四道闸门编排 → §6.7 报告 + usable（需 AGENT_DIR）
	@node tools/verify.mjs $(AGENT_DIR) --harness $(HARNESS) $(if $(OUT),--out $(OUT),) $(if $(ENDPOINT),--endpoint $(ENDPOINT),) $(if $(JSON),--json,) $(if $(LIVE),--live,)

compare: ## 跨运行时等价性比对（AGENT_DIR=… ：三组集合是否一致、差异是否都有声明）
	@node tools/compare.mjs $(AGENT_DIR) $(if $(HARNESSES),--harnesses $(HARNESSES),) $(if $(JSON),--json,)

providers-init: ## 从端点问出可用模型并写成路由目录（--endpoint 必填；本工具会 GET <endpoint>/models）
	@node tools/providers-init.mjs --endpoint "$(ENDPOINT)" $(if $(API_KEY),--api-key "$(API_KEY)",) $(if $(ROUTE),--route $(ROUTE),) $(if $(OUT),--out $(OUT),) $(if $(DRY_RUN),--dry-run,) $(if $(JSON),--json,)

gen-docs: ## 从真源刷新**全部生成物**文档（改了 catalog/adapters 就跑）
	@node tools/gen-capability-doc.mjs
	@node tools/gen-selection-facts.mjs

gen-selection-facts: ## 生成"运行时选型的事实材料"（决策门输入；闸门 1 守同步）
	@node tools/gen-selection-facts.mjs

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

image-derived: ## 构建派生镜像（业务层）并在镜像内自证（需 AGENT_DIR；可选 OVERLAY_DIR/IMAGE_REF/HARNESS）
	@node tools/derived-image.mjs "$(AGENT_DIR)" $(if $(HARNESS),--harness $(HARNESS),) $(if $(IMAGE_REF),--ref $(IMAGE_REF),) $(if $(OVERLAY_DIR),--overlay $(OVERLAY_DIR),) $(if $(KEEP),--keep,)

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
