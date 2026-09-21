package prometheus

import (
	"context"
	"fmt"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/prometheus/client_golang/api"
	v1 "github.com/prometheus/client_golang/api/prometheus/v1"
	"github.com/prometheus/common/model"
	"k8s.io/klog/v2"
)

type Client struct {
	client    promAPI
	transport http.RoundTripper
}

type promAPI interface {
	Query(ctx context.Context, query string, ts time.Time, opts ...v1.Option) (model.Value, v1.Warnings, error)
	QueryRange(ctx context.Context, query string, r v1.Range, opts ...v1.Option) (model.Value, v1.Warnings, error)
}

type ResourceMetrics struct {
	CPURequest    float64
	CPUTotal      float64
	MemoryRequest float64
	MemoryTotal   float64
}

// UsageDataPoint represents a single time point in usage metrics
type UsageDataPoint struct {
	Timestamp time.Time `json:"timestamp"`
	Value     float64   `json:"value"`
	Series    string    `json:"series,omitempty"`
}

// ResourceUsageHistory contains historical usage data for a resource
type ResourceUsageHistory struct {
	CPU        []UsageDataPoint `json:"cpu"`
	Memory     []UsageDataPoint `json:"memory"`
	NetworkIn  []UsageDataPoint `json:"networkIn"`
	NetworkOut []UsageDataPoint `json:"networkOut"`
	DiskRead   []UsageDataPoint `json:"diskRead"`
	DiskWrite  []UsageDataPoint `json:"diskWrite"`
	Warnings   []string         `json:"warnings,omitempty"`
}

// PodMetrics contains metrics for a specific pod
type PodMetrics struct {
	CPU               []UsageDataPoint `json:"cpu"`
	Memory            []UsageDataPoint `json:"memory"`
	CPUUtilization    []UsageDataPoint `json:"cpuUtilization"`
	MemoryUtilization []UsageDataPoint `json:"memoryUtilization"`
	NetworkIn         []UsageDataPoint `json:"networkIn"`
	NetworkOut        []UsageDataPoint `json:"networkOut"`
	DiskRead          []UsageDataPoint `json:"diskRead"`
	DiskWrite         []UsageDataPoint `json:"diskWrite"`
	Fallback          bool             `json:"fallback"`
	Source            string           `json:"source,omitempty"`
	Warnings          []string         `json:"warnings,omitempty"`
}

type PodCurrentMetrics struct {
	PodName   string  `json:"podName"`
	Namespace string  `json:"namespace"`
	CPU       float64 `json:"cpu"`    // CPU cores
	Memory    float64 `json:"memory"` // Memory in MB
}

func NewClientWithRoundTripper(prometheusURL string, rt http.RoundTripper) (*Client, error) {
	if prometheusURL == "" {
		return nil, fmt.Errorf("prometheus URL cannot be empty")
	}
	client, err := api.NewClient(api.Config{
		Address:      prometheusURL,
		RoundTripper: rt,
	})
	if err != nil {
		return nil, fmt.Errorf("error creating prometheus client: %w", err)
	}

	v1api := v1.NewAPI(client)
	return &Client{
		client:    v1api,
		transport: rt,
	}, nil
}

// Close releases idle connections owned by a Prometheus client. The shared
// http.DefaultTransport is intentionally left untouched.
func (c *Client) Close() {
	if c == nil || c.transport == nil || c.transport == http.DefaultTransport {
		return
	}
	if closer, ok := c.transport.(interface{ CloseIdleConnections() }); ok {
		closer.CloseIdleConnections()
	}
}

type seriesCandidate struct {
	query       string
	legacyQuery string
	source      string
	warning     string
}

func joinMatchers(matchers []string) string {
	return strings.Join(matchers, ",")
}

func workloadMatchers(namespace, podNamePrefix, container string, withContainerLabel bool) []string {
	matchers := []string{}
	if withContainerLabel {
		matchers = append(matchers, `container!="POD"`, `container!=""`)
		if container != "" {
			matchers = append(matchers, fmt.Sprintf(`container="%s"`, container))
		}
	} else {
		matchers = append(matchers, `pod!=""`)
	}
	if podNamePrefix != "" {
		matchers = append(matchers, fmt.Sprintf(`pod=~"%s.*"`, podNamePrefix))
	}
	if namespace != "" {
		matchers = append(matchers, fmt.Sprintf(`namespace="%s"`, namespace))
	}
	return matchers
}

func workloadMatchersForPods(namespace, podNamePrefix string, podNames []string, container string, withContainerLabel bool) []string {
	matchers := workloadMatchers(namespace, "", container, withContainerLabel)
	if len(podNames) > 0 {
		escapedNames := make([]string, 0, len(podNames))
		for _, podName := range podNames {
			escapedNames = append(escapedNames, regexp.QuoteMeta(podName))
		}
		return append(matchers, fmt.Sprintf(`pod=~"^(%s)$"`, strings.Join(escapedNames, "|")))
	}
	if podNamePrefix != "" {
		return append(matchers, fmt.Sprintf(`pod=~"%s.*"`, podNamePrefix))
	}
	return matchers
}

