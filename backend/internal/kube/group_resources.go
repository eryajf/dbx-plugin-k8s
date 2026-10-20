package kube

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"mime"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"
)

const (
	discoveryCacheTTL       = 30 * time.Second
	discoveryRequestTimeout = 5 * time.Second
	discoveryStaleMaxAge    = 5 * time.Minute
	discoveryFailureBackoff = 250 * time.Millisecond
)

// Successful metadata and pending work deliberately have separate lifetimes.
// at always means the last success, never the last attempt or stale use.
type discoveryEntry struct {
	object runtime.Object
	at     time.Time
	err    error
	retry  time.Time
}

type discoveryFlight struct {
	done       chan struct{}
	abort      chan struct{}
	cancel     context.CancelFunc
	waiters    int
	finished   bool
	generation uint64
	object     runtime.Object
	err        error
}

// DiscoverySnapshot couples the resource lists and preferred versions from one
// directory read. Callers own deep copies; invalidation cannot mix generations.
// This is a metadata snapshot, not an atomic snapshot of the Kubernetes server.
type DiscoverySnapshot struct {
	Lists      []*metav1.APIResourceList
	Preferred  map[string]string
	Generation uint64
}

// SearchDynamic isolates background indexing from interactive request budgets.
func (c *Client) SearchDynamic() dynamic.Interface {
	if c.BackgroundDynamic != nil {
		return c.BackgroundDynamic
	}
	return c.Dynamic
}

func (c *Client) discoveryState() (uint64, error) {
	c.discoveryMu.Lock()
	defer c.discoveryMu.Unlock()
	if c.discoveryClosed || (c.Context != nil && c.Context.Err() != nil) {
		return c.discoveryGeneration, context.Canceled
	}
	return c.discoveryGeneration, nil
}

// APIResourcesForGroupVersion is strict: metadata failures are returned, not
// hidden behind old data. Mutating callers must use this form.
func (c *Client) APIResourcesForGroupVersion(ctx context.Context, gv string) (*metav1.APIResourceList, error) {
	return c.apiResources(ctx, gv, false)
}

// APIResourcesForGroupVersionReadOnly permits old metadata only after a known
// transient discovery failure. It does not retry or replay the resource operation.
func (c *Client) APIResourcesForGroupVersionReadOnly(ctx context.Context, gv string) (*metav1.APIResourceList, error) {
	return c.apiResources(ctx, gv, true)
}

func (c *Client) apiResources(ctx context.Context, gv string, stale bool) (*metav1.APIResourceList, error) {
	if !validDiscoveryGV(gv) {
		return nil, fmt.Errorf("invalid discovery group/version")
	}
	generation, err := c.discoveryState()
	if err != nil {
		return nil, err
	}
	object, _, err := c.discoveryLookup(ctx, gv, generation, stale)
	if err != nil {
		return nil, err
	}
	return object.(*metav1.APIResourceList), nil
}

func validDiscoveryGV(gv string) bool {
	parsed, err := schema.ParseGroupVersion(gv)
	if err != nil || parsed.Version == "" {
		return false
	}
	for _, part := range []string{parsed.Group, parsed.Version} {
		if part == "." || part == ".." {
			return false
		}
		for _, char := range part {
			if !(char >= 'a' && char <= 'z' || char >= '0' && char <= '9' || char == '.' || char == '-') {
				return false
			}
		}
	}
	return true
}

