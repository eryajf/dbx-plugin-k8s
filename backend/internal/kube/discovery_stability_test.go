package kube

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/discovery"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	"k8s.io/client-go/rest"
)

func stabilityClient(t *testing.T, handler func(*http.Request) (*http.Response, error)) *Client {
	t.Helper()
	d, err := discovery.NewDiscoveryClientForConfigAndClient(&rest.Config{Host: "https://discovery.test", QPS: -1}, &http.Client{Transport: discoveryRetryTransport{base: discoveryRoundTripFunc(handler)}})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	c := &Client{Discovery: d, Context: ctx, cancel: cancel}
	t.Cleanup(c.Close)
	return c
}

func discoveryResponse(r *http.Request, status int, value any) (*http.Response, error) {
	body, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	return &http.Response{StatusCode: status, Header: http.Header{"Content-Type": {"application/json"}}, Body: io.NopCloser(strings.NewReader(string(body))), Request: r}, nil
}

func stabilityList(gv, name string) *metav1.APIResourceList {
	return &metav1.APIResourceList{GroupVersion: gv, APIResources: []metav1.APIResource{{Name: name, Kind: "Pod", Namespaced: true, Verbs: metav1.Verbs{"list", "get"}}}}
}

func expireDiscovery(c *Client, key string, age time.Duration) {
	c.discoveryMu.Lock()
	defer c.discoveryMu.Unlock()
	entry := c.discoveryEntries[key]
	entry.at = time.Now().Add(-age)
	entry.retry = time.Time{}
	c.discoveryEntries[key] = entry
}

func waitDiscovery(t *testing.T, description string, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for !condition() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", description)
		}
		time.Sleep(time.Millisecond)
	}
}

func TestDiscoveryFullAndGVShareFlightsAndHealthyTTL(t *testing.T) {
	var mu sync.Mutex
	calls := map[string]int{}
	entered, release := make(chan struct{}), make(chan struct{})
	c := stabilityClient(t, func(r *http.Request) (*http.Response, error) {
		mu.Lock()
		calls[r.URL.Path]++
		n := calls[r.URL.Path]
		mu.Unlock()
		switch r.URL.Path {
		case "/api":
			return discoveryResponse(r, 200, &metav1.APIVersions{Versions: []string{"v1"}})
		case "/apis":
			return discoveryResponse(r, 200, &metav1.APIGroupList{Groups: []metav1.APIGroup{{Name: "broken.example", PreferredVersion: metav1.GroupVersionForDiscovery{Version: "v1"}, Versions: []metav1.GroupVersionForDiscovery{{Version: "v1"}}}}})
		case "/api/v1":
			if n == 1 {
				close(entered)
				select {
				case <-release:
				case <-r.Context().Done():
					return nil, r.Context().Err()
				}
			}
			return discoveryResponse(r, 200, stabilityList("v1", "pods"))
		case "/apis/broken.example/v1":
			return discoveryResponse(r, 503, &metav1.Status{Status: "Failure", Reason: metav1.StatusReasonServiceUnavailable, Code: 503})
		}
		return nil, fmt.Errorf("unexpected path")
	})
	full := make(chan DiscoverySnapshot, 1)
	go func() { snapshot, _, _ := c.CachedDiscoverySnapshot(context.Background()); full <- snapshot }()
	<-entered
	group := make(chan error, 1)
	go func() { _, err := c.APIResourcesForGroupVersion(context.Background(), "v1"); group <- err }()
	waitDiscovery(t, "full and direct waiters", func() bool {
		c.discoveryMu.Lock()
		defer c.discoveryMu.Unlock()
		return c.discoveryFlights["v1"] != nil && c.discoveryFlights["v1"].waiters == 2
	})
	close(release)
	if err := <-group; err != nil {
		t.Fatal(err)
	}
	snapshot := <-full
	if len(snapshot.Lists) != 1 || snapshot.Preferred["broken.example"] != "v1" {
		t.Fatalf("partial snapshot = %+v", snapshot)
	}
	// Mutations to the full snapshot must not touch the strict GV cache.
	snapshot.Lists[0].APIResources[0].Verbs[0] = "mutated"
	snapshot.Preferred["broken.example"] = "mutated"
	list, err := c.APIResourcesForGroupVersion(context.Background(), "v1")
	if err != nil || list.APIResources[0].Verbs[0] != "list" {
		t.Fatalf("deep copy = %v, %v", list, err)
	}
	// Force only the failed group's backoff to elapse; successful directory
	// and core entries must be reused despite the aggregate failure.
	c.discoveryMu.Lock()
	entry := c.discoveryEntries["broken.example/v1"]
	entry.retry = time.Time{}
	c.discoveryEntries["broken.example/v1"] = entry
	c.discoveryMu.Unlock()
	second, err, _ := c.CachedDiscoverySnapshot(context.Background())
	if err == nil || len(second.Lists) != 1 || second.Preferred["broken.example"] != "v1" {
		t.Fatalf("second snapshot = %+v, %v", second, err)
	}
	mu.Lock()
	defer mu.Unlock()
	for _, path := range []string{"/api", "/apis", "/api/v1"} {
		if calls[path] != 1 {
			t.Errorf("%s calls = %d, want 1", path, calls[path])
		}
	}
	if calls["/apis/broken.example/v1"] != 2 {
		t.Fatalf("failed GV calls = %d", calls["/apis/broken.example/v1"])
	}
}

