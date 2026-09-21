package prometheus

import (
	"context"
	"fmt"
	"net/http"
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
	Config(ctx context.Context) (v1.ConfigResult, error)
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
	CPU        []UsageDataPoint `json:"cpu"`
	Memory     []UsageDataPoint `json:"memory"`
	NetworkIn  []UsageDataPoint `json:"networkIn"`
	NetworkOut []UsageDataPoint `json:"networkOut"`
	DiskRead   []UsageDataPoint `json:"diskRead"`
	DiskWrite  []UsageDataPoint `json:"diskWrite"`
	Fallback   bool             `json:"fallback"`
	Source     string           `json:"source,omitempty"`
	Warnings   []string         `json:"warnings,omitempty"`
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
	query   string
	source  string
	warning string
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
			// Some cAdvisor scrape configurations preserve Kubernetes identity in
			// container_label_io_kubernetes_* labels. Retry the same query with
			// that label scheme before falling through to the next metric.
			if prefixed := prefixedWorkloadQuery(candidate.query); prefixed != candidate.query {
				if prefixedData, prefixedErr := c.queryRange(ctx, prefixed, start, end, step); prefixedErr == nil && len(prefixedData) > 0 {
					return prefixedData, candidate.source + "-container-labels", candidateWarnings(candidate), nil
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

func prefixedWorkloadQuery(query string) string {
	replacements := []struct{ old, new string }{
		{`container!="POD"`, `container_label_io_kubernetes_container_name!="POD"`},
		{`container!=""`, `container_label_io_kubernetes_container_name!=""`},
		{`container="`, `container_label_io_kubernetes_container_name="`},
		{`pod!=""`, `container_label_io_kubernetes_pod_name!=""`},
		{`pod=~"`, `container_label_io_kubernetes_pod_name=~"`},
		{`namespace="`, `container_label_io_kubernetes_pod_namespace="`},
	}
	result := query
	for _, replacement := range replacements {
		result = strings.ReplaceAll(result, replacement.old, replacement.new)
	}
	return result
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
			for _, sample := range matrix[0].Values {
				dataPoints = append(dataPoints, UsageDataPoint{
					Timestamp: sample.Timestamp.Time(),
					Value:     float64(sample.Value),
				})
			}
		}
	default:
		return nil, fmt.Errorf("unexpected result type: %s", result.Type())
	}

	return dataPoints, nil
}

// HealthCheck verifies if Prometheus is accessible
func (c *Client) HealthCheck(ctx context.Context) error {
	_, err := c.client.Config(ctx)
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

func (c *Client) getCPUUsage(ctx context.Context, namespace, podNamePrefix, container string, timeRange, step time.Duration) ([]UsageDataPoint, string, []string, error) {
	now := time.Now()
	start := now.Add(-timeRange)
	return c.queryRangeFirstAvailable(ctx, start, now, step,
		seriesCandidate{
			query:   fmt.Sprintf(`sum(rate(container_cpu_usage_seconds_total{%s}[1m]))`, joinMatchers(workloadMatchers(namespace, podNamePrefix, container, true))),
			source:  "prometheus-container",
			warning: "",
		},
		seriesCandidate{
			query:   fmt.Sprintf(`sum(rate(container_cpu_usage_seconds_total{%s}[1m]))`, joinMatchers(workloadMatchers(namespace, podNamePrefix, "", false))),
			source:  "prometheus-pod",
			warning: warningForCandidate("prometheus-container", "pod"),
		},
	)
}

func (c *Client) getMemoryUsage(ctx context.Context, namespace, podNamePrefix, container string, timeRange, step time.Duration) ([]UsageDataPoint, string, []string, error) {
	now := time.Now()
	start := now.Add(-timeRange)
	return c.queryRangeFirstAvailable(ctx, start, now, step,
		seriesCandidate{
			query:   fmt.Sprintf(`sum(container_memory_working_set_bytes{%s}) / 1024 / 1024`, joinMatchers(workloadMatchers(namespace, podNamePrefix, container, true))),
			source:  "prometheus-container",
			warning: "",
		},
		seriesCandidate{
			query:   fmt.Sprintf(`sum(container_memory_working_set_bytes{%s}) / 1024 / 1024`, joinMatchers(workloadMatchers(namespace, podNamePrefix, "", false))),
			source:  "prometheus-pod",
			warning: warningForCandidate("prometheus-container", "pod"),
		},
		seriesCandidate{
			query:   fmt.Sprintf(`sum(container_memory_usage_bytes{%s}) / 1024 / 1024`, joinMatchers(workloadMatchers(namespace, podNamePrefix, container, true))),
			source:  "prometheus-container",
			warning: "",
		},
		seriesCandidate{
			query:   fmt.Sprintf(`sum(container_memory_usage_bytes{%s}) / 1024 / 1024`, joinMatchers(workloadMatchers(namespace, podNamePrefix, "", false))),
			source:  "prometheus-pod",
			warning: warningForCandidate("prometheus-container", "pod"),
		},
	)
}

func (c *Client) getNetworkInUsage(ctx context.Context, namespace, podNamePrefix, container string, timeRange, step time.Duration) ([]UsageDataPoint, string, []string, error) {
	now := time.Now()
	start := now.Add(-timeRange)
	return c.queryRangeFirstAvailable(ctx, start, now, step,
		seriesCandidate{
			query:   fmt.Sprintf(`sum(rate(container_network_receive_bytes_total{%s}[1m]))`, joinMatchers(workloadMatchers(namespace, podNamePrefix, container, true))),
			source:  "prometheus-container",
			warning: "",
		},
		seriesCandidate{
			query:   fmt.Sprintf(`sum(rate(container_network_receive_bytes_total{%s}[1m]))`, joinMatchers(workloadMatchers(namespace, podNamePrefix, "", false))),
			source:  "prometheus-pod",
			warning: warningForCandidate("prometheus-container", "pod"),
		},
	)
}

func (c *Client) getNetworkOutUsage(ctx context.Context, namespace, podNamePrefix, container string, timeRange, step time.Duration) ([]UsageDataPoint, string, []string, error) {
	now := time.Now()
	start := now.Add(-timeRange)
	return c.queryRangeFirstAvailable(ctx, start, now, step,
		seriesCandidate{
			query:   fmt.Sprintf(`sum(rate(container_network_transmit_bytes_total{%s}[1m]))`, joinMatchers(workloadMatchers(namespace, podNamePrefix, container, true))),
			source:  "prometheus-container",
			warning: "",
		},
		seriesCandidate{
			query:   fmt.Sprintf(`sum(rate(container_network_transmit_bytes_total{%s}[1m]))`, joinMatchers(workloadMatchers(namespace, podNamePrefix, "", false))),
			source:  "prometheus-pod",
			warning: warningForCandidate("prometheus-container", "pod"),
		},
	)
}

func (c *Client) getDiskReadUsage(ctx context.Context, namespace, podNamePrefix, container string, timeRange, step time.Duration) ([]UsageDataPoint, string, []string, error) {
	now := time.Now()
	start := now.Add(-timeRange)
	return c.queryRangeFirstAvailable(ctx, start, now, step,
		seriesCandidate{
			query:   fmt.Sprintf(`sum(rate(container_fs_reads_bytes_total{%s}[1m]))`, joinMatchers(workloadMatchers(namespace, podNamePrefix, container, true))),
			source:  "prometheus-container",
			warning: "",
		},
		seriesCandidate{
			query:   fmt.Sprintf(`sum(rate(container_fs_reads_bytes_total{%s}[1m]))`, joinMatchers(workloadMatchers(namespace, podNamePrefix, "", false))),
			source:  "prometheus-pod",
			warning: warningForCandidate("prometheus-container", "pod"),
		},
	)
}

func (c *Client) getDiskWriteUsage(ctx context.Context, namespace, podNamePrefix, container string, timeRange, step time.Duration) ([]UsageDataPoint, string, []string, error) {
	now := time.Now()
	start := now.Add(-timeRange)
	return c.queryRangeFirstAvailable(ctx, start, now, step,
		seriesCandidate{
			query:   fmt.Sprintf(`sum(rate(container_fs_writes_bytes_total{%s}[1m]))`, joinMatchers(workloadMatchers(namespace, podNamePrefix, container, true))),
			source:  "prometheus-container",
			warning: "",
		},
		seriesCandidate{
			query:   fmt.Sprintf(`sum(rate(container_fs_writes_bytes_total{%s}[1m]))`, joinMatchers(workloadMatchers(namespace, podNamePrefix, "", false))),
			source:  "prometheus-pod",
			warning: warningForCandidate("prometheus-container", "pod"),
		},
	)
}

func FillMissingDataPoints(timeRange time.Duration, step time.Duration, existing []UsageDataPoint) []UsageDataPoint {
	if len(existing) == 0 {
		return existing
	}

	startTime := time.Now().Add(-timeRange)
	firstTime := existing[0].Timestamp

	if firstTime.Sub(startTime) <= step {
		return existing
	}

	result := []UsageDataPoint{}
	for t := startTime.Add(step); t.Before(firstTime); t = t.Add(step) {
		result = append(result, UsageDataPoint{
			Timestamp: t,
			Value:     0.0,
		})
	}

	return append(result, existing...)
}

// GetPodMetrics fetches metrics for a specific pod
func (c *Client) GetPodMetrics(ctx context.Context, namespace, podName, container string, duration string) (*PodMetrics, error) {
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

	var warnings []string
	cpuData, cpuSource, cpuWarnings, err := c.getCPUUsage(ctx, namespace, podName, container, timeRange, step)
	if err != nil {
		return nil, fmt.Errorf("error querying pod CPU usage: %w", err)
	}
	warnings = append(warnings, cpuWarnings...)

	memoryData, memorySource, memoryWarnings, err := c.getMemoryUsage(ctx, namespace, podName, container, timeRange, step)
	if err != nil {
		return nil, fmt.Errorf("error querying pod Memory usage: %w", err)
	}
	warnings = append(warnings, memoryWarnings...)

	networkInData, _, networkInWarnings, err := c.getNetworkInUsage(ctx, namespace, podName, container, timeRange, step)
	if err != nil {
		return nil, fmt.Errorf("error querying pod Network incoming usage: %w", err)
	}
	warnings = append(warnings, networkInWarnings...)

	networkOutData, _, networkOutWarnings, err := c.getNetworkOutUsage(ctx, namespace, podName, container, timeRange, step)
	if err != nil {
		return nil, fmt.Errorf("error querying pod Network outgoing usage: %w", err)
	}
	warnings = append(warnings, networkOutWarnings...)

	diskReadData, _, diskReadWarnings, err := c.getDiskReadUsage(ctx, namespace, podName, container, timeRange, step)
	if err != nil {
		return nil, fmt.Errorf("error querying pod Disk read usage: %w", err)
	}
	warnings = append(warnings, diskReadWarnings...)

	diskWriteData, _, diskWriteWarnings, err := c.getDiskWriteUsage(ctx, namespace, podName, container, timeRange, step)
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
		CPU:        FillMissingDataPoints(timeRange, step, cpuData),
		Memory:     FillMissingDataPoints(timeRange, step, memoryData),
		NetworkIn:  FillMissingDataPoints(timeRange, step, networkInData),
		NetworkOut: FillMissingDataPoints(timeRange, step, networkOutData),
		DiskRead:   FillMissingDataPoints(timeRange, step, diskReadData),
		DiskWrite:  FillMissingDataPoints(timeRange, step, diskWriteData),
		Fallback:   false,
		Source:     source,
		Warnings:   warnings,
	}, nil
}
