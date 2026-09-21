package prometheus

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	v1 "github.com/prometheus/client_golang/api/prometheus/v1"
	"github.com/prometheus/common/model"
)

type healthCheckAPI struct {
	query     string
	queryTime time.Time
	err       error
}

func (a *healthCheckAPI) Query(_ context.Context, query string, ts time.Time, _ ...v1.Option) (model.Value, v1.Warnings, error) {
	a.query = query
	a.queryTime = ts
	return model.Vector{}, nil, a.err
}

func (a *healthCheckAPI) QueryRange(context.Context, string, v1.Range, ...v1.Option) (model.Value, v1.Warnings, error) {
	return nil, nil, errors.New("QueryRange must not be called by HealthCheck")
}

func TestHealthCheckUsesPrometheusQueryAPI(t *testing.T) {
	api := &healthCheckAPI{}
	before := time.Now()
	err := (&Client{client: api}).HealthCheck(context.Background())
	after := time.Now()

	if err != nil {
		t.Fatalf("HealthCheck returned unexpected error: %v", err)
	}
	if api.query != "vector(1)" {
		t.Fatalf("HealthCheck query = %q, want vector(1)", api.query)
	}
	if api.queryTime.Before(before) || api.queryTime.After(after) {
		t.Fatalf("HealthCheck query time %s is outside the call interval", api.queryTime)
	}
}

func TestHealthCheckReturnsQueryError(t *testing.T) {
	want := errors.New("query is forbidden")
	err := (&Client{client: &healthCheckAPI{err: want}}).HealthCheck(context.Background())
	if !errors.Is(err, want) {
		t.Fatalf("HealthCheck error = %v, want %v", err, want)
	}
}

type rangeRecordingAPI struct {
	ranges  []v1.Range
	queries []string
}

func (a *rangeRecordingAPI) Query(context.Context, string, time.Time, ...v1.Option) (model.Value, v1.Warnings, error) {
	return model.Vector{}, nil, nil
}

func (a *rangeRecordingAPI) QueryRange(_ context.Context, query string, r v1.Range, _ ...v1.Option) (model.Value, v1.Warnings, error) {
	a.ranges = append(a.ranges, r)
	a.queries = append(a.queries, query)
	return model.Matrix{&model.SampleStream{
		Values: []model.SamplePair{{Timestamp: model.Time(r.Start.UnixMilli()), Value: 1}},
	}}, nil, nil
}

func TestPodMetricsUseOneQueryWindowForAllSeries(t *testing.T) {
	for _, tc := range []struct {
		duration  string
		wantRange time.Duration
		wantStep  time.Duration
	}{
		{duration: "3h", wantRange: 3 * time.Hour, wantStep: 2 * time.Minute},
		{duration: "6h", wantRange: 6 * time.Hour, wantStep: 3 * time.Minute},
		{duration: "12h", wantRange: 12 * time.Hour, wantStep: 5 * time.Minute},
	} {
		t.Run(tc.duration, func(t *testing.T) {
			api := &rangeRecordingAPI{}
			_, err := (&Client{client: api}).GetPodMetrics(context.Background(), "default", "demo", nil, "", tc.duration)
			if err != nil {
				t.Fatalf("GetPodMetrics returned unexpected error: %v", err)
			}
			if len(api.ranges) != 8 {
				t.Fatalf("QueryRange calls = %d, want 8", len(api.ranges))
			}
			first := api.ranges[0]
			if first.End.Sub(first.Start) != tc.wantRange || first.Step != tc.wantStep {
				t.Fatalf("first range = %s/%s, want %s/%s", first.End.Sub(first.Start), first.Step, tc.wantRange, tc.wantStep)
			}
			for i, r := range api.ranges[1:] {
				if !r.Start.Equal(first.Start) || !r.End.Equal(first.End) || r.Step != first.Step {
					t.Fatalf("range %d = %+v, want %+v", i+1, r, first)
				}
			}
			if !strings.Contains(api.queries[2], "kube_pod_container_resource_limits") || !strings.Contains(api.queries[2], "kube_pod_container_resource_requests") {
				t.Fatalf("CPU utilization query does not use limit/request metrics: %q", api.queries[2])
			}
			if !strings.Contains(api.queries[2], "kube_pod_container_resource_limits_cpu_cores") || !strings.Contains(api.queries[2], "kube_pod_container_resource_requests_cpu_cores") {
				t.Fatalf("CPU utilization query does not support legacy resource metrics: %q", api.queries[2])
			}
			if !strings.Contains(api.queries[3], "kube_pod_container_resource_limits") || !strings.Contains(api.queries[3], "kube_pod_container_resource_requests") {
				t.Fatalf("memory utilization query does not use limit/request metrics: %q", api.queries[3])
			}
			if !strings.Contains(api.queries[3], "kube_pod_container_resource_limits_memory_bytes") || !strings.Contains(api.queries[3], "kube_pod_container_resource_requests_memory_bytes") {
				t.Fatalf("memory utilization query does not support legacy resource metrics: %q", api.queries[3])
			}
		})
	}
}

