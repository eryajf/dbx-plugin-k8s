package kube

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/watch"
	discoveryfake "k8s.io/client-go/discovery/fake"
	"k8s.io/client-go/dynamic/fake"
	kubernetesfake "k8s.io/client-go/kubernetes/fake"
)

func TestSearchIndexPersistenceRequiresConnectionIdentity(t *testing.T) {
	client := &Client{}
	if key := client.searchIndexPersistenceKey(); key != "" {
		t.Fatalf("anonymous client persistence key = %q; want no shared disk cache", key)
	}
	index := client.SearchIndex()
	if index.store != nil {
		t.Fatal("anonymous client must not restore or persist another client's snapshot")
	}
	client.SetSearchIndexPersistenceKey("connection-a")
	if index.store == nil {
		t.Fatal("identified connection must retain persistence support")
	}
	first := index.store.key
	client.SetSearchIndexPersistenceKey("connection-b")
	if index.store == nil || index.store.key == first {
		t.Fatal("different connections must have separate snapshots")
	}
}

func TestSearchIndexMatchesAllTokensAndMetadataOnly(t *testing.T) {
	core := kubernetesfake.NewSimpleClientset()
	core.Discovery().(*discoveryfake.FakeDiscovery).Resources = []*metav1.APIResourceList{
		{GroupVersion: "v1", APIResources: []metav1.APIResource{{Name: "pods", Kind: "Pod", Namespaced: true, Verbs: []string{"list"}}}},
	}
	gvr := schema.GroupVersionResource{Version: "v1", Resource: "pods"}
	pod := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "v1", "kind": "Pod",
		"metadata": map[string]any{"name": "api-server", "namespace": "platform", "labels": map[string]any{"team": "control-plane"}, "uid": "pod-1"},
		"data":     map[string]any{"shouldNotBeIndexed": "secret-value"},
	}}
	listKinds := map[schema.GroupVersionResource]string{gvr: "PodList"}
	for _, resource := range stableSearchResources {
		gvr := schema.GroupVersionResource{Group: resource.Group, Version: resource.Version, Resource: resource.Resource}
		listKinds[gvr] = resource.Kind + "List"
	}
	dynamic := fake.NewSimpleDynamicClientWithCustomListKinds(runtime.NewScheme(), listKinds, pod)
	client := &Client{Core: core, Dynamic: dynamic}
	index := client.SearchIndex()
	if err := index.rebuild(context.Background()); err != nil {
		t.Fatal(err)
	}
	result := index.Query(SearchQuery{Query: "api server", Limit: 10})
	if !result.Complete || result.Status != SearchIndexReady {
		t.Fatalf("index status = %q complete=%t warnings=%v", result.Status, result.Complete, result.Warnings)
	}
	if result.Total != 1 || result.Items[0].Name != "api-server" {
		t.Fatalf("query result = %#v", result.Items)
	}
	if result.Items[0].UID != "pod-1" || result.Items[0].Labels["team"] != "control-plane" {
		t.Fatalf("metadata was not retained: %#v", result.Items[0])
	}
}

func TestSearchIndexPrioritizesCommonResourceKinds(t *testing.T) {
	resources := []string{"endpoints", "services", "pods", "deployments"}
	candidates := make([]searchCandidate, 0, len(resources))
	for _, resource := range resources {
		candidates = append(candidates, searchCandidate{
			entry: SearchEntry{
				ID:        "v1/" + resource + "/default/agent-q",
				Resource:  resource,
				Name:      "agent-q",
				Namespace: "default",
			},
			score: 0,
		})
	}
	sort.SliceStable(candidates, func(i, j int) bool {
		return searchCandidateBetter(candidates[i], candidates[j])
	})

	want := []string{"deployments", "pods", "services", "endpoints"}
	for i, candidate := range candidates {
		if candidate.entry.Resource != want[i] {
			t.Fatalf("result %d = %q, want %q", i, candidate.entry.Resource, want[i])
		}
	}
}

func TestSearchIndexWatchExpiredRequestsRelist(t *testing.T) {
	index := newSearchIndex(&Client{})
	stream := watch.NewFake()
	done := make(chan watchOutcome, 1)
	go func() {
		outcome, _ := index.consumeWatch(context.Background(), schema.GroupVersionResource{Version: "v1", Resource: "pods"}, "Pod", stream)
		done <- outcome
	}()
	stream.Error(&metav1.Status{Status: "Failure", Reason: metav1.StatusReasonExpired})
	select {
	case outcome := <-done:
		if outcome != watchRelist {
			t.Fatalf("watch outcome = %v, want relist", outcome)
		}
	case <-time.After(time.Second):
		t.Fatal("expired watch did not return")
	}
}