func TestDiscoveryIndependentSuccessTTLs(t *testing.T) {
	var coreCalls, groupCalls atomic.Int32
	c := stabilityClient(t, func(r *http.Request) (*http.Response, error) {
		if r.URL.Path == "/api/v1" {
			coreCalls.Add(1)
			return discoveryResponse(r, 200, stabilityList("v1", "pods"))
		}
		groupCalls.Add(1)
		return discoveryResponse(r, 200, stabilityList("apps/v1", "deployments"))
	})
	for _, gv := range []string{"v1", "apps/v1"} {
		if _, err := c.APIResourcesForGroupVersion(context.Background(), gv); err != nil {
			t.Fatal(err)
		}
	}
	expireDiscovery(c, "v1", discoveryCacheTTL+time.Second)
	for _, gv := range []string{"v1", "apps/v1"} {
		if _, err := c.APIResourcesForGroupVersion(context.Background(), gv); err != nil {
			t.Fatal(err)
		}
	}
	if coreCalls.Load() != 2 || groupCalls.Load() != 1 {
		t.Fatalf("independent TTL calls: core=%d group=%d", coreCalls.Load(), groupCalls.Load())
	}
}

func TestDiscoveryStaleAgeAndHardErrors(t *testing.T) {
	for _, test := range []struct {
		name   string
		status int
		body   string
		stale  bool
		age    time.Duration
	}{
		{name: "temporary", status: 503, stale: true, age: time.Minute},
		{name: "rate limited", status: 429, stale: true, age: time.Minute},
		{name: "too old", status: 503, age: discoveryStaleMaxAge + time.Second},
		{name: "unauthorized", status: 401, age: time.Minute},
		{name: "forbidden", status: 403, age: time.Minute},
		{name: "group removed", status: 404, age: time.Minute},
		{name: "unknown", status: 400, age: time.Minute},
		{name: "decode", status: 200, body: "{", age: time.Minute},
		{name: "empty decode", status: 200, body: " ", age: time.Minute},
		{name: "wrong GV", status: 200, body: `{"groupVersion":"apps/v1"}`, age: time.Minute},
	} {
		t.Run(test.name, func(t *testing.T) {
			var phase atomic.Int32
			c := stabilityClient(t, func(r *http.Request) (*http.Response, error) {
				if phase.Load() == 0 {
					return discoveryResponse(r, 200, stabilityList("v1", "pods"))
				}
				if phase.Load() == 2 {
					return discoveryResponse(r, 503, &metav1.Status{Code: 503})
				}
				if test.body != "" {
					return &http.Response{StatusCode: test.status, Header: http.Header{"Content-Type": {"application/json"}}, Body: io.NopCloser(strings.NewReader(test.body)), Request: r}, nil
				}
				return discoveryResponse(r, test.status, &metav1.Status{Code: int32(test.status)})
			})
			if _, err := c.APIResourcesForGroupVersion(context.Background(), "v1"); err != nil {
				t.Fatal(err)
			}
			expireDiscovery(c, "v1", test.age)
			phase.Store(1)
			list, err := c.APIResourcesForGroupVersionReadOnly(context.Background(), "v1")
			if (err == nil) != test.stale {
				t.Fatalf("stale list = %v, error = %v, want allowed %t", list, err, test.stale)
			}
			if _, err := c.APIResourcesForGroupVersion(context.Background(), "v1"); err == nil {
				t.Fatal("strict/write lookup accepted stale metadata")
			}
			c.discoveryMu.Lock()
			entry := c.discoveryEntries["v1"]
			if test.stale && time.Since(entry.at) < test.age {
				t.Error("stale use extended success age")
			}
			entry.retry = time.Time{}
			c.discoveryEntries["v1"] = entry
			c.discoveryMu.Unlock()
			phase.Store(2)
			_, err = c.APIResourcesForGroupVersionReadOnly(context.Background(), "v1")
			if !test.stale && err == nil {
				t.Fatal("hard failure/age did not revoke stale eligibility")
			}
		})
	}
}

