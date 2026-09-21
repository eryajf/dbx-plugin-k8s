package operations

import (
	"context"
	"fmt"
	"github.com/eryajf/dbx-plugin-k8s/internal/kube"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"sort"
)

func metrics(ctx context.Context, c *kube.Client, r Request) (any, error) {
	if c.Dynamic == nil {
		return nil, fmt.Errorf("dynamic client is unavailable")
	}
	resource := r.Resource
	if resource == "" {
		resource = "pods"
	}
	if resource != "nodes" && resource != "pods" {
		return nil, fmt.Errorf("metrics supports nodes and pods")
	}
	api := c.Dynamic.Resource(schema.GroupVersionResource{Group: "metrics.k8s.io", Version: "v1beta1", Resource: resource})
	if resource == "pods" {
		return api.Namespace(r.Namespace).List(ctx, metav1.ListOptions{})
	}
	return api.List(ctx, metav1.ListOptions{})
}

func recentEvents(ctx context.Context, c *kube.Client, r Request) (any, error) {
	events, err := c.Core.CoreV1().Events(r.Namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, err
	}
	items := make([]corev1.Event, len(events.Items))
	copy(items, events.Items)
	sort.Slice(items, func(i, j int) bool { return items[i].LastTimestamp.After(items[j].LastTimestamp.Time) })
	if len(items) > 20 {
		items = items[:20]
	}
	return map[string]any{"items": items}, nil
}
func overview(ctx context.Context, c *kube.Client) (any, error) {
	nodes, err := c.Core.CoreV1().Nodes().List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, err
	}
	pods, err := c.Core.CoreV1().Pods("").List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, err
	}
	namespaces, err := c.Core.CoreV1().Namespaces().List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, err
	}
	capacity := corev1.ResourceList{}
	allocatable := corev1.ResourceList{}
	ready := 0
	unschedulable := 0
	for _, n := range nodes.Items {
		for k, v := range n.Status.Capacity {
			q := capacity[k]
			q.Add(v)
			capacity[k] = q
		}
		for k, v := range n.Status.Allocatable {
			q := allocatable[k]
			q.Add(v)
			allocatable[k] = q
		}
		for _, condition := range n.Status.Conditions {
			if condition.Type == corev1.NodeReady && condition.Status == corev1.ConditionTrue {
				ready++
				break
			}
		}
		if n.Spec.Unschedulable {
			unschedulable++
		}
	}
	phases := map[string]int{}
	restarts := int32(0)
	for _, p := range pods.Items {
		phases[string(p.Status.Phase)]++
		for _, s := range p.Status.ContainerStatuses {
			restarts += s.RestartCount
		}
	}
	return map[string]any{"prometheusEnabled": c.Prometheus != nil && c.PrometheusReachable, "nodes": len(nodes.Items), "readyNodes": ready, "unschedulableNodes": unschedulable, "namespaces": len(namespaces.Items), "pods": len(pods.Items), "podPhases": phases, "containerRestarts": restarts, "capacity": capacity, "allocatable": allocatable}, nil
}