const (
	legacyPodLabel       = "container_label_io_kubernetes_pod_name"
	legacyContainerLabel = "container_label_io_kubernetes_container_name"
	legacyNamespaceLabel = "container_label_io_kubernetes_pod_namespace"
)

func legacyWorkloadMatchersForPods(namespace, podNamePrefix string, podNames []string, container string, withContainerLabel bool) []string {
	matchers := []string{}
	if withContainerLabel {
		matchers = append(matchers, legacyContainerLabel+`!="POD"`, legacyContainerLabel+`!=""`)
		if container != "" {
			matchers = append(matchers, fmt.Sprintf(`%s="%s"`, legacyContainerLabel, container))
		}
	} else {
		matchers = append(matchers, legacyPodLabel+`!=""`)
	}
	if len(podNames) > 0 {
		escapedNames := make([]string, 0, len(podNames))
		for _, podName := range podNames {
			escapedNames = append(escapedNames, regexp.QuoteMeta(podName))
		}
		matchers = append(matchers, fmt.Sprintf(`%s=~"^(%s)$"`, legacyPodLabel, strings.Join(escapedNames, "|")))
	} else if podNamePrefix != "" {
		matchers = append(matchers, fmt.Sprintf(`%s=~"%s.*"`, legacyPodLabel, podNamePrefix))
	}
	if namespace != "" {
		matchers = append(matchers, fmt.Sprintf(`%s="%s"`, legacyNamespaceLabel, namespace))
	}
	return matchers
}

// legacyContainerSeries preserves the cAdvisor Kubernetes labels while adding
// standard pod/container labels required by the UI and utilization joins.
func legacyContainerSeries(expression string) string {
	return fmt.Sprintf(
		`label_replace(label_replace(sum by (%s, %s) (%s), "pod", "$1", "%s", "(.*)"), "container", "$1", "%s", "(.*)")`,
		legacyPodLabel,
		legacyContainerLabel,
		expression,
		legacyPodLabel,
		legacyContainerLabel,
	)
}

func legacyPodSeries(expression string) string {
	return fmt.Sprintf(
		`label_replace(sum by (%s) (%s), "pod", "$1", "%s", "(.*)")`,
		legacyPodLabel,
		expression,
		legacyPodLabel,
	)
}

func nodeScopedMatchers(nodeLabel, instance string) []string {
	if instance == "" {
		return nil
	}
	return []string{fmt.Sprintf(`%s="%s"`, nodeLabel, instance)}
}

func warningForCandidate(primary, candidate string) string {
	if candidate == primary {
		return ""
	}
	switch candidate {
	case "node":
		return "using node-level metrics because container-level metrics are unavailable"
	case "pod":
		return "using pod-level aggregate metrics because container labels are unavailable"
	default:
		return ""
	}
}

func (c *Client) queryRangeFirstAvailable(ctx context.Context, start, end time.Time, step time.Duration, candidates ...seriesCandidate) ([]UsageDataPoint, string, []string, error) {
	var errs []string
	for _, candidate := range candidates {
		if candidate.query == "" {
			continue
		}
		data, err := c.queryRange(ctx, candidate.query, start, end, step)
		if err != nil {
			errs = append(errs, fmt.Sprintf("%s: %v", candidate.source, err))
			continue
		}
		if len(data) == 0 {
			if candidate.legacyQuery != "" {
				if legacyData, legacyErr := c.queryRange(ctx, candidate.legacyQuery, start, end, step); legacyErr == nil && len(legacyData) > 0 {
					return legacyData, candidate.source + "-container-labels", candidateWarnings(candidate), nil
				}
			}
			continue
		}
		var warnings []string
		if candidate.warning != "" {
			warnings = append(warnings, candidate.warning)
		}
		return data, candidate.source, warnings, nil
	}
	if len(errs) > 0 {
		return nil, "", nil, fmt.Errorf("%s", strings.Join(errs, "; "))
	}
	return nil, "", nil, nil
}

func candidateWarnings(candidate seriesCandidate) []string {
	if candidate.warning == "" {
		return nil
	}
	return []string{candidate.warning}
}