func TestDiscoveryRetryAfterIsBackoffNotRetryLoop(t *testing.T) {
	for _, source := range []string{"header", "body"} {
		t.Run(source, func(t *testing.T) {
			var calls atomic.Int32
			c := stabilityClient(t, func(r *http.Request) (*http.Response, error) {
				calls.Add(1)
				status := &metav1.Status{TypeMeta: metav1.TypeMeta{Kind: "Status", APIVersion: "v1"}, Status: metav1.StatusFailure, Code: 429, Reason: metav1.StatusReasonTooManyRequests}
				if source == "body" {
					status.Details = &metav1.StatusDetails{RetryAfterSeconds: 3}
				}
				response, err := discoveryResponse(r, 429, status)
				if source == "header" {
					response.Header.Set("Retry-After", "3")
				}
				return response, err
			})
			start := time.Now()
			for i := 0; i < 5; i++ {
				if _, err := c.APIResourcesForGroupVersion(context.Background(), "v1"); err == nil {
					t.Fatal("429 did not return an error")
				}
			}
			c.discoveryMu.Lock()
			entry := c.discoveryEntries["v1"]
			c.discoveryMu.Unlock()
			if calls.Load() != 1 || entry.retry.Sub(start) < 3*time.Second || time.Since(start) > time.Second {
				t.Fatalf("calls=%d retry=%v elapsed=%v", calls.Load(), entry.retry.Sub(start), time.Since(start))
			}
		})
	}
}

func TestDiscoveryCallerCancellationDoesNotPoisonSharedRequest(t *testing.T) {
	for _, key := range []string{"v1", "/api", "/apis"} {
		t.Run(key, func(t *testing.T) {
			entered, release := make(chan struct{}), make(chan struct{})
			var calls atomic.Int32
			c := stabilityClient(t, func(r *http.Request) (*http.Response, error) {
				calls.Add(1)
				close(entered)
				select {
				case <-release:
				case <-r.Context().Done():
					return nil, r.Context().Err()
				}
				if key == "/api" {
					return discoveryResponse(r, 200, &metav1.APIVersions{Versions: []string{"v1"}})
				}
				if key == "/apis" {
					return discoveryResponse(r, 200, &metav1.APIGroupList{})
				}
				return discoveryResponse(r, 200, stabilityList("v1", "pods"))
			})
			ctx, cancel := context.WithCancel(context.Background())
			first, second := make(chan error, 1), make(chan error, 1)
			go func() { _, _, err := c.discoveryLookup(ctx, key, 0, false); first <- err }()
			<-entered
			go func() { _, _, err := c.discoveryLookup(context.Background(), key, 0, false); second <- err }()
			waitDiscovery(t, "second waiter", func() bool {
				c.discoveryMu.Lock()
				defer c.discoveryMu.Unlock()
				return c.discoveryFlights[key].waiters == 2
			})
			cancel()
			if err := <-first; !errors.Is(err, context.Canceled) {
				t.Fatalf("first waiter = %v", err)
			}
			close(release)
			if err := <-second; err != nil {
				t.Fatal(err)
			}
			if _, hit, err := c.discoveryLookup(context.Background(), key, 0, false); !hit || err != nil || calls.Load() != 1 {
				t.Fatalf("cache poisoned: hit=%t err=%v calls=%d", hit, err, calls.Load())
			}
		})
	}
}

