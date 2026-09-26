# Next-Session Handoff

> Updated: 2026-09-26 21:00 end of session. **取代** 20:30 那份活动会话检查点。

## TL;DR

1. **起点门槛已打通**：接入缝（运行期加业务代码/钩子，产物不动）· 镜像内自证（离线零凭据）· 派生镜像（一条命令构建 + 自证）
2. **7 处"文档说有、实现没有"的缺陷收口**（D1–D6 + 示例命令断链）并让**钩子触发可验**（P4）；其中 `tools.deny` 交付入口失效是**真漏** —— 旧写法本地也没生效，实测 `probe/model.tools` 4 → 1
3. **下一个具体动作**：E1 —— 钩子**事件名校验**（`adapter.yaml` 声明每运行时可订阅事件集合，写错必须红；某运行时有 39 个可订阅事件，现在写错不报）

## Where things stand

- **全绿**：14 个自检 · 两侧 conformance **10/10** · `make examples-check` · `make walkthrough`
- 四个镜像变体 + 多架构 OCI 归档**与源码同源**（C9 逐份核对）；同源指纹 `sha256:73f6c4ed…`
- 工作树干净；**无远端**（`main` 仅本地），本轮 9 个提交全部落在本地
- 状态层已刷新：`CURRENT-STATE.md` 结构层重写（两层产品形态、定制分层 L0–L4、开放问题已剔除解决项、去掉会过期的镜像 ID 表）

## What this session delivered

**调研与定位**（`docs/design/2026-09-26-harness-customization.md`、`docs/design/2026-09-26-base-value-and-openness.md`、D-0014/0015/0016、`docs/13-developer-contract.md`、`docs/14-how-to-verify.md`）

- 两侧可定制点实测：pi **39 个钩子事件**（`types.d.ts:979-1017` 逐行数）/ dsh **~30 个服务 seam + waterfall**；loop 与组合树的真实可定制边界、patch row 的硬边界（只能改 `config`/`disabled`）
- 定下两层产品形态（基座镜像 / 上层业务镜像）与**保证 / 允许 / 不管**三段式措辞原则

**起点门槛 P1–P3**（`core/image/derived/Dockerfile`、`tools/derived-image.mjs`、`core/image/verify-in-image.mjs`、`core/image/startup.mjs` 的 `applyOverlay`、`make image-derived`）

- 接入缝只改暂存副本；扩展登记进 `settings.json`；闸门 2 的集合断言覆盖 overlay 声明（实测 2 项）
- 镜像携带闸门 ⇒ `docker run <镜像> verify` 离线零凭据；为它新增 `validate --agent-only`

**钩子可验 P4**（`core/trace/schema.json`、`core/trace/emit.mjs`、`adapters/{pi,dsh}/trace.mjs`、`tools/probe.mjs`）

- 轨迹事件带 `emitter: hook|post-hoc`；`probe/hook-fired` 要求"声明了钩子就必须有钩子当场发出的事件"（pi 实测 5 条）；事后映射的运行时**如实报"不适用"**

**缺陷收口 D1–D6**（`core/spec/enhancements.schema.json`、`adapters/pi/render.mjs`、`adapters/dsh/render.mjs`、`core/catalog/params.yaml`、`runtimePlan.prependArgs`）

- 增强 schema + 负例 11/12 · 未声明接入件渲染期失败 · 增强进 `compare`（暴露并声明 pi/dsh 结构性差异）· dsh 非法声明响亮失败 · 参数层登记 · 工具边界清单化且两条启动路径都执行

**开发循环可依**（6 个示例 README、`template/README.md`、`examples/README.md`、`tools/run-local.mjs`、`tools/examples-check.mjs`）

- 全部示例 README 统一成"改 → 查 → 跑 → 验"；`run-local` 复用产物前比定义摘要；`examples-check` 新增两条检查（示例 Makefile 引用必须存在、README 参数名必须落在产物契约或平台变量里）

## Next steps (immediate, action-level)

1. **E1 钩子事件名契约**：`adapters/<h>/adapter.yaml` 声明可订阅事件集合（版本 pin），`enhancements.yaml` 的 `event` 必须属于它；补负例（写错事件名必须红）
2. **E2b 钩子逐条自证**：声明 N 个钩子 ⇒ N 个都能指到自己的痕迹（现在只证明"发射路径在工作"）
3. **定主运行时**（D-0014 §7.1 待决：dsh 业务面更全 vs pi 更轻）—— 它决定 E5（服务形态）与 E6（loop 策略）的落点
4. 次要候选：dsh 侧接入缝（E3）· 多语言共享业务代码（D-0012/E9）· `image-push` 仍未对真实 registry 验证 · `CLAUDE.md` 仍未创建

## Don't go down these paths again (ruled out)

- **不校验定义摘要就复用渲染产物** ⇒ "改了没生效"，且报错指向已改掉的供应商/参数名（本轮实际踩中）
- **在 `try` 里算摘要/调外部函数** ⇒ 漏 import 被 catch 伪装成"旧产物清单读不出来"，排查成本翻倍；错要当场炸
- **检查写死名字或只认特定后缀** ⇒ `_BASE_URL` 后缀过滤让 `DEEPSEEK_ENDPOINT_URL` 溜过；C9 容器检查写死 `CORP_GATEWAY_*` 在示例换供应商后永远红 —— 名字一律从产物契约读
- **把"文档说有"当真** ⇒ 本轮 7 处缺陷全是"文档声称 vs 实现不符"
- **只看 C9 的第一条失败** ⇒ 同源失败时后面的容器能力检查根本不跑，会掩盖它们已经坏了很久
- **不要靠"某条检查过了"推断能力存在** ⇒ 检查可能因错误原因通过（本轮自查一次）

## Ready-to-paste commands

```bash
cd ~/sandbox/agentic-2026/agent-base

# 回归（全部应为全绿）
for t in validate validate-selftest gates-selftest trace-selftest emit-selftest trace-view-selftest \
         gateway-selftest providers-selftest startup-selftest pi-selftest pi-trace-selftest \
         pi-trace-ext-selftest new-agent-selftest local-selftest; do printf "%-24s" $t; make -s $t >/dev/null 2>&1 && echo OK || echo FAIL; done
node conformance/run.mjs --harness pi && node conformance/run.mjs --harness dsh
make examples-check && make walkthrough

# 派生镜像（业务层起点）
make image-derived AGENT_DIR=examples/idea-to-proof OVERLAY_DIR=./my-overlay IMAGE_REF=agent:mine

# 镜像内自证（离线、零凭据）
docker run --rm --network none -v <产物>:/opt/agent-base/artifact:ro -e HARNESS=pi <镜像> verify

# 确认工具边界真的生效（应 tools=1；旧写法是 4）
docker run --rm --network none -e HARNESS=pi -e CORP_GATEWAY_BASE_URL=… -e CORP_GATEWAY_API_KEY=… \
  --entrypoint /bin/sh <镜像> -c 'node /opt/agent-base/gates/tools/probe.mjs /opt/agent-base/artifact --harness pi | grep model.tools'

# 示例里开发调试（每个示例 README 的「构建与验证过程」同此）
cd examples/idea-to-proof && make validate && make verify
```
