# {{NAME}}

{{DESCRIPTION}}

> 由 `agent-base` 基座派生而来。**它不属于基座** —— 你可以随便改这里，基座不受影响；
> 反过来也不要为了这里的需要去改基座（要改基座说明基座缺能力，那是另一件事）。

## 你需要认识的东西（很少）

| 文件 | 你在这里写什么 |
|---|---|
| `agent.yaml` | 它是谁（`persona`）、用哪个模型（`model`）、边界（`tools`） |
| `connectors.yaml` | 它能连哪些系统（不写就是没有） |
| `skills/<名字>/SKILL.md` | 它会哪些技能；技能可以带 `scripts/` 放脚本 |
| `harness/<runtime>/` | 业务级增强（自定义工具 / 钩子 / 插件）—— 用到再说，模板默认不生成 |
| `Makefile` | **不用改**，它只是把命令转发给基座 |

## 常用命令

**开发循环：改 → 查 → 跑 → 验**（都在这个目录里跑）：

```bash
make validate     # ① 改完先跑：秒级、不用网络、不用密钥（定义/引用/分层/增强声明都查）
make run-local ENDPOINT=<端点> API_KEY=<密钥> PROMPT="…"   # ② 真跑一次
make verify       # ③ 四道闸门 → 「可用 / 不可用」
make compare      # ④ 换个运行时再验、看等价性（差异必须有声明）
```

**能力包默认是 `coding`**（编码辅助）：filesystem / git / repomix 三个连接器 + 三个编码技能
（跨文件定位 · 系统化排障 · 先跑验证再声称完成），所以开箱就能读改代码。

想要**纯验证**环境（结论更可复现、失败原因不被无关能力淹没）：

```bash
make verify BUNDLES=verify-baseline     # 只留基座不变量；切换需重载会话
```

会话里问一句就能看清有哪些包、开着哪些、包里有什么：

```
/project bundles
```

不确定有哪些模型可用：

```bash
make providers-init ENDPOINT=<端点> API_KEY=<密钥>   # 写成 ./providers.yaml（会被自动采用）
```

其它：`make render`（只看渲染产物）· `make probe` / `make smoke`（零凭据地看链路与边界）·
`make doctor`（运行时"实际加载了什么"）· `make help`（全部命令）

`make verify` 是核心。它依次跑四道闸门：

1. **静态校验** —— 定义是否合法、引用是否都存在
2. **解析自证** —— 运行时报告它**真正加载了**哪些技能 / 连接器 / 扩展（不是"我们以为它加载了"）
3. **集成探针** —— 模型、技能、连接器是否真的可达（默认用零凭据假网关，不需要任何密钥）
4. **端到端冒烟** —— 它是否真的能干活（退出码、输出、轨迹、有没有用到未声明的工具）

四道全过才叫**可用**。只说"能启动"不算。

## 换运行时

```bash
make verify HARNESS=dsh
```

定义不用改。差异（如果做不到等价）会被显式列出来，不会沉默地不一样。

## 接真实模型端点

定义里只写**路由名**（`model.route`）；真实地址与密钥在运行时注入，**不写进这个目录**：

```bash
CORP_GATEWAY_BASE_URL=https://your-gateway.example.com/v1 \
CORP_GATEWAY_API_KEY=xxx \
make verify
```

变量名由路由名推导：大写、非字母数字换下划线，后缀 `_BASE_URL` / `_API_KEY`。

## 出问题时

- `make validate` 报错里会写清**哪个文件、哪个字段、可选值有哪些**
- 闸门 2 失败通常意味着"运行时加载的东西和我们声明的不一样"，它会列出两边集合
- 想看轨迹：跑一次后查看 `.render/<runtime>/` 里的产物；轨迹默认走 stderr
