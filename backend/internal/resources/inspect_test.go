package resources

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/eryajf/dbx-plugin-k8s/internal/kube"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	discoveryfake "k8s.io/client-go/discovery/fake"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/dynamic/fake"
	kubernetesfake "k8s.io/client-go/kubernetes/fake"
	"k8s.io/client-go/rest"
	ktesting "k8s.io/client-go/testing"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return f(request)
}

func searchClient(objects ...runtime.Object) *kube.Client {
	core := kubernetesfake.NewSimpleClientset()
	core.Discovery().(*discoveryfake.FakeDiscovery).Resources = []*metav1.APIResourceList{{
		GroupVersion: "v1",
		APIResources: []metav1.APIResource{{Name: "pods", Kind: "Pod", Namespaced: true, Verbs: []string{"list"}}},
	}}
	scheme := runtime.NewScheme()
	listKinds := make(map[schema.GroupVersionResource]string)
	for _, resource := range builtInSearchResources {
		listKinds[schema.GroupVersionResource{Group: resource.Group, Version: resource.Version, Resource: resource.Resource}] = resource.Kind + "List"
	}
	dynamic := fake.NewSimpleDynamicClientWithCustomListKinds(scheme, listKinds, objects...)
	return &kube.Client{Core: core, Dynamic: dynamic}
}

func pod(name, namespace string, labels map[string]string) *unstructured.Unstructured {
	jsonLabels := make(map[string]any, len(labels))
	for key, value := range labels {
		jsonLabels[key] = value
	}
	return &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "v1",
		"kind":       "Pod",
		"metadata": map[string]any{
			"name":      name,
			"namespace": namespace,
			"labels":    jsonLabels,
		},
	}}
}

