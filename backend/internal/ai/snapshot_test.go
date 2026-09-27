package ai

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/eryajf/dbx-plugin-k8s/internal/kube"
	"k8s.io/apimachinery/pkg/runtime"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	corefake "k8s.io/client-go/kubernetes/fake"
)

func TestSanitizeRemovesSecretAndConfigMapData(t *testing.T) {
	for _, kind := range []string{"Secret", "ConfigMap"} {
		clean := sanitize(map[string]any{
			"kind":     kind,
			"data":     map[string]any{"password": "hidden"},
			"metadata": map[string]any{"name": "demo"},
		}).(map[string]any)
		if clean["data"] != "[REDACTED]" {
			t.Fatalf("%s data was not redacted: %#v", kind, clean)
		}
	}
}

func TestSanitizeRedactsPodEnvironmentAndTextSecrets(t *testing.T) {
	clean := sanitize(map[string]any{
		"spec": map[string]any{"containers": []any{map[string]any{"env": []any{map[string]any{"name": "DB_PASSWORD", "value": "do-not-return"}}}}},
		"logs": "Bearer abc123 token=also-secret",
	}).(map[string]any)
	encoded, _ := json.Marshal(clean)
	text := string(encoded)
	if strings.Contains(text, "do-not-return") || strings.Contains(text, "abc123") || strings.Contains(text, "also-secret") {
		t.Fatalf("pod secrets were not redacted: %s", text)
	}
}

func TestFitDropsLargeCollections(t *testing.T) {
	large := strings.Repeat("x", maxSnapshotBytes)
	value := map[string]any{
		"schemaVersion": 1,
		"source":        "io.dbx.k8s",
		"capturedAt":    "now",
		"page":          map[string]any{"route": "/pods"},
		"cluster":       map[string]any{},
		"data":          map[string]any{"resources": large, "overview": map[string]any{"nodes": 1}},
		"warnings":      []string{},
	}
	_, truncated := fit(value)
	if !truncated {
		t.Fatal("large snapshot should be marked truncated")
	}
}

func TestSnapshotNormalizesTypedKubernetesResults(t *testing.T) {
	client := &kube.Client{
		Core:        corefake.NewSimpleClientset(),
		Dynamic:     dynamicfake.NewSimpleDynamicClient(runtime.NewScheme()),
		ContextName: "kind-demo",
		Namespace:   "default",
	}
	result, err := Snapshot(context.Background(), client, json.RawMessage(`{"connectionId":"cluster-a","page":{"route":"/"}}`))
	if err != nil {
		t.Fatal(err)
	}
	if result["source"] != "io.dbx.k8s" || result["truncated"] != false {
		t.Fatalf("unexpected snapshot: %#v", result)
	}
}
