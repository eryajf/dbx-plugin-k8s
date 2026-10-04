package kube_test

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/eryajf/dbx-plugin-k8s/internal/kube"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/apimachinery/pkg/watch"
	"k8s.io/client-go/discovery"
	discoveryfake "k8s.io/client-go/discovery/fake"
	"k8s.io/client-go/dynamic"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	kubernetesfake "k8s.io/client-go/kubernetes/fake"
	"k8s.io/client-go/rest"
	ktesting "k8s.io/client-go/testing"
)

// These tests exercise the connection-owned index through its public API. The
// fake API supplies List resourceVersions and independently controlled watches,
// so the assertions cover synchronization behavior rather than index internals.
type regressionWatchCall struct {
	gvr       schema.GroupVersionResource
	namespace string
	rv        string
	stream    *watch.RaceFreeFakeWatcher
}

type regressionListCall struct {
	gvr       schema.GroupVersionResource
	namespace string
}

type regressionAPI struct {
	client     *kube.Client
	mu         sync.Mutex
	lists      map[schema.GroupVersionResource]*unstructured.UnstructuredList
	listCalls  []regressionListCall
	watchError map[schema.GroupVersionResource]error
	watches    chan regressionWatchCall
}

func newRegressionAPI(t *testing.T, resources ...kube.SearchResource) *regressionAPI {
	t.Helper()
	core := kubernetesfake.NewSimpleClientset()
	listKinds := make(map[schema.GroupVersionResource]string)
	apiLists := make([]*metav1.APIResourceList, 0, len(resources))
	api := &regressionAPI{
		lists:      make(map[schema.GroupVersionResource]*unstructured.UnstructuredList),
		watchError: make(map[schema.GroupVersionResource]error),
		watches:    make(chan regressionWatchCall, 128),
	}
	for _, resource := range resources {
		gvr := schema.GroupVersionResource{Group: resource.Group, Version: resource.Version, Resource: resource.Resource}
		listKinds[gvr] = resource.Kind + "List"
		apiLists = append(apiLists, &metav1.APIResourceList{
			GroupVersion: gvr.GroupVersion().String(),
			APIResources: []metav1.APIResource{{Name: resource.Resource, Kind: resource.Kind, Namespaced: resource.Namespaced, Verbs: resource.Verbs}},
		})
		api.lists[gvr] = regressionList(gvr, resource.Kind, "10", regressionObject(gvr, resource.Kind, "existing-"+resource.Resource, "blue", "10"))
	}
	core.Discovery().(*discoveryfake.FakeDiscovery).Resources = apiLists
	dyn := dynamicfake.NewSimpleDynamicClientWithCustomListKinds(runtime.NewScheme(), listKinds)
	dyn.PrependReactor("list", "*", func(action ktesting.Action) (bool, runtime.Object, error) {
		api.mu.Lock()
		defer api.mu.Unlock()
		api.listCalls = append(api.listCalls, regressionListCall{action.GetResource(), action.GetNamespace()})
		list, exists := api.lists[action.GetResource()]
		if !exists {
			return true, nil, apierrors.NewNotFound(action.GetResource().GroupResource(), "")
		}
		result := list.DeepCopy()
		if namespace := action.GetNamespace(); namespace != "" {
			result.Items = nil
			for _, item := range list.Items {
				if item.GetNamespace() == namespace {
					result.Items = append(result.Items, *item.DeepCopy())
				}
			}
		}
		return true, result, nil
	})
	dyn.PrependWatchReactor("*", func(action ktesting.Action) (bool, watch.Interface, error) {
		api.mu.Lock()
		err := api.watchError[action.GetResource()]
		api.mu.Unlock()
		call := regressionWatchCall{gvr: action.GetResource(), namespace: action.GetNamespace(), rv: action.(ktesting.WatchAction).GetWatchRestrictions().ResourceVersion}
		if err == nil {
			call.stream = watch.NewRaceFreeFake()
		}
		select {
		case api.watches <- call:
		default:
		}
		return true, call.stream, err
	})
	api.client = &kube.Client{Core: core, Dynamic: dyn, Context: context.Background()}
	t.Cleanup(api.client.Close)
	return api
}

