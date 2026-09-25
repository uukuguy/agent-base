# core/ —— 基座不变量（harness 无关）

> **本层纪律（统一设计 §12.1 原话，写入文件头注释）**
>
> 放：中性定义规范、能力目录、闸门框架、统一轨迹 schema、基座镜像。
> **不放**：任何 harness 名字、任何业务概念的具体取值。

## 目录

| 路径 | 作用 | 状态 |
|---|---|---|
| `spec/agent.schema.json` | `agent.yaml` 的唯一真源（§4.2） | ✅ S0 |
| `spec/connectors.schema.json` | `connectors.yaml` 的唯一真源（§4.3） | ✅ S0 |
| `spec/fixtures/` | 闸门 1 自检用例（1 个合法 + 逐条注入的非法样本） | ✅ S0 |
| `catalog/capabilities.yaml` | 能力目录机器可读真源（§4.6，N26）；`docs/03-capability-catalog.md` 由它生成 | ✅ S0 |
| `catalog/params.yaml` | 参数层允许/禁止清单（§2.3）；`validate` 与 `conformance/C8` 都读它 | ✅ S0 |
| `gates/` | 四闸门框架：编排、断言语言、报告格式（§6） | ⏳ S1 |
| `trace/schema.json` | 统一轨迹事件 schema（§8.3，P1 决策：无法映射的事件输出 `native.raw`，不许丢弃） | ⏳ S1 |
| `image/` | `Dockerfile.base`、`Dockerfile.debug`、`entrypoint.sh` | ⏳ S3+ |

## 两条执法线（本目录存在的理由）

「行为烤、参数下放」（J2）在文档里只是一句话，本目录把它变成**两个可执行执法点**：

1. **`catalog/params.yaml`** —— 参数层的允许/禁止清单。判据是统一设计 §2.2 的执法线：
   > 这个字段改了，同一个输入会不会得到不同行为？**会 → 烤进制品；不会 → 参数层。**
2. **`catalog/capabilities.yaml`** —— 每个字段的**所属层**。目录说某字段属参数层、而它却出现在 `agent.yaml` 里，`validate` 直接报错。

`conformance/C8`（参数层隔离）会把禁止项当参数注入，要求**无效或直接报错，不得静默生效**——本目录的清单就是那个用例的输入。

## 校验入口

```bash
make validate AGENT_DIR=<智能体目录>   # 闸门 1：schema + 引用 + 凭据引用 + 命名 + 层纪律
make validate-selftest                # 注入式负向自检：非法样本必须全部变红
```

`core/` 内不得出现任何 harness 名字 —— 这是每个实施阶段的通用闸门，也是 `validate` 的自检项之一。
