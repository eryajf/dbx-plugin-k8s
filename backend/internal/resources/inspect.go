package resources

import (
	"context"
	"fmt"
	"log"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/eryajf/dbx-plugin-k8s/internal/kube"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/fields"
	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/apimachinery/pkg/runtime/schema"
)

func describe(ctx context.Context, c *kube.Client, r Resource, req Request) (any, error) {
	object, err := endpoint(c, r, req.Namespace).Get(ctx, req.Name, metav1.GetOptions{})
	if err != nil {
		return nil, err
	}
	result := map[string]any{"object": object, "warnings": []string{}}
	selector := fields.OneTermEqualSelector("involvedObject.uid", string(object.GetUID())).String()
	events, err := c.Core.CoreV1().Events(req.Namespace).List(ctx, metav1.ListOptions{FieldSelector: selector, Limit: 500})
	if err != nil {
		result["warnings"] = []string{fmt.Sprintf("events: %v", err)}
	} else {
		result["events"] = events
	}
	return result, nil
}

type SearchResult struct {
	Items     []map[string]any `json:"items"`
	Warnings  []string         `json:"warnings"`
	Truncated bool             `json:"truncated"`
}

type scoredSearchResult struct {
	item  map[string]any
	score int
	group string
	res   string
	name  string
	ns    string
}

const (
	searchTimeout       = 2 * time.Second
	exactSearchTimeout  = 1200 * time.Millisecond
	searchMinQueryChars = 2
)

var searchResourcePriority = map[string]int{
	"pods": 1, "deployments": 2, "statefulsets": 3, "daemonsets": 4,
	"services": 5, "configmaps": 6, "secrets": 7, "jobs": 8,
	"ingresses": 9, "persistentvolumeclaims": 10, "persistentvolumes": 11,
	"horizontalpodautoscalers": 12, "namespaces": 13, "nodes": 14,
}

func searchMatch(object *unstructured.Unstructured, query string) (int, bool) {
	if query == "" {
		return 7, true
	}
	name := strings.ToLower(object.GetName())
	namespace := strings.ToLower(object.GetNamespace())
	switch {
	case name == query:
		return 0, true
	case strings.HasPrefix(name, query):
		return 1, true
	case strings.Contains(name, query):
		return 2, true
	case namespace == query:
		return 3, true
	case strings.HasPrefix(namespace, query):
		return 4, true
	case strings.Contains(namespace, query):
		return 5, true
	case strings.Contains(strings.ToLower(labels.Set(object.GetLabels()).String()), query):
		return 6, true
	default:
		return 0, false
	}
}

func resourcePriority(resource string) int {
	if priority, ok := searchResourcePriority[resource]; ok {
		return priority
	}
	return len(searchResourcePriority) + 1
}