// GetResourceUsageHistory fetches historical usage data for CPU and Memory
func (c *Client) GetResourceUsageHistory(ctx context.Context, instance string, duration string, nodeLabel string) (*ResourceUsageHistory, error) {
	var step time.Duration
	var timeRange time.Duration

	switch duration {
	case "15m":
		timeRange = 15 * time.Minute
		step = 30 * time.Second
	case "30m":
		timeRange = 30 * time.Minute
		step = 1 * time.Minute
	case "1h":
		timeRange = 1 * time.Hour
		step = 2 * time.Minute
	case "3h":
		timeRange = 3 * time.Hour
		step = 5 * time.Minute
	case "6h":
		timeRange = 6 * time.Hour
		step = 10 * time.Minute
	case "12h":
		timeRange = 12 * time.Hour
		step = 15 * time.Minute
	case "24h":
		timeRange = 24 * time.Hour
		step = 30 * time.Minute
	case "2d":
		timeRange = 48 * time.Hour
		step = 1 * time.Hour
	case "7d":
		timeRange = 7 * 24 * time.Hour
		step = 3 * time.Hour
	default:
		return nil, fmt.Errorf("unsupported duration: %s", duration)
	}

	now := time.Now()
	start := now.Add(-timeRange)

	var warnings []string

	nodeMatchers := nodeScopedMatchers(nodeLabel, instance)
	cpuAllocatableMatchers := append([]string{`resource="cpu"`}, nodeMatchers...)
	memoryAllocatableMatchers := append([]string{`resource="memory"`}, nodeMatchers...)

	cpuData, _, cpuWarnings, err := c.queryRangeFirstAvailable(ctx, start, now, step,
		seriesCandidate{
			query:   fmt.Sprintf(`sum(rate(node_cpu_seconds_total{%s}[5m])) / sum(rate(node_cpu_seconds_total{%s}[5m])) * 100`, joinMatchers(append([]string{`mode!="idle"`}, nodeMatchers...)), joinMatchers(nodeMatchers)),
			source:  "node",
			warning: warningForCandidate("node", "node"),
		},
		seriesCandidate{
			query:   fmt.Sprintf(`sum(rate(container_cpu_usage_seconds_total{%s}[1m])) / sum(kube_node_status_allocatable{%s}) * 100`, joinMatchers(append(workloadMatchers("", "", "", true), nodeMatchers...)), joinMatchers(cpuAllocatableMatchers)),
			source:  "container",
			warning: warningForCandidate("node", "container"),
		},
		seriesCandidate{
			query:   fmt.Sprintf(`sum(rate(container_cpu_usage_seconds_total{%s}[1m])) / sum(kube_node_status_allocatable{%s}) * 100`, joinMatchers(append(workloadMatchers("", "", "", false), nodeMatchers...)), joinMatchers(cpuAllocatableMatchers)),
			source:  "pod",
			warning: warningForCandidate("node", "pod"),
		},
	)
	if err != nil {
		return nil, fmt.Errorf("error querying CPU usage: %w", err)
	}
	warnings = append(warnings, cpuWarnings...)

	memoryData, _, memoryWarnings, err := c.queryRangeFirstAvailable(ctx, start, now, step,
		seriesCandidate{
			query:   fmt.Sprintf(`(1 - sum(node_memory_MemAvailable_bytes{%s}) / sum(node_memory_MemTotal_bytes{%s})) * 100`, joinMatchers(nodeMatchers), joinMatchers(nodeMatchers)),
			source:  "node",
			warning: warningForCandidate("node", "node"),
		},
		seriesCandidate{
			query:   fmt.Sprintf(`sum(container_memory_working_set_bytes{%s}) / sum(kube_node_status_allocatable{%s}) * 100`, joinMatchers(append(workloadMatchers("", "", "", true), nodeMatchers...)), joinMatchers(memoryAllocatableMatchers)),
			source:  "container",
			warning: warningForCandidate("node", "container"),
		},
		seriesCandidate{
			query:   fmt.Sprintf(`sum(container_memory_working_set_bytes{%s}) / sum(kube_node_status_allocatable{%s}) * 100`, joinMatchers(append(workloadMatchers("", "", "", false), nodeMatchers...)), joinMatchers(memoryAllocatableMatchers)),
			source:  "pod",
			warning: warningForCandidate("node", "pod"),
		},
		seriesCandidate{
			query:   fmt.Sprintf(`sum(container_memory_usage_bytes{%s}) / sum(kube_node_status_allocatable{%s}) * 100`, joinMatchers(append(workloadMatchers("", "", "", true), nodeMatchers...)), joinMatchers(memoryAllocatableMatchers)),
			source:  "container",
			warning: warningForCandidate("node", "container"),
		},
		seriesCandidate{
			query:   fmt.Sprintf(`sum(container_memory_usage_bytes{%s}) / sum(kube_node_status_allocatable{%s}) * 100`, joinMatchers(append(workloadMatchers("", "", "", false), nodeMatchers...)), joinMatchers(memoryAllocatableMatchers)),
			source:  "pod",
			warning: warningForCandidate("node", "pod"),
		},
	)
	if err != nil {
		return nil, fmt.Errorf("error querying Memory usage: %w", err)
	}
	warnings = append(warnings, memoryWarnings...)

	networkInData, _, networkInWarnings, err := c.queryRangeFirstAvailable(ctx, start, now, step,
		seriesCandidate{
			query:   fmt.Sprintf(`sum(rate(node_network_receive_bytes_total{%s}[1m]))`, joinMatchers(append([]string{`device!="lo"`}, nodeMatchers...))),
			source:  "node",
			warning: warningForCandidate("node", "node"),
		},
		seriesCandidate{
			query:   fmt.Sprintf(`sum(rate(container_network_receive_bytes_total{%s}[1m]))`, joinMatchers(nodeMatchers)),
			source:  "container",
			warning: warningForCandidate("node", "container"),
		},
	)
	if err != nil {
		return nil, fmt.Errorf("error querying Network incoming bytes: %w", err)
	}
	warnings = append(warnings, networkInWarnings...)

	networkOutData, _, networkOutWarnings, err := c.queryRangeFirstAvailable(ctx, start, now, step,
		seriesCandidate{
			query:   fmt.Sprintf(`sum(rate(node_network_transmit_bytes_total{%s}[1m]))`, joinMatchers(append([]string{`device!="lo"`}, nodeMatchers...))),
			source:  "node",
			warning: warningForCandidate("node", "node"),
		},
		seriesCandidate{
			query:   fmt.Sprintf(`sum(rate(container_network_transmit_bytes_total{%s}[1m]))`, joinMatchers(nodeMatchers)),
			source:  "container",
			warning: warningForCandidate("node", "container"),
		},
	)
	if err != nil {
		return nil, fmt.Errorf("error querying Network outgoing bytes: %w", err)
	}
	warnings = append(warnings, networkOutWarnings...)

	if len(cpuData) == 0 && len(memoryData) == 0 {
		return nil, fmt.Errorf("resource usage history is unavailable from Prometheus")
	}

	return &ResourceUsageHistory{
		CPU:        cpuData,
		Memory:     memoryData,
		NetworkIn:  networkInData,
		NetworkOut: networkOutData,
		Warnings:   warnings,
	}, nil
}

