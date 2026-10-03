# DBX Kubernetes 插件开发约定

本文件用于约束在本仓库中工作的 AI agent 和开发者。本文档中的规则优先用于本仓库的 DBX 插件开发、调试和本地打包流程。

## DBX 插件规范

开始任何插件功能、Manifest、Host API、Sidecar、调试、打包或发布相关工作前，应尽可能优先调用并阅读 `dbx-plugin` skill（也称 `dbx-plugin-skill`）。根据任务继续阅读该 skill 下对应的 reference，尤其是：

- Manifest、权限和贡献点：`references/manifest.md`、`references/contributions.md`
- Host API 和 Sidecar：`references/host-api.md`、`references/sidecar-protocol.md`
- 本地调试和打包：`references/debugging.md`、`references/packaging.md`
- 发布和候选包：`references/publishing.md`

实现时优先遵循 DBX Manifest v1、Host API、Sidecar Protocol 和 `.dbxp` 包规范，复用仓库现有的构建脚本和检查工具。不要仅凭经验修改插件协议、Manifest 字段或包结构。

## 本地插件包构建

本地测试包必须输出到仓库根目录的 `dist/` 目录，并使用当前版本之后的下一个未占用 patch 版本号，便于用户区分和安装测试包。不要覆盖已经生成的旧 `.dbxp` 或 `.artifact.json` 文件，也不要把 `dist/` 作为下一次打包的输入目录。

优先使用仓库已有的自动打包脚本：

```bash
node scripts/auto-package.mjs --force
```

该脚本会校验版本一致性，选择 `dist/` 中尚未占用的下一个 patch 版本，构建 UI 和本地 Sidecar，将包输出到 `dist/`，并在可用时检查生成的 `.dbxp` 包。若连续版本已存在，脚本会继续向后选择可用版本，避免覆盖旧产物。普通情况下也可以使用 `make auto`；如果需要明确生成下一个本地测试版本，使用 `--force`。

打包前应先完成相关测试和构建检查。打包后确认以下内容一致：

- `manifest.json` 中的插件 `id` 和 `version`；
- 生成的 `.dbxp` 文件名中的插件 ID、版本和目标平台；
- 对应 `.artifact.json` 中的插件 ID、版本、文件大小和校验值。

未签名的本地包只用于开发测试，不要将本地 `.dbxp` 或 `.artifact.json` 当作源码提交或发布包使用。

## 插件版本必须同步修改的三个位置

插件版本不是只改一个文件。每次手动递增插件版本时，必须把同一个 SemVer 版本同步写入下面三个位置：

| 文件 | 位置 | 用途 |
| --- | --- | --- |
| `manifest.json` | 顶层 `version` | 插件包和 DBX 安装识别的版本 |
| `backend/main.go` | `dbx.Metadata{Version: "..."}` | Sidecar 握手返回的插件版本 |
| `backend/internal/kube/client.go` | `cfg.UserAgent = "dbx-plugin-k8s/..."` | Kubernetes 客户端 User-Agent 中的插件版本 |

三个位置必须完全相同，否则可能出现 Sidecar 握手版本不一致、安装失败或运行时识别异常。修改后至少执行一次：

```bash
node scripts/auto-package.mjs --check
```

该检查会在版本不一致时失败。`scripts/auto-package.mjs` 中的 `VERSION_SYNC` 是这三个位置的维护清单，新增或移动版本定义时必须同步更新该清单和相关校验。

以下版本字段通常不属于本插件版本同步范围，不要在普通插件版本递增时顺手修改：

- `ui/package.json` 的前端包版本；
- `.github/workflows/plugin-release.yml` 中的 `plugin-cli-version` 和 reusable workflow tag，它们表示 DBX Plugin CLI 版本，只有升级 CLI 时才修改。

## 推荐验证顺序

完成代码修改后，按任务范围执行必要检查；涉及 UI 或打包时，至少检查：

```bash
make test
cd ui && pnpm run type-check
cd ui && pnpm run lint
cd ui && pnpm run i18n:check
```

确认版本、构建和包内容后，再进行本地安装测试。任何会改变版本、生成包或更新 `dist/` 的操作都应在结果中记录实际版本号和产物路径。