var builtInSearchResources = []Resource{
	{Group: "", Version: "v1", Resource: "pods", Kind: "Pod", Namespaced: true, Verbs: metav1.Verbs{"list"}},
	{Group: "apps", Version: "v1", Resource: "deployments", Kind: "Deployment", Namespaced: true, Verbs: metav1.Verbs{"list"}},
	{Group: "apps", Version: "v1", Resource: "statefulsets", Kind: "StatefulSet", Namespaced: true, Verbs: metav1.Verbs{"list"}},
	{Group: "apps", Version: "v1", Resource: "daemonsets", Kind: "DaemonSet", Namespaced: true, Verbs: metav1.Verbs{"list"}},
	{Group: "apps", Version: "v1", Resource: "replicasets", Kind: "ReplicaSet", Namespaced: true, Verbs: metav1.Verbs{"list"}},
	{Group: "batch", Version: "v1", Resource: "jobs", Kind: "Job", Namespaced: true, Verbs: metav1.Verbs{"list"}},
	{Group: "batch", Version: "v1", Resource: "cronjobs", Kind: "CronJob", Namespaced: true, Verbs: metav1.Verbs{"list"}},
	{Group: "", Version: "v1", Resource: "services", Kind: "Service", Namespaced: true, Verbs: metav1.Verbs{"list"}},
	{Group: "", Version: "v1", Resource: "configmaps", Kind: "ConfigMap", Namespaced: true, Verbs: metav1.Verbs{"list"}},
	{Group: "", Version: "v1", Resource: "secrets", Kind: "Secret", Namespaced: true, Verbs: metav1.Verbs{"list"}},
	{Group: "networking.k8s.io", Version: "v1", Resource: "ingresses", Kind: "Ingress", Namespaced: true, Verbs: metav1.Verbs{"list"}},
	{Group: "", Version: "v1", Resource: "persistentvolumeclaims", Kind: "PersistentVolumeClaim", Namespaced: true, Verbs: metav1.Verbs{"list"}},
	{Group: "", Version: "v1", Resource: "persistentvolumes", Kind: "PersistentVolume", Namespaced: false, Verbs: metav1.Verbs{"list"}},
	{Group: "autoscaling", Version: "v2", Resource: "horizontalpodautoscalers", Kind: "HorizontalPodAutoscaler", Namespaced: true, Verbs: metav1.Verbs{"list"}},
	{Group: "", Version: "v1", Resource: "namespaces", Kind: "Namespace", Namespaced: false, Verbs: metav1.Verbs{"list"}},
	{Group: "", Version: "v1", Resource: "nodes", Kind: "Node", Namespaced: false, Verbs: metav1.Verbs{"list"}},
}

var searchResourceAliases = map[string]string{
	"po": "pods", "pod": "pods", "pods": "pods",
	"svc": "services", "service": "services", "services": "services",
	"cm": "configmaps", "configmap": "configmaps", "configmaps": "configmaps",
	"dep": "deployments", "deploy": "deployments", "deployment": "deployments", "deployments": "deployments",
	"ds": "daemonsets", "daemonset": "daemonsets", "daemonsets": "daemonsets",
	"statefulset": "statefulsets", "statefulsets": "statefulsets",
	"job": "jobs", "jobs": "jobs", "cronjob": "cronjobs", "cronjobs": "cronjobs",
	"secret": "secrets", "secrets": "secrets",
	"pv": "persistentvolumes", "persistentvolume": "persistentvolumes", "persistentvolumes": "persistentvolumes",
	"pvc": "persistentvolumeclaims", "persistentvolumeclaim": "persistentvolumeclaims", "persistentvolumeclaims": "persistentvolumeclaims",
	"hpa": "horizontalpodautoscalers", "horizontalpodautoscaler": "horizontalpodautoscalers", "horizontalpodautoscalers": "horizontalpodautoscalers",
}

func splitSearchQuery(raw string) (resource, query string) {
	parts := strings.Fields(raw)
	if len(parts) > 1 {
		if alias, ok := searchResourceAliases[strings.ToLower(parts[0])]; ok {
			return alias, strings.Join(parts[1:], " ")
		}
	}
	return "", strings.TrimSpace(raw)
}