// discoveryLookup is the single cache/flight entry point for both directories
// and GVs. A waiter never lends its context to shared I/O; the last one out
// detaches and cancels the request, just like the search snapshot cache.
func (c *Client) discoveryLookup(ctx context.Context, key string, generation uint64, stale bool) (result runtime.Object, cacheHit bool, resultErr error) {
	started := time.Now()
	cacheState, staleUsed, age, category := "miss", false, time.Duration(-1), "none"
	defer func() {
		// Cached/stale results are still subject to this individual caller's
		// cancellation, including time spent waiting to acquire discoveryMu.
		if err := ctx.Err(); err != nil && resultErr == nil {
			result, resultErr, staleUsed = nil, err, false
		}
		if resultErr != nil {
			category = discoveryErrorCategory(resultErr)
		}
		if staleUsed || cacheState == "backoff" || cacheState == "shared" || resultErr != nil || time.Since(started) >= time.Second {
			logDiscovery(key, started, cacheState, staleUsed, category, age)
		}
	}()
	if err := ctx.Err(); err != nil {
		return nil, false, err
	}
	c.discoveryMu.Lock()
	if c.discoveryClosed || generation != c.discoveryGeneration || (c.Context != nil && c.Context.Err() != nil) {
		c.discoveryMu.Unlock()
		return nil, false, context.Canceled
	}
	now := time.Now()
	entry := c.discoveryEntries[key]
	age = discoveryAge(entry.at, now)
	if entry.object != nil && entry.err == nil && now.Sub(entry.at) < discoveryCacheTTL {
		cacheState = "hit"
		object := entry.object.DeepCopyObject()
		c.discoveryMu.Unlock()
		return object, true, nil
	}
	if entry.err != nil && now.Before(entry.retry) {
		cacheState, category = "backoff", discoveryErrorCategory(entry.err)
		object, err := discoveryResult(entry, stale, now)
		staleUsed = object != nil && err == nil
		c.discoveryMu.Unlock()
		return object, true, err
	}
	if c.discoveryFlights == nil {
		c.discoveryFlights = make(map[string]*discoveryFlight)
	}
	flight, hit := c.discoveryFlights[key]
	if hit {
		cacheState = "shared"
		flight.waiters++
	} else {
		cacheState = "refresh"
		requestCtx, cancel := c.RequestContext(discoveryRequestTimeout)
		flight = &discoveryFlight{done: make(chan struct{}), abort: make(chan struct{}), cancel: cancel, waiters: 1, generation: generation}
		c.discoveryFlights[key] = flight
		go c.fetchDiscovery(requestCtx, key, flight)
	}
	c.discoveryMu.Unlock()
	defer c.releaseDiscovery(key, flight)
	select {
	case <-ctx.Done():
		return nil, hit, ctx.Err()
	case <-flight.abort:
		return nil, hit, context.Canceled
	case <-flight.done:
		if err := ctx.Err(); err != nil {
			return nil, hit, err
		}
		c.discoveryMu.Lock()
		defer c.discoveryMu.Unlock()
		if c.discoveryClosed || generation != c.discoveryGeneration || (c.Context != nil && c.Context.Err() != nil) {
			return nil, hit, context.Canceled
		}
		entry = c.discoveryEntries[key]
		age = discoveryAge(entry.at, time.Now())
		category = discoveryErrorCategory(flight.err)
		if flight.err == nil {
			return flight.object.DeepCopyObject(), hit, nil
		}
		// Re-read the entry: a hard failure must revoke stale eligibility even
		// if a different, detached attempt had previously succeeded.
		if stale && transientDiscoveryError(flight.err) {
			if object, err := discoveryResult(entry, true, time.Now()); err == nil && object != nil {
				staleUsed = true
				return object, hit, nil
			}
		}
		return nil, hit, flight.err
	}
}

func discoveryResult(entry discoveryEntry, stale bool, now time.Time) (runtime.Object, error) {
	if stale && entry.object != nil && now.Sub(entry.at) <= discoveryStaleMaxAge && transientDiscoveryError(entry.err) {
		return entry.object.DeepCopyObject(), nil
	}
	return nil, entry.err
}

func (c *Client) releaseDiscovery(key string, flight *discoveryFlight) {
	c.discoveryMu.Lock()
	defer c.discoveryMu.Unlock()
	flight.waiters--
	if flight.waiters == 0 && !flight.finished {
		if c.discoveryFlights[key] == flight {
			delete(c.discoveryFlights, key)
		}
		flight.cancel()
	}
}

