# multi-env-rollout

验证同一份智能体制品能否只更换运行期参数，安全地进入 dev、staging 和 prod。

## 建议流程

1. `make validate`：检查定义和本地 provider 配置。
2. `make run-local ENDPOINT=<端点> API_KEY=<密钥> PROMPT="同一份制品要进 staging，给出环境差异核对与上线检查单"`。
3. `make verify`：确认制品摘要、参数和回滚判据可核对。
4. 用 `artifact-consistency` 和 `env-parity-check` 技能复核三个环境。

## 可以直接试的输入

- `比较 dev/staging/prod 的模型名、端点引用和制品摘要`
- `给出上线放行条件、可观测回滚判据和不应出现的差异`