func (c *Client) queryRange(ctx context.Context, query string, start, end time.Time, step time.Duration) ([]UsageDataPoint, error) {
	r := v1.Range{
		Start: start,
		End:   end,
		Step:  step,
	}

	result, warnings, err := c.client.QueryRange(ctx, query, r)
	if err != nil {
		klog.Error("queryRange", "error", err)
		return nil, err
	}
	if len(warnings) > 0 {
		fmt.Printf("Warnings: %v\n", warnings)
	}

	var dataPoints []UsageDataPoint

	switch result.Type() {
	case model.ValMatrix:
		matrix := result.(model.Matrix)
		if len(matrix) > 0 {
			for _, stream := range matrix {
				series := metricSeriesName(stream.Metric)
				for _, sample := range stream.Values {
					dataPoints = append(dataPoints, UsageDataPoint{
						Timestamp: sample.Timestamp.Time(),
						Value:     float64(sample.Value),
						Series:    series,
					})
				}
			}
		}
	default:
		return nil, fmt.Errorf("unexpected result type: %s", result.Type())
	}

	return dataPoints, nil
}

func metricSeriesName(metric model.Metric) string {
	pod := string(metric["pod"])
	if pod == "" {
		pod = string(metric["container_label_io_kubernetes_pod_name"])
	}
	container := string(metric["container"])
	if container == "" {
		container = string(metric["container_label_io_kubernetes_container_name"])
	}
	if pod != "" && container != "" {
		return pod + "/" + container
	}
	return pod
}

// HealthCheck verifies that the Prometheus query API is accessible. Avoid the
// status/config endpoint because managed Prometheus services often forbid it
// even when normal metric queries are permitted.
func (c *Client) HealthCheck(ctx context.Context) error {
	_, _, err := c.client.Query(ctx, "vector(1)", time.Now())
	return err
}

// Query executes an instant query against Prometheus
func (c *Client) Query(ctx context.Context, query string, ts time.Time, opts ...v1.Option) (model.Value, v1.Warnings, error) {
	return c.client.Query(ctx, query, ts, opts...)
}

// QueryRange executes a range query against Prometheus
func (c *Client) QueryRange(ctx context.Context, query string, r v1.Range, opts ...v1.Option) (model.Value, v1.Warnings, error) {
	return c.client.QueryRange(ctx, query, r, opts...)
}

func (c *Client) getCPUUsage(ctx context.Context, namespace, podNamePrefix string, podNames []string, container string, start, end time.Time, step time.Duration) ([]UsageDataPoint, string, []string, error) {
	legacyContainerMatchers := joinMatchers(legacyWorkloadMatchersForPods(namespace, podNamePrefix, podNames, container, true))
	legacyPodMatchers := joinMatchers(legacyWorkloadMatchersForPods(namespace, podNamePrefix, podNames, "", false))
	return c.queryRangeFirstAvailable(ctx, start, end, step,
		seriesCandidate{
			query:       fmt.Sprintf(`sum by (pod, container) (rate(container_cpu_usage_seconds_total{%s}[1m]))`, joinMatchers(workloadMatchersForPods(namespace, podNamePrefix, podNames, container, true))),
			legacyQuery: legacyContainerSeries(fmt.Sprintf(`rate(container_cpu_usage_seconds_total{%s}[1m])`, legacyContainerMatchers)),
			source:      "prometheus-container",
			warning:     "",
		},
		seriesCandidate{
			query:       fmt.Sprintf(`sum by (pod) (rate(container_cpu_usage_seconds_total{%s}[1m]))`, joinMatchers(workloadMatchersForPods(namespace, podNamePrefix, podNames, "", false))),
			legacyQuery: legacyPodSeries(fmt.Sprintf(`rate(container_cpu_usage_seconds_total{%s}[1m])`, legacyPodMatchers)),
			source:      "prometheus-pod",
			warning:     warningForCandidate("prometheus-container", "pod"),
		},
	)
}

