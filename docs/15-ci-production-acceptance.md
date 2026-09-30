# 15 · CI 生产验收

完整生产验收需要能运行 Docker、能绑定 `127.0.0.1` 的执行环境。本机 OrbStack 可以执行同一套验收；GitHub Actions 使用 Linux runner。Codex 沙箱若限制 Docker socket 或监听，需要通过审批在沙箱外执行。当前仓库提供的 GitHub Actions 工作流是：

```text
.github/workflows/production-acceptance.yml
```

## Runner 要求

- Linux runner（默认使用 `ubuntu-latest`）。
- Docker daemon 可访问，且允许 `docker run` 使用 `--network none`、只读根文件系统、`--cap-drop ALL` 和 `--tmpfs`。
- Node.js 24 和 npm 可用。
- 宿主进程可以监听 `127.0.0.1`。假网关/provider 自检在宿主回环地址启动；这不是容器联网测试。
- x86 runner 需要 QEMU 才能构建并运行 `linux/arm64`；工作流已安装 `docker/setup-qemu-action`。

自托管 runner 必须把 Docker socket 只提供给受信任的 CI job，并在执行前确认：

```bash
docker version
node -e 'require("node:net").createServer().listen(0, "127.0.0.1").close()'
```

## 验收顺序

1. `npm ci` 固定安装依赖。
2. `make hygiene-selftest` 检查凭据文件、标准入口和测试脚本。
3. 静态 job 执行 `validate` 和安全策略自检。`--fast` 仍执行含 C9 的 conformance，不能在没有镜像的干净 runner 上充当纯静态门禁。
4. 生产 job 用 `make local-packages` 和 `make local-packages-lock` 安装、记录预装锁声明的宿主运行时和连接器；只执行 `npm ci` 不会安装这些包。
5. `node core/image/build.mjs --manifest` 一次构建生产用的 `linux/amd64` + `linux/arm64` OCI 归档；Skopeo 从同一归档加载两个平台的生产镜像供回归使用，不再重复构建。
6. `node tools/regression.mjs --json` 执行完整生产验收：
   - 镜像与当前源码指纹一致；
   - 全部自检和真实 Docker 自检；
   - 两侧 conformance C1–C10；
   - 两个平台的容器安全下限；
   - 发布镜像不包含调试变体；
   - `examples-check` 和能力判据自检。

工作流会把 `ci-artifacts/regression.json` 上传为构建产物。只有该命令退出码为 0，才可把本次提交视为生产验收通过。`FAST=1` 只能证明宿主快速路径，不能替代 Docker 生产验收。

## 发布到 GHCR

普通 main 提交和 PR 只做静态与策略检查，不启动完整 Docker/QEMU 验收。推送与 `package.json` 版本相同的版本 tag（例如 `v0.1.0`），或在 main 上手动运行工作流并勾选 `publish`，才会启动完整验收，并在通过后发布。

发布要求报告中 `ok: true`、`failed: []`、`skipped: []` 同时成立。生产 job 保存已验证的 OCI 归档和源码指纹；独立发布 job 用 `GITHUB_TOKEN` 的 `packages: write` 权限，把这份归档的所有架构复制到 `ghcr.io/uukuguy/agent-base:<版本>`，确认 ARM64 和 AMD64 均存在后更新 `latest`。发布 job 限时 15 分钟，首次上传限时 8 分钟。

GHCR 新包默认私有。首次发布后需要在包设置中改为 public，并验证不登录也能拉取；仅有上传成功不能称为公开发布完成。

本地日常开发和回归只构建、测试当前主机架构（`make image`）。双架构生产镜像和多架构归档只在发布 CI 中验收；本地不需要构建四个变体。

生产 job 的总上限是 50 分钟。多架构 OCI 构建、镜像加载和完整回归各自有硬上限；Docker 或 QEMU 卡住时，工作流会指出卡住的阶段并尽快失败，不会等 90 分钟才返回结果。

## 本地复现

在具备 Docker 和回环网络的主机上（包括 macOS + OrbStack），从仓库根目录执行：

```bash
npm ci
make local-packages local-packages-lock
node core/image/build.mjs --arch arm64
node tools/regression.mjs --json > regression.json
```

在 amd64 主机上把 `--arch arm64` 换成 `--arch amd64`；`make regression` 会按当前主机架构自动选择生产镜像。需要排查跨架构问题时，再单独运行 `make image-all` 或 `make image-manifest`。

若镜像构建失败，先检查 Docker daemon、Buildx builder 和 QEMU；若 gateway/provider 自检失败，先检查 runner 是否禁止监听 `127.0.0.1`。不要用 `--allow-stale-image` 作为 CI 修复手段：它会使镜像与当前源码不可比。
