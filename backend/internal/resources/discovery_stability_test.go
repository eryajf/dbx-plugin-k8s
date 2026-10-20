package resources

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/eryajf/dbx-plugin-k8s/internal/kube"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	"k8s.io/client-go/rest"
	ktesting "k8s.io/client-go/testing"
)

func TestSlowDiscoveryListSucceedsWhileSearchKeepsOwnBudget(t *testing.T) {
	entered, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api":
			fmt.Fprint(w, `{"kind":"APIVersions","apiVersion":"v1","versions":[]}`)
		case "/apis":
			fmt.Fprint(w, `{"kind":"APIGroupList","apiVersion":"v1","groups":[{"name":"example.com","preferredVersion":{"version":"v1","groupVersion":"example.com/v1"},"versions":[{"version":"v1","groupVersion":"example.com/v1"}]}]}`)
		case "/apis/example.com/v1":
			calls.Add(1)
			once.Do(func() { close(entered) })
			select {
			case <-release:
			case <-r.Context().Done():
				return
			}
			fmt.Fprint(w, `{"kind":"APIResourceList","apiVersion":"v1","groupVersion":"example.com/v1","resources":[{"name":"widgets","kind":"Widget","namespaced":true,"verbs":["list"]}]}`)
		default:
			t.Errorf("unexpected request path %s", r.URL.Path)
		}
	}))
	defer server.Close()
	c, err := kube.New(&rest.Config{Host: server.URL, QPS: -1}, "", "")
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	gvr := schema.GroupVersionResource{Group: "example.com", Version: "v1", Resource: "widgets"}
	c.Dynamic = dynamicfake.NewSimpleDynamicClientWithCustomListKinds(runtime.NewScheme(), map[schema.GroupVersionResource]string{gvr: "WidgetList"}, &unstructured.Unstructured{Object: map[string]any{"apiVersion": "example.com/v1", "kind": "Widget", "metadata": map[string]any{"name": "demo", "namespace": "default"}}})
	listDone := make(chan error, 1)
	started := time.Now()
	go func() {
		value, err := Handle(context.Background(), c, "resource/list", json.RawMessage(`{"group":"example.com","version":"v1","resource":"widgets","namespace":"default"}`))
		if err == nil && len(value.(*unstructured.UnstructuredList).Items) != 1 {
			err = fmt.Errorf("list lost widget")
		}
		listDone <- err
	}()
	<-entered
	// Ordinary discovery takes 2.2s, beyond the search deadline but within its
	// own 5s request timeout. The search waiter must not cancel the list waiter.
	timer := time.AfterFunc(2200*time.Millisecond, func() { close(release) })
	defer timer.Stop()
	searchStarted := time.Now()
	result, err := search(context.Background(), c, Request{Group: "example.com", Version: "v1", Resource: "widgets", Namespace: "default", Query: "demo"})
	if err != nil {
		t.Fatal(err)
	}
	if elapsed := time.Since(searchStarted); elapsed < 1800*time.Millisecond || elapsed > 2150*time.Millisecond {
		t.Fatalf("search elapsed=%v, want independent 2s budget", elapsed)
	}
	if !strings.Contains(strings.Join(result.(SearchResult).Warnings, " "), "timed out") {
		t.Fatalf("search did not report partial timeout: %+v", result)
	}
	if err := <-listDone; err != nil {
		t.Fatalf("ordinary 2.2s discovery list failed: %v", err)
	}
	if time.Since(started) < 2200*time.Millisecond || calls.Load() != 1 {
		t.Fatalf("elapsed=%v discovery calls=%d", time.Since(started), calls.Load())
	}
}

func TestResourceErrorsAreNotSwallowedOrWritesReplayed(t *testing.T) {
	for _, method := range []string{"resource/list", "resource/get", "resource/create", "resource/update", "resource/apply", "resource/patch", "resource/delete"} {
		t.Run(method, func(t *testing.T) {
			c := searchClient()
			defer c.Close()
			dyn := c.Dynamic.(*dynamicfake.FakeDynamicClient)
			var calls atomic.Int32
			dyn.PrependReactor("*", "pods", func(ktesting.Action) (bool, runtime.Object, error) {
				calls.Add(1)
				return true, nil, apierrors.NewServiceUnavailable("operation outcome unavailable")
			})
			_, err := Handle(context.Background(), c, method, json.RawMessage(`{"version":"v1","resource":"pods","namespace":"default","name":"demo","patch":{"metadata":{"labels":{"test":"value"}}},"object":{"apiVersion":"v1","kind":"Pod","metadata":{"name":"demo","namespace":"default","resourceVersion":"1"}}}`))
			if !apierrors.IsServiceUnavailable(err) || calls.Load() != 1 {
				t.Fatalf("operation error=%v, requests=%d; want original error and exactly one operation", err, calls.Load())
			}
		})
	}
}

func TestResolvePolicyUsesFreshMetadataForAllMethods(t *testing.T) {
	c := searchClient()
	defer c.Close()
	read, err := resolveWithPolicy(context.Background(), c, Request{Version: "v1", Resource: "pods"}, true)
	if err != nil {
		t.Fatal(err)
	}
	write, err := resolveWithPolicy(context.Background(), c, Request{Version: "v1", Resource: "pods"}, false)
	if err != nil || read.Kind != write.Kind || !write.Namespaced {
		t.Fatalf("resolve read=%+v write=%+v err=%v", read, write, err)
	}
	// Returned verbs must also belong to the caller, not the discovery cache.
	read.Verbs = append(read.Verbs, "mutated")
	again, err := resolveWithPolicy(context.Background(), c, Request{Version: "v1", Resource: "pods"}, true)
	if err != nil || strings.Contains(strings.Join(again.Verbs, " "), "mutated") {
		t.Fatalf("resolve mutated cache: %+v %v", again, err)
	}
}
