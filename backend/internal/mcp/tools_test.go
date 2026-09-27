package mcp

import (
	"strings"
	"testing"

	"github.com/eryajf/dbx-plugin-k8s/internal/kube"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	discoveryfake "k8s.io/client-go/discovery/fake"
	corefake "k8s.io/client-go/kubernetes/fake"
)

func TestToolsExposeReadOnlyAndMutationAnnotations(t *testing.T) {
	response := Tools()
	items, ok := response["tools"].([]any)
	if !ok || len(items) < 20 {
		t.Fatalf("expected MCP tool list, got %#v", response)
	}
	seen := map[string]map[string]any{}
	for _, item := range items {
		tool := item.(map[string]any)
		seen[tool["name"].(string)] = tool["annotations"].(map[string]any)
	}
	if seen["get_resource"]["readOnlyHint"] != true {
		t.Fatal("get_resource must be read-only")
	}
	if seen["delete_resource"]["readOnlyHint"] != false || seen["delete_resource"]["destructiveHint"] != true {
		t.Fatal("delete_resource must require mutation confirmation")
	}
	if seen["drain_node"]["destructiveHint"] != true {
		t.Fatal("drain_node must be marked destructive")
	}
}

func TestBoundedJSONRedactsSensitiveFields(t *testing.T) {
	text, truncated := boundedJSON(map[string]any{
		"kind":     "Secret",
		"data":     map[string]any{"token": "do-not-return"},
		"metadata": map[string]any{"name": "demo"},
	})
	if truncated || strings.Contains(text, "do-not-return") || !strings.Contains(text, "REDACTED") {
		t.Fatalf("sensitive value was not redacted: truncated=%v text=%s", truncated, text)
	}
}

func TestBoundedJSONRedactsPodEnvironmentAndLogSecrets(t *testing.T) {
	text, truncated := boundedJSON(map[string]any{
		"spec": map[string]any{"containers": []any{map[string]any{"env": []any{map[string]any{"name": "DB_PASSWORD", "value": "do-not-return"}}}}},
		"logs": "Authorization: Bearer abc123 password=also-secret",
	})
	if truncated || strings.Contains(text, "do-not-return") || strings.Contains(text, "abc123") || strings.Contains(text, "also-secret") {
		t.Fatalf("pod secrets were not redacted: truncated=%v text=%s", truncated, text)
	}
}

func TestClusterScopedResourcesDoNotInheritConnectionNamespace(t *testing.T) {
	core := corefake.NewSimpleClientset()
	core.Discovery().(*discoveryfake.FakeDiscovery).Resources = []*metav1.APIResourceList{{
		GroupVersion: "v1",
		APIResources: []metav1.APIResource{
			{Name: "nodes", Namespaced: false},
			{Name: "pods", Namespaced: true},
		},
	}}
	client := &kube.Client{Core: core, Namespace: "default"}
	if defaultsToNamespace("resource/list", client, map[string]any{"version": "v1", "resource": "nodes"}) {
		t.Fatal("cluster-scoped nodes must not inherit a namespace")
	}
	if !defaultsToNamespace("resource/list", client, map[string]any{"version": "v1", "resource": "pods"}) {
		t.Fatal("namespaced pods should inherit the connection namespace")
	}
}

func TestCallRejectsUnknownTool(t *testing.T) {
	result, err := Call(nil, nil, []byte(`{"tool":"unknown"}`), nil)
	if err != nil || result["isError"] != true || !strings.Contains(resultText(result), "unknown MCP tool") {
		t.Fatalf("expected MCP tool error result, got result=%v err=%v", result, err)
	}
}

func TestCallRejectsMalformedArguments(t *testing.T) {
	result, err := Call(nil, nil, []byte(`{"tool":"get_resource","arguments":[]}`))
	if err != nil || result["isError"] != true || !strings.Contains(resultText(result), "arguments must be a JSON object") {
		t.Fatalf("expected MCP tool error result, got result=%v err=%v", result, err)
	}
}

func resultText(result map[string]any) string {
	content, _ := result["content"].([]any)
	if len(content) == 0 {
		return ""
	}
	item, _ := content[0].(map[string]any)
	text, _ := item["text"].(string)
	return text
}
