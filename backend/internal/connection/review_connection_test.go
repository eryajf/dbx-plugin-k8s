package connection

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestReviewAuthMode(t *testing.T) {
	r, err := Resolve(map[string]any{"connection": map[string]any{"external_config": map[string]any{"auth_mode": "token", "server": "https://new.example"}, "connection_secrets": map[string]any{"kubeconfig": sampleConfig, "token": "new-token"}}})
	if err != nil {
		t.Fatal(err)
	}
	if r.Config.Host != "https://new.example" {
		t.Fatalf("selected token mode, got host %s", r.Config.Host)
	}
}
func TestReviewExecBoolean(t *testing.T) {
	cfg := strings.Replace(sampleConfig, "    token: private-token", "    exec:\n      apiVersion: client.authentication.k8s.io/v1beta1\n      command: review-command-never-executed", 1)
	_, err := Resolve(map[string]any{"connection": map[string]any{"external_config": map[string]any{"auth_mode": "kubeconfig", "allow_exec": true}, "connection_secrets": map[string]any{"kubeconfig": cfg}}})
	if err != nil {
		t.Fatalf("explicit boolean opt-in rejected: %v", err)
	}
}
func TestReviewChosenPath(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(path, []byte(strings.ReplaceAll(sampleConfig, "https://cluster.example", "https://selected-file.example")), 0600); err != nil {
		t.Fatal(err)
	}
	r, err := Resolve(map[string]any{"connection": map[string]any{"external_config": map[string]any{"auth_mode": "kubeconfig", "kubeconfig_path": path}, "connection_secrets": map[string]any{"kubeconfig": sampleConfig}}})
	if err != nil {
		t.Fatal(err)
	}
	if r.Config.Host != "https://selected-file.example" {
		t.Fatalf("selected new file, got host %s", r.Config.Host)
	}
}

func TestReviewRejectsUnknownAuthMode(t *testing.T) {
	_, err := Resolve(map[string]any{"connection": map[string]any{
		"external_config":    map[string]any{"auth_mode": "password", "server": "https://cluster.example"},
		"connection_secrets": map[string]any{"token": "token"},
	}})
	if err == nil {
		t.Fatal("expected unknown authentication mode to be rejected")
	}
}