func TestDiscoveryCancelCloseAndGenerationRejectLateSuccess(t *testing.T) {
	for _, action := range []string{"last waiter", "invalidate", "close"} {
		t.Run(action, func(t *testing.T) {
			entered, release, canceled, completed := make(chan struct{}), make(chan struct{}), make(chan struct{}), make(chan struct{})
			var calls atomic.Int32
			c := stabilityClient(t, func(r *http.Request) (*http.Response, error) {
				if calls.Add(1) == 1 {
					close(entered)
					<-r.Context().Done()
					close(canceled)
					<-release // Simulate a transport which returns a late success.
					defer close(completed)
					return discoveryResponse(r, 200, stabilityList("v1", "old"))
				}
				return discoveryResponse(r, 200, stabilityList("v1", "new"))
			})
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			first := make(chan error, 1)
			go func() { _, err := c.APIResourcesForGroupVersion(ctx, "v1"); first <- err }()
			<-entered
			switch action {
			case "last waiter":
				cancel()
			case "invalidate":
				c.InvalidateDiscoveryCache()
			case "close":
				c.Close()
			}
			select {
			case err := <-first:
				if !errors.Is(err, context.Canceled) {
					t.Fatalf("waiter = %v", err)
				}
			case <-time.After(time.Second):
				t.Fatal("waiter blocked on uncooperative transport")
			}
			<-canceled
			if action != "close" {
				list, err := c.APIResourcesForGroupVersion(context.Background(), "v1")
				if err != nil || list.APIResources[0].Name != "new" {
					t.Fatalf("new generation = %v %v", list, err)
				}
			}
			close(release)
			<-completed
			if action == "close" {
				if _, err := c.APIResourcesForGroupVersion(context.Background(), "v1"); !errors.Is(err, context.Canceled) {
					t.Fatalf("closed cache reused: %v", err)
				}
			} else {
				list, err := c.APIResourcesForGroupVersion(context.Background(), "v1")
				if err != nil || list.APIResources[0].Name != "new" || calls.Load() != 2 {
					t.Fatalf("late result published: %v %v calls=%d", list, err, calls.Load())
				}
			}
		})
	}
}

func TestLiveDiscoveryRetryAfterHTTPDate(t *testing.T) {
	var calls atomic.Int32
	retryAt := time.Now().Add(10 * time.Second).UTC().Truncate(time.Second)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Retry-After", retryAt.Format(http.TimeFormat))
		w.WriteHeader(429)
		fmt.Fprint(w, `{"kind":"Status","apiVersion":"v1","code":429,"reason":"TooManyRequests"}`)
	}))
	defer server.Close()
	c, err := New(&rest.Config{Host: server.URL, QPS: -1}, "", "")
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	for i := 0; i < 3; i++ {
		if _, err := c.APIResourcesForGroupVersion(context.Background(), "v1"); err == nil {
			t.Fatal("expected 429")
		}
	}
	c.discoveryMu.Lock()
	entry := c.discoveryEntries["v1"]
	c.discoveryMu.Unlock()
	if calls.Load() != 1 || entry.retry.Before(retryAt) {
		t.Fatalf("HTTP-date ignored: calls=%d retry=%s want >=%s", calls.Load(), entry.retry, retryAt)
	}
}

func TestDiscoveryRequestHasFiveSecondBudget(t *testing.T) {
	var remaining time.Duration
	c := stabilityClient(t, func(r *http.Request) (*http.Response, error) {
		deadline, ok := r.Context().Deadline()
		if !ok {
			return nil, fmt.Errorf("missing deadline")
		}
		remaining = time.Until(deadline)
		return discoveryResponse(r, 200, stabilityList("v1", "pods"))
	})
	if _, err := c.APIResourcesForGroupVersion(context.Background(), "v1"); err != nil {
		t.Fatal(err)
	}
	if remaining < 4500*time.Millisecond || remaining > 5*time.Second {
		t.Fatalf("request deadline=%v, want 5s", remaining)
	}
}