func TestSearchRanksNameBeforeNamespaceAndLabels(t *testing.T) {
	client := searchClient(
		pod("web", "default", nil),
		pod("web-api", "default", nil),
		pod("worker", "web", nil),
		pod("worker", "default", map[string]string{"app": "web"}),
	)
	defer client.Close()

	value, err := search(context.Background(), client, Request{Query: "web", Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	result := value.(SearchResult)
	if len(result.Items) != 4 {
		t.Fatalf("got %d results, want 4: %#v", len(result.Items), result.Items)
	}
	want := []struct{ name, namespace string }{
		{"web", "default"},
		{"web-api", "default"},
		{"worker", "web"},
		{"worker", "default"},
	}
	for i, item := range result.Items {
		if item["name"] != want[i].name || item["namespace"] != want[i].namespace {
			t.Fatalf("result %d = %#v, want %v", i, item, want[i])
		}
	}
}

func TestSearchFindsCoreDeploymentWithoutDiscoveryCatalog(t *testing.T) {
	deployment := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "apps/v1",
		"kind":       "Deployment",
		"metadata": map[string]any{
			"name":      "api-server",
			"namespace": "default",
		},
	}}
	client := searchClient(deployment)
	client.Core.Discovery().(*discoveryfake.FakeDiscovery).Resources = nil
	defer client.Close()

	value, err := search(context.Background(), client, Request{Query: "api-server", Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	result := value.(SearchResult)
	if len(result.Items) != 1 || result.Items[0]["resource"] != "deployments" {
		t.Fatalf("got %#v, want one deployment result", result.Items)
	}
}

func TestSearchExactDeploymentUsesServerSelectorAndAlias(t *testing.T) {
	deployment := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "apps/v1",
		"kind":       "Deployment",
		"metadata": map[string]any{
			"name":      "api-server",
			"namespace": "default",
		},
	}}
	client := searchClient(deployment)
	defer client.Close()

	value, err := search(context.Background(), client, Request{Query: "deployment api-server", FieldSelector: "metadata.namespace=default", Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	result := value.(SearchResult)
	if len(result.Items) != 1 || result.Items[0]["resource"] != "deployments" {
		t.Fatalf("got %#v, want one deployment result", result.Items)
	}

	var deploymentList bool
	for _, action := range client.Dynamic.(*fake.FakeDynamicClient).Actions() {
		list, ok := action.(ktesting.ListAction)
		if !ok || list.GetResource().Resource != "deployments" {
			continue
		}
		deploymentList = true
		if got := list.GetListRestrictions().Fields.String(); got != "metadata.name=api-server,metadata.namespace=default" {
			t.Fatalf("deployment field selector = %q", got)
		}
	}
	if !deploymentList {
		t.Fatal("exact search did not list deployments")
	}
}

func TestSearchMatchesPartialDeploymentNameAcrossListPages(t *testing.T) {
	firstPageObject := unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "apps/v1",
		"kind":       "Deployment",
		"metadata": map[string]any{
			"name":      "other-deployment",
			"namespace": "default",
		},
	}}
	target := unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "apps/v1",
		"kind":       "Deployment",
		"metadata": map[string]any{
			"name":      "akamai-check-deployment",
			"namespace": "default",
		},
	}}
	var requests []*http.Request
	transport := roundTripFunc(func(request *http.Request) (*http.Response, error) {
		requests = append(requests, request.Clone(request.Context()))
		page := len(requests)
		list := map[string]any{
			"apiVersion": "apps/v1",
			"kind":       "DeploymentList",
			"metadata":   map[string]any{},
		}
		if page == 1 {
			list["metadata"] = map[string]any{"continue": "page-2"}
			list["items"] = []unstructured.Unstructured{firstPageObject}
		} else {
			list["items"] = []unstructured.Unstructured{target}
		}
		body, err := json.Marshal(list)
		if err != nil {
			return nil, err
		}
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     make(http.Header),
			Body:       io.NopCloser(strings.NewReader(string(body))),
			Request:    request,
		}, nil
	})
	dynamicClient, err := dynamic.NewForConfigAndClient(&rest.Config{Host: "https://kube.test"}, &http.Client{Transport: transport})
	if err != nil {
		t.Fatal(err)
	}
	client := &kube.Client{Dynamic: dynamicClient}
	defer client.Close()

	value, err := searchCatalogWithTimeout(context.Background(), client, Request{Query: "akamai", Namespace: "default", Limit: 10}, &Discovery{Resources: []Resource{{Group: "apps", Version: "v1", Resource: "deployments", Kind: "Deployment", Namespaced: true, Verbs: metav1.Verbs{"list"}}}}, false, time.Now(), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	result := value.(SearchResult)
	if len(result.Items) != 1 || result.Items[0]["name"] != "akamai-check-deployment" {
		t.Fatalf("got %#v, want the deployment from the second page", result.Items)
	}
	if len(requests) != 2 {
		t.Fatalf("List requests = %d, want 2", len(requests))
	}
	if got := requests[0].URL.Query().Get("limit"); got != "500" {
		t.Fatalf("first page limit = %q, want 500", got)
	}
	if got := requests[0].URL.Query().Get("continue"); got != "" {
		t.Fatalf("first page continue = %q, want empty", got)
	}
	if got := requests[1].URL.Query().Get("limit"); got != "500" {
		t.Fatalf("second page limit = %q, want 500", got)
	}
	if got := requests[1].URL.Query().Get("continue"); got != "page-2" {
		t.Fatalf("second page continue = %q, want page-2", got)
	}
}