func TestSearchIndexMatchesSingleCharacterAndFullGVR(t *testing.T) {
	core := kubernetesfake.NewSimpleClientset()
	core.Discovery().(*discoveryfake.FakeDiscovery).Resources = []*metav1.APIResourceList{
		{GroupVersion: "example.com/v1", APIResources: []metav1.APIResource{{Name: "widgets", Kind: "Widget", Namespaced: true, Verbs: []string{"list"}}}},
		{GroupVersion: "example.com/v2", APIResources: []metav1.APIResource{{Name: "widgets", Kind: "Widget", Namespaced: true, Verbs: []string{"list"}}}},
	}
	gvrV1 := schema.GroupVersionResource{Group: "example.com", Version: "v1", Resource: "widgets"}
	gvrV2 := schema.GroupVersionResource{Group: "example.com", Version: "v2", Resource: "widgets"}
	widgetV1 := &unstructured.Unstructured{Object: map[string]any{"apiVersion": "example.com/v1", "kind": "Widget", "metadata": map[string]any{"name": "alpha", "namespace": "ns"}}}
	widgetV2 := &unstructured.Unstructured{Object: map[string]any{"apiVersion": "example.com/v2", "kind": "Widget", "metadata": map[string]any{"name": "beta", "namespace": "ns"}}}
	dynamic := fake.NewSimpleDynamicClientWithCustomListKinds(runtime.NewScheme(), map[schema.GroupVersionResource]string{gvrV1: "WidgetList", gvrV2: "WidgetList"}, widgetV1, widgetV2)
	client := &Client{Core: core, Dynamic: dynamic}
	index := client.SearchIndex()
	if err := index.rebuild(context.Background()); err != nil {
		t.Fatal(err)
	}
	result := index.Query(SearchQuery{Query: "b", Resource: "widgets", Limit: 10})
	if result.Total != 1 || result.Items[0].Version != "v2" {
		t.Fatalf("single-character/full-GVR result = %#v", result.Items)
	}
	result = index.Query(SearchQuery{Query: "widgets.example.com", Limit: 10})
	if result.Total != 2 {
		t.Fatalf("resource type token result = %#v", result.Items)
	}
}

func TestSearchIndexPersistsAndRestoresMetadataSnapshot(t *testing.T) {
	core := kubernetesfake.NewSimpleClientset()
	core.Discovery().(*discoveryfake.FakeDiscovery).Resources = []*metav1.APIResourceList{
		{GroupVersion: "v1", APIResources: []metav1.APIResource{{Name: "pods", Kind: "Pod", Namespaced: true, Verbs: []string{"list"}}}},
	}
	gvr := schema.GroupVersionResource{Version: "v1", Resource: "pods"}
	pod := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "v1",
		"kind":       "Pod",
		"metadata": map[string]any{
			"name": "cached-api-server", "namespace": "platform", "uid": "pod-cache",
			"labels": map[string]any{"team": "control-plane"},
		},
		"data": map[string]any{"credential": "must-not-persist"},
	}}
	dynamic := fake.NewSimpleDynamicClientWithCustomListKinds(runtime.NewScheme(), map[schema.GroupVersionResource]string{gvr: "PodList"}, pod)
	store := &searchIndexStore{path: filepath.Join(t.TempDir(), "search-index.json"), key: "test-key"}
	client := &Client{Core: core, Dynamic: dynamic}
	index := newSearchIndex(client)
	index.store = store
	if err := index.rebuild(context.Background()); err != nil {
		t.Fatal(err)
	}

	data, err := os.ReadFile(store.path)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), "must-not-persist") || strings.Contains(string(data), "credential") {
		t.Fatalf("persisted index contains object data: %s", data)
	}
	if err := os.Remove(store.path); err != nil {
		t.Fatal(err)
	}
	index.Close()
	if _, err := os.Stat(store.path); err != nil {
		t.Fatalf("close did not persist the latest snapshot: %v", err)
	}

	restored := newSearchIndex(&Client{Core: core, Dynamic: dynamic})
	restored.store = store
	ok, err := restored.restorePersistedSnapshot()
	if err != nil || !ok {
		t.Fatalf("restore = ok=%t err=%v", ok, err)
	}
	result := restored.Query(SearchQuery{Query: "cached-api", Limit: 10})
	if !result.Usable || result.Complete || !result.Syncing || result.Total != 1 {
		t.Fatalf("restored query = usable=%t complete=%t syncing=%t total=%d warnings=%v", result.Usable, result.Complete, result.Syncing, result.Total, result.Warnings)
	}
	if result.Items[0].Labels["team"] != "control-plane" {
		t.Fatalf("restored metadata lost labels: %#v", result.Items[0])
	}
	needsRebuild, err := restored.resumePersistedSnapshot(context.Background(), false)
	if err != nil || needsRebuild {
		t.Fatalf("persisted snapshot resume = rebuild=%t err=%v", needsRebuild, err)
	}
	result = restored.Query(SearchQuery{Query: "cached-api", Limit: 10})
	if !result.Complete || result.Syncing {
		t.Fatalf("resumed query = complete=%t syncing=%t warnings=%v", result.Complete, result.Syncing, result.Warnings)
	}
}

func TestSearchIndexPersistenceValidationFailureIsDegradedNotSyncing(t *testing.T) {
	index := newSearchIndex(&Client{})
	index.snapshotLoaded = true
	index.status = SearchIndexReady
	index.stale = true

	index.recordPersistenceWarning(fmt.Errorf("discovery forbidden"))
	result := index.Query(SearchQuery{Query: "anything", Limit: 10})
	if result.Syncing {
		t.Fatal("persistence validation failure must not be reported as active syncing")
	}
	if result.Status != SearchIndexDegraded || result.Complete {
		t.Fatalf("degraded persistence result = status=%q complete=%t warnings=%v", result.Status, result.Complete, result.Warnings)
	}
	if len(result.Warnings) != 1 || result.Warnings[0] != "discovery forbidden" {
		t.Fatalf("persistence warning = %v", result.Warnings)
	}
}
