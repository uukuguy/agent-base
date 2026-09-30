# local-model-dev

验证本机部署的 OpenAI 兼容模型：端点、模型名、工具调用和输出边界。

## 建议流程

1. `make providers-init ENDPOINT=<端点>`：先取得端点实际支持的模型名单。
2. `make validate`：确认定义中的 provider 和模型名合法。
3. `make run-local ENDPOINT=<端点> PROMPT="核对本机端点与模型是否可用，并给出结论"`。
4. `make verify`：跑四道闸门；再用固定用例做离线评测。

## 可以直接试的输入

- `核对端点是否可达、模型名是否存在，并说明证据`
- `重复运行同一个结构化输出用例，记录通过率和能力边界`
