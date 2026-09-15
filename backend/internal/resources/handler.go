package resources

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/eryajf/dbx-plugin-k8s/internal/kube"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/yaml"
)

type Request struct {
	Group           string          `json:"group"`
	Version         string          `json:"version"`
	Resource        string          `json:"resource"`
	Namespace       string          `json:"namespace"`
	Name            string          `json:"name"`
	Object          map[string]any  `json:"object"`
	YAML            string          `json:"yaml"`
	Patch           json.RawMessage `json:"patch"`
	PatchType       string          `json:"patchType"`
	LabelSelector   string          `json:"labelSelector"`
	Selector        string          `json:"selector"`
	FieldSelector   string          `json:"fieldSelector"`
	Limit           int64           `json:"limit"`
	Continue        string          `json:"continue"`
	DryRun          bool            `json:"dryRun"`
	UID             string          `json:"uid"`
	ResourceVersion string          `json:"resourceVersion"`
	Query           string          `json:"query"`
	MaxResources    int             `json:"maxResources"`
}

func Handle(ctx context.Context, c *kube.Client, method string, raw json.RawMessage) (any, error) {
	var req Request
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &req); err != nil {
			return nil, fmt.Errorf("invalid request: %w", err)
		}
	}
	if c == nil || c.Core == nil || c.Dynamic == nil {
		return nil, fmt.Errorf("Kubernetes connection is unavailable")
	}
	if method == "kube/discover" {
		return discover(c)
	}
	if method == "kube/namespaces" {
		return Namespaces(ctx, c)
	}
	if method == "resource/search" || method == "kube/search" {
		return search(ctx, c, req)
	}
	switch method {
	case "resource/list", "resource/get", "resource/create", "resource/update", "resource/patch", "resource/delete", "resource/describe", "resource/related", "resource/apply":
	default:
		return nil, fmt.Errorf("unknown resource method: %s", method)
	}
	r, err := resolve(c, req)
	if err != nil {
		return nil, err
	}
	write := method == "resource/create" || method == "resource/update" || method == "resource/apply" || method == "resource/patch" || method == "resource/delete"
	if !r.Namespaced && req.Namespace != "" {
		return nil, fmt.Errorf("%s is cluster scoped; namespace must be empty", r.Resource)
	}
	if r.Namespaced && req.Namespace == "" && (write || method != "resource/list") {
		return nil, fmt.Errorf("namespace is required for %s", method)
	}
	if method != "resource/list" && method != "resource/create" && req.Name == "" {
		return nil, fmt.Errorf("name is required for %s", method)
	}
	api := endpoint(c, r, req.Namespace)
	dry := []string(nil)
	if req.DryRun {
		dry = []string{metav1.DryRunAll}
	}
	switch method {
	case "resource/list":
		if req.Limit < 0 || req.Limit > 10000 {
			return nil, fmt.Errorf("limit must be between 0 and 10000")
		}
		return api.List(ctx, metav1.ListOptions{LabelSelector: req.labels(), FieldSelector: req.FieldSelector, Limit: req.Limit, Continue: req.Continue, ResourceVersion: req.ResourceVersion})
	case "resource/get":
		return api.Get(ctx, req.Name, metav1.GetOptions{})
	case "resource/describe":
		return describe(ctx, c, r, req)
	case "resource/related":
		return related(ctx, c, r, req)
	case "resource/create", "resource/update", "resource/apply":
		object, err := decodeObject(req, r)
		if err != nil {
			return nil, err
		}
		if method == "resource/create" {
			return api.Create(ctx, object, metav1.CreateOptions{DryRun: dry, FieldManager: "dbx-kubernetes"})
		}
		if method == "resource/update" {
			if object.GetResourceVersion() == "" {
				return nil, fmt.Errorf("metadata.resourceVersion is required for update; reload the resource before editing")
			}
			return api.Update(ctx, object, metav1.UpdateOptions{DryRun: dry, FieldManager: "dbx-kubernetes"})
		}
		body, err := json.Marshal(object.Object)
		if err != nil {
			return nil, err
		}
		return api.Patch(ctx, req.Name, types.ApplyPatchType, body, metav1.PatchOptions{DryRun: dry, FieldManager: "dbx-kubernetes"})
	case "resource/patch":
		if len(req.Patch) == 0 || !json.Valid(req.Patch) {
			return nil, fmt.Errorf("patch must contain valid JSON")
		}
		typ := types.MergePatchType
		switch req.PatchType {
		case "", "merge", "application/merge-patch+json":
		case "json", "application/json-patch+json":
			typ = types.JSONPatchType
		case "strategic", "application/strategic-merge-patch+json":
			typ = types.StrategicMergePatchType
		default:
			return nil, fmt.Errorf("unsupported patchType")
		}
		if err := validatePatch(req, typ); err != nil {
			return nil, err
		}
		return api.Patch(ctx, req.Name, typ, req.Patch, metav1.PatchOptions{DryRun: dry, FieldManager: "dbx-kubernetes"})
	case "resource/delete":
		options := metav1.DeleteOptions{DryRun: dry}
		if req.UID != "" || req.ResourceVersion != "" {
			options.Preconditions = &metav1.Preconditions{}
			if req.UID != "" {
				uid := types.UID(req.UID)
				options.Preconditions.UID = &uid
			}
			if req.ResourceVersion != "" {
				options.Preconditions.ResourceVersion = &req.ResourceVersion
			}
		}
		if err := api.Delete(ctx, req.Name, options); err != nil {
			return nil, err
		}
		return map[string]any{"deleted": true, "name": req.Name, "namespace": req.Namespace, "dryRun": req.DryRun}, nil
	}
	return nil, fmt.Errorf("unhandled method %s", method)
}
func (r Request) labels() string {
	if r.LabelSelector != "" {
		return r.LabelSelector
	}
	return r.Selector
}
func decodeObject(req Request, r Resource) (*unstructured.Unstructured, error) {
	data := req.Object
	if req.YAML != "" {
		if data != nil {
			return nil, fmt.Errorf("provide object or yaml, not both")
		}
		if err := yaml.UnmarshalStrict([]byte(req.YAML), &data); err != nil {
			return nil, fmt.Errorf("invalid YAML: %w", err)
		}
	}
	if data == nil {
		return nil, fmt.Errorf("object or yaml is required")
	}
	// JSON roundtrip normalizes numeric YAML values for unstructured clients and isolates caller data.
	encoded, err := json.Marshal(data)
	if err != nil {
		return nil, err
	}
	var normalized map[string]any
	if err = json.Unmarshal(encoded, &normalized); err != nil {
		return nil, err
	}
	object := &unstructured.Unstructured{Object: normalized}
	apiVersion := r.Version
	if r.Group != "" {
		apiVersion = r.Group + "/" + r.Version
	}
	if object.GetAPIVersion() != "" && object.GetAPIVersion() != apiVersion {
		return nil, fmt.Errorf("object apiVersion does not match requested resource")
	}
	if object.GetKind() != "" && object.GetKind() != r.Kind {
		return nil, fmt.Errorf("object kind does not match requested resource")
	}
	object.SetAPIVersion(apiVersion)
	object.SetKind(r.Kind)
	if req.Name != "" {
		if object.GetName() != "" && object.GetName() != req.Name {
			return nil, fmt.Errorf("metadata.name does not match requested name")
		}
		object.SetName(req.Name)
	}
	if object.GetName() == "" && object.GetGenerateName() == "" {
		return nil, fmt.Errorf("metadata.name or metadata.generateName is required")
	}
	if strings.ContainsAny(object.GetName(), "/\\?#%") {
		return nil, fmt.Errorf("invalid metadata.name")
	}
	if object.GetNamespace() != "" && object.GetNamespace() != req.Namespace {
		return nil, fmt.Errorf("metadata.namespace does not match requested namespace")
	}
	if r.Namespaced {
		object.SetNamespace(req.Namespace)
	} else if object.GetNamespace() != "" {
		return nil, fmt.Errorf("cluster scoped object cannot have namespace")
	}
	return object, nil
}
func validatePatch(req Request, typ types.PatchType) error {
	if typ == types.JSONPatchType {
		var ops []struct {
			Op   string `json:"op"`
			Path string `json:"path"`
			From string `json:"from"`
		}
		if err := json.Unmarshal(req.Patch, &ops); err != nil {
			return err
		}
		for _, op := range ops {
			for _, p := range []string{op.Path, op.From} {
				if p == "" && op.Path != "" {
					continue
				}
				if p == "" || p == "/metadata" || p == "/metadata/name" || p == "/metadata/namespace" || p == "/apiVersion" || p == "/kind" {
					if op.Op != "test" {
						return fmt.Errorf("JSON patch cannot replace resource identity")
					}
				}
			}
		}
		return nil
	}
	var object map[string]any
	if err := json.Unmarshal(req.Patch, &object); err != nil {
		return err
	}
	if object == nil {
		return fmt.Errorf("patch must be an object")
	}
	if metadata, ok := object["metadata"]; ok {
		m, ok := metadata.(map[string]any)
		if !ok {
			return fmt.Errorf("patch metadata must be an object")
		}
		for field, expected := range map[string]string{"name": req.Name, "namespace": req.Namespace} {
			if v, ok := m[field]; ok && v != expected {
				return fmt.Errorf("patch metadata.%s does not match requested identity", field)
			}
		}
	}
	if v, ok := object["apiVersion"]; ok {
		expected := req.Version
		if req.Group != "" {
			expected = req.Group + "/" + req.Version
		}
		if v != expected {
			return fmt.Errorf("patch cannot change apiVersion")
		}
	}
	return nil
}