func (c *Client) getMemoryUsage(ctx context.Context, namespace, podNamePrefix string, podNames []string, container string, start, end time.Time, step time.Duration) ([]UsageDataPoint, string, []string, error) {
	legacyContainerMatchers := joinMatchers(legacyWorkloadMatchersForPods(namespace, podNamePrefix, podNames, container, true))
	legacyPodMatchers := joinMatchers(legacyWorkloadMatchersForPods(namespace, podNamePrefix, podNames, "", false))
	return c.queryRangeFirstAvailable(ctx, start, end, step,
		seriesCandidate{
			query:       fmt.Sprintf(`sum by (pod, container) (container_memory_working_set_bytes{%s}) / 1024 / 1024`, joinMatchers(workloadMatchersForPods(namespace, podNamePrefix, podNames, container, true))),
			legacyQuery: legacyContainerSeries(fmt.Sprintf(`container_memory_working_set_bytes{%s} / 1024 / 1024`, legacyContainerMatchers)),
			source:      "prometheus-container",
			warning:     "",
		},
		seriesCandidate{
			query:       fmt.Sprintf(`sum by (pod) (container_memory_working_set_bytes{%s}) / 1024 / 1024`, joinMatchers(workloadMatchersForPods(namespace, podNamePrefix, podNames, "", false))),
			legacyQuery: legacyPodSeries(fmt.Sprintf(`container_memory_working_set_bytes{%s} / 1024 / 1024`, legacyPodMatchers)),
			source:      "prometheus-pod",
			warning:     warningForCandidate("prometheus-container", "pod"),
		},
		seriesCandidate{
			query:       fmt.Sprintf(`sum by (pod, container) (container_memory_usage_bytes{%s}) / 1024 / 1024`, joinMatchers(workloadMatchersForPods(namespace, podNamePrefix, podNames, container, true))),
			legacyQuery: legacyContainerSeries(fmt.Sprintf(`container_memory_usage_bytes{%s} / 1024 / 1024`, legacyContainerMatchers)),
			source:      "prometheus-container",
			warning:     "",
		},
		seriesCandidate{
			query:       fmt.Sprintf(`sum by (pod) (container_memory_usage_bytes{%s}) / 1024 / 1024`, joinMatchers(workloadMatchersForPods(namespace, podNamePrefix, podNames, "", false))),
			legacyQuery: legacyPodSeries(fmt.Sprintf(`container_memory_usage_bytes{%s} / 1024 / 1024`, legacyPodMatchers)),
			source:      "prometheus-pod",
			warning:     warningForCandidate("prometheus-container", "pod"),
		},
	)
}

func resourceUsageMatchers(namespace, podNamePrefix string, podNames []string, container, resource string) []string {
	return append([]string{fmt.Sprintf(`resource="%s"`, resource)}, workloadMatchersForPods(namespace, podNamePrefix, podNames, container, true)...)
}

func (c *Client) getCPUUtilization(ctx context.Context, namespace, podNamePrefix string, podNames []string, container string, start, end time.Time, step time.Duration) ([]UsageDataPoint, string, []string, error) {
	usageMatchers := joinMatchers(workloadMatchersForPods(namespace, podNamePrefix, podNames, container, true))
	resourceMatchers := joinMatchers(resourceUsageMatchers(namespace, podNamePrefix, podNames, container, "cpu"))
	legacyResourceMatchers := joinMatchers(workloadMatchersForPods(namespace, podNamePrefix, podNames, container, true))
	legacyUsageMatchers := joinMatchers(legacyWorkloadMatchersForPods(namespace, podNamePrefix, podNames, container, true))
	denominator := fmt.Sprintf(
		`clamp_min((sum by (pod, container) (kube_pod_container_resource_limits{%s}) or sum by (pod, container) (kube_pod_container_resource_limits_cpu_cores{%s}) or sum by (pod, container) (kube_pod_container_resource_requests{%s}) or sum by (pod, container) (kube_pod_container_resource_requests_cpu_cores{%s})), 0.001)`,
		resourceMatchers,
		legacyResourceMatchers,
		resourceMatchers,
		legacyResourceMatchers,
	)
	return c.queryRangeFirstAvailable(ctx, start, end, step,
		seriesCandidate{
			query:       fmt.Sprintf(`sum by (pod, container) (rate(container_cpu_usage_seconds_total{%s}[1m])) / %s * 100`, usageMatchers, denominator),
			legacyQuery: fmt.Sprintf(`%s / on(pod, container) %s * 100`, legacyContainerSeries(fmt.Sprintf(`rate(container_cpu_usage_seconds_total{%s}[1m])`, legacyUsageMatchers)), denominator),
			source:      "prometheus-container",
			warning:     "",
		},
	)
}

