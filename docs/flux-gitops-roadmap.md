# Flux GitOps 路线图（对标 Lens 2026.6）

官方参考：<https://docs.lenshq.io/k8slens/flux-cd/using-flux-cd/>

> 本文是分阶段计划，不是已交付功能清单。实现每个 PR 前，应重新对照上述官方文档核对 Lens 的具体行为，不要凭本文推断细节。

## 当前状态（第 1 个 PR：仅导航）

- 侧边栏在集群安装了 Flux 时显示 "Flux" 分组，共 13 种 Kind：
  GitRepository、OCIRepository、HelmRepository、Bucket、ExternalArtifact、Kustomization、HelmRelease、
  ImageRepository、ImagePolicy、ImageUpdateAutomation、Alert、Provider、Receiver。
- 条目指向现有通用 CRD 列表/详情路由 `/crds/<plural>.<group>`，不新增页面。
- API 版本完全来自集群 discovery（GA 优先于 beta/alpha，再取较新版本），不写死版本。
- 分组按连接隔离：切换连接后不显示上一个集群的条目；discovery 失败（含 RBAC 受限）或未安装 Flux 时静默隐藏分组。
- 仅显示 API discovery 中宣告支持 `list` 操作的 Kind；这**不等于**当前用户具有 Kubernetes RBAC `list` 权限。真正列出对象时仍由 API Server 执行授权，可能返回 403。
- 已知限制：通用 CRD 列表页使用 CRD 的存储版本读取资源，不读取 URL 中的 `version` 参数；需要按所选版本读取时在后续 PR 处理。

## 决策

1. **Go 客户端 + dynamic CRD，复用通用 UI。** 后端用现有 Kubernetes 客户端的 dynamic/discovery 读取 Flux CRD，
   不引入 Flux 的 Go 类型依赖（避免绑定 Flux 版本）；前端复用通用 CRD 列表/详情，仅为 Flux 增加专用列和状态渲染。
2. **不做独立插件。** Flux 功能留在本插件内，共享连接、认证、RBAC 和侧边栏。
3. **先只读，后写操作。** 只读功能完整并稳定后，才引入 reconcile/suspend/resume 等写操作。
4. **版本来自 discovery。** 不假设 `v1`/`v1beta2` 等固定版本。

## 分阶段 PR 计划

每个 PR 保持小而独立，可单独回滚。

| PR | 范围 | 类型 |
| --- | --- | --- |
| 1 | 侧边栏导航 + discovery（本 PR） | 只读 |
| 2 | 通用列表页遵循 `version` 参数；Flux 列表的 Ready / Suspended / Revision 列 | 只读 |
| 3 | 资源详情：conditions、`status.lastAppliedRevision`、`sourceRef`/`dependsOn` 链接、关联事件 | 只读 |
| 4 | GitOps Dashboard：Ready/NotReady/Suspended/Reconciliation 汇总、Needs Attention、Kubernetes Events 驱动的 Recent Activity | 只读 |
| 5 | 依赖与来源关系视图（Kustomization/HelmRelease → Source、inventory）；Workloads 列表的 Flux 管理状态和归属关系 | 只读 |
| 6 | 受控写操作：suspend / resume | 写（需 RBAC 与确认） |
| 7 | 受控写操作：reconcile（设置 `reconcile.fluxcd.io/requestedAt` 注解），可选 with-source | 写（需 RBAC 与确认） |
| 8 | 日志/事件整合（kustomize-controller、helm-controller 等）、Image Automation/Notifications 专用详情与 i18n 校对 | 只读 |
| 9 | Lens 的 AI Summary 等可选辅助排障体验（需现有 DBX AI 功能可用，绝不转储 Secrets） | 只读 |

## Lens 2026.6 功能对照

| Lens Flux 功能 | DBX 计划 | PR |
| --- | --- | --- |
| 自动识别 Flux CRD 和集群上下文导航 | 已实现首个导航切片；需要集群集成验证 | 1 |
| GitOps 资源列表：Sources、Kustomizations、HelmReleases、Image Automation、Notifications | 通用 CRD 页面可打开，专用状态/版本列待做 | 1–3、8 |
| Ready / Reconciling / Suspended / Failed 状态、revision 和错误信息 | 按 `.status.conditions` / `.spec.suspend` / revision 字段计算，未实现 | 2–3 |
| Dashboard 健康卡片、Needs Attention 和 Recent Activity | 按资源状态与 K8s Events 汇总，未实现 | 4 |
| 来源依赖、实际工作负载归属与 Flux managed column | 使用 SourceRef、inventory、Helm release 元数据建立可验证关系，未实现 | 5 |
| 用户触发 reconcile、suspend、resume | 逐资源 RBAC 验证、二次确认、审计、状态刷新，未实现 | 6–7 |
| Image Automation、Notification 详情与控制器事件 | 复用 CRD 后增加 Flux 专用详情，未实现 | 8 |
| Ask AI / Summarize | 可选，使用现有 DBX AI 能力，未实现 | 9 |

对标的是**用户可完成的操作与可观测性**，不是复制 Lens 私有代码或像素级 UI。

## RBAC 与安全

- 所有读取使用当前连接的用户身份，不使用额外的提升权限；Discovery 失败时隐藏导航。API Discovery 的 `verbs` 不保证当前用户可读，具体对象列表遇到 403 时必须清楚展示授权错误；不缓存跨集群数据。
- 只读阶段所需权限：`get/list/watch` 于 `*.toolkit.fluxcd.io`；事件读取沿用现有 `events` 权限。
- 写操作（PR 6、7）只 `patch` 对应 CR 的 `spec.suspend` 或 reconcile 注解；前端按 `SelfSubjectAccessReview` 结果启用按钮，
  后端仍须独立校验，不能依赖前端判断。执行前必须显式确认，并记录审计信息。
- 不展示或回显 Secret 内容；`secretRef` 只显示名称。Provider/Receiver 字段可能包含敏感信息：扩展详情前必须单独审计通用 YAML 视图的脱敏行为，不假设现有视图已经安全。
- Flux 条目和折叠状态是集群派生数据，不写入持久化的侧边栏配置，折叠偏好按连接 ID 分别保存。

## 验收标准

通用（每个 PR）：
- `make test`、`pnpm run type-check`、`pnpm run lint`、`pnpm run i18n:check` 通过，且不放宽已有检查。
- 10 种语言同步新增文案，繁体与简体各自独立维护；Kind 名称和 `Flux` 保持原文。
- 版本三处同步（`manifest.json`、`backend/main.go`、`backend/internal/kube/client.go`），`node scripts/auto-package.mjs --check` 通过。

按 PR：
- PR 1：13 个 Kind 在 discovery 完整时全部出现；无 Flux、discovery 失败、无 `list` 权限时不显示分组；切换连接不显示旧数据；条目可通过通用 CRD 页面打开。
- PR 2–5：列/详情数据全部来自 API，无硬编码版本；缺失字段时优雅降级；大列表不阻塞 UI。
- PR 6–7：无写权限时操作不可用；操作失败显示后端错误；成功后列表状态刷新；有单元测试覆盖请求体仅含预期字段。
- PR 8–9：日志/事件按 Flux 控制器和资源关联；Image Automation/Notifications 可正确解释条件及状态；AI 分析遵守现有权限，不泄露 Secret 内容。
