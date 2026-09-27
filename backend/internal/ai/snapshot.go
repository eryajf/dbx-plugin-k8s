// Package ai builds bounded, redacted snapshots for DBX's built-in AI panel.
package ai

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/eryajf/dbx-plugin-k8s/internal/connection"
	"github.com/eryajf/dbx-plugin-k8s/internal/kube"
	"github.com/eryajf/dbx-plugin-k8s/internal/operations"
	"github.com/eryajf/dbx-plugin-k8s/internal/resources"
)

// Leave headroom for the page metadata added by the UI before handing context to DBX.
const maxSnapshotBytes = (2 << 20) - (16 << 10)

type request struct {
	ConnectionID string `json:"connectionId"`
	Page         struct {
		Route     string `json:"route"`
		Resource  string `json:"resource"`
		Group     string `json:"group"`
		Version   string `json:"version"`
		Namespace string `json:"namespace"`
		Name      string `json:"name"`
	} `json:"page"`
}

// Snapshot returns the current workbench context without credentials or large
// Kubernetes objects. Individual fetch failures become warnings so the AI
// panel still opens with the data that was available.
func Snapshot(ctx context.Context, client *kube.Client, raw json.RawMessage) (map[string]any, error) {
	var req request
	if len(raw) > 0 && string(raw) != "null" {
		if err := json.Unmarshal(raw, &req); err != nil {
			return nil, fmt.Errorf("invalid AI snapshot request: %w", err)
		}
	}
	if client == nil || client.Core == nil || client.Dynamic == nil {
		return nil, fmt.Errorf("Kubernetes connection is unavailable")
	}
	page := map[string]any{"route": req.Page.Route}
	for key, value := range map[string]string{
		"resource": req.Page.Resource, "group": req.Page.Group, "version": req.Page.Version,
		"namespace": req.Page.Namespace, "name": req.Page.Name,
	} {
		if value != "" {
			if len(value) > 512 {
				value = value[:512] + "…"
			}
			page[key] = value
		}
	}
	result := map[string]any{
		"schemaVersion": 1,
		"source":        "io.dbx.k8s",
		"capturedAt":    time.Now().UTC().Format(time.RFC3339),
		"page":          page,
		"cluster":       map[string]any{"connectionId": req.ConnectionID, "context": client.ContextName, "namespace": client.Namespace},
		"data":          map[string]any{},
		"warnings":      []string{},
		"truncated":     false,
	}
	warnings := result["warnings"].([]string)
	data := result["data"].(map[string]any)

	if info, err := connection.Probe(ctx, client); err != nil {
		warnings = append(warnings, warning("cluster info unavailable: "+err.Error()))
	} else {
		data["clusterInfo"] = info
	}
	if req.Page.Resource == "" {
		if overview, err := operations.Handle(ctx, client, "kube/overview", []byte(`{}`)); err != nil {
			warnings = append(warnings, warning("cluster overview unavailable: "+err.Error()))
		} else {
			data["overview"] = overview
		}
	}
	eventRequest := map[string]any{"limit": int64(50)}
	if req.Page.Namespace != "" {
		eventRequest["namespace"] = req.Page.Namespace
	}
	if events, err := operations.Handle(ctx, client, "kube/recent-events", marshal(eventRequest)); err != nil {
		warnings = append(warnings, warning("recent events unavailable: "+err.Error()))
	} else {
		data["recentEvents"] = events
	}

	resourceName := req.Page.Resource
	if resourceName != "" {
		group, version := req.Page.Group, req.Page.Version
		if version == "" {
			discovery, err := resources.Handle(ctx, client, "kube/discover", []byte(`{}`))
			if err != nil {
				warnings = append(warnings, warning("resource discovery unavailable: "+err.Error()))
			} else if d, ok := discovery.(*resources.Discovery); ok {
				for _, candidate := range d.Resources {
					if candidate.Resource == resourceName || strings.EqualFold(candidate.Kind, resourceName) {
						group, version = candidate.Group, candidate.Version
						resourceName = candidate.Resource
						break
					}
				}
			}
		}
		if version == "" {
			warnings = append(warnings, warning("resource version could not be resolved"))
		} else {
			served, err := resources.ResolveResource(client, resources.Request{Group: group, Version: version, Resource: resourceName})
			if err != nil {
				warnings = append(warnings, warning("resource scope unavailable: "+err.Error()))
			} else {
				namespace := req.Page.Namespace
				if !served.Namespaced {
					namespace = ""
				} else if namespace == "" {
					namespace = client.Namespace
				}
				base := map[string]any{"group": group, "version": version, "resource": resourceName, "namespace": namespace, "limit": int64(50)}
				if req.Page.Name != "" {
					base["name"] = req.Page.Name
					if object, err := resources.Handle(ctx, client, "resource/get", marshal(base)); err != nil {
						warnings = append(warnings, warning("resource unavailable: "+err.Error()))
					} else {
						data["resource"] = object
					}
					if described, err := resources.Handle(ctx, client, "resource/describe", marshal(base)); err == nil {
						data["description"] = described
					}
				} else if listed, err := resources.Handle(ctx, client, "resource/list", marshal(base)); err != nil {
					warnings = append(warnings, warning("resource list unavailable: "+err.Error()))
				} else {
					data["resources"] = listed
				}
			}
		}
	}
	result["warnings"] = warnings
	clean, ok := sanitize(normalize(result)).(map[string]any)
	if !ok {
		return nil, fmt.Errorf("failed to serialize AI snapshot")
	}
	clean, truncated := fit(clean)
	clean["truncated"] = truncated
	if len(marshal(clean)) > maxSnapshotBytes {
		clean["data"] = map[string]any{}
		clean["warnings"] = []any{"snapshot exceeded 2 MiB and was reduced"}
		clean["truncated"] = true
	}
	return clean, nil
}

