# agent-base 协作说明

## 先读什么

开始工作或恢复会话时，先读：

1. `docs/status/RESUME-NEXT-SESSION.md`
2. `docs/status/CURRENT-STATE.md`
3. `docs/14-how-to-verify.md`
4. `docs/plans/IMPLEMENTATION-ROADMAP.md`

`docs/status/INDEX.md` 是状态文档索引。评审、计划和 CI 说明分别位于 `docs/reviews/`、`docs/superpowers/plans/` 和 `.github/workflows/`。

## 分层纪律

- `core/` 只能放 harness 无关的契约、闸门、轨迹和镜像逻辑；运行时专有代码放在 `adapters/<name>/`。
- 业务示例和模板不能依赖具体 harness 名称。
- 构建期依赖可以联网，运行期镜像必须按验证脚本支持断网运行。
- 行为改变必须进入源码指纹；修改 `core/`、`adapters/` 或 `tools/{validate,probe,smoke,verify}.mjs` 后先重建镜像，再做容器验证。
- 真源变更后运行 `make gen-docs`，不要直接手改生成文档。

## 安全与凭据

- 不提交 `.env`、API key、token、登录态目录或真实凭据。示例只使用 `<密钥>`、`placeholder` 或零凭据假网关。
- 子进程环境必须通过 allowlist；不要恢复 `...process.env` 的全量继承。
- DSH 默认权限是 `workspace-write`；只有明确的零凭据无人值守自检才可注入更高权限。
- 运行期不要新增隐式联网、自动下载或静默忽略连接器失败。

## 验证命令

```bash
# 快速回归（会明确标出跳过的容器项）
npm test

# 完整本地回归（需要 Docker、回环网络和已构建镜像）
node tools/regression.mjs --json

# 镜像与 OCI manifest
node core/image/build.mjs --all --debug
node core/image/build.mjs --manifest

# 变更完成前
git diff --check
node tools/hygiene-selftest.mjs
```

完整回归必须报告 `failed: []` 和 `skipped: []` 才能称为本地全绿。`npm test` 的 `--fast` 模式会跳过容器重项，不能替代生产验收。

## CI 与提交

- 生产验收工作流是 `.github/workflows/production-acceptance.yml`，在 Linux runner 上执行 Docker/QEMU、回环探针、双架构构建和完整回归。
- 本地若使用 OrbStack，先确认 `docker version` 的 Server 可用；沙箱限制不等同于代码失败。
- 不要重置或覆盖其他协作者的修改。提交前保留评审文档、状态文档和验证证据的一致性。
- 当前仓库是否配置 remote 以 `git remote -v` 为准；没有 remote 时不能从本地触发 GitHub Actions。
- 发现历史凭据时，同时清理 Git 历史并在供应商平台撤销旧 key；两步缺一不可。