func (c *Client) getMemoryUtilization(ctx context.Context, namespace, podNamePrefix string, podNames []string, container string, start, end time.Time, step time.Duration) ([]UsageDataPoint, string, []string, error) {
	usageMatchers := joinMatchers(workloadMatchersForPods(namespace, podNamePrefix, podNames, container, true))
	resourceMatchers := joinMatchers(resourceUsageMatchers(namespace, podNamePrefix, podNames, container, "memory"))
	legacyResourceMatchers := joinMatchers(workloadMatchersForPods(namespace, podNamePrefix, podNames, container, true))
	legacyUsageMatchers := joinMatchers(legacyWorkloadMatchersForPods(namespace, podNamePrefix, podNames, container, true))
	denominator := fmt.Sprintf(
		`clamp_min((sum by (pod, container) (kube_pod_container_resource_limits{%s}) or sum by (pod, container) (kube_pod_container_resource_limits_memory_bytes{%s}) or sum by (pod, container) (kube_pod_container_resource_requests{%s}) or sum by (pod, container) (kube_pod_container_resource_requests_memory_bytes{%s})), 1)`,
		resourceMatchers,
		legacyResourceMatchers,
		resourceMatchers,
		legacyResourceMatchers,
	)
	return c.queryRangeFirstAvailable(ctx, start, end, step,
		seriesCandidate{
			query:       fmt.Sprintf(`sum by (pod, container) (container_memory_working_set_bytes{%s}) / %s * 100`, usageMatchers, denominator),
			legacyQuery: fmt.Sprintf(`%s / on(pod, container) %s * 100`, legacyContainerSeries(fmt.Sprintf(`container_memory_working_set_bytes{%s}`, legacyUsageMatchers)), denominator),
			source:      "prometheus-container",
			warning:     "",
		},
	)
}

func (c *Client) getNetworkInUsage(ctx context.Context, namespace, podNamePrefix string, podNames []string, container string, start, end time.Time, step time.Duration) ([]UsageDataPoint, string, []string, error) {
	legacyContainerMatchers := joinMatchers(legacyWorkloadMatchersForPods(namespace, podNamePrefix, podNames, container, true))
	legacyPodMatchers := joinMatchers(legacyWorkloadMatchersForPods(namespace, podNamePrefix, podNames, "", false))
	return c.queryRangeFirstAvailable(ctx, start, end, step,
		seriesCandidate{
			query:       fmt.Sprintf(`sum by (pod, container) (rate(container_network_receive_bytes_total{%s}[1m]))`, joinMatchers(workloadMatchersForPods(namespace, podNamePrefix, podNames, container, true))),
			legacyQuery: legacyContainerSeries(fmt.Sprintf(`rate(container_network_receive_bytes_total{%s}[1m])`, legacyContainerMatchers)),
			source:      "prometheus-container",
			warning:     "",
		},
		seriesCandidate{
			query:       fmt.Sprintf(`sum by (pod) (rate(container_network_receive_bytes_total{%s}[1m]))`, joinMatchers(workloadMatchersForPods(namespace, podNamePrefix, podNames, "", false))),
			legacyQuery: legacyPodSeries(fmt.Sprintf(`rate(container_network_receive_bytes_total{%s}[1m])`, legacyPodMatchers)),
			source:      "prometheus-pod",
			warning:     warningForCandidate("prometheus-container", "pod"),
		},
	)
}

func (c *Client) getNetworkOutUsage(ctx context.Context, namespace, podNamePrefix string, podNames []string, container string, start, end time.Time, step time.Duration) ([]UsageDataPoint, string, []string, error) {
	legacyContainerMatchers := joinMatchers(legacyWorkloadMatchersForPods(namespace, podNamePrefix, podNames, container, true))
	legacyPodMatchers := joinMatchers(legacyWorkloadMatchersForPods(namespace, podNamePrefix, podNames, "", false))
	return c.queryRangeFirstAvailable(ctx, start, end, step,
		seriesCandidate{
			query:       fmt.Sprintf(`sum by (pod, container) (rate(container_network_transmit_bytes_total{%s}[1m]))`, joinMatchers(workloadMatchersForPods(namespace, podNamePrefix, podNames, container, true))),
			legacyQuery: legacyContainerSeries(fmt.Sprintf(`rate(container_network_transmit_bytes_total{%s}[1m])`, legacyContainerMatchers)),
			source:      "prometheus-container",
			warning:     "",
		},
		seriesCandidate{
			query:       fmt.Sprintf(`sum by (pod) (rate(container_network_transmit_bytes_total{%s}[1m]))`, joinMatchers(workloadMatchersForPods(namespace, podNamePrefix, podNames, "", false))),
			legacyQuery: legacyPodSeries(fmt.Sprintf(`rate(container_network_transmit_bytes_total{%s}[1m])`, legacyPodMatchers)),
			source:      "prometheus-pod",
			warning:     warningForCandidate("prometheus-container", "pod"),
		},
	)
}

