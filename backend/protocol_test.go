package main

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"testing"
	"strings"

	"github.com/eryajf/dbx-plugin-k8s/internal/connection"
	"github.com/eryajf/dbx-plugin-k8s/internal/kube"
	"github.com/eryajf/dbx-plugin-k8s/internal/resources"
	"github.com/eryajf/dbx-plugin-k8s/internal/sessions"
	dbx "github.com/t8y2/dbx/plugins/sdk/go/dbx-plugin-sdk"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	discoveryfake "k8s.io/client-go/discovery/fake"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	"k8s.io/client-go/kubernetes/fake"
	"k8s.io/client-go/rest"
	ktesting "k8s.io/client-go/testing"
)

func testPlugin(t *testing.T) *plugin {
	t.Helper()
	p := &plugin{connections: connection.New(), sessions: sessions.New()}
	p.favorites.path = filepath.Join(t.TempDir(), "favorites.json")
	core := fake.NewSimpleClientset()
	core.Discovery().(*discoveryfake.FakeDiscovery).Resources = []*metav1.APIResourceList{{GroupVersion: "v1", APIResources: []metav1.APIResource{{Name: "nodes", Kind: "Node"}, {Name: "pods", Kind: "Pod", Namespaced: true}}}}
	p.connections.Put("test", &kube.Client{Core: core, Dynamic: dynamicfake.NewSimpleDynamicClient(runtime.NewScheme()), Context: context.Background(), Config: &rest.Config{Host: "http://127.0.0.1:1"}})
	t.Cleanup(func() { p.sessions.Close(); p.connections.Close() })
	return p
}
func call(p *plugin, method, body string) (any, *dbx.PluginError) {
	return p.Handle(dbx.RequestContext{}, method, json.RawMessage(body), nil)
}
func TestProtocolRejectsInvalidRequests(t *testing.T) {
	p := testPlugin(t)
	for _, tt := range []struct {
		method, body string
		code         int
	}{
		{"resource/typo", `{}`, -32601}, {"pod/typo", `{}`, -32601},
		{"resource/list", `[]`, -32602}, {"resource/list", `{}`, -32602},
		{"connection/disconnect", `null`, -32602}, {"connection/disconnect", `{"connectionId":3}`, -32602},
		{"resource/list", `{"connectionId":"test","version":"v1","resource":"nodes","namespace":"default"}`, -32602},
		{"resource/get", `{"connectionId":"test","version":"v1","resource":"pods","name":"x"}`, -32602},
		{"node/drain", `{"connectionId":"test","name":"node","timeoutSeconds":3601}`, -32602},
		{"node/drain", `{"connectionId":"test","name":"node","timeoutSeconds":1.5}`, -32602},
	} {
		t.Run(tt.method+tt.body, func(t *testing.T) {
			_, err := call(p, tt.method, tt.body)
			if err == nil || err.Code != tt.code {
				t.Fatalf("got %#v, expected %d", err, tt.code)
			}
		})
	}
}
func TestClusterInfoRoute(t *testing.T) {
	p := testPlugin(t)
	out, err := call(p, "kube/cluster-info", `{"connectionId":"test"}`)
	if err != nil {
		t.Fatal(err)
	}
	info, ok := out.(*connection.Info)
	if !ok || !info.Success || info.ConnectionID != "test" {
		t.Fatalf("bad cluster info: %#v", out)
	}
}
func TestKubeSearchAlias(t *testing.T) {
	p := testPlugin(t)
	out, err := call(p, "kube/search", `{"connectionId":"test","query":"web"}`)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := out.(resources.SearchResult); !ok {
		t.Fatalf("unexpected search result: %#v", out)
	}
}
func TestWatchRoutesAndConnectionIsolation(t *testing.T) {
	p := testPlugin(t)
	out, err := call(p, "resource/watch", `{"connectionId":"test","version":"v1","resource":"pods","resourceVersion":"1"}`)
	if err != nil {
		t.Fatal(err)
	}
	id := out.(map[string]string)["sessionId"]
	body, _ := json.Marshal(map[string]string{"connectionId": "test", "sessionId": id})
	if _, err = call(p, "resource/watch-read", string(body)); err != nil {
		t.Fatal(err)
	}
	if _, err = call(p, "resource/watch-close", string(body)); err != nil {
		t.Fatal(err)
	}
	if _, err = call(p, "resource/watch-read", string(body)); err == nil {
		t.Fatal("closed session remained available")
	}
}
func TestClassifyKubernetesErrors(t *testing.T) {
	for _, tt := range []struct {
		err   error
		code  string
		retry bool
	}{
		{apierrors.NewForbidden(schema.GroupResource{Resource: "pods"}, "web", errors.New("denied")), "forbidden", false},
		{apierrors.NewConflict(schema.GroupResource{Resource: "pods"}, "web", errors.New("changed")), "conflict", false},
		{context.DeadlineExceeded, "timeout", true},
	} {
		got := classify(tt.err)
		data := got.Data.(map[string]any)
		if data["code"] != tt.code || data["retryable"] != tt.retry {
			t.Fatalf("bad classification: %#v", got)
		}
	}
}

func TestRPCPreservesForbiddenDetails(t *testing.T) {
	p := testPlugin(t)
	c, _ := p.connections.Get("test")
	c.Dynamic.(*dynamicfake.FakeDynamicClient).PrependReactor("get", "pods", func(ktesting.Action) (bool, runtime.Object, error) {
		return true, nil, apierrors.NewForbidden(schema.GroupResource{Resource: "pods"}, "web", errors.New("denied"))
	})
	_, err := call(p, "resource/get", `{"connectionId":"test","version":"v1","resource":"pods","namespace":"default","name":"web"}`)
	if err == nil {
		t.Fatal("expected forbidden")
	}
	data := err.Data.(map[string]any)
	for k, want := range map[string]any{"code": "forbidden", "resource": "pods", "verb": "get", "namespace": "default", "name": "web", "retryable": false} {
		if data[k] != want {
			t.Errorf("%s=%v, want %v", k, data[k], want)
		}
	}
}

func TestRecentEventsPublicRoute(t *testing.T) {
	p := testPlugin(t)
	out, err := call(p, "kube/recent-events", `{"connectionId":"test"}`)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := out.(map[string]any)["items"]; !ok {
		t.Fatalf("missing event list: %#v", out)
	}
}

func TestFileRoutesReachValidationWithoutSessionID(t *testing.T) {
	p := testPlugin(t)
	for _, method := range []string{"pod/file-read", "pod/file-write", "pod/file-delete"} {
		t.Run(method, func(t *testing.T) {
			_, err := call(p, method, `{"connectionId":"test","namespace":"default","name":"pod","path":"/"}`)
			if err == nil || !strings.Contains(err.Message, "absolute file path") {
				t.Fatalf("request did not reach file path validation: %#v", err)
			}
		})
	}
}