func regressionResource(name string) kube.SearchResource {
	return kube.SearchResource{Group: "search.example.com", Version: "v1", Resource: name, Kind: "Widget", Namespaced: true, Verbs: metav1.Verbs{"list", "watch"}}
}

func regressionGVR(resource kube.SearchResource) schema.GroupVersionResource {
	return schema.GroupVersionResource{Group: resource.Group, Version: resource.Version, Resource: resource.Resource}
}

func regressionObject(gvr schema.GroupVersionResource, kind, name, namespace, rv string) *unstructured.Unstructured {
	object := &unstructured.Unstructured{}
	object.SetAPIVersion(gvr.GroupVersion().String())
	object.SetKind(kind)
	object.SetName(name)
	object.SetNamespace(namespace)
	object.SetUID(types.UID(gvr.Group + "/" + gvr.Resource + "/" + namespace + "/" + name))
	object.SetResourceVersion(rv)
	return object
}

func regressionList(gvr schema.GroupVersionResource, kind, rv string, objects ...*unstructured.Unstructured) *unstructured.UnstructuredList {
	list := &unstructured.UnstructuredList{}
	list.SetAPIVersion(gvr.GroupVersion().String())
	list.SetKind(kind + "List")
	list.SetResourceVersion(rv)
	for _, object := range objects {
		list.Items = append(list.Items, *object.DeepCopy())
	}
	return list
}

func (api *regressionAPI) setList(gvr schema.GroupVersionResource, list *unstructured.UnstructuredList) {
	api.mu.Lock()
	defer api.mu.Unlock()
	api.lists[gvr] = list.DeepCopy()
}

func (api *regressionAPI) calls() []regressionListCall {
	api.mu.Lock()
	defer api.mu.Unlock()
	return append([]regressionListCall(nil), api.listCalls...)
}

func regressionEventually(t *testing.T, description string, condition func() bool) {
	t.Helper()
	deadline := time.NewTimer(5 * time.Second)
	defer deadline.Stop()
	tick := time.NewTicker(5 * time.Millisecond)
	defer tick.Stop()
	for {
		if condition() {
			return
		}
		select {
		case <-deadline.C:
			t.Fatalf("timed out waiting for %s", description)
		case <-tick.C:
		}
	}
}

func regressionNextWatch(t *testing.T, api *regressionAPI) regressionWatchCall {
	t.Helper()
	select {
	case call := <-api.watches:
		return call
	case <-time.After(5 * time.Second):
		t.Fatalf("watch was not opened; query state: %+v", api.client.SearchIndex().Query(kube.SearchQuery{Query: "existing"}))
		return regressionWatchCall{}
	}
}

func TestSearchIndexRegressionWatchesEveryDiscoveredResource(t *testing.T) {
	resources := make([]kube.SearchResource, 12)
	for i := range resources {
		resources[i] = regressionResource(fmt.Sprintf("widgets%02d", i))
	}
	api := newRegressionAPI(t, resources...)
	api.client.StartSearchIndex()
	watches := make(map[schema.GroupVersionResource]regressionWatchCall)
	for range resources {
		call := regressionNextWatch(t, api)
		if call.stream == nil || call.rv != "10" || call.namespace != "" {
			t.Fatalf("initial watch = %+v; want all namespaces and List RV 10", call)
		}
		if _, duplicate := watches[call.gvr]; duplicate {
			t.Fatalf("duplicate watch before all resource types were started: %s", call.gvr)
		}
		watches[call.gvr] = call
	}
	for _, resource := range resources {
		gvr := regressionGVR(resource)
		call, found := watches[gvr]
		if !found {
			t.Fatalf("resource %s has no watch", gvr)
		}
		call.stream.Add(regressionObject(gvr, resource.Kind, "watch-only-"+resource.Resource, "green", "11"))
	}
	regressionEventually(t, "watch updates from all 12 resource types", func() bool {
		result := api.client.SearchIndex().Query(kube.SearchQuery{Query: "watch-only", Limit: 20})
		return result.Complete && result.Total == len(resources)
	})
	if calls := api.calls(); len(calls) != len(resources) {
		t.Fatalf("List calls = %+v; want exactly the 12 discovered resource types", calls)
	}
}

