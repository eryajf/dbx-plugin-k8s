// Package resources adapts Kubernetes resource operations to DBX RPC without an HTTP server.
package resources

import (
	"context"
	"fmt"
	"sort"
	"strings"

	"github.com/eryajf/dbx-plugin-k8s/internal/kube"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"
)

type Resource struct {
	Group      string       `json:"group"`
	Version    string       `json:"version"`
	Resource   string       `json:"resource"`
	Kind       string       `json:"kind"`
	Namespaced bool         `json:"namespaced"`
	Verbs      metav1.Verbs `json:"verbs"`
	Preferred  bool         `json:"-"`
}
type Discovery struct {
	Resources []Resource `json:"resources"`
	Warnings  []string   `json:"warnings"`
}

func discover(c *kube.Client) (*Discovery, error) {
	result, _, err := discoverWithCache(c)
	return result, err
}

func discoverWithCache(c *kube.Client) (*Discovery, bool, error) {
	return discoverWithCacheContext(context.Background(), c)
}

func discoverWithCacheContext(ctx context.Context, c *kube.Client) (*Discovery, bool, error) {
	lists, err, hit := c.CachedAPIResourceListsContext(ctx)
	result := &Discovery{Resources: []Resource{}, Warnings: []string{}}
	preferredVersions := c.PreferredVersions()
	if err != nil {
		if len(lists) == 0 {
			return nil, hit, err
		}
		result.Warnings = append(result.Warnings, err.Error())
	}
	for _, list := range lists {
		gv, e := schema.ParseGroupVersion(list.GroupVersion)
		if e != nil {
			continue
		}
		for _, r := range list.APIResources {
			if strings.Contains(r.Name, "/") {
				continue
			}
			result.Resources = append(result.Resources, Resource{Group: gv.Group, Version: gv.Version, Resource: r.Name, Kind: r.Kind, Namespaced: r.Namespaced, Verbs: r.Verbs, Preferred: preferredVersions[gv.Group] == gv.Version})
		}
	}
	sort.Slice(result.Resources, func(i, j int) bool {
		a, b := result.Resources[i], result.Resources[j]
		return a.Group+"/"+a.Resource+"/"+a.Version < b.Group+"/"+b.Resource+"/"+b.Version
	})
	return result, hit, nil
}
func resolve(ctx context.Context, c *kube.Client, req Request) (Resource, error) {
	if req.Version == "" || req.Resource == "" {
		return Resource{}, fmt.Errorf("version and resource are required")
	}
	for _, value := range []string{req.Group, req.Version, req.Resource, req.Namespace, req.Name} {
		if strings.ContainsAny(value, "/\\?#%") || value == "." || value == ".." {
			return Resource{}, fmt.Errorf("invalid Kubernetes resource path")
		}
	}
	gv := schema.GroupVersion{Group: req.Group, Version: req.Version}
	list, err := c.APIResourcesForGroupVersion(ctx, gv.String())
	if err != nil {
		return Resource{}, err
	}
	for _, r := range list.APIResources {
		if r.Name == req.Resource {
			return Resource{Group: req.Group, Version: req.Version, Resource: r.Name, Kind: r.Kind, Namespaced: r.Namespaced, Verbs: r.Verbs, Preferred: true}, nil
		}
	}
	return Resource{}, fmt.Errorf("resource %s is not served by %s", req.Resource, gv.String())
}

// ResolveResource resolves a served Kubernetes resource for adapters that need
// to build a request outside the regular RPC handler (for example AI tools).
func ResolveResource(c *kube.Client, req Request) (Resource, error) {
	return resolve(context.Background(), c, req)
}
func endpoint(c *kube.Client, r Resource, namespace string) dynamic.ResourceInterface {
	resource := c.Dynamic.Resource(schema.GroupVersionResource{Group: r.Group, Version: r.Version, Resource: r.Resource})
	if r.Namespaced {
		return resource.Namespace(namespace)
	}
	return resource
}
func can(r Resource, verb string) bool {
	for _, v := range r.Verbs {
		if v == verb {
			return true
		}
	}
	return false
}

// Namespaces is kept separate so callers can populate the namespace picker without discovery.
func Namespaces(ctx context.Context, c *kube.Client) (any, error) {
	return c.Core.CoreV1().Namespaces().List(ctx, metav1.ListOptions{})
}
