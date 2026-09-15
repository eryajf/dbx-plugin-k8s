package resources

import (
	"context"
	"fmt"
	"strings"

	"github.com/eryajf/dbx-plugin-k8s/internal/kube"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/fields"
	"k8s.io/apimachinery/pkg/labels"
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

// Search deliberately bounds both resource kinds and objects scanned. Kubernetes has no
// server-side substring filter; returning warnings avoids presenting a partial scan as exhaustive.
func search(ctx context.Context, c *kube.Client, req Request) (any, error) {
	catalog, err := discover(c)
	if err != nil {
		return nil, err
	}
	result := SearchResult{Items: []map[string]any{}, Warnings: catalog.Warnings}
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
	seen := map[string]bool{}
	scanned := 0
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
		if scanned >= maxResources {
			result.Truncated = true
			break
		}
		scanned++
		list, e := endpoint(c, r, req.Namespace).List(ctx, metav1.ListOptions{LabelSelector: req.labels(), FieldSelector: req.FieldSelector, Limit: 500})
		if e != nil {
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			result.Warnings = append(result.Warnings, fmt.Sprintf("%s: %v", key, e))
			continue
		}
		if list.GetContinue() != "" {
			result.Truncated = true
			result.Warnings = append(result.Warnings, key+": scan limited to 500 objects")
		}
		query := strings.ToLower(req.Query)
		for _, object := range list.Items {
			if query != "" && !strings.Contains(strings.ToLower(object.GetName()+" "+object.GetNamespace()+" "+labels.Set(object.GetLabels()).String()), query) {
				continue
			}
			result.Items = append(result.Items, map[string]any{"group": r.Group, "version": r.Version, "resource": r.Resource, "kind": r.Kind, "name": object.GetName(), "namespace": object.GetNamespace(), "uid": object.GetUID(), "labels": object.GetLabels()})
			if int64(len(result.Items)) >= max {
				result.Truncated = true
				return result, nil
			}
		}
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