func TestSearchIndexRegressionResumesWatchAndRelistsAfterExpiration(t *testing.T) {
	resource := regressionResource("widgets")
	gvr := regressionGVR(resource)
	api := newRegressionAPI(t, resource)
	api.client.StartSearchIndex()
	first := regressionNextWatch(t, api)
	if first.rv != "10" || first.stream == nil {
		t.Fatalf("first watch = %+v; want the List resourceVersion", first)
	}
	updated := regressionObject(gvr, resource.Kind, "existing-widgets", "blue", "11")
	updated.SetLabels(map[string]string{"phase": "updated"})
	first.stream.Modify(updated)
	regressionEventually(t, "modified metadata to be searchable", func() bool {
		return api.client.SearchIndex().Query(kube.SearchQuery{Query: "updated"}).Total == 1
	})
	first.stream.Stop()
	second := regressionNextWatch(t, api)
	if second.rv != "11" || second.stream == nil {
		t.Fatalf("reconnected watch = %+v; want last event resourceVersion 11", second)
	}
	if calls := api.calls(); len(calls) != 1 {
		t.Fatalf("ordinary disconnect caused a relist: %+v", calls)
	}
	api.setList(gvr, regressionList(gvr, resource.Kind, "20", regressionObject(gvr, resource.Kind, "recovered-widget", "blue", "20")))
	second.stream.Error(&metav1.Status{Status: metav1.StatusFailure, Code: http.StatusGone, Reason: metav1.StatusReasonExpired, Message: "resourceVersion expired"})
	third := regressionNextWatch(t, api)
	if third.rv != "20" || third.stream == nil {
		t.Fatalf("watch after 410 = %+v; want fresh List resourceVersion 20", third)
	}
	regressionEventually(t, "relisted data to replace the expired snapshot", func() bool {
		result := api.client.SearchIndex().Query(kube.SearchQuery{Query: "recovered"})
		return result.Complete && result.Total == 1 && api.client.SearchIndex().Query(kube.SearchQuery{Query: "existing"}).Total == 0
	})
	if calls := api.calls(); len(calls) != 2 {
		t.Fatalf("List calls after watch expiration = %+v; want initial List and one relist", calls)
	}
	third.stream.Add(regressionObject(gvr, resource.Kind, "post-recovery", "green", "21"))
	regressionEventually(t, "watch events after relisting", func() bool {
		return api.client.SearchIndex().Query(kube.SearchQuery{Query: "post-recovery"}).Total == 1
	})
}

func TestSearchIndexRegressionForbiddenWatchPreservesSnapshot(t *testing.T) {
	resource := regressionResource("widgets")
	gvr := regressionGVR(resource)
	api := newRegressionAPI(t, resource)
	api.watchError[gvr] = apierrors.NewForbidden(gvr.GroupResource(), "", fmt.Errorf("watch is denied"))
	api.client.StartSearchIndex()
	regressionNextWatch(t, api)
	regressionEventually(t, "watch denial to report incomplete searchable data", func() bool {
		result := api.client.SearchIndex().Query(kube.SearchQuery{Query: "existing"})
		return result.Total == 1 && !result.Complete && strings.Contains(strings.ToLower(strings.Join(result.Warnings, " ")), "forbidden")
	})
	result := api.client.SearchIndex().Query(kube.SearchQuery{Query: "existing"})
	if result.Items[0].Name != "existing-widgets" {
		t.Fatalf("watch failure discarded or replaced listed data: %+v", result)
	}
	api.client.InvalidateSearchIndex(gvr, "")
	regressionEventually(t, "watch warning to survive a successful shard refresh", func() bool {
		result := api.client.SearchIndex().Query(kube.SearchQuery{Query: "existing"})
		return !result.Complete && strings.Contains(strings.ToLower(strings.Join(result.Warnings, " ")), "forbidden")
	})
}