func (c *Client) fetchDiscovery(ctx context.Context, key string, flight *discoveryFlight) {
	started := time.Now()
	object, err := c.requestDiscovery(ctx, key)
	// A transport/fake may return success after ignoring cancellation.
	if err == nil && ctx.Err() != nil {
		object, err = nil, ctx.Err()
	}
	c.discoveryMu.Lock()
	flight.finished = true
	flight.object, flight.err = object, err
	if c.discoveryFlights[key] == flight {
		delete(c.discoveryFlights, key)
		if !c.discoveryClosed && flight.generation == c.discoveryGeneration && flight.waiters > 0 && !errors.Is(err, context.Canceled) && (c.Context == nil || c.Context.Err() == nil) {
			if c.discoveryEntries == nil {
				c.discoveryEntries = make(map[string]discoveryEntry)
			}
			entry := c.discoveryEntries[key]
			if err == nil {
				entry = discoveryEntry{object: object.DeepCopyObject(), at: time.Now()}
			} else {
				if !transientDiscoveryError(err) {
					entry.object, entry.at = nil, time.Time{}
				}
				delay := discoveryFailureBackoff
				if seconds, ok := apierrors.SuggestsClientDelay(err); ok && time.Duration(seconds)*time.Second > delay {
					delay = time.Duration(seconds) * time.Second
				}
				var retry discoveryRetryError
				if errors.As(err, &retry) && retry.delay > delay {
					delay = retry.delay
				}
				entry.err, entry.retry = err, time.Now().Add(delay)
			}
			c.discoveryEntries[key] = entry
		}
	}
	age := discoveryAge(c.discoveryEntries[key].at, time.Now())
	close(flight.done)
	c.discoveryMu.Unlock()
	flight.cancel()
	if err != nil || time.Since(started) >= time.Second {
		logDiscovery(key, started, "refresh", false, discoveryErrorCategory(err), age)
	}
}

func discoveryAge(at, now time.Time) time.Duration {
	if at.IsZero() {
		return -1 // No eligible successful metadata remains.
	}
	return now.Sub(at)
}

func logDiscovery(key string, started time.Time, cache string, stale bool, category string, age time.Duration) {
	stage, gv := "resources", key
	if strings.HasPrefix(key, "/") {
		stage, gv = "directory", ""
	} else if !validDiscoveryGV(key) {
		gv = "" // Do not log unvalidated path text from compatibility callers.
	}
	ageMS := int64(-1)
	if age >= 0 {
		ageMS = age.Milliseconds()
	}
	log.Printf("discovery stage=%s gv=%q duration_ms=%d cache=%s stale=%t error_category=%s age_ms=%d", stage, gv, time.Since(started).Milliseconds(), cache, stale, category, ageMS)
}

type discoveryDecodeError struct{ error }

func (err discoveryDecodeError) Unwrap() error { return err.error }

func transientDiscoveryError(err error) bool {
	switch discoveryErrorCategory(err) {
	case "deadline", "rate_limited", "unavailable", "timeout", "server_timeout", "server", "network":
		return true
	default:
		return false
	}
}

// Return only fixed labels: neither logs nor classification depend on error
// strings, which may contain URLs, response bodies or credentials.
func discoveryErrorCategory(err error) string {
	if err == nil {
		return "none"
	}
	var decode discoveryDecodeError
	if errors.As(err, &decode) {
		return "decode"
	}
	var response discoveryHTTPError
	var status apierrors.APIStatus
	var code int32
	if errors.As(err, &status) {
		code = status.Status().Code
	}
	errors.As(err, &response)
	// Hard authentication/removal wins over contradictory transient reasons,
	// whether it comes from the real HTTP response or the Status body.
	switch {
	case response.status == 401 || code == 401 || apierrors.IsUnauthorized(err):
		return "unauthorized"
	case response.status == 403 || code == 403 || apierrors.IsForbidden(err):
		return "forbidden"
	case response.status == 404 || code == 404 || apierrors.IsNotFound(err):
		return "not_found"
	case errors.Is(err, context.Canceled):
		return "canceled"
	case errors.Is(err, context.DeadlineExceeded):
		return "deadline"
	case apierrors.IsTooManyRequests(err) || response.status == 429:
		return "rate_limited"
	case apierrors.IsServiceUnavailable(err):
		return "unavailable"
	case apierrors.IsTimeout(err) || code == 408 || response.status == 408:
		return "timeout"
	case apierrors.IsServerTimeout(err):
		return "server_timeout"
	case code >= 500 && code <= 599 || response.status >= 500 && response.status <= 599:
		return "server"
	}
	var network net.Error
	if (errors.As(err, &network) && (network.Timeout() || network.Temporary())) ||
		errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) ||
		errors.Is(err, syscall.ECONNRESET) || errors.Is(err, syscall.ECONNREFUSED) || errors.Is(err, syscall.EPIPE) {
		return "network"
	}
	return "unknown"
}

