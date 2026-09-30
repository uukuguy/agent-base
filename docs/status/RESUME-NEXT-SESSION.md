# Next-Session Handoff

> Updated: 2026-09-30 11:44. End of session.

## TL;DR

1. agent-base 已完成 v0.1.0 发布闭环：GitHub Actions 构建并验收 production OCI 多架构镜像，GHCR 已公开提供 `linux/arm64` 与 `linux/amd64`。
2. 本地工作边界已确定：只构建和回归当前主机架构的 production 镜像；四变体、跨架构和多架构 manifest 只在发布 CI 验收。
3. 当前没有进行中的工作包。主要未决项是 DSH hook 事件集合穷举（E10）、DSH coding 插件内容（C8）以及若干可选扩展项。

## Where things stand

- 分支：`main`
- 远端：`origin/main`
- 最新提交：`5d74f52`
- GitHub Actions：
  - 发布验收运行 `36661566006`：成功
  - main 静态检查运行 `36663875449`：成功
- GHCR：
  - `ghcr.io/uukuguy/agent-base:0.1.0`
  - `ghcr.io/uukuguy/agent-base:latest`
  - 两者当前指向同一个 OCI 多架构 digest
- 工作树只有一项未提交修改：`.gitignore` 新增 `.codegraph/`、`.codex/`、`.claude/`。
- 本文件已根据本次确认保存。

## What this session delivered

- 本地验收改为当前主机架构 production 镜像。
- 发布 CI 改为一次 production 多架构构建：
  - 构建 OCI archive
  - 分别加载 arm64/amd64
  - 完整生产回归
  - 推送 GHCR
- GHCR v0.1.0 发布并验证匿名 manifest。
- 更新 `CURRENT-STATE.md`，移除旧的“四变体本地交付”和“未推 registry”结论。
- 追加状态日志：
  - `92a38e4`：刷新当前状态快照
  - `5d74f52`：记录状态快照更新

## Next steps

1. 先确认 `.gitignore` 的三个目录是否应作为项目约定提交。
2. 继续工作时只使用当前主机架构本地流程：
   ```bash
   node core/image/build.mjs --arch arm64
   node tools/regression.mjs --json
   ```
   Apple Silicon 主机使用 `arm64`；不要在本地默认执行四变体构建。
3. 下一个功能包可在以下两项中选择：
   - E10：穷举并验证 DSH hook 事件集合
   - C8：补齐 DSH `coding` 能力包的插件内容
4. 后续版本发布使用 tag 或手动触发：
   ```bash
   gh workflow run production-acceptance.yml --ref main -f publish=true
   ```

## Don't go down these paths again

- 不要把本地四变体构建当作生产验收要求。
- 不要把 OCI archive 当作本地 Docker daemon 已加载的多架构镜像。
- 不要在生产发布前绕过 `AGENT_BASE_RELEASE_ACCEPTANCE=1` 的完整回归。
- 不要使用 `npm install --prefix .local-packages <单包>`，它会剪掉其余锁定包。
- 修改 `core/`、`adapters/` 或验证工具后，不要跳过镜像重建和容器同源校验。
- 不要把未穷举的 DSH hook 事件写成已验证能力。

## Ready-to-paste commands

```bash
git status --short --branch
git log --oneline -5
git diff --check

# 本地当前架构构建与回归
node core/image/build.mjs --arch arm64
node tools/regression.mjs --json

# 发布 CI
gh workflow run production-acceptance.yml --ref main -f publish=true

# 查看发布结果
gh run list --workflow production-acceptance.yml --limit 5
```

## State summary

- Theme focus：本地单架构验收、发布多架构验收和 GHCR 交付边界已经明确。
- Project route：`managed`
- Canonical worklist：`docs/plans/IMPLEMENTATION-ROADMAP.md`
- JOURNAL synthesized：12 条