func TestDiscoverySnapshotSurvivesRefreshAsOwnedValue(t *testing.T) {
	var version atomic.Int32
	version.Store(1)
	c := stabilityClient(t, func(r *http.Request) (*http.Response, error) {
		v := fmt.Sprintf("v%d", version.Load())
		switch r.URL.Path {
		case "/api":
			return discoveryResponse(r, 200, &metav1.APIVersions{})
		case "/apis":
			return discoveryResponse(r, 200, &metav1.APIGroupList{Groups: []metav1.APIGroup{{Name: "example.com", PreferredVersion: metav1.GroupVersionForDiscovery{Version: v}, Versions: []metav1.GroupVersionForDiscovery{{Version: v}}}}})
		default:
			return discoveryResponse(r, 200, stabilityList("example.com/"+v, "widgets"))
		}
	})
	old, err, _ := c.CachedDiscoverySnapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	c.InvalidateDiscoveryCache()
	version.Store(2)
	fresh, err, _ := c.CachedDiscoverySnapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if old.Preferred["example.com"] != "v1" || old.Lists[0].GroupVersion != "example.com/v1" || fresh.Preferred["example.com"] != "v2" || fresh.Lists[0].GroupVersion != "example.com/v2" || old.Generation == fresh.Generation {
		t.Fatalf("mixed snapshots: old=%+v new=%+v", old, fresh)
	}
}

func TestDiscoveryMalformedContentTypeRevokesStale(t *testing.T) {
	for _, status := range []int{200, 401, 403, 503} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			var phase atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				if phase.Load() == 0 {
					_ = json.NewEncoder(w).Encode(stabilityList("v1", "pods"))
					return
				}
				if phase.Load() == 1 {
					w.Header().Set("Content-Type", "application/json; token=\"unterminated")
					w.WriteHeader(status)
					fmt.Fprint(w, `{}`)
					return
				}
				w.WriteHeader(503)
				fmt.Fprint(w, `{"kind":"Status","apiVersion":"v1","status":"Failure","reason":"ServiceUnavailable"}`)
			}))
			defer server.Close()
			c, err := New(&rest.Config{Host: server.URL, QPS: -1}, "", "")
			if err != nil {
				t.Fatal(err)
			}
			defer c.Close()
			if _, err := c.APIResourcesForGroupVersion(context.Background(), "v1"); err != nil {
				t.Fatal(err)
			}
			expireDiscovery(c, "v1", time.Minute)
			phase.Store(1)
			_, err = c.APIResourcesForGroupVersionReadOnly(context.Background(), "v1")
			var decode discoveryDecodeError
			var response discoveryHTTPError
			if err == nil || !errors.As(err, &decode) || !errors.As(err, &response) || response.status != status || transientDiscoveryError(err) {
				t.Fatalf("malformed Content-Type classification=%T %v; HTTP=%d", err, err, response.status)
			}
			c.discoveryMu.Lock()
			entry := c.discoveryEntries["v1"]
			c.discoveryMu.Unlock()
			if entry.object != nil || !entry.at.IsZero() {
				t.Fatal("malformed Content-Type retained stale eligibility")
			}
			expireDiscovery(c, "v1", time.Minute)
			phase.Store(2)
			if _, err := c.APIResourcesForGroupVersionReadOnly(context.Background(), "v1"); err == nil {
				t.Fatal("later transient failure resurrected revoked stale metadata")
			}
		})
	}
}