func TestSearchKeepsMatchesWhenLaterListPageFails(t *testing.T) {
	target := unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "apps/v1",
		"kind":       "Deployment",
		"metadata": map[string]any{
			"name":      "akamai-check-deployment",
			"namespace": "default",
		},
	}}
	client := searchClient()
	client.Core.Discovery().(*discoveryfake.FakeDiscovery).Resources = nil
	dynamic := client.Dynamic.(*fake.FakeDynamicClient)
	page := 0
	dynamic.PrependReactor("list", "deployments", func(ktesting.Action) (bool, runtime.Object, error) {
		page++
		if page == 1 {
			return true, &unstructured.UnstructuredList{Object: map[string]any{
				"apiVersion": "apps/v1",
				"kind":       "DeploymentList",
				"metadata":   map[string]any{"continue": "page-2"},
			}, Items: []unstructured.Unstructured{target}}, nil
		}
		return true, nil, fmt.Errorf("second page unavailable")
	})
	defer client.Close()

	value, err := search(context.Background(), client, Request{Query: "akamai", Namespace: "default", Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	result := value.(SearchResult)
	if len(result.Items) != 1 || result.Items[0]["name"] != "akamai-check-deployment" {
		t.Fatalf("got %#v, want the first-page deployment", result.Items)
	}
	if !result.Truncated {
		t.Fatal("expected partial search result to be marked truncated")
	}
	if !strings.Contains(strings.Join(result.Warnings, "\n"), "second page unavailable") {
		t.Fatalf("missing later-page warning: %v", result.Warnings)
	}
}

func TestSearchKeepsMatchesWhenLaterListPageTimesOut(t *testing.T) {
	target := unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "apps/v1",
		"kind":       "Deployment",
		"metadata": map[string]any{
			"name":      "akamai-check-deployment",
			"namespace": "default",
		},
	}}
	client := searchClient()
	dynamic := client.Dynamic.(*fake.FakeDynamicClient)
	page := 0
	started := make(chan struct{})
	release := make(chan struct{})
	defer func() {
		select {
		case <-release:
		default:
			close(release)
		}
	}()
	dynamic.PrependReactor("list", "deployments", func(ktesting.Action) (bool, runtime.Object, error) {
		page++
		if page == 1 {
			return true, &unstructured.UnstructuredList{Object: map[string]any{
				"apiVersion": "apps/v1",
				"kind":       "DeploymentList",
				"metadata":   map[string]any{"continue": "page-2"},
			}, Items: []unstructured.Unstructured{target}}, nil
		}
		close(started)
		<-release
		return true, nil, context.DeadlineExceeded
	})
	defer client.Close()

	done := make(chan struct {
		value any
		err   error
	}, 1)
	go func() {
		value, err := searchCatalogWithTimeout(
			context.Background(),
			client,
			Request{Query: "akamai", Namespace: "default", Limit: 10},
			&Discovery{Resources: []Resource{{Group: "apps", Version: "v1", Resource: "deployments", Kind: "Deployment", Namespaced: true, Verbs: metav1.Verbs{"list"}}}},
			false,
			time.Now(),
			20*time.Millisecond,
		)
		done <- struct {
			value any
			err   error
		}{value: value, err: err}
	}()

	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("second list page did not start")
	}
	time.Sleep(30 * time.Millisecond)
	close(release)
	resultValue := <-done
	if resultValue.err != nil {
		t.Fatal(resultValue.err)
	}
	result := resultValue.value.(SearchResult)
	if len(result.Items) != 1 || result.Items[0]["name"] != "akamai-check-deployment" {
		t.Fatalf("got %#v, want the first-page deployment", result.Items)
	}
	if !result.Truncated {
		t.Fatal("expected timed out partial search result to be marked truncated")
	}
	if !strings.Contains(strings.Join(result.Warnings, "\n"), "search timed out") {
		t.Fatalf("missing timeout warning: %v", result.Warnings)
	}
}

func TestSearchFindsCustomResourcesByPartialNameAndLabel(t *testing.T) {
	gvr := schema.GroupVersionResource{Group: "example.com", Version: "v1", Resource: "widgets"}
	widget := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "example.com/v1",
		"kind":       "Widget",
		"metadata": map[string]any{
			"name":      "platform-controller",
			"namespace": "platform",
			"labels":    map[string]any{"team": "platform"},
		},
	}}
	core := kubernetesfake.NewSimpleClientset()
	core.Discovery().(*discoveryfake.FakeDiscovery).Resources = []*metav1.APIResourceList{
		{GroupVersion: "v1", APIResources: []metav1.APIResource{{Name: "pods", Kind: "Pod", Namespaced: true, Verbs: []string{"list"}}}},
		{GroupVersion: "example.com/v1", APIResources: []metav1.APIResource{{Name: "widgets", Kind: "Widget", Namespaced: true, Verbs: []string{"list"}}}},
	}
	dynamic := fake.NewSimpleDynamicClientWithCustomListKinds(runtime.NewScheme(), map[schema.GroupVersionResource]string{
		schema.GroupVersionResource{Group: "", Version: "v1", Resource: "pods"}: "PodList",
		gvr: "WidgetList",
	}, widget)
	client := &kube.Client{Core: core, Dynamic: dynamic}
	defer client.Close()

	for _, query := range []string{"controller", "platform"} {
		value, err := search(context.Background(), client, Request{Query: query, Limit: 10})
		if err != nil {
			t.Fatal(err)
		}
		result := value.(SearchResult)
		if len(result.Items) != 1 || result.Items[0]["resource"] != "widgets" {
			t.Fatalf("query %q returned %#v, want the custom widget", query, result.Items)
		}
	}
}

