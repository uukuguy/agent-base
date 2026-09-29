# Next-Session Handoff

> Updated: 2026-09-30 02:40 end of session.

## TL;DR

1. **L4 能力包整条闭合**（`B1 → C4 → B2 → C3 → C5` 全做完）：包定义 → 运行期选择（写错包名启动即响亮失败）→ **激活真的生效**（未激活包的连接器/技能/插件从暂存产物里摘除）→ 期望集合 = 声明 ∩ 当前启用 → 证据自带组合 → 发现面 `/project bundles` → 内容（3 个编码技能）→ 默认（新智能体开箱就能编码）→ 插件类目。
2. **另收口三件**：**Q4** 本地预装镜像有锁（按同一份锁装入 + 可复算指纹 + 回归里的检查）；**另一侧两条能力包豁免实测推翻后删除**（原写「重写会破坏 `!!js`」不成立）；**候选运行时容器内起不来**已修（根因：它的原生加载器把 `.node` 复制到 `$TMPDIR`（tmpfs）再 `require` ⇒ `failed to map segment`；修法 = 该适配器设 `NARB_DISABLE_NATIVE_CACHE=1` 就地加载）。
3. **一条设计边界已定**（用户口径 ⇒ `DECISIONS.md` 2026-09-28）：**运行环境与开发环境是两套，不提供「会话内即时改代码」**；改完**重启即生效**（实测 `run-local` 会**自动重渲染**）。据此 **C7 关闭**、**开发容器工作线 W1–W4 降级**。
4. **无进行中的包**。若要继续，优先 **E10**（另一侧事件集合穷举）或 **C8**（另一侧 coding 包插件内容）。

## Where things stand

- **最新实测**：`make regression` **37 项全绿** · 闸门 1 **34 项（带定义 51）** · 两侧 conformance **10/10** · **两侧**加固容器内自证通过（`verify-container --no-cache`，含开 `coding`）· 三个示例容器内自证通过
- 规模：`core/` 125 文件 · `adapters/` 46 · `tools/` 36 · Makefile **66 目标**（**28 个自检**）· 编号文档 16 篇
- 工作树**干净**；本弧 **20 个提交**全部在本地（**未配远端**，无推送概念）
- 状态文件：`CURRENT-STATE.md` 已按真相刷新（结构快照）；本文件即交接；`JOURNAL.md` 只追加

## What this session delivered

| 主题 | 提交 |
|---|---|
| L4 能力包（定义/选择/证据/激活真的生效/技能/发现面/默认/插件） | `3f2e1be` · `b90b15a` · `dbed4af` · `14c6130` · `2b81c15` · `9c36884` · `26d0d22` · `267ba30` |
| 整体验收 + 只在容器里触发的 bug | `ef9782f` |
| 本地预装镜像有锁（含 `npm install --prefix` 剪包事故的教训） | `92b0935` · `986cfb5` |
| 三轮真实走查：派生 README 摩擦 / 自研连接器**静默起不来**（新增硬断言 `resolution/connectors-start`）/ 文档与现实 4 处不符 | `4b18373` · `0646139` · `e3fad08` |
| 收口另一侧两条豁免（实测推翻旧理由） | `5ade5fd` |
| 候选运行时容器可用性修好 | `46c766b` |
| 改号、关 E9、运行/开发两套环境决策 | `f3024a4` · `36d41ae` · `73b0224` |
| 结构快照刷新 | `016ff9d` |

## Next steps (immediate, action-level)

1. **E10 · 另一侧事件集合穷举**：把该运行时可订阅的事件名补全（**从运行时代码/实测取名字，不许猜**），填进 `adapters/dsh/adapter.yaml` 的 `hookEvents`（去掉 `enumerated: false`）⇒ 那边写钩子也能被名字层面的判据拦住。入口：`grep -n "hookEvents" adapters/dsh/adapter.yaml`、`make dsh-approval-probe`
2. **C8 · 另一侧 `coding` 包的插件内容**：换成一个在该侧无头用法下真的有用的插件，并实测「它真的进了会话」（闸门 2 启动自证 + 工具/命令名单）
3. 或者**停在这里**：L1–L5 + 三轮走查 + 全部已知留白闭合，可作交付点

## Don't go down these paths again (ruled out)

- **不要用 `npm install --prefix .local-packages <单包>`**：npm 会把其余包**全剪掉**（本轮 filesystem/git/repomix 当场消失，闸门 3 + 两份自检连锁红）⇒ 要装就 `make local-packages`
- **不要把行文当契约**：设计稿里 `stdio: {command…}` 的嵌套写法**过不了 schema**（真源是平铺）—— 引用 schema，别引用散文
- **不要在 `core/` 里出现运行时名**：**连注释都不行**（本轮被自己的 `core/harness-name` 拦了两次）
- **不要用「读起来对」当验证**：本段至少 6 处只有真跑才暴露（相对路径连接器静默起不来、派生目录里给的命令跑不了、文档里的产物路径不存在、`tools=N` 取数方式错导致「没变化」的假结论…）
- **不要把会腐烂的数字写进文档**：闸门项数、事件类数、文档篇数都腐烂过
- **不要给声明式断言表写未支持的模式**：它只有预定义比较（无 `custom` 分支）⇒ 要「真启动」这类检查就直接 `report.pass/fail`
- **不要在没重建镜像时用容器验新源码**：工具会直接拒绝（这是对的）；改了 `core/` · `adapters/` · `tools/{validate,probe,smoke,verify}.mjs` 就要重建
- **沙箱字面量**：`process.env` / `*.split(` / `**` / 带 ASCII 双引号的脚本会被拦 ⇒ 用 `edit` 工具或改写词语

## Ready-to-paste commands / configs

```bash
# 收尾三连（本轮每次都用）
make regression                                          # 37 项（含两侧 conformance）
node conformance/run.mjs --harness pi                    # 或 dsh
node tools/verify-container.mjs examples/idea-to-proof --harness pi --no-cache

# 两侧容器内自证（含开 coding 组合）
AGENT_BUNDLES=coding node tools/verify-container.mjs examples/contract-review --harness dsh --no-cache

# 改了 core/ adapters/ tools/{validate,probe,smoke,verify}.mjs 之后 —— 必须先重建镜像
node core/image/build.mjs --all --debug                  # 4 个变体；同源指纹进 LABEL
make image-all                                           # 双架构 + 多架构 manifest

# 派生新智能体（模板默认组合 = coding ⇒ 开箱就能编码）
make new-agent NAME=my-agent DESCRIPTION="一句话"
cd ../my-agent && make validate && make verify && make local ENDPOINT=… API_KEY=…

# 看一次运行到底发生了什么
make trace-view TRACE=<轨迹 JSONL>

# Docker 引擎不在时（本轮遇到过一次，24 项连锁红）
open -a OrbStack
```