func marshal(value any) []byte {
	encoded, _ := json.Marshal(value)
	return encoded
}

func warning(value string) string {
	if len(value) > 512 {
		return value[:512] + "…"
	}
	return value
}

func sanitize(value any) any {
	switch v := value.(type) {
	case map[string]any:
		out := make(map[string]any, len(v))
		kind := strings.ToLower(fmt.Sprint(v["kind"]))
		for key, item := range v {
			lower := strings.ToLower(key)
			if lower == "managedfields" || lower == "stringdata" || lower == "binarydata" || (lower == "data" && (kind == "secret" || kind == "configmap")) {
				out[key] = "[REDACTED]"
				continue
			}
			if strings.Contains(lower, "token") || strings.Contains(lower, "password") || strings.Contains(lower, "privatekey") || lower == "clientkey" {
				out[key] = "[REDACTED]"
				continue
			}
			if lower == "env" {
				out[key] = sanitizeEnv(item)
			} else {
				out[key] = sanitize(item)
			}
		}
		return out
	case []any:
		out := make([]any, len(v))
		for i, item := range v {
			out[i] = sanitize(item)
		}
		return out
	case string:
		v = redactText(v)
		if len(v) > 32*1024 {
			return v[:32*1024] + "…[truncated]"
		}
		return v
	default:
		return value
	}
}

var (
	bearerPattern     = regexp.MustCompile(`(?i)\bbearer\s+[A-Za-z0-9._~+/=-]+`)
	secretTextPattern = regexp.MustCompile(`(?i)\b(token|password|secret|api[_-]?key|private[_-]?key|client[_-]?key)\s*[:=]\s*[^\s,;]+`)
)

func sanitizeEnv(value any) any {
	items, ok := value.([]any)
	if !ok {
		return sanitize(value)
	}
	out := make([]any, len(items))
	for i, item := range items {
		entry, ok := item.(map[string]any)
		if !ok {
			out[i] = sanitize(item)
			continue
		}
		copy := make(map[string]any, len(entry))
		for key, field := range entry {
			if strings.EqualFold(key, "value") {
				copy[key] = "[REDACTED]"
			} else {
				copy[key] = sanitize(field)
			}
		}
		out[i] = copy
	}
	return out
}

func redactText(value string) string {
	value = bearerPattern.ReplaceAllString(value, "Bearer [REDACTED]")
	return secretTextPattern.ReplaceAllStringFunc(value, func(match string) string {
		index := strings.IndexAny(match, ":=")
		if index < 0 {
			return "[REDACTED]"
		}
		return match[:index+1] + "[REDACTED]"
	})
}

func normalize(value any) any {
	encoded, err := json.Marshal(value)
	if err != nil {
		return value
	}
	var generic any
	if err := json.Unmarshal(encoded, &generic); err != nil {
		return value
	}
	return generic
}

func fit(value map[string]any) (map[string]any, bool) {
	if len(marshal(value)) <= maxSnapshotBytes {
		return value, false
	}
	if data, ok := value["data"].(map[string]any); ok {
		for _, key := range []string{"resources", "recentEvents", "description", "overview", "clusterInfo"} {
			delete(data, key)
			if len(marshal(value)) <= maxSnapshotBytes {
				return value, true
			}
		}
	}
	return map[string]any{
		"schemaVersion": value["schemaVersion"],
		"source":        value["source"],
		"capturedAt":    value["capturedAt"],
		"page":          value["page"],
		"cluster":       value["cluster"],
		"warnings":      append(warnings(value["warnings"]), "snapshot exceeded 2 MiB and was reduced"),
		"truncated":     true,
	}, true
}

func warnings(value any) []any {
	switch items := value.(type) {
	case []any:
		return append([]any{}, items...)
	case []string:
		out := make([]any, len(items))
		for i, item := range items {
			out[i] = item
		}
		return out
	default:
		return []any{}
	}
}