type discoveryHTTPError struct {
	error
	status int
}

func (err discoveryHTTPError) Unwrap() error { return err.error }

// Capture the real response status and header validity before client-go can
// replace malformed Content-Type with a synthetic 500. The dedicated discovery
// transport also preserves Retry-After HTTP-date hints absent from REST Result.
// Core/dynamic clients and their request/retry semantics are not changed.
type discoveryRetryKey struct{}
type discoveryRetryHint struct {
	delay            time.Duration
	status           int
	invalidMediaType bool
}
type discoveryRetryTransport struct{ base http.RoundTripper }

func (transport discoveryRetryTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	base := transport.base
	if base == nil {
		base = http.DefaultTransport
	}
	response, err := base.RoundTrip(request)
	if err == nil && response != nil {
		if hint, ok := request.Context().Value(discoveryRetryKey{}).(*discoveryRetryHint); ok {
			hint.status = response.StatusCode
			if contentType := response.Header.Get("Content-Type"); contentType != "" {
				_, _, parseErr := mime.ParseMediaType(contentType)
				hint.invalidMediaType = parseErr != nil
			}
			if response.StatusCode != http.StatusTooManyRequests {
				return response, err
			}
			value := response.Header.Get("Retry-After")
			if seconds, err := strconv.Atoi(value); err == nil && seconds > 0 {
				// Avoid overflowing time.Duration for malformed server hints.
				if int64(seconds) > int64((1<<63-1)/int64(time.Second)) {
					hint.delay = time.Duration(1<<63 - 1)
				} else {
					hint.delay = time.Duration(seconds) * time.Second
				}
			} else if date, err := http.ParseTime(value); err == nil {
				hint.delay = time.Until(date)
			}
		}
	}
	return response, err
}

type discoveryRetryError struct {
	err   error
	delay time.Duration
}

func (err discoveryRetryError) Error() string { return err.err.Error() }
func (err discoveryRetryError) Unwrap() error { return err.err }

// requestDiscovery performs exactly one HTTP attempt, with no client-go retry
// loop. A failure's Retry-After becomes a cache backoff, not a sleeping request.
func (c *Client) requestDiscovery(ctx context.Context, key string) (runtime.Object, error) {
	if c.Discovery == nil {
		return c.requestLegacyDiscovery(ctx, key)
	}
	var into runtime.Object
	path := key
	switch key {
	case "/api":
		into = &metav1.APIVersions{}
	case "/apis":
		into = &metav1.APIGroupList{}
	default:
		into = &metav1.APIResourceList{}
		path = "/apis/" + key
		if !strings.Contains(key, "/") {
			path = "/api/" + key
		}
	}
	hint := &discoveryRetryHint{}
	ctx = context.WithValue(ctx, discoveryRetryKey{}, hint)
	result := c.Discovery.WithLegacy().RESTClient().Get().AbsPath(path).MaxRetries(0).Do(ctx)
	// Raw preserves Retry-After from HTTP even when a structured Status body
	// omits status.details.retryAfterSeconds (Result.Into would lose the hint).
	_, err := result.Raw()
	if hint.invalidMediaType {
		// client-go turns mime.ParseMediaType failure into a synthetic 500,
		// even for HTTP 200/401/403. Never treat that as a transient outage.
		err = discoveryDecodeError{fmt.Errorf("discovery response has malformed Content-Type")}
	} else if err != nil {
		if seconds, ok := apierrors.SuggestsClientDelay(err); ok && time.Duration(seconds)*time.Second > hint.delay {
			hint.delay = time.Duration(seconds) * time.Second
		}
		// Preserve structured Status reasons and body retryAfterSeconds too.
		if structuredErr := result.Error(); structuredErr != nil {
			err = structuredErr
		}
	} else if decodeErr := result.Into(into); decodeErr != nil {
		err = discoveryDecodeError{decodeErr}
	}
	if err == nil {
		if list, ok := into.(*metav1.APIResourceList); ok && list.GroupVersion != key {
			err = fmt.Errorf("discovery response group/version mismatch")
		}
	}
	if err != nil {
		if hint.status != 0 {
			err = discoveryHTTPError{error: err, status: hint.status}
		}
		if hint.delay > 0 {
			err = discoveryRetryError{err: err, delay: hint.delay}
		}
		return nil, err
	}
	return into, nil
}