func TestSearchIndexRegressionMutationRefreshesOnlyAffectedResource(t *testing.T) {
	resource := regressionResource("widgets")
	other := regressionResource("gadgets")
	gvr := regressionGVR(resource)
	api := newRegressionAPI(t, resource, other)
	api.setList(gvr, regressionList(gvr, resource.Kind, "10",
		regressionObject(gvr, resource.Kind, "old-widget", "blue", "10"),
		regressionObject(gvr, resource.Kind, "untouched-widget", "green", "10")))
	api.client.StartSearchIndex()
	regressionNextWatch(t, api)
	regressionNextWatch(t, api)
	regressionEventually(t, "initial ready snapshot", func() bool {
		return api.client.SearchIndex().Query(kube.SearchQuery{}).Complete
	})
	api.setList(gvr, regressionList(gvr, resource.Kind, "20",
		regressionObject(gvr, resource.Kind, "new-widget", "blue", "20"),
		regressionObject(gvr, resource.Kind, "untouched-widget", "green", "10")))
	api.client.InvalidateSearchIndex(gvr, "blue")
	regressionEventually(t, "mutated resource to be refreshed", func() bool {
		return api.client.SearchIndex().Query(kube.SearchQuery{Query: "new-widget", Namespace: "blue"}).Total == 1
	})
	if result := api.client.SearchIndex().Query(kube.SearchQuery{Query: "old-widget"}); result.Total != 0 {
		t.Fatalf("stale resource survived mutation refresh: %+v", result.Items)
	}
	if result := api.client.SearchIndex().Query(kube.SearchQuery{Query: "untouched-widget", Namespace: "green"}); result.Total != 1 {
		t.Fatalf("refresh lost another namespace: %+v", result.Items)
	}
	calls := api.calls()
	otherLists, changedLists := 0, 0
	for _, call := range calls {
		if call.gvr == regressionGVR(other) {
			otherLists++
		}
		if call.gvr == gvr {
			changedLists++
		}
	}
	if otherLists != 1 || changedLists != 2 {
		t.Fatalf("mutation refreshed unrelated resources: %+v; want target=2, other=1", calls)
	}
}

type regressionRoundTripper func(*http.Request) (*http.Response, error)

func (f regressionRoundTripper) RoundTrip(request *http.Request) (*http.Response, error) {
	return f(request)
}

func TestSearchIndexRegressionCloseStopsWatchesAndRequests(t *testing.T) {
	t.Run("watch", func(t *testing.T) {
		api := newRegressionAPI(t, regressionResource("widgets"), regressionResource("gadgets"))
		api.client.StartSearchIndex()
		first, second := regressionNextWatch(t, api), regressionNextWatch(t, api)
		api.client.Close()
		regressionEventually(t, "all active watches to stop", func() bool {
			return first.stream.IsStopped() && second.stream.IsStopped()
		})
	})
	t.Run("in-flight-list", func(t *testing.T) {
		api := newRegressionAPI(t, regressionResource("widgets"))
		started, canceled := make(chan struct{}), make(chan struct{})
		var startOnce, cancelOnce sync.Once
		transport := regressionRoundTripper(func(request *http.Request) (*http.Response, error) {
			startOnce.Do(func() { close(started) })
			<-request.Context().Done()
			cancelOnce.Do(func() { close(canceled) })
			return nil, request.Context().Err()
		})
		dyn, err := dynamic.NewForConfigAndClient(&rest.Config{Host: "https://search.test", QPS: -1}, &http.Client{Transport: transport})
		if err != nil {
			t.Fatal(err)
		}
		api.client.Dynamic = dyn
		api.client.StartSearchIndex()
		select {
		case <-started:
		case <-time.After(5 * time.Second):
			t.Fatal("initial List did not start")
		}
		api.client.Close()
		select {
		case <-canceled:
		case <-time.After(5 * time.Second):
			t.Fatal("Close did not cancel the in-flight List request")
		}
	})
}

