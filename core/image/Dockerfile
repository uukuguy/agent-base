# ============================================================================
# 基座镜像（统一设计 §9 / §10.4 H5 / §11.6）
#
# ## 它是什么
#
#   agent-base 基座镜像 = 工具链 + 两个 harness + 预装的开发用 MCP 服务器 + 安全姿态。
#   它**不含任何业务智能体**：智能体镜像 = FROM 本镜像 + 构建期渲染出的产物（薄层）。
#
# ## 两条硬约束
#
#   ① **架构中立**：必须同时支持 linux/arm64 与 linux/amd64（用户明确要求）。
#      所以基础镜像、apt 包、npm 包都取双架构可得的；清单里若出现单架构声明，
#      生成锁的那一步就会失败（不让残废镜像被静默产出）。
#   ② **版本 pin 单一真源**：harness 版本来自各 `adapters/*/adapter.yaml`，
#      由构建期以 --build-arg 注入。**不许**在 Dockerfile 里再抄一份 —— 两份 pin
#      一定会漂移，而且漂移时两边都不报错。
#
# ## 为什么预装 MCP 服务器
#
#   目的是**开发智能体时省事**（不必知道包名/版本/参数），且让镜像在**拉不到 npm 的内网**
#   里也能用（外部输入 I2 的风险）。所以不只是装，还要**预热 npx 缓存** ——
#   连接器是按 `npx -y <pkg>@<ver>` 启动的，只装不预热的话离线仍然拉不到。
# ============================================================================

ARG NODE_IMAGE=node:24-bookworm-slim
FROM ${NODE_IMAGE}

# 版本 pin：由 make image 从 adapters/*/adapter.yaml 读出后注入（见 harnesses.lock.json）。
# **本文件不出现任何 harness 名** —— 装什么由坐标表决定，加一个 harness 不需要改这个文件。
ARG HARNESS_SPECS

RUN test -n "${HARNESS_SPECS}" || { \
      echo "❌ 缺 HARNESS_SPECS 构建参数（空格分隔的 pkg@ver）。" >&2; \
      echo "   应由 core/image/build.mjs 从 adapters/*/adapter.yaml 注入（版本 pin 的单一真源）。" >&2; \
      exit 2; }

ENV DEBIAN_FRONTEND=noninteractive
ENV NODE_ENV=production

# ---- 系统工具链（从预装锁读，不手抄）----
COPY preinstall.lock.txt /tmp/preinstall.lock.txt
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends $(grep '^apt ' /tmp/preinstall.lock.txt | cut -d' ' -f2-); \
    rm -rf /var/lib/apt/lists/*

# ---- 并列安装全部 harness（基座支持并列可选，精确 pin；装什么由坐标表决定）----
# 坐标表同时留在镜像里：entrypoint 靠它给出"镜像里到底装了什么"的准确提示，而不是写死名字。
COPY harnesses.lock.json /opt/agent-base/harnesses.json
RUN set -eux; \
    for spec in ${HARNESS_SPECS}; do npm install -g --no-audit --no-fund "$spec"; done; \
    node -e 'const s=require("/opt/agent-base/harnesses.json").harnesses; for (const [n,v] of Object.entries(s)) console.log(n, v.package+"@"+v.version);'

# ---- 预装 MCP 服务器 + 灌热 npm 缓存（离线可用）----
# 连接器以 `npx -y <pkg>@<ver>` 启动；只做全局安装**不够** —— npx 带版本号时仍会去 registry 解析。
# 所以用 `npm cache add` 把包体与 packument 都灌进缓存（它不做执行，退出码干净可靠）。
#
# 为什么"全局安装"就够了（实测，别再去做所谓的"预热 npx 缓存"）：
#   连接器以 `npx -y <pkg>@<ver>` 启动。当该 **精确版本**已经全局安装时，npx 直接用它、
#   根本不去碰 _npx 缓存 —— 实测：`npm cache add` 灌完仍然 ENOTCACHED，而
#   `npx -y <pkg>@<ver>` 在 `--network none` 下直接 EXIT=0。
#   我还试过 `timeout npx -y <spec> --version` 这种"预热"，那是错的：
#   MCP 服务器多数不认 `--version`（非零退出），把它当成功会掩盖真的拉取失败。
# 所以本步骤只做一件有确定收益的事：**按精确 pin 全局安装**。
# **离线可用性由 conformance C9 在断网容器里实测**，那里才是判据。
RUN set -eux; \
    grep '^npm ' /tmp/preinstall.lock.txt | awk '{print $2}' > /tmp/npm-specs.txt; \
    npm install -g --no-audit --no-fund $(cat /tmp/npm-specs.txt); \
    npm config set prefer-offline true; \
    cp /tmp/npm-specs.txt /opt/agent-base/preinstall.npm.txt; \
    rm -f /tmp/preinstall.lock.txt /tmp/npm-specs.txt

# ---- 非 root：基座镜像的默认身份（安全下限，C9 会在容器内实测）----
RUN set -eux; \
    groupadd -g 10001 agent; \
    useradd -u 10001 -g 10001 -m -d /home/agent -s /bin/bash agent; \
    mkdir -p /opt/agent-base; \
    printf 'production\n' > /etc/agent-base-variant; \
    chown -R agent:agent /home/agent /opt/agent-base

COPY entrypoint.sh /usr/local/bin/agent-base-entrypoint
RUN chmod 0755 /usr/local/bin/agent-base-entrypoint

# 智能体的渲染产物挂到这里（P-b：隔离靠文件系统）
ENV PI_CODING_AGENT_DIR=/opt/agent-base/agent-dir
ENV AGENT_BASE_VARIANT_FILE=/etc/agent-base-variant
WORKDIR /workspace

USER agent
ENTRYPOINT ["/usr/local/bin/agent-base-entrypoint"]
CMD ["agent"]
