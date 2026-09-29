# 业务代码怎么写（能力 / 自研连接器）

> 这一页是**业务方视角**的实操页：写自己的规则代码与自研连接器。
> 里面的每一段都是**跑通过的**（不是示意），配套的判据在 §「怎么验」。
> 基座侧的实现：`core/spec/connectors.schema.json`（连接器）、`core/capabilities/`（能力）。

## 决策表：我该写哪种

| 我要做的事 | 写什么 | 放哪 | 为什么 |
|---|---|---|---|
| 确定性的**业务规则/计算**（打分、判定、格式化） | **能力**（描述 yaml + 任意语言实现） | `capabilities/` | 两侧运行时都会按**同一份描述**注册工具并调用你的实现，**零胶水** |
| 连一个**内部系统**（没有现成 MCP server） | **自研连接器**（一个 stdio MCP server） | `mcp-servers/<名字>/` | 它是"制品"：随产物一起烤、一起算指纹 |
| 连一个**已有** MCP server 或基座预装项 | **不写代码**：在 `connectors.yaml` 里 `ref:` 引用 | `connectors.yaml` | 包名/版本由基座能力目录管，换 pin 只改基座一处 |
| 给智能体加一段**方法**（怎么做事） | **技能**（`SKILL.md`） | `skills/<名字>/` | 与业务无关的方法论；断言的是"可被发现且就位" |

## 一、能力（推荐先写这个）

两个文件，**不需要动任何运行时胶水**：

**`capabilities/change-window-check.yaml`**（描述 = 唯一输入，语言无关）

```yaml
apiVersion: agent-base/v1
name: change_window_check          # 工具名（模型看到的就是它）
label: 变更窗口检查
description: >
  按内部规则判断一次变更能不能落在指定窗口（确定性、可复算）。
  缺关键事实时拒答并列出缺什么 —— 不要自己补上再调用。
promptSnippet: change_window_check：按内部规则判断变更窗口是否可用
parameters:                        # JSON Schema：模型据此填参
  type: object
  additionalProperties: false
  properties:
    service: { type: string, description: 服务名 }
    window: { type: string, enum: [off-peak, peak], description: 计划窗口 }
    freezeWindows: { type: array, items: { type: string }, description: 已知封版窗口（可空） }
  required: [service, window]
result:                            # 返回值形状：闸门 3 会按它校验 details
  type: object
  required: [allowed, reason, ruleVersion]
  properties:
    allowed: { type: boolean }
    reason: { type: string }
    ruleVersion: { type: string }
execution:
  kind: process                    # 进程边界：**任意语言**
  runtime: python
  entry: window_check.py           # 与描述同目录
  timeoutMs: 5000
declaration:
  deterministic: true              # 同入参永远同结果：不随机、不读时钟、不访问网络
  sideEffects: none
  version: "2026-09-28"            # 改规则就改它：旧结果必须仍能被解释
```

**`capabilities/window_check.py`**（协议：stdin 一行 JSON → stdout 一行 JSON）

```python
#!/usr/bin/env python3
import json, sys
RULE_VERSION = "2026-09-28"

def main():
    args = json.loads(sys.stdin.readline() or "{}")
    missing = [k for k in ("service", "window") if not args.get(k)]
    if missing:                                    # 缺事实 ⇒ **拒答**，不要猜
        print(json.dumps({"text": f"缺少关键事实：{', '.join(missing)}", "refused": True,
                          "details": {"missing": missing}}, ensure_ascii=False))
        return 0
    allowed = args["window"] == "off-peak" and not (args.get("freezeWindows") or [])
    print(json.dumps({"text": f"{args['service']}：{'允许' if allowed else '不允许'}",
                      "details": {"allowed": allowed, "reason": "…", "ruleVersion": RULE_VERSION}},
                     ensure_ascii=False))
    return 0

if __name__ == "__main__":
    sys.exit(main())
```

三条纪律：**零依赖**（只用标准库）、**确定性**（审计要能复算）、**退出码**（`0` 正常含拒答 · `2` 入参不合契约 · 其他 = 执行失败）。

## 二、自研连接器（内部系统没有现成 MCP server 时）

**`connectors.yaml`** —— 注意是**平铺**写法（没有 `stdio:` 这一层；真源是 schema）：

```yaml
mcpServers:
  - ref: filesystem                 # 预装项：按名引用，不写包名/版本
    enabled: true
  - name: corpus                    # 自研：名字有硬约束 [A-Za-z0-9_-]{1,32}
    transport: stdio
    command: node
    args: ["mcp-servers/corpus/index.js"]   # 相对路径：相对**智能体目录**
    enabled: true
    description: 公司语料检索（自研，只读、确定性）
```

`mcp-servers/corpus/index.js` 是一个**零依赖**的 MCP over stdio 最小实现（逐行 JSON-RPC，三个方法）：
`initialize`（**回显**客户端给的 `protocolVersion` 最稳）· `tools/list` · `tools/call`。
完整可跑代码见 `examples/` 里带自研连接器的示例，或按下表自己写：

| 要点 | 说明 |
|---|---|
| 传输 | stdin/stdout **逐行** JSON-RPC；日志一律走 stderr（stdout 只能是协议） |
| 通知 | 没有 `id` 的消息是通知，**不要回** |
| 解析失败 | 忽略该行，**不要崩**（客户端可能发别的东西） |
| 错误 | 返回 `{error: {code, message}}`；工具级失败用 `{isError: true, content: [...]}` |
| 只读/确定性 | 与能力同一条纪律；写副作用要显式声明 |

相对路径由**启动期**解析成暂存产物的绝对路径（产物保持可搬，本地与容器同一条路径）。
**别自己拼绝对路径**：写相对的，基座负责解析。

## 三、怎么验（这三条必须自己跑）

```bash
make validate      # 闸门 1：描述合法、实现就位、引用解析得到、层纪律
make verify        # 四道闸门：其中两条专门盯"你的代码真的被调用了"——
                   #   [probe/capabilities.callable]  能力**真调通**，details 按 result 校验、确定性复算
                   #   [resolution/connectors-start]  stdio 连接器**真启动并完成握手**（起不来就红，带 stderr 尾巴）
```

**这两条断言就是"声明与行为一致"的兜底**：能力只写描述不写实现、连接器代码路径写错、
服务器起不来 —— 都会在这里当场变红，而不是等到会话里"工具没了"却没人知道为什么。

## 四、常见坑（都实测踩过）

- `connectors.yaml` 里写成 `stdio: {command: …}` ⇒ **schema 校验失败**（要平铺）。
- 连接器代码用**绝对路径**引用 ⇒ 产物不可搬；用相对路径，启动期解析。
- 能力实现里 `print` 了非 JSON 的东西到 stdout ⇒ 基座按协议解析失败（诊断请走 stderr）。
- 能力描述里没写 `result` ⇒ 闸门 3 无法校验 `details`（少一层保障，不报错但更弱）。
- 名字撞车：能力名/工具名在同一智能体内必须唯一（撞了闸门 1 会红）。
