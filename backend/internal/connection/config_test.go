package connection

import "testing"

const sampleConfig = `apiVersion: v1
kind: Config
clusters:
- name: demo
  cluster:
    server: https://cluster.example
contexts:
- name: production
  context:
    cluster: demo
    user: user
    namespace: application
current-context: production
users:
- name: user
  user:
    token: private-token
`

func TestResolveDBXSecretsAndContext(t *testing.T) {
	r, err := Resolve(map[string]any{"connection": map[string]any{"id": "cluster-a", "external_config": map[string]any{"namespace": "override"}, "connection_secrets": map[string]any{"kubeconfig": sampleConfig}}})
	if err != nil {
		t.Fatal(err)
	}
	if r.ID != "cluster-a" || r.Namespace != "override" || r.ContextName != "production" || r.Config.BearerToken != "private-token" {
		t.Fatal("hydrated DBX payload not resolved correctly")
	}
}
func TestRejectUnknownContext(t *testing.T) {
	_, err := Resolve(map[string]any{"kubeconfig": sampleConfig, "context": "missing"})
	if err == nil {
		t.Fatal("expected missing context error")
	}
}
func TestResolveFlatKubeconfigWithoutAuthMode(t *testing.T) {
	r, err := Resolve(map[string]any{"kubeconfig": sampleConfig, "context": "production"})
	if err != nil {
		t.Fatal(err)
	}
	if r.Config.Host != "https://cluster.example" || r.ContextName != "production" {
		t.Fatalf("flat kubeconfig payload not resolved correctly: host=%s context=%s", r.Config.Host, r.ContextName)
	}
}
func TestCredentialsMustNotComeFromExternalConfig(t *testing.T) {
	_, err := Resolve(map[string]any{"connection": map[string]any{"external_config": map[string]any{"server": "https://example.com", "token": "secret"}}})
	if err == nil {
		t.Fatal("ordinary config must not contain credential fallback")
	}
}
func TestDirectTokenAndInvalidTLSKeyPair(t *testing.T) {
	r, err := Resolve(map[string]any{"server": "https://example.com", "token": "token"})
	if err != nil || r.Config.BearerToken != "token" {
		t.Fatal("token configuration failed", err)
	}
	_, err = Resolve(map[string]any{"server": "https://example.com", "client_cert": "certificate"})
	if err == nil {
		t.Fatal("expected incomplete key pair rejection")
	}
}

func TestPrometheusURLNormalizationAndValidation(t *testing.T) {
	r, err := Resolve(map[string]any{"server": "https://example.com", "token": "token", "prometheus_url": "http://localhost:30090/query"})
	if err != nil {
		t.Fatal(err)
	}
	if r.PrometheusURL != "http://localhost:30090" {
		t.Fatalf("expected Prometheus web path to normalize, got %q", r.PrometheusURL)
	}
	managedURL := "https://workspace.example.com/prometheus/workspace-123/aliyun-prom-abc"
	r, err = Resolve(map[string]any{"server": "https://example.com", "token": "token", "prometheus_url": managedURL})
	if err != nil {
		t.Fatalf("expected managed Prometheus path to be accepted: %v", err)
	}
	if r.PrometheusURL != managedURL {
		t.Fatalf("expected managed Prometheus path to be preserved, got %q", r.PrometheusURL)
	}
	for _, value := range []string{"ftp://prometheus:9090", "http://user:pass@prometheus:9090", "http://prometheus:9090/custom?tenant=demo", "http://prometheus:9090/custom#fragment"} {
		if _, err := Resolve(map[string]any{"server": "https://example.com", "token": "token", "prometheus_url": value}); err == nil {
			t.Fatalf("expected invalid Prometheus URL %q to be rejected", value)
		}
	}
}
