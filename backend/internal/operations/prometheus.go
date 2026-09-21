package operations

import (
	"context"
	"fmt"
	"github.com/eryajf/dbx-plugin-k8s/internal/kube"
)

func resourceUsageHistory(ctx context.Context, c *kube.Client, duration, instance string) (any, error) {
	if duration == "" {
		duration = "30m"
	}
	if c.Prometheus == nil || c.PrometheusURL == "" {
		return nil, fmt.Errorf("prometheus_not_configured: configure a Prometheus URL for this connection")
	}
	if !c.PrometheusReachable {
		return nil, fmt.Errorf("prometheus_unreachable: Prometheus URL is not reachable")
	}
	data, err := c.Prometheus.GetResourceUsageHistory(ctx, instance, duration, "instance")
	if err != nil {
		return nil, fmt.Errorf("prometheus_metrics_missing: resource metrics are unavailable; check Prometheus collection: %w", err)
	}
	return data, nil
}
func podPromMetrics(ctx context.Context, c *kube.Client, r Request) (any, error) {
	if r.Duration == "" {
		r.Duration = "1h"
	}
	if r.Namespace == "" || r.Name == "" {
		return nil, fmt.Errorf("namespace and name are required")
	}
	if c.Prometheus == nil || c.PrometheusURL == "" {
		return nil, fmt.Errorf("prometheus_not_configured: configure a Prometheus URL for this connection")
	}
	if !c.PrometheusReachable {
		return nil, fmt.Errorf("prometheus_unreachable: Prometheus URL is not reachable")
	}
	m, err := c.Prometheus.GetPodMetrics(ctx, r.Namespace, r.Name, r.PodNames, r.Container, r.Duration)
	if err != nil {
		return nil, fmt.Errorf("prometheus_metrics_missing: pod metrics are unavailable; check container_* metrics and namespace/pod/container labels: %w", err)
	}
	return m, nil
}