// Search starts with the stable core Kubernetes catalog so a slow discovery
// endpoint or unhealthy CRD cannot delay common Deployment/Pod searches.
func search(ctx context.Context, c *kube.Client, req Request) (any, error) {
	started := time.Now()
	searchCtx, cancelSearch := context.WithTimeout(ctx, searchTimeout)
	defer cancelSearch()
	global := req.Group == "" && req.Version == "" && req.Resource == ""
	var staticResult SearchResult
	haveStaticResult := false
	if global {
		resource, query := splitSearchQuery(req.Query)
		req.Query = query
		if resource != "" {
			req.Resource = resource
		}
		if resource != "" && len([]rune(query)) >= searchMinQueryChars && !strings.ContainsAny(query, " \t\r\n") {
			exactReq := req
			exactReq.FieldSelector = searchNameFieldSelector(req.FieldSelector, query)
			fast, err := searchCatalogWithTimeout(searchCtx, c, exactReq, &Discovery{Resources: builtInSearchResources}, false, started, exactSearchTimeout)
			if err != nil {
				return nil, err
			}
			if result, ok := fast.(SearchResult); ok && len(result.Items) > 0 {
				return result, nil
			}
		}
		fast, err := searchCatalogWithTimeout(searchCtx, c, req, &Discovery{Resources: builtInSearchResources}, false, started, searchTimeout)
		if err != nil {
			return nil, err
		}
		if result, ok := fast.(SearchResult); ok {
			staticResult = result
			haveStaticResult = true
			limit := req.Limit
			if limit <= 0 {
				limit = 200
			}
			// Continue to discovery when the core catalog did not fill the
			// requested result window. This keeps same-name and supplementary CRD
			// matches visible without scanning custom resources when the result set
			// is already complete.
			if strings.TrimSpace(req.Query) == "" || int64(len(result.Items)) >= limit {
				return result, nil
			}
		}
		// An explicit built-in resource scope is complete after the static
		// catalog scan. Do not pay the discovery cost just to prove a missing
		// Deployment/Pod name is absent.
		if resource != "" {
			return fast, nil
		}
	}
	// Discovery is part of the interactive search path and must not inherit the
	// much longer general RPC timeout. Aggregated API servers can otherwise leave
	// Cmd+K waiting for tens of seconds before the CRD fallback is attempted.
	catalog, discoveryHit, err := discoverWithCacheContext(searchCtx, c)
	if err != nil {
		// Core resources were already queried above. Discovery includes optional
		// API groups and should not erase useful Deployment/Pod results when an
		// aggregated endpoint is unavailable. Preserve cancellation from the
		// caller, but otherwise return the partial result with an explicit warning.
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		if haveStaticResult && len(staticResult.Items) > 0 {
			warnings := append([]string{}, staticResult.Warnings...)
			warnings = append(warnings, fmt.Sprintf("resource discovery unavailable: %v; core results may be incomplete", err))
			sort.Strings(warnings)
			staticResult.Warnings = warnings
			staticResult.Truncated = true
			return staticResult, nil
		}
		return nil, err
	}
	if len(catalog.Resources) == 0 && haveStaticResult {
		// Compatibility clients may not expose discovery data even though their
		// dynamic client can list the stable built-in resources.
		return staticResult, nil
	}
	return searchCatalogWithTimeout(searchCtx, c, req, catalog, discoveryHit, started, searchTimeout)
}

func searchNameFieldSelector(existing, name string) string {
	exact := fields.OneTermEqualSelector("metadata.name", strings.ToLower(name))
	if strings.TrimSpace(existing) == "" {
		return exact.String()
	}
	selector, err := fields.ParseSelector(existing)
	if err != nil {
		// Preserve the caller's selector. The API server will return the same
		// validation error it would have returned before the exact-search hint.
		return existing
	}
	return fields.AndSelectors(selector, exact).String()
}

// Search deliberately bounds both resource kinds and objects scanned. Kubernetes has no
// server-side substring filter; parallel collection plus deterministic ranking keeps the
// fast name/namespace stage responsive while labels provide a second-stage fallback.
func searchCatalog(ctx context.Context, c *kube.Client, req Request, catalog *Discovery, discoveryHit bool, started time.Time) (any, error) {
	return searchCatalogWithTimeout(ctx, c, req, catalog, discoveryHit, started, searchTimeout)
}