func TestDiscoveryReasonOnlyFailureRetainsStale(t *testing.T) {
	for _, test := range []struct {
		reason metav1.StatusReason
		status int
	}{
		{metav1.StatusReasonTooManyRequests, 429},
		{metav1.StatusReasonServiceUnavailable, 503},
		{metav1.StatusReasonTimeout, 504},
		{metav1.StatusReasonServerTimeout, 500},
	} {
		t.Run(string(test.reason), func(t *testing.T) {
			var phase atomic.Bool
			c := stabilityClient(t, func(r *http.Request) (*http.Response, error) {
				if !phase.Load() {
					return discoveryResponse(r, 200, stabilityList("v1", "pods"))
				}
				return discoveryResponse(r, test.status, &metav1.Status{TypeMeta: metav1.TypeMeta{Kind: "Status", APIVersion: "v1"}, Status: metav1.StatusFailure, Reason: test.reason})
			})
			if _, err := c.APIResourcesForGroupVersion(context.Background(), "v1"); err != nil {
				t.Fatal(err)
			}
			expireDiscovery(c, "v1", time.Minute)
			phase.Store(true)
			list, err := c.APIResourcesForGroupVersionReadOnly(context.Background(), "v1")
			if err != nil || list == nil || list.APIResources[0].Name != "pods" {
				t.Fatalf("reason-only Status rejected stale: %v %v", list, err)
			}
			c.discoveryMu.Lock()
			entry := c.discoveryEntries["v1"]
			c.discoveryMu.Unlock()
			var status apierrors.APIStatus
			if !errors.As(entry.err, &status) || status.Status().Code != 0 || !transientDiscoveryError(entry.err) || entry.object == nil {
				t.Fatalf("reason-only cache = %+v", entry)
			}
			if _, err := c.APIResourcesForGroupVersion(context.Background(), "v1"); err == nil {
				t.Fatal("strict lookup accepted stale reason-only metadata")
			}
		})
	}
	// Authentication/removal is hard even with a contradictory transient code
	// or reason. Check both actual HTTP status and Status body directions.
	for _, hard := range []int{401, 403, 404} {
		for _, reason := range []metav1.StatusReason{metav1.StatusReasonTooManyRequests, metav1.StatusReasonServiceUnavailable} {
			err := discoveryHTTPError{error: &apierrors.StatusError{ErrStatus: metav1.Status{Status: metav1.StatusFailure, Reason: reason}}, status: hard}
			if transientDiscoveryError(err) {
				t.Fatalf("HTTP %d lost precedence over %s", hard, reason)
			}
			err = discoveryHTTPError{error: &apierrors.StatusError{ErrStatus: metav1.Status{Status: metav1.StatusFailure, Reason: reason, Code: int32(hard)}}, status: 503}
			if transientDiscoveryError(err) {
				t.Fatalf("Status %d lost precedence over %s", hard, reason)
			}
		}
	}
}

func partialDiscoveryClient(t *testing.T) *Client {
	t.Helper()
	return stabilityClient(t, func(r *http.Request) (*http.Response, error) {
		switch r.URL.Path {
		case "/api":
			return discoveryResponse(r, 200, &metav1.APIVersions{Versions: []string{"v1"}})
		case "/apis":
			return discoveryResponse(r, 200, &metav1.APIGroupList{Groups: []metav1.APIGroup{{Name: "slow.example", PreferredVersion: metav1.GroupVersionForDiscovery{Version: "v1"}, Versions: []metav1.GroupVersionForDiscovery{{Version: "v1"}}}}})
		case "/api/v1":
			return discoveryResponse(r, 200, stabilityList("v1", "pods"))
		default:
			<-r.Context().Done()
			return nil, r.Context().Err()
		}
	})
}

