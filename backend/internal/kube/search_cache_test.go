package kube

import (
	"context"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	discoveryfake "k8s.io/client-go/discovery/fake"
	"k8s.io/client-go/dynamic/fake"
	kubernetesfake "k8s.io/client-go/kubernetes/fake"
	ktesting "k8s.io/client-go/testing"
)

var searchCacheTestGVR = schema.GroupVersionResource{Group: "apps", Version: "v1", Resource: "deployments"}

func testSearchClient(objects ...runtime.Object) (*Client, *fake.FakeDynamicClient) {
	dynamic := fake.NewSimpleDynamicClientWithCustomListKinds(runtime.NewScheme(), map[schema.GroupVersionResource]string{
		searchCacheTestGVR: "DeploymentList",
	}, objects...)
	return &Client{Dynamic: dynamic, Context: context.Background()}, dynamic
}

func testSearchDeployment(name, namespace string) *unstructured.Unstructured {
	return &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "apps/v1", "kind": "Deployment",
		"metadata": map[string]any{"name": name, "namespace": namespace, "labels": map[string]any{"app": "api"}},
	}}
}

func TestSearchResourceListCachesAndDeepCopies(t *testing.T) {
	client, dynamic := testSearchClient(testSearchDeployment("api", "default"))
	options := metav1.ListOptions{LabelSelector: "app=api"}
	first, hit, err := client.SearchResourceList(context.Background(), searchCacheTestGVR, "default", options)
	if err != nil || hit || len(first.Items) != 1 {
		t.Fatalf("first search = hit %t, err %v, items %d", hit, err, len(first.Items))
	}
	first.Items[0].SetName("mutated")
	second, hit, err := client.SearchResourceList(context.Background(), searchCacheTestGVR, "default", options)
	if err != nil || !hit || second.Items[0].GetName() != "api" {
		t.Fatalf("cached search = hit %t, err %v, name %q", hit, err, second.Items[0].GetName())
	}
	if got := len(dynamic.Actions()); got != 1 {
		t.Fatalf("List calls = %d, want 1", got)
	}
}

func TestSearchResourceListMergesConcurrentRequests(t *testing.T) {
	client, dynamic := testSearchClient(testSearchDeployment("api", "default"))
	const callers = 8
	start := make(chan struct{})
	var wg sync.WaitGroup
	results := make([]*unstructured.UnstructuredList, callers)
	errs := make([]error, callers)
	hits := make([]bool, callers)
	for i := 0; i < callers; i++ {
		wg.Add(1)
		go func(index int) {
			defer wg.Done()
			<-start
			results[index], hits[index], errs[index] = client.SearchResourceList(context.Background(), searchCacheTestGVR, "default", metav1.ListOptions{})
		}(i)
	}
	close(start)
	wg.Wait()
	for i := range results {
		if errs[i] != nil || results[i] == nil || len(results[i].Items) != 1 {
			t.Fatalf("caller %d = hit %t, err %v, result %#v", i, hits[i], errs[i], results[i])
		}
	}
	if got := len(dynamic.Actions()); got != 1 {
		t.Fatalf("concurrent List calls = %d, want 1", got)
	}
}

func TestSearchResourceListExpires(t *testing.T) {
	client, dynamic := testSearchClient(testSearchDeployment("api", "default"))
	cache := client.searchResourceCache()
	cache.ttl = time.Millisecond
	if _, _, err := client.SearchResourceList(context.Background(), searchCacheTestGVR, "default", metav1.ListOptions{}); err != nil {
		t.Fatal(err)
	}
	time.Sleep(5 * time.Millisecond)
	if _, hit, err := client.SearchResourceList(context.Background(), searchCacheTestGVR, "default", metav1.ListOptions{}); err != nil || hit {
		t.Fatalf("expired search = hit %t, err %v", hit, err)
	}
	if got := len(dynamic.Actions()); got != 2 {
		t.Fatalf("expired List calls = %d, want 2", got)
	}
}

func TestSearchResourceListSecretsBypassCache(t *testing.T) {
	gvr := schema.GroupVersionResource{Group: "", Version: "v1", Resource: "secrets"}
	client, dynamic := testSearchClient()
	// The fake client needs the secret list kind for this separate GVR.
	dynamic = fake.NewSimpleDynamicClientWithCustomListKinds(runtime.NewScheme(), map[schema.GroupVersionResource]string{gvr: "SecretList"})
	client.Dynamic = dynamic
	for i := 0; i < 2; i++ {
		if _, hit, err := client.SearchResourceList(context.Background(), gvr, "default", metav1.ListOptions{}); err != nil || hit {
			t.Fatalf("secret search %d = hit %t, err %v", i, hit, err)
		}
	}
	if got := len(dynamic.Actions()); got != 2 {
		t.Fatalf("secret List calls = %d, want 2", got)
	}
}

func TestSearchResourceListContextCancellation(t *testing.T) {
	client, _ := testSearchClient(testSearchDeployment("api", "default"))
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, _, err := client.SearchResourceList(ctx, searchCacheTestGVR, "default", metav1.ListOptions{}); err != context.Canceled {
		t.Fatalf("cancelled search error = %v, want context.Canceled", err)
	}
}