func searchCatalogWithTimeout(ctx context.Context, c *kube.Client, req Request, catalog *Discovery, discoveryHit bool, started time.Time, timeout time.Duration) (any, error) {
	warnings := append([]string{}, catalog.Warnings...)
	result := SearchResult{Items: []map[string]any{}, Warnings: warnings}
	max := req.Limit
	if max <= 0 {
		max = 200
	}
	if max > 1000 {
		max = 1000
	}
	maxResources := req.MaxResources
	if maxResources <= 0 {
		maxResources = 80
	}
	if maxResources > 200 {
		maxResources = 200
	}
	candidates := make([]Resource, 0, maxResources)
	seen := map[string]bool{}
	for _, r := range catalog.Resources {
		if !can(r, "list") || (r.Resource == "secrets" && req.Resource != "secrets") {
			continue
		}
		if req.Resource != "" && req.Resource != r.Resource {
			continue
		}
		if req.Group != "" && req.Group != r.Group {
			continue
		}
		if req.Version != "" && req.Version != r.Version {
			continue
		}
		key := r.Group + "/" + r.Resource
		if seen[key] {
			continue
		}
		seen[key] = true
		candidates = append(candidates, r)
	}
	// Select the bounded catalog only after prioritizing built-in GVRs. Both
	// search phases use this order, so custom groups cannot displace resources
	// already scanned by the static phase when discovery exceeds the limit.
	builtIn := make(map[schema.GroupVersionResource]bool, len(builtInSearchResources))
	for _, r := range builtInSearchResources {
		builtIn[schema.GroupVersionResource{Group: r.Group, Version: r.Version, Resource: r.Resource}] = true
	}
	sort.SliceStable(candidates, func(i, j int) bool {
		a, b := candidates[i], candidates[j]
		ai := builtIn[schema.GroupVersionResource{Group: a.Group, Version: a.Version, Resource: a.Resource}]
		bi := builtIn[schema.GroupVersionResource{Group: b.Group, Version: b.Version, Resource: b.Resource}]
		if ai != bi {
			return ai
		}
		pi, pj := resourcePriority(candidates[i].Resource), resourcePriority(candidates[j].Resource)
		if pi != pj {
			return pi < pj
		}
		return candidates[i].Group+"/"+candidates[i].Resource+"/"+candidates[i].Version < candidates[j].Group+"/"+candidates[j].Resource+"/"+candidates[j].Version
	})
	if len(candidates) > maxResources {
		result.Truncated = true
		result.Warnings = append(result.Warnings, fmt.Sprintf("search limited to %d resource types; results may be incomplete", maxResources))
		candidates = candidates[:maxResources]
	}

	type listResult struct {
		resource Resource
		list     *unstructured.UnstructuredList
		err      error
	}
	searchCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	results := make(chan listResult, len(candidates))
	sem := make(chan struct{}, 8)
	var wg sync.WaitGroup
	for _, resource := range candidates {
		wg.Add(1)
		go func(r Resource) {
			defer wg.Done()
			select {
			case sem <- struct{}{}:
			case <-searchCtx.Done():
				results <- listResult{resource: r, err: searchCtx.Err()}
				return
			}
			defer func() { <-sem }()
			var list *unstructured.UnstructuredList
			var listErr error
			func() {
				defer func() {
					if recovered := recover(); recovered != nil {
						listErr = fmt.Errorf("list failed: %v", recovered)
					}
				}()
				options := metav1.ListOptions{LabelSelector: req.labels(), FieldSelector: req.FieldSelector, Limit: 500}
				namespace := req.Namespace
				if !r.Namespaced {
					namespace = ""
				}
				list, _, listErr = c.SearchResourceList(searchCtx, schema.GroupVersionResource{Group: r.Group, Version: r.Version, Resource: r.Resource}, namespace, options)
			}()
			results <- listResult{resource: r, list: list, err: listErr}
		}(resource)
	}
	wg.Wait()
	close(results)

	query := strings.ToLower(strings.TrimSpace(req.Query))
	scored := make([]scoredSearchResult, 0)
	timeoutWarning := false
	for listed := range results {
		key := listed.resource.Group + "/" + listed.resource.Resource
		if listed.err != nil {
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			if searchCtx.Err() != nil {
				result.Truncated = true
				if !timeoutWarning {
					result.Warnings = append(result.Warnings, fmt.Sprintf("search timed out after %s; results may be incomplete", timeout.Round(time.Millisecond)))
					timeoutWarning = true
				}
				continue
			}
			result.Warnings = append(result.Warnings, fmt.Sprintf("%s: %v", key, listed.err))
			continue
		}
		if listed.list.GetContinue() != "" {
			result.Truncated = true
			result.Warnings = append(result.Warnings, key+": scan limited to 500 objects")
		}
		for _, object := range listed.list.Items {
			score, matched := searchMatch(&object, query)
			if !matched {
				continue
			}
			scored = append(scored, scoredSearchResult{
				item:  map[string]any{"group": listed.resource.Group, "version": listed.resource.Version, "resource": listed.resource.Resource, "kind": listed.resource.Kind, "name": object.GetName(), "namespace": object.GetNamespace(), "uid": object.GetUID(), "labels": object.GetLabels()},
				score: score, group: listed.resource.Group, res: listed.resource.Resource, name: object.GetName(), ns: object.GetNamespace(),
			})
		}
	}
	sort.SliceStable(scored, func(i, j int) bool {
		if scored[i].score != scored[j].score {
			return scored[i].score < scored[j].score
		}
		pi, pj := resourcePriority(scored[i].res), resourcePriority(scored[j].res)
		if pi != pj {
			return pi < pj
		}
		if scored[i].name != scored[j].name {
			return scored[i].name < scored[j].name
		}
		if scored[i].ns != scored[j].ns {
			return scored[i].ns < scored[j].ns
		}
		return scored[i].group+"/"+scored[i].res < scored[j].group+"/"+scored[j].res
	})
	if int64(len(scored)) > max {
		result.Truncated = true
		scored = scored[:max]
	}
	for _, item := range scored {
		result.Items = append(result.Items, item.item)
	}
	sort.Strings(result.Warnings)
	if elapsed := time.Since(started); elapsed >= time.Second {
		log.Printf("resource search slow query_length=%d resources=%d results=%d truncated=%t discovery_cache_hit=%t duration_ms=%d", len(query), len(candidates), len(result.Items), result.Truncated, discoveryHit, elapsed.Milliseconds())
	}
	return result, nil
}

