ARG BASE_IMAGE=agent-base:0.1.0-arm64
FROM ${BASE_IMAGE}

# ============================================================================
# 派生镜像骨架：**业务层在这里自由发挥**
#
# 基座给你的是：不变量（轨迹/参数分层/产物只读/不静默失败）+ 契约（定义/渲染/启动）+
# 闸门（镜像内可自证，见 `agent-base-entrypoint verify`）+ 两个运行时。
# 你要加的是：业务代码、钩子、以及（需要时）服务形态。**不必改基座，也不会被基座挡住。**
#
# 三样东西按约定放，基座启动时自动接上（都不改产物本身）：
#   · /opt/agent-base/artifact    渲染产物（烤进镜像 ⇒ 运行时不必挂载）
#   · /opt/agent-base/definition  中性定义（可选；有了它镜像内自证能连闸门 1 一起跑）
#   · /opt/agent-base/overlay     接入缝：业务代码与钩子（见 overlay/overlay.yaml）
#
# 装了哪些能力，用 `docker run <镜像> verify` 自己确认 —— 离线、零凭据。
# ============================================================================

# ---- ① 产物与定义（烤进镜像）-------------------------------------------------
COPY artifact/ /opt/agent-base/artifact/
COPY definition/ /opt/agent-base/definition/
ENV AGENT_DEFINITION_DIR=/opt/agent-base/definition

# ---- ② 接入缝：业务代码与钩子 -------------------------------------------------
# overlay/ 里按**产物同构**的布局放文件：
#   overlay/overlay.yaml         声明（harness + enhancements 列表）
#   overlay/extensions/*         该运行时的接入件（例如 pi 的 TS 扩展）
#   overlay/business/*           可共享的业务代码
COPY overlay/ /opt/agent-base/overlay/

# ---- ③ 权限：COPY **保留源文件的权限位** -------------------------------------
# 这个坑基座自己踩过一次（开发机上的文件可能是 0600，容器里以非 root 跑就读不到）。
# 派生镜像同理：产物与业务代码是开发者 COPY 进来的，权限可能不是 a+r。
# 以非 root 运行的智能体读不到配置，表现是"文件在，但读不到" —— 极难查。
USER root
RUN chmod -R a+rX /opt/agent-base/artifact /opt/agent-base/definition /opt/agent-base/overlay
USER agent

# ---- ④ 业务依赖（任意语言，随便加）-------------------------------------------
# 基座镜像里已有 node 与 python3 之外的常用运行时按需自行安装；下面只是示例，默认不动。
# USER root
# RUN set -eux; apt-get update; apt-get install -y --no-install-recommends <你的依赖>; rm -rf /var/lib/apt/lists/*
# RUN pip install --no-cache-dir <你的 Python 依赖>
# USER agent
