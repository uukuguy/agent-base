# Live Session Checkpoint

> Updated: 2026-09-26 20:30. **Session remains active — not a final handoff.**

## TL;DR

1. 本轮打通**两层产品形态的起点**：接入缝（运行期加业务代码/钩子，不动产物）· 镜像内自证（离线零凭据）· 派生镜像（一条命令构建+自证）
2. 收口 6 个实证缺陷（D1–D6）并让**钩子触发可验**（P4）；途中修掉的 `tools.deny` 交付入口失效是**真漏**（旧写法本地也没生效）
3. 6 个示例 README 统一成同一条开发循环，并把"示例命令断链/参数名漂移"变成检查

## Where things stand

- 全绿：14 个自检 · 两侧 conformance **10/10** · `make examples-check` · `make walkthrough`
- 四个镜像变体 + 多架构归档**与源码同源**（C9 逐份核对）
- 工作树干净；最近提交：`c612c7e`（README 参数名检查）· `9ffeb4f`（6 个 README + 3 缺陷）· `d2226c4`（示例命令断链）· `4ed49e9`（D1–D6 + P4）· `d750539`（派生镜像 P1–P3）

## What this session delivered

- **派生镜像与接入缝（P1–P3）**：`core/image/derived/Dockerfile` · `tools/derived-image.mjs` · `core/image/verify-in-image.mjs` ·
  `startup.mjs` 的 `applyOverlay`（只改暂存副本）· `make image-derived`
- **钩子可验（P4）**：轨迹事件带 `emitter: hook|post-hoc`；闸门 3 的 `probe/hook-fired`；事后映射的运行时如实报"不适用"
- **缺陷收口**：D1 增强 schema（`core/spec/enhancements.schema.json` + 负例 11/12）· D2 未声明接入件渲染期失败 ·
  D3 增强进 `compare`（暴露并声明了 pi/dsh 的结构性差异）· D4 dsh 非法声明响亮失败 · D5 两个参数进参数层 ·
  **D6 工具边界改为清单声明 + 两条启动路径都执行**（实测 `probe/model.tools` 4 → 1）
- **开发循环可依**：6 个示例 README 统一（改→查→跑→验 + 参数名 + 查模型名单 + 换运行时 + 零凭据看边界）；
  `run-local` 复用产物前比定义摘要；`examples-check` 校验 README 参数名与 Makefile 引用

## Next steps (immediate, action-level)

1. **E1 钩子事件名校验**：`adapter.yaml` 声明每运行时可订阅事件集合（版本 pin），`enhancements.yaml` 的 `event` 必须属于它；
   负例：写错事件名必须红（当前某运行时有 39 个可订阅事件，写错不报）
2. **E2b 钩子逐条自证**：声明 N 个钩子 ⇒ N 个都能指到自己的痕迹（现在只证明"发射路径在工作"）
3. 之后才是新增大能力：**E5 服务形态契约**（长驻/多会话/审批）与 **E6 loop 策略声明**；先定主运行时（D-0014 §7.1 待决）
4. 可选清理：`docs/status/` 若继续增长，跑 `harvest`（当前无 topic 文件堆积，未触发）

## Don't go down these paths again (ruled out)

- **不要靠"复用已有产物"省时间**：不校验定义摘要就复用 ⇒ "改了没生效"，而且报错会指向已改掉的供应商/参数名
- **不要在 `try` 里算摘要/调外部函数**：漏 import 会被 catch 伪装成"旧产物清单读不出来"，排查成本翻倍（错要当场炸）
- **不要把检查写成"只认特定后缀/固定名字"**：`_BASE_URL` 后缀过滤让 `DEEPSEEK_ENDPOINT_URL` 溜过去；
  C9 容器检查写死 `CORP_GATEWAY_*` 而在示例换供应商后永远红 —— 名字一律**从产物契约读**
- **不要按"文档说有"就当真**：本轮 7 处缺陷全是"文档声称 vs 实现不符"；能验的才写"已支持"
- **不要用 `docker run --network none` 之外的方式跑镜像内自证**：离线是这条判据的前提（构件期才允许联网）

## Ready-to-paste commands

```bash
cd ~/sandbox/agentic-2026/agent-base

# 回归（全部应为全绿）
for t in validate validate-selftest gates-selftest trace-selftest emit-selftest trace-view-selftest \
         gateway-selftest providers-selftest startup-selftest pi-selftest pi-trace-selftest \
         pi-trace-ext-selftest new-agent-selftest local-selftest; do printf "%-24s" $t; make -s $t >/dev/null 2>&1 && echo OK || echo FAIL; done
node conformance/run.mjs --harness pi && node conformance/run.mjs --harness dsh
make examples-check && make walkthrough

# 派生镜像（业务层起点）：渲染 → 构建 → 镜像内自证
make image-derived AGENT_DIR=examples/idea-to-proof OVERLAY_DIR=./my-overlay IMAGE_REF=agent:mine

# 镜像内自证（离线、零凭据）
docker run --rm --network none -v <产物>:/opt/agent-base/artifact:ro -e HARNESS=pi <镜像> verify

# 容器内确认工具边界真的生效（应 tools=1；旧写法是 4）
docker run --rm --network none -e HARNESS=pi -e CORP_GATEWAY_BASE_URL=… -e CORP_GATEWAY_API_KEY=… \
  --entrypoint /bin/sh <镜像> -c 'node /opt/agent-base/gates/tools/probe.mjs /opt/agent-base/artifact --harness pi | grep model.tools'

# 示例里开发调试（每个示例 README 的「构建与验证过程」同此）
cd examples/idea-to-proof && make validate && make verify
```
