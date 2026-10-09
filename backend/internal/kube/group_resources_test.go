package kube

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"k8s.io/client-go/rest"
)

func TestGroupResourcesCoalescesAndInvalidates(t *testing.T) {
	var calls atomic.Int32
	entered, release := make(chan struct{}), make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1" {
			t.Errorf("unexpected path %s", r.URL.Path)
		}
		if calls.Add(1) == 1 {
			close(entered)
			<-release
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"kind":"APIResourceList","apiVersion":"v1","groupVersion":"v1","resources":[{"name":"pods","kind":"Pod","namespaced":true}]}`)
	}))
	defer server.Close()
	c, err := New(&rest.Config{Host: server.URL}, "", "")
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	ctx, cancel := context.WithCancel(context.Background())
	first := make(chan error, 1)
	go func() { _, err := c.APIResourcesForGroupVersion(ctx, "v1"); first <- err }()
	<-entered
	cancel()
	if err := <-first; err != context.Canceled {
		t.Fatalf("cancel = %v", err)
	}
	var wg sync.WaitGroup
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			list, err := c.APIResourcesForGroupVersion(context.Background(), "v1")
			if err != nil {
				t.Error(err)
				return
			}
			if len(list.APIResources) != 1 {
				t.Errorf("resources = %v", list)
			}
			list.APIResources[0].Name = "local-mutation"
		}()
	}
	close(release)
	wg.Wait()
	if calls.Load() != 1 {
		t.Fatalf("calls = %d", calls.Load())
	}
	list, err := c.APIResourcesForGroupVersion(context.Background(), "v1")
	if err != nil || list.APIResources[0].Name != "pods" {
		t.Fatalf("cache mutated: %v %v", list, err)
	}
	c.InvalidateDiscoveryCache()
	if _, err := c.APIResourcesForGroupVersion(context.Background(), "v1"); err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 2 {
		t.Fatalf("calls after invalidation = %d", calls.Load())
	}
}

func TestGroupResourceFailureIsRetried(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if calls.Add(1) == 1 {
			http.Error(w, "unavailable", 403)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"kind":"APIResourceList","apiVersion":"v1","groupVersion":"v1","resources":[]}`)
	}))
	defer server.Close()
	c, err := New(&rest.Config{Host: server.URL}, "", "")
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if _, err := c.APIResourcesForGroupVersion(ctx, "v1"); err == nil {
		t.Fatal("expected discovery failure")
	}
	if _, err := c.APIResourcesForGroupVersion(ctx, "v1"); err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 2 {
		t.Fatalf("calls = %d", calls.Load())
	}
}