func TestSearchDoesNotSkipDiscoveryWhenCoreResultsFillLimit(t *testing.T) {
	gvr := schema.GroupVersionResource{Group: "example.com", Version: "v1", Resource: "widgets"}
	widget := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "example.com/v1",
		"kind":       "Widget",
		"metadata": map[string]any{
			"name":      "same",
			"namespace": "default",
		},
	}}
	core := kubernetesfake.NewSimpleClientset()
	core.Discovery().(*discoveryfake.FakeDiscovery).Resources = []*metav1.APIResourceList{
		{GroupVersion: "v1", APIResources: []metav1.APIResource{{Name: "pods", Kind: "Pod", Namespaced: true, Verbs: []string{"list"}}}},
		{GroupVersion: "example.com/v1", APIResources: []metav1.APIResource{{Name: "widgets", Kind: "Widget", Namespaced: true, Verbs: []string{"list"}}}},
	}
	listKinds := map[schema.GroupVersionResource]string{
		{Group: "", Version: "v1", Resource: "pods"}: "PodList",
		gvr: "WidgetList",
	}
	objects := make([]runtime.Object, 0, 11)
	for i := 0; i < 10; i++ {
		objects = append(objects, pod(fmt.Sprintf("same-%d", i), "default", nil))
	}
	objects = append(objects, widget)
	dynamic := fake.NewSimpleDynamicClientWithCustomListKinds(runtime.NewScheme(), listKinds, objects...)
	client := &kube.Client{Core: core, Dynamic: dynamic}
	defer client.Close()

	value, err := search(context.Background(), client, Request{Query: "same", Namespace: "default", Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	result := value.(SearchResult)
	foundWidget := false
	for _, item := range result.Items {
		if item["resource"] == "widgets" && item["name"] == "same" {
			foundWidget = true
			break
		}
	}
	if !foundWidget {
		t.Fatalf("got %#v, want the exact custom resource alongside core matches", result.Items)
	}
}

func TestSearchIncludesCustomResultsWhenCoreResultsAreIncomplete(t *testing.T) {
	gvr := schema.GroupVersionResource{Group: "example.com", Version: "v1", Resource: "widgets"}
	corePod := pod("platform", "default", nil)
	widget := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "example.com/v1",
		"kind":       "Widget",
		"metadata": map[string]any{
			"name":      "platform",
			"namespace": "default",
		},
	}}
	core := kubernetesfake.NewSimpleClientset()
	core.Discovery().(*discoveryfake.FakeDiscovery).Resources = []*metav1.APIResourceList{
		{GroupVersion: "v1", APIResources: []metav1.APIResource{{Name: "pods", Kind: "Pod", Namespaced: true, Verbs: []string{"list"}}}},
		{GroupVersion: "example.com/v1", APIResources: []metav1.APIResource{{Name: "widgets", Kind: "Widget", Namespaced: true, Verbs: []string{"list"}}}},
	}
	dynamic := fake.NewSimpleDynamicClientWithCustomListKinds(runtime.NewScheme(), map[schema.GroupVersionResource]string{
		schema.GroupVersionResource{Group: "", Version: "v1", Resource: "pods"}: "PodList",
		gvr: "WidgetList",
	}, corePod, widget)
	client := &kube.Client{Core: core, Dynamic: dynamic}
	defer client.Close()

	value, err := search(context.Background(), client, Request{Query: "platform", Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	result := value.(SearchResult)
	if len(result.Items) != 2 {
		t.Fatalf("got %#v, want both core and custom results", result.Items)
	}
}

func TestSearchUsesDiscoveryCachePerClient(t *testing.T) {
	client := searchClient()
	defer client.Close()

	if _, err, hit := client.CachedAPIResourceLists(); err != nil || hit {
		t.Fatalf("first discovery = err %v, hit %t", err, hit)
	}
	if _, err, hit := client.CachedAPIResourceLists(); err != nil || !hit {
		t.Fatalf("second discovery = err %v, hit %t", err, hit)
	}
}

func TestSearchKeepsCoreMatchesWhenResourceCatalogIsLarge(t *testing.T) {
	for _, tc := range []struct {
		name            string
		maxResources    int
		wantLists       int
		expectTruncated bool
	}{
		{name: "all discovered resources", wantLists: 265},
		{name: "explicit limit", maxResources: 2, wantLists: 2, expectTruncated: true},
		{name: "hard limit", maxResources: 300, wantLists: 200, expectTruncated: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			core := kubernetesfake.NewSimpleClientset()
			var catalog []*metav1.APIResourceList
			listKinds := make(map[schema.GroupVersionResource]string)
			for _, r := range builtInSearchResources {
				gv := schema.GroupVersion{Group: r.Group, Version: r.Version}
				catalog = append(catalog, &metav1.APIResourceList{GroupVersion: gv.String(), APIResources: []metav1.APIResource{{Name: r.Resource, Kind: r.Kind, Namespaced: r.Namespaced, Verbs: r.Verbs}}})
				listKinds[gv.WithResource(r.Resource)] = r.Kind + "List"
			}
			// These groups sort before apps/v1. The default search still scans
			// every discovered resource, while explicit MaxResources remains a
			// supported performance budget.
			for i := 0; i < 250; i++ {
				gv := schema.GroupVersion{Group: fmt.Sprintf("aaa%03d.example.com", i), Version: "v1"}
				catalog = append(catalog, &metav1.APIResourceList{GroupVersion: gv.String(), APIResources: []metav1.APIResource{{Name: "widgets", Kind: "Widget", Namespaced: true, Verbs: metav1.Verbs{"list"}}}})
				listKinds[gv.WithResource("widgets")] = "WidgetList"
			}
			core.Discovery().(*discoveryfake.FakeDiscovery).Resources = catalog
			deployment := &unstructured.Unstructured{Object: map[string]any{
				"apiVersion": "apps/v1", "kind": "Deployment",
				"metadata": map[string]any{"name": "web", "namespace": "default"},
			}}
			dynamic := fake.NewSimpleDynamicClientWithCustomListKinds(runtime.NewScheme(), listKinds, pod("web", "default", nil), deployment)
			client := &kube.Client{Core: core, Dynamic: dynamic}
			defer client.Close()
			value, err := search(context.Background(), client, Request{Query: "web", Namespace: "default", Limit: 10, MaxResources: tc.maxResources})
			if err != nil {
				t.Fatal(err)
			}
			result := value.(SearchResult)
			if len(result.Items) != 2 || result.Items[0]["resource"] != "pods" || result.Items[1]["resource"] != "deployments" {
				t.Fatalf("got %#v, want Pod then Deployment without duplicates", result.Items)
			}
			if result.Truncated != tc.expectTruncated {
				t.Fatalf("truncated = %t, want %t (warnings: %v)", result.Truncated, tc.expectTruncated, result.Warnings)
			}
			if tc.expectTruncated && !strings.Contains(strings.Join(result.Warnings, "\n"), fmt.Sprintf("search limited to %d resource types", tc.wantLists)) {
				t.Fatalf("missing resource-limit warning: %v", result.Warnings)
			}
			listedTypes := make(map[schema.GroupVersionResource]int)
			for _, action := range dynamic.Actions() {
				if action.GetResource().Resource == "secrets" {
					t.Fatal("global search must not list secrets")
				}
				listedTypes[action.GetResource()]++
			}
			if len(listedTypes) != tc.wantLists {
				t.Fatalf("queried resource types = %d, want %d", len(listedTypes), tc.wantLists)
			}
			// A catalog larger than the snapshot cache can evict a core entry
			// between phases, but neither phase may list a GVR more than once.
			for gvr, calls := range listedTypes {
				if calls > 2 {
					t.Fatalf("%s listed %d times, want at most once per phase", gvr, calls)
				}
			}
		})
	}
}
