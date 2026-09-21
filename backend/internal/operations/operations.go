// Package operations adapts Kite's workload and node operations to DBX RPC.
package operations

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/eryajf/dbx-plugin-k8s/internal/kube"
)

type Request struct {
	Namespace        string   `json:"namespace"`
	Name             string   `json:"name"`
	Resource         string   `json:"resource"`
	ResourceVersion  string   `json:"resourceVersion"`
	Replicas         *int32   `json:"replicas"`
	Revision         string   `json:"revision"`
	Suspend          *bool    `json:"suspend"`
	Force            bool     `json:"force"`
	IgnoreDaemonSets bool     `json:"ignoreDaemonSets"`
	DeleteLocalData  bool     `json:"deleteLocalData"`
	GracePeriod      *int64   `json:"gracePeriod"`
	TimeoutSeconds   int      `json:"timeoutSeconds"`
	Duration         string   `json:"duration"`
	Instance         string   `json:"instance"`
	Container        string   `json:"container"`
	PodNames         []string `json:"podNames"`
	LabelSelector    string   `json:"labelSelector"`
}

// Handle preserves Kubernetes StatusErrors so the protocol layer can classify them.
func Handle(ctx context.Context, client *kube.Client, method string, raw json.RawMessage) (any, error) {
	var r Request
	if err := json.Unmarshal(raw, &r); err != nil {
		return nil, fmt.Errorf("invalid operation request: %w", err)
	}
	if client == nil || client.Core == nil {
		return nil, fmt.Errorf("Kubernetes client is not initialized")
	}
	if method == "prometheus/resource-usage-history" {
		return resourceUsageHistory(ctx, client, r.Duration, r.Instance)
	}
	if method == "prometheus/pods-metrics" {
		return podPromMetrics(ctx, client, r)
	}
	if method == "kube/overview" {
		return overview(ctx, client)
	}
	if method == "kube/metrics" {
		return metrics(ctx, client, r)
	}
	if method == "kube/recent-events" {
		return recentEvents(ctx, client, r)
	}
	if r.Name == "" {
		return nil, fmt.Errorf("name is required")
	}
	switch method {
	case "node/cordon":
		return cordon(ctx, client, r, true)
	case "node/uncordon":
		return cordon(ctx, client, r, false)
	case "node/drain":
		return drain(ctx, client, r)
	}
	if r.Namespace == "" {
		return nil, fmt.Errorf("namespace is required")
	}
	switch method {
	case "workload/restart":
		return restart(ctx, client, r)
	case "workload/scale":
		return scale(ctx, client, r)
	case "workload/history":
		return history(ctx, client, r)
	case "workload/rollback":
		return rollback(ctx, client, r)
	case "cronjob/trigger":
		return trigger(ctx, client, r)
	case "cronjob/suspend":
		return suspend(ctx, client, r)
	default:
		return nil, fmt.Errorf("unsupported operation: %s", method)
	}
}
