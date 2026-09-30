# contract-review

读取合同并产出能回指原文的条款级审阅表。

## 建议流程

1. `make validate`：检查定义和连接器引用。
2. `make run-local ENDPOINT=<端点> API_KEY=<密钥> PROMPT="把这段试用期条款逐条定位、分级，并给出可核查的修改建议"`。
3. `make verify`：跑四道闸门；需要时再运行 `make verify HARNESS=dsh` 和 `make compare`。

## 可以直接试的输入

- 试用期、自动续约、违约责任或数据处理条款。
- 要求每条结论包含原文摘录、风险等级、依据、建议和不确定性。