type Link struct {
	Group     string `json:"group"`
	Version   string `json:"version"`
	Resource  string `json:"resource"`
	Kind      string `json:"kind"`
	Name      string `json:"name"`
	Namespace string `json:"namespace"`
	Reason    string `json:"reason"`
	Direction string `json:"direction"`
}

// Related follows owner references and the same selector/reference relationships used
// by Kite's resource views. Discovery supplies scope and plural names for custom kinds.
func related(ctx context.Context, c *kube.Client, r Resource, req Request) (any, error) {
	object, err := endpoint(c, r, req.Namespace).Get(ctx, req.Name, metav1.GetOptions{})
	if err != nil {
		return nil, err
	}
	catalog, err := discover(c)
	if err != nil {
		return nil, err
	}
	links := []Link{}
	warnings := catalog.Warnings
	seen := map[string]bool{}
	add := func(target Resource, ns, name, reason, direction string) {
		if name == "" {
			return
		}
		key := target.Group + "/" + target.Resource + "/" + ns + "/" + name
		if seen[key] {
			return
		}
		seen[key] = true
		links = append(links, Link{target.Group, target.Version, target.Resource, target.Kind, name, ns, reason, direction})
	}
	find := func(group, resource string) (Resource, bool) {
		for _, candidate := range catalog.Resources {
			if candidate.Group == group && candidate.Resource == resource {
				return candidate, true
			}
		}
		return Resource{}, false
	}
	reference := func(group, resource, ns, name, reason string) {
		if target, ok := find(group, resource); ok {
			add(target, ns, name, reason, "references")
		}
	}
	for _, owner := range object.GetOwnerReferences() {
		for _, target := range catalog.Resources {
			gv := target.Version
			if target.Group != "" {
				gv = target.Group + "/" + target.Version
			}
			if owner.APIVersion == gv && owner.Kind == target.Kind {
				ns := ""
				if target.Namespaced {
					ns = req.Namespace
				}
				add(target, ns, owner.Name, "owner reference", "owned-by")
				break
			}
		}
	}
	// Candidate child types are bounded; each list failure is visible rather than fatal.
	for _, pair := range [][2]string{{"apps", "replicasets"}, {"apps", "controllerrevisions"}, {"", "pods"}, {"batch", "jobs"}} {
		target, ok := find(pair[0], pair[1])
		if !ok {
			continue
		}
		list, e := endpoint(c, target, req.Namespace).List(ctx, metav1.ListOptions{Limit: 1000})
		if e != nil {
			warnings = append(warnings, fmt.Sprintf("%s: %v", target.Resource, e))
			continue
		}
		if list.GetContinue() != "" {
			warnings = append(warnings, target.Resource+": related scan limited to 1000 objects")
		}
		for _, child := range list.Items {
			for _, owner := range child.GetOwnerReferences() {
				if object.GetUID() != "" && owner.UID == object.GetUID() {
					add(target, child.GetNamespace(), child.GetName(), "owner reference", "owns")
				}
			}
		}
	}
	switch r.Resource {
	case "services":
		selectors, _, _ := unstructured.NestedStringMap(object.Object, "spec", "selector")
		if len(selectors) > 0 {
			if target, ok := find("", "pods"); ok {
				list, e := endpoint(c, target, req.Namespace).List(ctx, metav1.ListOptions{LabelSelector: labels.Set(selectors).String(), Limit: 500})
				if e != nil {
					warnings = append(warnings, e.Error())
				} else {
					for _, pod := range list.Items {
						add(target, pod.GetNamespace(), pod.GetName(), "service selector", "selects")
					}
				}
			}
		}
		if target, ok := find("discovery.k8s.io", "endpointslices"); ok {
			list, e := endpoint(c, target, req.Namespace).List(ctx, metav1.ListOptions{LabelSelector: labels.Set{"kubernetes.io/service-name": req.Name}.String(), Limit: 500})
			if e != nil {
				warnings = append(warnings, e.Error())
			} else {
				for _, item := range list.Items {
					add(target, item.GetNamespace(), item.GetName(), "service endpoints", "references")
				}
			}
		}
	case "persistentvolumeclaims":
		name, _, _ := unstructured.NestedString(object.Object, "spec", "volumeName")
		reference("", "persistentvolumes", "", name, "bound volume")
	case "persistentvolumes":
		name, _, _ := unstructured.NestedString(object.Object, "spec", "claimRef", "name")
		ns, _, _ := unstructured.NestedString(object.Object, "spec", "claimRef", "namespace")
		reference("", "persistentvolumeclaims", ns, name, "volume claim")
	case "ingresses":
		name, _, _ := unstructured.NestedString(object.Object, "spec", "defaultBackend", "service", "name")
		reference("", "services", req.Namespace, name, "default ingress backend")
		rules, _, _ := unstructured.NestedSlice(object.Object, "spec", "rules")
		for _, rule := range rules {
			m, ok := rule.(map[string]any)
			if !ok {
				continue
			}
			paths, _, _ := unstructured.NestedSlice(m, "http", "paths")
			for _, path := range paths {
				p, ok := path.(map[string]any)
				if !ok {
					continue
				}
				name, _, _ := unstructured.NestedString(p, "backend", "service", "name")
				reference("", "services", req.Namespace, name, "ingress backend")
			}
		}
	case "pods":
		volumes, _, _ := unstructured.NestedSlice(object.Object, "spec", "volumes")
		for _, volume := range volumes {
			v, ok := volume.(map[string]any)
			if !ok {
				continue
			}
			name, _, _ := unstructured.NestedString(v, "persistentVolumeClaim", "claimName")
			reference("", "persistentvolumeclaims", req.Namespace, name, "mounted claim")
		}
		node, _, _ := unstructured.NestedString(object.Object, "spec", "nodeName")
		reference("", "nodes", "", node, "scheduled node")
	}
	return map[string]any{"items": links, "warnings": warnings}, nil
}