// The old interface cannot interrupt a fake/legacy call. The buffered channel
// bounds our waiter, and flight identity still prevents late cache publication.
func (c *Client) requestLegacyDiscovery(ctx context.Context, key string) (runtime.Object, error) {
	if c.Core == nil {
		return nil, fmt.Errorf("Kubernetes discovery client is unavailable")
	}
	type result struct {
		object runtime.Object
		err    error
	}
	results := make(chan result, 1)
	go func() {
		var object runtime.Object
		var err error
		if key == "/groups" {
			var groups *metav1.APIGroupList
			groups, err = c.Core.Discovery().ServerGroups()
			if groups != nil {
				object = groups
			}
		} else {
			var list *metav1.APIResourceList
			list, err = c.Core.Discovery().ServerResourcesForGroupVersion(key)
			if list != nil {
				object = list
			}
		}
		if err == nil {
			if object == nil {
				err = fmt.Errorf("Kubernetes discovery returned no response")
			} else {
				object = object.DeepCopyObject()
			}
		}
		results <- result{object, err}
	}()
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case value := <-results:
		return value.object, value.err
	}
}

// CachedDiscoverySnapshot assembles full discovery through the very same GV
// entry point used by ordinary operations. Healthy GVs retain independent TTLs
// when another aggregation endpoint fails. No aggregate error is success-cached.
func (c *Client) CachedDiscoverySnapshot(ctx context.Context) (DiscoverySnapshot, error, bool) {
	snapshot := DiscoverySnapshot{Preferred: make(map[string]string)}
	generation, err := c.discoveryState()
	if err != nil {
		return snapshot, err, false
	}
	snapshot.Generation = generation
	var versions []string
	var errs []error
	hit := true
	addGroups := func(groups *metav1.APIGroupList) {
		for _, group := range groups.Groups {
			if group.PreferredVersion.Version != "" {
				snapshot.Preferred[group.Name] = group.PreferredVersion.Version
			}
			for _, version := range group.Versions {
				versions = append(versions, schema.GroupVersion{Group: group.Name, Version: version.Version}.String())
			}
		}
	}
	if c.Discovery == nil {
		object, cached, err := c.discoveryLookup(ctx, "/groups", generation, false)
		hit = hit && cached
		if err != nil {
			errs = append(errs, err)
		} else {
			addGroups(object.(*metav1.APIGroupList))
		}
	} else {
		object, cached, err := c.discoveryLookup(ctx, "/api", generation, false)
		hit = hit && cached
		if err != nil {
			errs = append(errs, err)
		} else {
			core := object.(*metav1.APIVersions)
			versions = append(versions, core.Versions...)
			if len(core.Versions) > 0 {
				snapshot.Preferred[""] = core.Versions[0]
			}
		}
		object, cached, err = c.discoveryLookup(ctx, "/apis", generation, false)
		hit = hit && cached
		if err != nil {
			errs = append(errs, err)
		} else {
			addGroups(object.(*metav1.APIGroupList))
		}
	}
	// Malformed/legacy directories may mention a GV more than once. Do not
	// duplicate lists, and do not let duplicate jobs amplify a failed request.
	seen := make(map[string]bool, len(versions))
	unique := versions[:0]
	for _, gv := range versions {
		if !seen[gv] {
			seen[gv] = true
			unique = append(unique, gv)
		}
	}
	versions = unique
	lists := make([]*metav1.APIResourceList, len(versions))
	failures := make([]error, len(versions))
	hits := make([]bool, len(versions))
	jobs := make(chan int)
	var workers sync.WaitGroup
	for worker := 0; worker < 8; worker++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for index := range jobs {
				gv := versions[index]
				if !validDiscoveryGV(gv) {
					failures[index] = fmt.Errorf("invalid discovery group/version")
					continue
				}
				object, cached, err := c.discoveryLookup(ctx, gv, generation, false)
				hits[index], failures[index] = cached, err
				if err == nil {
					lists[index] = object.(*metav1.APIResourceList)
				}
			}
		}()
	}
	for index := range versions {
		jobs <- index
	}
	close(jobs)
	workers.Wait()
	for index, list := range lists {
		hit = hit && hits[index]
		if list != nil {
			snapshot.Lists = append(snapshot.Lists, list)
		}
		if failures[index] != nil {
			errs = append(errs, failures[index])
		}
	}
	c.discoveryMu.Lock()
	defer c.discoveryMu.Unlock()
	if c.discoveryClosed || generation != c.discoveryGeneration || (c.Context != nil && c.Context.Err() != nil) || errors.Is(ctx.Err(), context.Canceled) {
		return DiscoverySnapshot{}, context.Canceled, hit
	}
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		// Only the assembly budget elapsed: keep successful lists from this
		// generation so callers can use them with an explicit partial warning.
		errs = append(errs, fmt.Errorf("discovery snapshot incomplete: %w", context.DeadlineExceeded))
	}
	c.discoveryPreferred = copyPreferred(snapshot.Preferred)
	return snapshot, errors.Join(errs...), hit
}