func TestDiscoverySnapshotDeadlineKeepsOnlySameGenerationPartial(t *testing.T) {
	for _, action := range []string{"deadline", "cancel", "close", "invalidate", "connection cancel"} {
		t.Run(action, func(t *testing.T) {
			c := partialDiscoveryClient(t)
			if _, err := c.APIResourcesForGroupVersion(context.Background(), "v1"); err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
			defer cancel()
			type result struct {
				snapshot DiscoverySnapshot
				err      error
			}
			done := make(chan result, 1)
			go func() {
				snapshot, err, _ := c.CachedDiscoverySnapshot(ctx)
				done <- result{snapshot, err}
			}()
			waitDiscovery(t, "pending slow GV", func() bool {
				c.discoveryMu.Lock()
				defer c.discoveryMu.Unlock()
				return c.discoveryFlights["slow.example/v1"] != nil
			})
			switch action {
			case "cancel":
				cancel()
			case "close":
				c.Close()
			case "invalidate":
				c.InvalidateDiscoveryCache()
			case "connection cancel":
				c.cancel()
			}
			got := <-done
			if action == "deadline" {
				if !errors.Is(got.err, context.DeadlineExceeded) || len(got.snapshot.Lists) != 1 || got.snapshot.Lists[0].GroupVersion != "v1" || got.snapshot.Preferred[""] != "v1" || !strings.Contains(got.err.Error(), "snapshot incomplete") {
					t.Fatalf("partial snapshot = %+v, %v", got.snapshot, got.err)
				}
				got.snapshot.Lists[0].APIResources[0].Name = "mutated"
				list, err := c.APIResourcesForGroupVersion(context.Background(), "v1")
				if err != nil || list.APIResources[0].Name != "pods" {
					t.Fatal("partial snapshot was not copied")
				}
			} else if !errors.Is(got.err, context.Canceled) || len(got.snapshot.Lists) != 0 || len(got.snapshot.Preferred) != 0 {
				t.Fatalf("%s returned invalid snapshot: %+v %v", action, got.snapshot, got.err)
			}
		})
	}
}

func TestDiscoveryReadOnlyExpiredCallerCannotUseStale(t *testing.T) {
	entered := make(chan struct{})
	c := stabilityClient(t, func(r *http.Request) (*http.Response, error) {
		close(entered)
		<-r.Context().Done()
		return nil, r.Context().Err()
	})
	c.discoveryEntries = map[string]discoveryEntry{"v1": {object: stabilityList("v1", "pods"), at: time.Now().Add(-time.Minute)}}
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	list, err := c.APIResourcesForGroupVersionReadOnly(ctx, "v1")
	<-entered
	if list != nil || !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expired caller used stale metadata: %v %v", list, err)
	}
}

func TestSearchIndexDiscoveryPhaseBudgetAndParent(t *testing.T) {
	t.Run("phase leaves budget for healthy List", func(t *testing.T) {
		var calls atomic.Int32
		c := stabilityClient(t, func(r *http.Request) (*http.Response, error) {
			switch r.URL.Path {
			case "/api":
				return discoveryResponse(r, 200, &metav1.APIVersions{Versions: []string{"v1"}})
			case "/apis":
				groups := &metav1.APIGroupList{}
				// Enough slow GVs to exceed one wave of 8 workers (5s each).
				for i := 0; i < 24; i++ {
					groups.Groups = append(groups.Groups, metav1.APIGroup{Name: fmt.Sprintf("slow%d.example", i), PreferredVersion: metav1.GroupVersionForDiscovery{Version: "v1"}, Versions: []metav1.GroupVersionForDiscovery{{Version: "v1"}}})
				}
				return discoveryResponse(r, 200, groups)
			case "/api/v1":
				return discoveryResponse(r, 200, stabilityList("v1", "pods"))
			default:
				calls.Add(1)
				<-r.Context().Done()
				return nil, r.Context().Err()
			}
		})
		gvr := schema.GroupVersionResource{Version: "v1", Resource: "pods"}
		c.Dynamic = dynamicfake.NewSimpleDynamicClientWithCustomListKinds(runtime.NewScheme(), map[schema.GroupVersionResource]string{gvr: "PodList"}, &unstructured.Unstructured{Object: map[string]any{"apiVersion": "v1", "kind": "Pod", "metadata": map[string]any{"name": "healthy", "namespace": "default"}}})
		parent, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		started := time.Now()
		if err := c.SearchIndex().rebuild(parent); err != nil {
			t.Fatalf("partial discovery prevented healthy rebuild: %v", err)
		}
		elapsed := time.Since(started)
		if elapsed < 9*time.Second || elapsed > 13*time.Second || parent.Err() != nil || calls.Load() < 8 {
			t.Fatalf("phase budget elapsed=%v parent=%v requests=%d", elapsed, parent.Err(), calls.Load())
		}
		result := c.SearchIndex().Query(SearchQuery{Query: "healthy"})
		if result.Total != 1 || result.Complete || !strings.Contains(strings.Join(result.Warnings, " "), "snapshot incomplete") {
			t.Fatalf("healthy resources not listed after discovery timeout: %+v", result)
		}
	})
	t.Run("earlier rebuild deadline wins", func(t *testing.T) {
		c := partialDiscoveryClient(t)
		parent, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
		defer cancel()
		started := time.Now()
		catalog, warnings, err := c.SearchIndex().resourceCatalog(parent)
		gvr := schema.GroupVersionResource{Version: "v1", Resource: "pods"}
		if !errors.Is(err, context.DeadlineExceeded) || time.Since(started) > time.Second || catalog[gvr].Resource != "pods" || len(warnings) == 0 {
			t.Fatalf("parent budget ignored: catalog=%v warnings=%v err=%v", catalog, warnings, err)
		}
		if parent.Err() == nil {
			t.Fatal("expected parent deadline")
		}
	})
}

