# Prometheus 监控指标要求

DBX Kubernetes 插件从连接配置中的 Prometheus 地址查询历史监控数据。地址只需要填写 Prometheus 根地址，例如 `http://localhost:30090`，不要填写 `/query` 路径。

如果监控页面提示“Prometheus 连接不可用”，请先确认地址已保存，并从运行插件的环境访问该地址。如果提示“Prometheus 指标缺失”，说明 Prometheus 可以访问，但查询没有返回所需的时间序列，请检查采集目标、指标保留策略和标签。

## 页面与指标

| 页面 | 指标 | 必需标签/匹配条件 | 推荐采集组件 |
| --- | --- | --- | --- |
| 概览、节点监控：CPU | `node_cpu_seconds_total` | `instance`、`job` | node-exporter |
| 概览、节点监控：内存 | `node_memory_MemAvailable_bytes`、`node_memory_MemTotal_bytes` | `instance`、`job` | node-exporter |
| 概览、节点监控：网络 | `node_network_receive_bytes_total`、`node_network_transmit_bytes_total` | `instance`、`device`、`job` | node-exporter |
| 概览资源请求/限制 | `kube_pod_container_resource_requests`、`kube_pod_container_resource_limits` | `namespace`、`pod`、`container`、`resource` | kube-state-metrics |
| Pod/Deployment：CPU | `container_cpu_usage_seconds_total` | `namespace`、`pod`、`container` | kubelet/cAdvisor |
| Pod/Deployment：内存 | `container_memory_working_set_bytes`（必要时回退 `container_memory_usage_bytes`） | `namespace`、`pod`、`container` | kubelet/cAdvisor |
| Pod/Deployment：网络 | `container_network_receive_bytes_total`、`container_network_transmit_bytes_total` | `namespace`、`pod`、`container` | kubelet/cAdvisor |
| Pod/Deployment：磁盘 | `container_fs_reads_bytes_total`、`container_fs_writes_bytes_total` | `namespace`、`pod`、`container` | kubelet/cAdvisor |

`container_*` 指标通常来自 kubelet 的 cAdvisor 端点。Prometheus 的 cAdvisor target 显示 `UP` 只代表抓取端点成功，不代表端点实际返回了容器指标；需要在 Prometheus 查询页确认 `count({__name__=~"container_.*"})` 有结果。

## 快速检查

在 Prometheus 查询页依次执行：

```promql
count(node_cpu_seconds_total)
count(kube_pod_container_resource_requests)
count({__name__=~"container_.*"})
count(container_cpu_usage_seconds_total{namespace="default"})
```

如果最后两条为 0，请检查 kubelet/cAdvisor 抓取配置是否启用了容器指标，并确认 relabel 配置没有删除 `namespace`、`pod` 或 `container`。如果指标名称存在但标签不完整，Pod 详情和 Deployment 聚合仍无法定位到具体资源。

## 组件对应关系

- **node-exporter**：节点 CPU、内存、网卡和磁盘等主机级指标。
- **kube-state-metrics**：Kubernetes 对象状态以及 Pod 容器资源请求/限制。
- **kubelet/cAdvisor**：容器 CPU、内存、网络和文件系统 I/O 使用量。
- **Prometheus**：抓取并保存上述指标，插件通过 Prometheus HTTP API 查询。

