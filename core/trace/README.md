# core/trace —— 统一轨迹（基座不变量）

> **本层纪律（统一设计 §12.1 原话）**
>
> 放：中性定义规范、能力目录、闸门框架、统一轨迹 schema、基座镜像。
> **不放**：任何 harness 名字、任何业务概念的具体取值。

`schema.json` 是**唯一真源**。本文件说明三件事：分层、**业务附加协议**（基座只提供位子，不解释内容）、可视化需要它保证什么。pi 侧的原生映射规格在 `adapters/pi/trace-mapping.md`；业务可读的渲染在 `tools/trace-view/`。

## 一、分层（各自老化速度不同）

| 层 | 谁写 | 能不能改 | 审计/查看方怎么用 |
|---|---|---|---|
| **核心字段** | 基座 / 适配器 | **冻结**：增删要走设计评审 | 只读核心字段即可工作，**不必懂任何业务语义** |
| **`biz` 附加位** | 业务层 | 自由加，受形状约束 | 忽略它也能审计 |
| **`native.raw`** | 适配器 | 兜底 | 用来发现"上游出了新事件"，所以 `reason` 必填 |

核心事件 8 类：`run.meta` / `model.request` / `model.error` / `tool.call` / `tool.result` / `gate` / `biz.event` / `native.raw`。

**核心字段为什么用 `additionalProperties: false`**：未知顶层字段一律拒绝，让"上游出新东西了"**响亮暴露**，而不是悄悄混进审计数据。业务要加东西走下面的附加位——**不是**往顶层塞字段。

## 二、业务附加协议（基座**不懂**业务语言）

基座对业务语义的态度是：**预留位子、原样带过、从不解释**。这是刻意的层次纪律——基座一旦去理解业务词汇，就等于把某个业务的概念写进了不变量，换个业务就得改基座。

三种附加方式，按侵入性递增：

### ① 给核心事件附业务上下文 —— `biz` 容器

任何事件都能挂 `biz`：

```json
{"type":"tool.call","callId":"call_abc","tool":"mcp__jira__get_issue",
 "inputDigest":"sha256:…","decision":"allow",
 "biz":{"contract.id":"C-1024","risk.level":3}}
```

约束（**只校验形状，不解释语义**）：键为小写点分命名空间（防与核心字段撞名），值只允许标量，最多 20 键、字符串最长 500。标量约束保证可序列化、可 diff、可视化时能直接渲染成表格。

### ② 业务级 logger —— 业务打日志，日志落进统一轨迹

**要解决的场景**：业务代码里有一个逻辑控制判断，比如

```js
if (amount > threshold) return requireLegalReview();
```

如果这里什么都不做，轨迹上只看得见"模型说了什么、调了哪个工具"——**业务判断这一步是隐形的**，事后没人知道"为什么要走法务复核"。

**它就是 logger**，业务方不需要学新协议：

```js
import { createLogger } from "<基座>/core/trace/emit.mjs";

const log = createLogger({ namespace: "contract", run, effectiveConfigDigest });
log.info("合同扫描完成", { clauses: 12 });
log.warn("金额 1.2M 超过阈值 1.0M，转法务复核",
         { amount: 1200000, threshold: 1000000, decision: "legal_review_required" });
```

轨迹里就出现了这一步，查看器渲染成：

```
    1 ◆ [WARN] 合同校验: 金额 1.2M 超过阈值 1.0M，转法务复核 ［amount=1200000, threshold=1000000, decision=legal_review_required］
```

**为什么是 logger 而不是自创协议**：心智负担。业务方已经会打日志；发明一套"业务事件协议"只会让人先学一遍新东西，然后因为麻烦而干脆不打 —— 那轨迹就永远只有机械语义。熟悉的形状（`namespace` + `level` + `message` + 字段）才是会被真正用起来的东西。

**形状**（`biz.event`）：`namespace`（点分小写，相当于 logger 的 category，用于分组）、`level`（`debug|info|warn|error`）、`message`（人读的一句话，**业务流操作就写在这里**）、`data`（可选，标量字段）。

- `TraceWriter` / `createLogger` 负责补齐公共字段（`ts` / `seq` / `run` / `effectiveConfigDigest`），业务不必关心
- 坏输入（缺消息、级别非法、命名空间含大写、字段嵌套）**记问题并拒发**，不静默 —— 静默丢日志正是"轨迹变黑箱"的起点
- **字段取值由业务决定**：`decision` 只是一个普通字段，基座不认识任何判定词。换一套业务、换一套词，一行都不用改

