package connection

import (
	"io"
	"k8s.io/client-go/rest"
	"net/http"
	"strings"
	"testing"
)

type recordingPrometheusTransport struct{ request *http.Request }

func (t *recordingPrometheusTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	t.request = r
	return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader("")), Request: r}, nil
}
func TestPrometheusServiceProxyAuthentication(t *testing.T) {
	for _, address := range []string{"http://prom.monitoring.svc:9090", "http://prom.monitoring.svc.cluster.local:9090"} {
		base := &recordingPrometheusTransport{}
		cfg := &rest.Config{Host: "https://kubernetes.example", BearerToken: "kubernetes-token", Transport: base}
		if _, err := prometheusTransport(cfg, address, http.Header{"Authorization": {"Basic other-credentials"}}); err == nil {
			t.Fatal("expected incompatible authentication to be rejected")
		}
		rt, err := prometheusTransport(cfg, address, http.Header{"Instanceid": {"tenant"}})
		if err != nil {
			t.Fatal(err)
		}
		req, _ := http.NewRequest(http.MethodGet, address+"/api/v1/query", nil)
		req.Header.Set("instanceId", "tenant")
		res, err := rt.RoundTrip(req)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		if base.request.URL.Host != "kubernetes.example" || base.request.Header.Get("Authorization") != "Bearer kubernetes-token" || base.request.Header.Get("instanceId") != "tenant" {
			t.Fatal("service proxy did not preserve Kubernetes authentication and tenant header")
		}
	}
	if _, err := prometheusTransport(&rest.Config{}, "https://prom.example", http.Header{"Authorization": {"Basic credentials"}}); err != nil {
		t.Fatal(err)
	}
}