func TestSearchResourceListCachesShortLivedListErrors(t *testing.T) {
	client, dynamic := testSearchClient()
	dynamic.PrependReactor("list", "deployments", func(ktesting.Action) (bool, runtime.Object, error) {
		return true, nil, fmt.Errorf("resource unavailable")
	})
	for i := 0; i < 2; i++ {
		if _, hit, err := client.SearchResourceList(context.Background(), searchCacheTestGVR, "default", metav1.ListOptions{}); err == nil || (i == 0 && hit) || (i == 1 && !hit) {
			t.Fatalf("error search %d = hit %t, err %v", i, hit, err)
		}
	}
	if got := len(dynamic.Actions()); got != 1 {
		t.Fatalf("cached error List calls = %d, want 1", got)
	}
}

func TestInvalidateSearchResourceCacheRefreshesNextSearch(t *testing.T) {
	client, dynamic := testSearchClient(testSearchDeployment("api", "default"))
	if _, _, err := client.SearchResourceList(context.Background(), searchCacheTestGVR, "default", metav1.ListOptions{}); err != nil {
		t.Fatal(err)
	}
	client.InvalidateSearchResourceCache()
	if _, hit, err := client.SearchResourceList(context.Background(), searchCacheTestGVR, "default", metav1.ListOptions{}); err != nil || hit {
		t.Fatalf("after invalidation = hit %t, err %v", hit, err)
	}
	if got := len(dynamic.Actions()); got != 2 {
		t.Fatalf("List calls after invalidation = %d, want 2", got)
	}
}

func TestClearSearchResourceCacheClosesSnapshot(t *testing.T) {
	client, _ := testSearchClient(testSearchDeployment("api", "default"))
	if _, _, err := client.SearchResourceList(context.Background(), searchCacheTestGVR, "default", metav1.ListOptions{}); err != nil {
		t.Fatal(err)
	}
	client.ClearSearchResourceCache()
	if _, _, err := client.SearchResourceList(context.Background(), searchCacheTestGVR, "default", metav1.ListOptions{}); err != context.Canceled {
		t.Fatalf("closed cache error = %v, want context.Canceled", err)
	}
}

func TestCachedDiscoveryRetriesAfterFailure(t *testing.T) {
	core := kubernetesfake.NewSimpleClientset()
	discoveryClient := core.Discovery().(*discoveryfake.FakeDiscovery)
	discoveryClient.Resources = []*metav1.APIResourceList{{
		GroupVersion: "invalid/group/version",
	}}
	client := &Client{Core: core, Dynamic: fake.NewSimpleDynamicClient(runtime.NewScheme())}
	defer client.Close()

	if _, err, hit := client.CachedAPIResourceLists(); err == nil || hit {
		t.Fatalf("first discovery = err %v, hit %t; want an uncached failure", err, hit)
	}
	discoveryClient.Resources = []*metav1.APIResourceList{{
		GroupVersion: "v1",
		APIResources: []metav1.APIResource{{Name: "pods", Kind: "Pod", Namespaced: true}},
	}}
	if _, err, hit := client.CachedAPIResourceLists(); err != nil || hit {
		t.Fatalf("recovered discovery = err %v, hit %t; want a fresh successful lookup", err, hit)
	}
}

func TestInvalidateDiscoveryCacheDoesNotPublishInFlightResult(t *testing.T) {
	core := kubernetesfake.NewSimpleClientset()
	discoveryClient := core.Discovery().(*discoveryfake.FakeDiscovery)
	oldResources := []*metav1.APIResourceList{{
		GroupVersion: "v1",
		APIResources: []metav1.APIResource{{Name: "pods", Kind: "Pod", Namespaced: true}},
	}}
	newResources := []*metav1.APIResourceList{{
		GroupVersion: "apps/v1",
		APIResources: []metav1.APIResource{{Name: "deployments", Kind: "Deployment", Namespaced: true}},
	}}
	discoveryClient.Resources = oldResources
	started := make(chan struct{})
	release := make(chan struct{})
	var calls atomic.Int32
	discoveryClient.PrependReactor("get", "resource", func(ktesting.Action) (bool, runtime.Object, error) {
		if calls.Add(1) == 1 {
			close(started)
			<-release
		}
		return false, nil, nil
	})
	client := &Client{Core: core, Dynamic: fake.NewSimpleDynamicClient(runtime.NewScheme())}
	defer client.Close()

	first := make(chan error, 1)
	go func() {
		_, err, _ := client.CachedAPIResourceListsContext(context.Background())
		first <- err
	}()
	<-started

	client.InvalidateDiscoveryCache()
	close(release)
	if err := <-first; err != nil {
		t.Fatalf("first discovery = %v", err)
	}

	discoveryClient.Resources = newResources
	lists, err, hit := client.CachedAPIResourceListsContext(context.Background())
	if err != nil || hit {
		t.Fatalf("post-invalidation discovery = hit %t, err %v; want a fresh lookup", hit, err)
	}
	if len(lists) != 1 || lists[0].GroupVersion != "apps/v1" {
		t.Fatalf("post-invalidation resources = %#v, want apps/v1", lists)
	}
	if got := calls.Load(); got != 2 {
		t.Fatalf("discovery calls = %d, want 2", got)
	}
}