func copyPreferred(preferred map[string]string) map[string]string {
	result := make(map[string]string, len(preferred))
	for group, version := range preferred {
		result[group] = version
	}
	return result
}

// Compatibility adapters. New consumers must use CachedDiscoverySnapshot,
// rather than separately reading lists and PreferredVersions across a refresh.
func (c *Client) CachedAPIResourceLists() ([]*metav1.APIResourceList, error, bool) {
	return c.CachedAPIResourceListsContext(context.Background())
}

func (c *Client) CachedAPIResourceListsContext(ctx context.Context) ([]*metav1.APIResourceList, error, bool) {
	snapshot, err, hit := c.CachedDiscoverySnapshot(ctx)
	return snapshot.Lists, err, hit
}

func (c *Client) PreferredVersions() map[string]string {
	c.discoveryMu.Lock()
	defer c.discoveryMu.Unlock()
	return copyPreferred(c.discoveryPreferred)
}

func (c *Client) discoverResourceLists(ctx context.Context) ([]*metav1.APIResourceList, map[string]string, error) {
	snapshot, err, _ := c.CachedDiscoverySnapshot(ctx)
	return snapshot.Lists, snapshot.Preferred, err
}

func (c *Client) InvalidateDiscoveryCache() {
	c.discoveryMu.Lock()
	defer c.discoveryMu.Unlock()
	c.resetDiscoveryLocked()
}

func (c *Client) closeDiscoveryCache() {
	c.discoveryMu.Lock()
	defer c.discoveryMu.Unlock()
	c.discoveryClosed = true
	c.resetDiscoveryLocked()
}

func (c *Client) resetDiscoveryLocked() {
	c.discoveryGeneration++
	for _, flight := range c.discoveryFlights {
		close(flight.abort)
		flight.cancel()
	}
	c.discoveryEntries = nil
	c.discoveryFlights = nil
	c.discoveryPreferred = nil
}