func (c *Client) getDiskReadUsage(ctx context.Context, namespace, podNamePrefix string, podNames []string, container string, start, end time.Time, step time.Duration) ([]UsageDataPoint, string, []string, error) {
	legacyContainerMatchers := joinMatchers(legacyWorkloadMatchersForPods(namespace, podNamePrefix, podNames, container, true))
	legacyPodMatchers := joinMatchers(legacyWorkloadMatchersForPods(namespace, podNamePrefix, podNames, "", false))
	return c.queryRangeFirstAvailable(ctx, start, end, step,
		seriesCandidate{
			query:       fmt.Sprintf(`sum by (pod, container) (rate(container_fs_reads_bytes_total{%s}[1m]))`, joinMatchers(workloadMatchersForPods(namespace, podNamePrefix, podNames, container, true))),
			legacyQuery: legacyContainerSeries(fmt.Sprintf(`rate(container_fs_reads_bytes_total{%s}[1m])`, legacyContainerMatchers)),
			source:      "prometheus-container",
			warning:     "",
		},
		seriesCandidate{
			query:       fmt.Sprintf(`sum by (pod) (rate(container_fs_reads_bytes_total{%s}[1m]))`, joinMatchers(workloadMatchersForPods(namespace, podNamePrefix, podNames, "", false))),
			legacyQuery: legacyPodSeries(fmt.Sprintf(`rate(container_fs_reads_bytes_total{%s}[1m])`, legacyPodMatchers)),
			source:      "prometheus-pod",
			warning:     warningForCandidate("prometheus-container", "pod"),
		},
	)
}

func (c *Client) getDiskWriteUsage(ctx context.Context, namespace, podNamePrefix string, podNames []string, container string, start, end time.Time, step time.Duration) ([]UsageDataPoint, string, []string, error) {
	legacyContainerMatchers := joinMatchers(legacyWorkloadMatchersForPods(namespace, podNamePrefix, podNames, container, true))
	legacyPodMatchers := joinMatchers(legacyWorkloadMatchersForPods(namespace, podNamePrefix, podNames, "", false))
	return c.queryRangeFirstAvailable(ctx, start, end, step,
		seriesCandidate{
			query:       fmt.Sprintf(`sum by (pod, container) (rate(container_fs_writes_bytes_total{%s}[1m]))`, joinMatchers(workloadMatchersForPods(namespace, podNamePrefix, podNames, container, true))),
			legacyQuery: legacyContainerSeries(fmt.Sprintf(`rate(container_fs_writes_bytes_total{%s}[1m])`, legacyContainerMatchers)),
			source:      "prometheus-container",
			warning:     "",
		},
		seriesCandidate{
			query:       fmt.Sprintf(`sum by (pod) (rate(container_fs_writes_bytes_total{%s}[1m]))`, joinMatchers(workloadMatchersForPods(namespace, podNamePrefix, podNames, "", false))),
			legacyQuery: legacyPodSeries(fmt.Sprintf(`rate(container_fs_writes_bytes_total{%s}[1m])`, legacyPodMatchers)),
			source:      "prometheus-pod",
			warning:     warningForCandidate("prometheus-container", "pod"),
		},
	)
}

func FillMissingDataPoints(startTime time.Time, step time.Duration, existing []UsageDataPoint) []UsageDataPoint {
	if len(existing) == 0 {
		return existing
	}

	bySeries := make(map[string][]UsageDataPoint)
	for _, point := range existing {
		bySeries[point.Series] = append(bySeries[point.Series], point)
	}

	result := make([]UsageDataPoint, 0, len(existing))
	for series, points := range bySeries {
		sort.Slice(points, func(i, j int) bool {
			return points[i].Timestamp.Before(points[j].Timestamp)
		})
		firstTime := points[0].Timestamp
		for timestamp := startTime.Add(step); timestamp.Before(firstTime); timestamp = timestamp.Add(step) {
			result = append(result, UsageDataPoint{
				Timestamp: timestamp,
				Value:     0,
				Series:    series,
			})
		}
		result = append(result, points...)
	}
	sort.Slice(result, func(i, j int) bool {
		if result[i].Timestamp.Equal(result[j].Timestamp) {
			return result[i].Series < result[j].Series
		}
		return result[i].Timestamp.Before(result[j].Timestamp)
	})
	return result
}