> 没有业务标签表时，这一步**也不会隐形**：查看器退化为显示命名空间与原文，只是没有业务说法。

### ③ 标签表 `trace-labels.yaml`（把机械事实与 namespace 翻译成业务说法）

基座**不翻译**。业务在智能体定义根目录放一份标签表，声明"这个元素该怎么说"：

```yaml
apiVersion: agent-base/v1
labels:
  "agent":                      <业务对这个智能体的称呼>
  "skill:<name>":               <业务对这个技能动作的称呼>
  "connector:<name>":           <业务对这个系统的称呼>
  "tool:<原生工具名>":           <业务对这次调用的称呼>
  "log:<日志命名空间>":          <业务对这个环节的称呼>
  "gate:<name>":                <业务对这个检查的称呼>
```

定位符语法由基座定义（**机械可判定**）：`agent` | `model:<route>` | `skill:<name>` | `connector:<name>` | `tool:<原生工具名>` | `log:<命名空间>` | `gate:<name>`。

渲染器把这份文件**原样带进产物**（连同 `definitionDigest`），基座不解析其中任何一个字。查看器按定位符做**字符串查找**，查不到就退回机械渲染 —— 它不知道"工单系统"是业务系统，只知道"业务给 `connector:jira` 起了这个名字"。**换一套业务、换一套词，查看器一行都不用改。**

> 这条纪律有可执行证明：`tools/trace-view/selftest.mjs` 会剥掉注释后扫描查看器源码，断言**可执行代码里不含任何业务词汇**（示例词只允许出现在注释里，供业务照抄格式）。

### ④ 订阅消费

轨迹是 JSONL 流（默认 stderr，`AGENT_TRACE_DEST` 可改文件）。基座不提供订阅 API —— 提供 API 就把"可消费"与"必须用我们的 SDK"混为一谈了。

## 三、可视化：schema 这边的承诺

可视化器是独立产物（`tools/trace-view/` 是基座附带的参考实现）。schema 这边保证：

| 可视化需要 | 保障 |
|---|---|
| 按时间轴回放 | `ts`（强制 UTC + `Z`）+ `seq`（同 run 单调，可检测丢行） |
| 按运行分组 | `run` 必填 |
| **画出调用嵌套与耗时** | `tool.call` / `tool.result` 的 `callId` **必填** —— 没有它只能线性回放，画不出配对 |
| 分层展开（核心 / 原生 / 业务） | `type` 判别 + `biz` 命名空间 + `native.raw` 的 `reason` |
| 失败点定位 | `gate.ok` + §6.7 退出码（退出码定位"失败在哪一层"） |
| 归因"当时生效的是什么" | 每条都带 `effectiveConfigDigest` |
| 标签按版本 join | `run.meta.definitionDigest`（标签来自定义，按它取对应版本） |
| 看出"这份轨迹能不能外发" | `run.meta.contentMode` |

### 内容 vs 摘要：必须显式化的取舍

§8.3 规定"工具入参只存 digest，不存明文"以防泄漏 —— 但**可视化需要内容**：拿着 `inputDigest` 画不出一次调用的真实样子。

处置：`run.meta.contentMode`

| 取值 | 含义 | 用在哪 |
|---|---|---|
| `digest`（默认） | 只留摘要；明文按 digest 去会话文件/工件存储取 | 审计件、可能外发的轨迹 |
| `full` | 轨迹里含明文 | 本地验证、容器排障、**可视化** |

**关键不在默认值，而在"必须显式标注"**：含明文的轨迹与纯摘要的轨迹**性质不同**，不能被下游当成同一种东西 —— 否则可视化的明文与审计的脱敏会互相污染。

> 取向：本基座核心目标是**验证走通**而非生产上线（§1.1），验证/可视化场景默认可取 `full`，但必须打标，生产化阶段要收回来。

## 四、自检

```bash
make trace-selftest          # schema：8 类合法事件 + 17 类必拒写法
make emit-selftest           # 业务级 logger：业务判断那一步必须显形（一行调用 → 过 schema → 查看器渲染）
make trace-view-selftest     # 查看器：附加协议 + 代码不含业务词汇 + 机械回退
```