func TestQueryRangeKeepsAllPodContainerSeries(t *testing.T) {
	api := &rangeRecordingAPI{}
	apiResult := model.Matrix{
		&model.SampleStream{
			Metric: model.Metric{"pod": "api-7c8cc44d68-abc12", "container": "app"},
			Values: []model.SamplePair{{Timestamp: 1, Value: 0.2}},
		},
		&model.SampleStream{
			Metric: model.Metric{"pod": "api-7c8cc44d68-def34", "container": "app"},
			Values: []model.SamplePair{{Timestamp: 1, Value: 0.3}},
		},
	}
	client := &Client{client: &rangeAPIWithResult{rangeRecordingAPI: api, result: apiResult}}
	points, err := client.queryRange(context.Background(), "vector(1)", time.Unix(0, 0), time.Unix(1, 0), time.Minute)
	if err != nil {
		t.Fatalf("queryRange returned unexpected error: %v", err)
	}
	if len(points) != 2 {
		t.Fatalf("queryRange returned %d points, want 2", len(points))
	}
	if points[0].Series != "api-7c8cc44d68-abc12/app" || points[1].Series != "api-7c8cc44d68-def34/app" {
		t.Fatalf("series = %#v, want Pod/container names", points)
	}
}

func TestPodMetricsUseExactSelectedPodNames(t *testing.T) {
	api := &rangeRecordingAPI{}
	_, err := (&Client{client: api}).GetPodMetrics(
		context.Background(),
		"ops",
		"ops-whoami",
		[]string{"ops-whoami-f65856dfd-gn9q9", "ops-whoami-f65856dfd-zq4dd"},
		"",
		"30m",
	)
	if err != nil {
		t.Fatalf("GetPodMetrics returned unexpected error: %v", err)
	}
	for _, query := range api.queries {
		if !strings.Contains(query, `pod=~"^(ops-whoami-f65856dfd-gn9q9|ops-whoami-f65856dfd-zq4dd)$"`) {
			t.Fatalf("query does not use the exact selected Pods: %q", query)
		}
		if strings.Contains(query, `pod=~"ops-whoami.*"`) {
			t.Fatalf("query used a workload-name prefix instead of selected Pods: %q", query)
		}
	}
}

type legacyFallbackAPI struct {
	queries []string
}

func (a *legacyFallbackAPI) Query(context.Context, string, time.Time, ...v1.Option) (model.Value, v1.Warnings, error) {
	return model.Vector{}, nil, nil
}

func (a *legacyFallbackAPI) QueryRange(_ context.Context, query string, _ v1.Range, _ ...v1.Option) (model.Value, v1.Warnings, error) {
	a.queries = append(a.queries, query)
	if !strings.Contains(query, legacyPodLabel) {
		return model.Matrix{}, nil, nil
	}
	return model.Matrix{
		&model.SampleStream{Metric: model.Metric{"pod": "api-abc12", "container": "app"}, Values: []model.SamplePair{{Timestamp: 1, Value: 0.2}}},
		&model.SampleStream{Metric: model.Metric{"pod": "api-def34", "container": "app"}, Values: []model.SamplePair{{Timestamp: 1, Value: 0.3}}},
	}, nil, nil
}

func TestLegacyCAdvisorFallbackKeepsPodContainerSeries(t *testing.T) {
	api := &legacyFallbackAPI{}
	client := &Client{client: api}
	start := time.Unix(0, 0)
	points, source, _, err := client.getCPUUsage(
		context.Background(),
		"default",
		"api",
		[]string{"api-abc12", "api-def34"},
		"",
		start,
		start.Add(time.Minute),
		time.Minute,
	)
	if err != nil {
		t.Fatalf("getCPUUsage returned unexpected error: %v", err)
	}
	if source != "prometheus-container-container-labels" {
		t.Fatalf("source = %q, want legacy container source", source)
	}
	if len(points) != 2 || points[0].Series != "api-abc12/app" || points[1].Series != "api-def34/app" {
		t.Fatalf("points = %#v, want separate Pod/container series", points)
	}
	if len(api.queries) != 2 || !strings.Contains(api.queries[1], `sum by (container_label_io_kubernetes_pod_name, container_label_io_kubernetes_container_name)`) {
		t.Fatalf("legacy query did not aggregate by legacy Pod/container labels: %#v", api.queries)
	}
}

func TestLegacyCAdvisorUtilizationKeepsKubeStateMetricsLabels(t *testing.T) {
	api := &legacyFallbackAPI{}
	client := &Client{client: api}
	start := time.Unix(0, 0)
	_, _, _, err := client.getCPUUtilization(
		context.Background(),
		"default",
		"api",
		[]string{"api-abc12", "api-def34"},
		"",
		start,
		start.Add(time.Minute),
		time.Minute,
	)
	if err != nil {
		t.Fatalf("getCPUUtilization returned unexpected error: %v", err)
	}
	if len(api.queries) != 2 {
		t.Fatalf("QueryRange calls = %d, want 2", len(api.queries))
	}
	legacyQuery := api.queries[1]
	if !strings.Contains(legacyQuery, `on(pod, container)`) || !strings.Contains(legacyQuery, `kube_pod_container_resource_limits{resource="cpu",container!="POD",container!=""`) {
		t.Fatalf("legacy utilization query does not join legacy usage with standard kube-state-metrics labels: %q", legacyQuery)
	}
}

type rangeAPIWithResult struct {
	*rangeRecordingAPI
	result model.Matrix
}

func (a *rangeAPIWithResult) QueryRange(_ context.Context, query string, r v1.Range, _ ...v1.Option) (model.Value, v1.Warnings, error) {
	a.ranges = append(a.ranges, r)
	a.queries = append(a.queries, query)
	return a.result, nil, nil
}