// Late fetch log lines can arrive after their last waiter exits. A synchronized
// buffer lets the race detector check logging without test-only synchronization
// affecting the actual cache/flight code.
type discoveryLogBuffer struct {
	mu     sync.Mutex
	buffer bytes.Buffer
}

func (buffer *discoveryLogBuffer) Write(value []byte) (int, error) {
	buffer.mu.Lock()
	defer buffer.mu.Unlock()
	return buffer.buffer.Write(value)
}

func (buffer *discoveryLogBuffer) String() string {
	buffer.mu.Lock()
	defer buffer.mu.Unlock()
	return buffer.buffer.String()
}

func TestDiscoveryLogsAreCategorizedAndRedacted(t *testing.T) {
	var buffer discoveryLogBuffer
	previous := log.Writer()
	log.SetOutput(&buffer)
	defer log.SetOutput(previous)
	var phase atomic.Bool
	c := stabilityClient(t, func(r *http.Request) (*http.Response, error) {
		if !phase.Load() {
			return discoveryResponse(r, 200, stabilityList("v1", "pods"))
		}
		return discoveryResponse(r, 503, &metav1.Status{TypeMeta: metav1.TypeMeta{Kind: "Status", APIVersion: "v1"}, Status: metav1.StatusFailure, Reason: metav1.StatusReasonServiceUnavailable, Message: "https://sensitive.invalid?token=DO-NOT-LOG"})
	})
	if _, err := c.APIResourcesForGroupVersion(context.Background(), "v1"); err != nil {
		t.Fatal(err)
	}
	expireDiscovery(c, "v1", time.Minute)
	phase.Store(true)
	for i := 0; i < 2; i++ {
		if _, err := c.APIResourcesForGroupVersionReadOnly(context.Background(), "v1"); err != nil {
			t.Fatal(err)
		}
	}
	entered, release := make(chan struct{}), make(chan struct{})
	shared := stabilityClient(t, func(r *http.Request) (*http.Response, error) {
		close(entered)
		<-release
		return discoveryResponse(r, 200, stabilityList("v1", "pods"))
	})
	done := make(chan error, 2)
	for i := 0; i < 2; i++ {
		go func() { _, err := shared.APIResourcesForGroupVersion(context.Background(), "v1"); done <- err }()
		if i == 0 {
			<-entered
		}
	}
	waitDiscovery(t, "shared log waiter", func() bool {
		shared.discoveryMu.Lock()
		defer shared.discoveryMu.Unlock()
		return shared.discoveryFlights["v1"].waiters == 2
	})
	close(release)
	for i := 0; i < 2; i++ {
		if err := <-done; err != nil {
			t.Fatal(err)
		}
	}
	output := buffer.String()
	for _, value := range []string{"stale=true", "cache=backoff", "cache=shared", "error_category=unavailable", "age_ms=600"} {
		if !strings.Contains(output, value) {
			t.Errorf("missing %q in logs: %s", value, output)
		}
	}
	for _, value := range []string{"https://", "sensitive.invalid", "DO-NOT-LOG", "token="} {
		if strings.Contains(output, value) {
			t.Errorf("sensitive text %q in logs", value)
		}
	}
}