func TestSearchIndexRegressionUsesDiscoveryPreferredVersion(t *testing.T) {
	v1 := regressionResource("widgets")
	v2 := v1
	v2.Version = "v2"
	api := newRegressionAPI(t, v1, v2)
	for _, resource := range []kube.SearchResource{v1, v2} {
		gvr := regressionGVR(resource)
		object := regressionObject(gvr, resource.Kind, "shared-widget", "blue", "10")
		object.SetUID(types.UID("shared-widget-uid"))
		api.setList(gvr, regressionList(gvr, resource.Kind, "10", object))
	}
	// Use real discovery decoding with an in-memory HTTP transport: the API
	// group's preferred version intentionally differs from lexical v1 order.
	transport := regressionRoundTripper(func(request *http.Request) (*http.Response, error) {
		var value any
		switch request.URL.Path {
		case "/api":
			value = metav1.APIVersions{TypeMeta: metav1.TypeMeta{APIVersion: "v1", Kind: "APIVersions"}, Versions: []string{}}
		case "/apis":
			value = metav1.APIGroupList{TypeMeta: metav1.TypeMeta{APIVersion: "v1", Kind: "APIGroupList"}, Groups: []metav1.APIGroup{{
				Name:             v1.Group,
				Versions:         []metav1.GroupVersionForDiscovery{{GroupVersion: v1.Group + "/v1", Version: "v1"}, {GroupVersion: v1.Group + "/v2", Version: "v2"}},
				PreferredVersion: metav1.GroupVersionForDiscovery{GroupVersion: v1.Group + "/v2", Version: "v2"},
			}}}
		case "/apis/" + v1.Group + "/v1", "/apis/" + v1.Group + "/v2":
			value = metav1.APIResourceList{TypeMeta: metav1.TypeMeta{APIVersion: "v1", Kind: "APIResourceList"}, GroupVersion: strings.TrimPrefix(request.URL.Path, "/apis/"), APIResources: []metav1.APIResource{{Name: "widgets", Kind: "Widget", Namespaced: true, Verbs: metav1.Verbs{"list", "watch"}}}}
		default:
			return nil, fmt.Errorf("unexpected discovery request: %s", request.URL.Path)
		}
		body, err := json.Marshal(value)
		if err != nil {
			return nil, err
		}
		return &http.Response{StatusCode: http.StatusOK, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(string(body))), Request: request}, nil
	})
	discoveryClient, err := discovery.NewDiscoveryClientForConfigAndClient(&rest.Config{Host: "https://search.test", QPS: -1}, &http.Client{Transport: transport})
	if err != nil {
		t.Fatal(err)
	}
	api.client.Discovery = discoveryClient
	api.client.StartSearchIndex()
	watches := make(map[string]regressionWatchCall)
	for range 2 {
		call := regressionNextWatch(t, api)
		watches[call.gvr.Version] = call
	}
	regressionEventually(t, "one result in the discovery preferred version", func() bool {
		result := api.client.SearchIndex().Query(kube.SearchQuery{Query: "shared-widget"})
		return result.Complete && result.Total == 1 && len(result.Items) == 1 && result.Items[0].Version == "v2"
	})
	updated := regressionObject(regressionGVR(v1), v1.Kind, "shared-widget", "blue", "11")
	updated.SetUID(types.UID("shared-widget-uid"))
	watches["v1"].stream.Modify(updated)
	// Closing after the event gives a public synchronization point: the next
	// Watch must resume at RV 11, so the modification has been consumed.
	watches["v1"].stream.Stop()
	reconnected := regressionNextWatch(t, api)
	if reconnected.gvr != regressionGVR(v1) || reconnected.rv != "11" {
		t.Fatalf("nonpreferred watch did not consume the update: %+v", reconnected)
	}
	result := api.client.SearchIndex().Query(kube.SearchQuery{Query: "shared-widget"})
	if result.Total != 1 || len(result.Items) != 1 || result.Items[0].Version != "v2" {
		t.Fatalf("nonpreferred watch displaced the preferred resource: %+v", result.Items)
	}
}
