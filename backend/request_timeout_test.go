package main

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/eryajf/dbx-plugin-k8s/internal/connection"
	"github.com/eryajf/dbx-plugin-k8s/internal/kube"
	"github.com/eryajf/dbx-plugin-k8s/internal/sessions"
	"k8s.io/client-go/rest"
)

func TestResourceListRequestTimeoutValidation(t *testing.T) {
	p := testPlugin(t)
	for _, value := range []string{`0`, `-1`, `60001`, `1.5`, `"10"`, `null`} {
		_, err := call(p, "resource/list", `{"connectionId":"test","version":"v1","resource":"nodes","requestTimeoutMs":`+value+`}`)
		if err == nil || err.Code != -32602 {
			t.Fatalf("timeout %s: %#v", value, err)
		}
	}
}

func TestResourceListRequestTimeoutReachesKubernetes(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api":
			fmt.Fprint(w, `{"kind":"APIVersions","apiVersion":"v1","versions":["v1"]}`)
		case "/apis":
			fmt.Fprint(w, `{"kind":"APIGroupList","apiVersion":"v1","groups":[]}`)
		case "/api/v1":
			fmt.Fprint(w, `{"kind":"APIResourceList","apiVersion":"v1","groupVersion":"v1","resources":[{"name":"nodes","kind":"Node","namespaced":false,"verbs":["list"]}]}`)
		case "/api/v1/nodes":
			if strings.Contains(r.Header.Get("Accept"), "PartialObjectMetadata") {
				fmt.Fprint(w, `{"kind":"NodeList","apiVersion":"v1","metadata":{},"items":[]}`)
				return
			}
			<-r.Context().Done()
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	c, err := kube.New(&rest.Config{Host: server.URL}, "", "")
	if err != nil {
		t.Fatal(err)
	}
	p := &plugin{connections: connection.New(), sessions: sessions.New()}
	p.connections.Put("bounded", c)
	defer p.connections.Close()
	defer p.sessions.Close()
	start := time.Now()
	_, rpcErr := call(p, "resource/list", `{"connectionId":"bounded","version":"v1","resource":"nodes","requestTimeoutMs":50}`)
	if rpcErr == nil || rpcErr.Data.(map[string]any)["code"] != "timeout" {
		t.Fatalf("expected classified timeout: %#v", rpcErr)
	}
	if time.Since(start) > time.Second {
		t.Fatalf("read did not obey the explicit timeout: %s", time.Since(start))
	}
}