// GetPodMetrics fetches metrics for a specific pod
func (c *Client) GetPodMetrics(ctx context.Context, namespace, podName string, podNames []string, container string, duration string) (*PodMetrics, error) {
	var step time.Duration
	var timeRange time.Duration

	switch duration {
	case "15m":
		timeRange = 15 * time.Minute
		step = 10 * time.Second
	case "30m":
		timeRange = 30 * time.Minute
		step = 15 * time.Second
	case "1h":
		timeRange = 1 * time.Hour
		step = 1 * time.Minute
	case "3h":
		timeRange = 3 * time.Hour
		step = 2 * time.Minute
	case "6h":
		timeRange = 6 * time.Hour
		step = 3 * time.Minute
	case "12h":
		timeRange = 12 * time.Hour
		step = 5 * time.Minute
	case "24h":
		timeRange = 24 * time.Hour
		step = 5 * time.Minute
	case "2d":
		timeRange = 48 * time.Hour
		step = 10 * time.Minute
	case "7d":
		timeRange = 7 * 24 * time.Hour
		step = 30 * time.Minute
	default:
		return nil, fmt.Errorf("unsupported duration: %s", duration)
	}
	now := time.Now()
	start := now.Add(-timeRange)

	var warnings []string
	cpuData, cpuSource, cpuWarnings, err := c.getCPUUsage(ctx, namespace, podName, podNames, container, start, now, step)
	if err != nil {
		return nil, fmt.Errorf("error querying pod CPU usage: %w", err)
	}
	warnings = append(warnings, cpuWarnings...)

	memoryData, memorySource, memoryWarnings, err := c.getMemoryUsage(ctx, namespace, podName, podNames, container, start, now, step)
	if err != nil {
		return nil, fmt.Errorf("error querying pod Memory usage: %w", err)
	}
	warnings = append(warnings, memoryWarnings...)

	cpuUtilizationData, _, cpuUtilizationWarnings, cpuUtilizationErr := c.getCPUUtilization(ctx, namespace, podName, podNames, container, start, now, step)
	if cpuUtilizationErr != nil {
		warnings = append(warnings, "CPU utilization is unavailable because resource limit/request metrics could not be queried")
	} else {
		warnings = append(warnings, cpuUtilizationWarnings...)
	}

	memoryUtilizationData, _, memoryUtilizationWarnings, memoryUtilizationErr := c.getMemoryUtilization(ctx, namespace, podName, podNames, container, start, now, step)
	if memoryUtilizationErr != nil {
		warnings = append(warnings, "memory utilization is unavailable because resource limit/request metrics could not be queried")
	} else {
		warnings = append(warnings, memoryUtilizationWarnings...)
	}

	networkInData, _, networkInWarnings, err := c.getNetworkInUsage(ctx, namespace, podName, podNames, container, start, now, step)
	if err != nil {
		return nil, fmt.Errorf("error querying pod Network incoming usage: %w", err)
	}
	warnings = append(warnings, networkInWarnings...)

	networkOutData, _, networkOutWarnings, err := c.getNetworkOutUsage(ctx, namespace, podName, podNames, container, start, now, step)
	if err != nil {
		return nil, fmt.Errorf("error querying pod Network outgoing usage: %w", err)
	}
	warnings = append(warnings, networkOutWarnings...)

	diskReadData, _, diskReadWarnings, err := c.getDiskReadUsage(ctx, namespace, podName, podNames, container, start, now, step)
	if err != nil {
		return nil, fmt.Errorf("error querying pod Disk read usage: %w", err)
	}
	warnings = append(warnings, diskReadWarnings...)

	diskWriteData, _, diskWriteWarnings, err := c.getDiskWriteUsage(ctx, namespace, podName, podNames, container, start, now, step)
	if err != nil {
		return nil, fmt.Errorf("error querying pod Disk write usage: %w", err)
	}
	warnings = append(warnings, diskWriteWarnings...)

	if len(cpuData) == 0 && len(memoryData) == 0 {
		return nil, fmt.Errorf("pod metrics are unavailable from Prometheus")
	}

	source := cpuSource
	if source == "" {
		source = memorySource
	}

	return &PodMetrics{
		CPU:               FillMissingDataPoints(start, step, cpuData),
		Memory:            FillMissingDataPoints(start, step, memoryData),
		CPUUtilization:    FillMissingDataPoints(start, step, cpuUtilizationData),
		MemoryUtilization: FillMissingDataPoints(start, step, memoryUtilizationData),
		NetworkIn:         FillMissingDataPoints(start, step, networkInData),
		NetworkOut:        FillMissingDataPoints(start, step, networkOutData),
		DiskRead:          FillMissingDataPoints(start, step, diskReadData),
		DiskWrite:         FillMissingDataPoints(start, step, diskWriteData),
		Fallback:          false,
		Source:            source,
		Warnings:          warnings,
	}, nil
}
