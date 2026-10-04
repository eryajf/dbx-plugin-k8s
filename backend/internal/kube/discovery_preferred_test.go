package kube

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/discovery"
	discoveryfake "k8s.io/client-go/discovery/fake"
	"k8s.io/client-go/dynamic/fake"
	kubernetesfake "k8s.io/client-go/kubernetes/fake"
	"k8s.io/client-go/rest"
)

type discoveryRoundTripFunc func(*http.Request) (*http.Response, error)

func (f discoveryRoundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return f(request)
}

func TestPreferredVersionsFromFakeDiscoveryAreCached(t *testing.T) {
	core := kubernetesfake.NewSimpleClientset()
	discoveryFake := core.Discovery().(*discoveryfake.FakeDiscovery)
	discoveryFake.Resources = []*metav1.APIResourceList{
		{GroupVersion: "v1", APIResources: []metav1.APIResource{{Name: "pods", Kind: "Pod", Verbs: metav1.Verbs{"list"}}}},
		{GroupVersion: "example.com/v1", APIResources: []metav1.APIResource{{Name: "widgets", Kind: "Widget", Verbs: metav1.Verbs{"list"}}}},
		{GroupVersion: "example.com/v2", APIResources: []metav1.APIResource{{Name: "widgets", Kind: "Widget", Verbs: metav1.Verbs{"list"}}}},
	}
	client := &Client{Core: core, Dynamic: fake.NewSimpleDynamicClient(runtime.NewScheme())}
	defer client.Close()
	if _, err, hit := client.CachedAPIResourceListsContext(context.Background()); err != nil || hit {
		t.Fatalf("discovery = err %v, hit %t", err, hit)
	}
	preferred := client.PreferredVersions()
	if preferred["example.com"] != "v1" {
		t.Fatalf("preferred versions = %#v, want example.com/v1", preferred)
	}
	if _, err, hit := client.CachedAPIResourceListsContext(context.Background()); err != nil || !hit {
		t.Fatalf("cached discovery = err %v, hit %t", err, hit)
	}
	if got := client.PreferredVersions()["example.com"]; got != "v1" {
		t.Fatalf("cached preferred version = %q, want v1", got)
	}
}

func TestLiveDiscoveryKeepsPartialListsAndPreferredVersions(t *testing.T) {
	transport := discoveryRoundTripFunc(func(request *http.Request) (*http.Response, error) {
		if _, ok := request.Context().Deadline(); !ok {
			t.Errorf("discovery request %s has no independent deadline", request.URL.Path)
		}
		var value any
		switch request.URL.Path {
		case "/api":
			value = metav1.APIVersions{Versions: []string{"v1"}}
		case "/api/v1":
			value = metav1.APIResourceList{GroupVersion: "v1", APIResources: []metav1.APIResource{{Name: "pods", Kind: "Pod", Verbs: metav1.Verbs{"list"}}}}
		case "/apis":
			value = metav1.APIGroupList{Groups: []metav1.APIGroup{
				{Name: "example.com", PreferredVersion: metav1.GroupVersionForDiscovery{GroupVersion: "example.com/v2", Version: "v2"}, Versions: []metav1.GroupVersionForDiscovery{{GroupVersion: "example.com/v1", Version: "v1"}, {GroupVersion: "example.com/v2", Version: "v2"}}},
				{Name: "broken.example", PreferredVersion: metav1.GroupVersionForDiscovery{GroupVersion: "broken.example/v1", Version: "v1"}, Versions: []metav1.GroupVersionForDiscovery{{GroupVersion: "broken.example/v1", Version: "v1"}}},
			}}
		case "/apis/example.com/v1":
			value = metav1.APIResourceList{GroupVersion: "example.com/v1", APIResources: []metav1.APIResource{{Name: "widgets", Kind: "Widget", Verbs: metav1.Verbs{"list"}}}}
		case "/apis/example.com/v2":
			value = metav1.APIResourceList{GroupVersion: "example.com/v2", APIResources: []metav1.APIResource{{Name: "widgets", Kind: "Widget", Verbs: metav1.Verbs{"list"}}}}
		case "/apis/broken.example/v1":
			return &http.Response{StatusCode: http.StatusInternalServerError, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(`{"kind":"Status","apiVersion":"v1","message":"aggregated API unavailable"}`)), Request: request}, nil
		default:
			t.Fatalf("unexpected discovery path %s", request.URL.Path)
		}
		body, err := json.Marshal(value)
		if err != nil {
			return nil, err
		}
		return &http.Response{StatusCode: http.StatusOK, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(string(body))), Request: request}, nil
	})
	discoveryClient, err := discovery.NewDiscoveryClientForConfigAndClient(&rest.Config{Host: "https://discovery.test", QPS: -1}, &http.Client{Transport: transport})
	if err != nil {
		t.Fatal(err)
	}
	client := &Client{Discovery: discoveryClient, Dynamic: fake.NewSimpleDynamicClient(runtime.NewScheme())}
	defer client.Close()
	lists, preferred, err := client.discoverResourceLists(context.Background())
	if err == nil {
		t.Fatal("partial discovery error = nil, want aggregated API warning")
	}
	if preferred["example.com"] != "v2" || preferred["broken.example"] != "v1" {
		t.Fatalf("preferred versions = %#v", preferred)
	}
	seen := map[string]bool{}
	for _, list := range lists {
		seen[list.GroupVersion] = true
	}
	for _, groupVersion := range []string{"v1", "example.com/v1", "example.com/v2"} {
		if !seen[groupVersion] {
			t.Fatalf("partial discovery omitted %s: %#v", groupVersion, seen)
		}
	}
	if seen["broken.example/v1"] {
		t.Fatal("failed aggregated resource unexpectedly returned a list")
	}
}
