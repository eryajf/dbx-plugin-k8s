// Package mcp exposes bounded Kubernetes tools to DBX's built-in Agent mode.
package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"regexp"
	"strings"
	"time"

	"github.com/eryajf/dbx-plugin-k8s/internal/connection"
	"github.com/eryajf/dbx-plugin-k8s/internal/kube"
	"github.com/eryajf/dbx-plugin-k8s/internal/operations"
	"github.com/eryajf/dbx-plugin-k8s/internal/resources"
	corev1 "k8s.io/api/core/v1"
)

const maxToolResultBytes = 256 << 10

type definition struct {
	Name        string
	Description string
	Method      string
	ReadOnly    bool
	Destructive bool
	Idempotent  bool
	Properties  map[string]any
	Required    []string
}

func resourceProperties() map[string]any {
	return map[string]any{
		"group":     map[string]any{"type": "string", "description": "Kubernetes API group; empty for core resources"},
		"version":   map[string]any{"type": "string", "description": "Kubernetes API version, for example v1 or apps/v1"},
		"resource":  map[string]any{"type": "string", "description": "Plural resource name, for example pods or deployments"},
		"namespace": map[string]any{"type": "string"},
		"name":      map[string]any{"type": "string"},
	}
}

func resourceDefinition(name, description, method string, readOnly, destructive, idempotent bool, extra map[string]any, required ...string) definition {
	properties := resourceProperties()
	for key, value := range extra {
		properties[key] = value
	}
	return definition{Name: name, Description: description, Method: method, ReadOnly: readOnly, Destructive: destructive, Idempotent: idempotent, Properties: properties, Required: required}
}

func definitions() []definition {
	return []definition{
		{Name: "get_cluster_overview", Description: "Read Kubernetes cluster health, node, pod and namespace summary.", Method: "kube/overview", ReadOnly: true, Idempotent: true},
		resourceDefinition("get_resource", "Read one Kubernetes resource.", "resource/get", true, false, true, nil, "version", "resource", "name"),
		resourceDefinition("list_resources", "List Kubernetes resources with optional selectors.", "resource/list", true, false, true, map[string]any{"labelSelector": map[string]any{"type": "string"}, "fieldSelector": map[string]any{"type": "string"}, "limit": map[string]any{"type": "integer", "minimum": 1, "maximum": 100}}, "version", "resource"),
		resourceDefinition("describe_resource", "Read a resource with related events and ownership details.", "resource/describe", true, false, true, nil, "version", "resource", "name"),
		resourceDefinition("get_related_resources", "Read resources related to a Kubernetes object.", "resource/related", true, false, true, nil, "version", "resource", "name"),
		{Name: "search_resources", Description: "Search Kubernetes resources by name or query.", Method: "resource/search", ReadOnly: true, Idempotent: true, Properties: map[string]any{"query": map[string]any{"type": "string"}, "namespace": map[string]any{"type": "string"}, "limit": map[string]any{"type": "integer", "minimum": 1, "maximum": 100}}, Required: []string{"query"}},
		{Name: "get_recent_events", Description: "Read recent Kubernetes warning and normal events.", Method: "kube/recent-events", ReadOnly: true, Idempotent: true, Properties: map[string]any{"namespace": map[string]any{"type": "string"}, "limit": map[string]any{"type": "integer", "minimum": 1, "maximum": 100}}},
		{Name: "get_metrics", Description: "Read current Kubernetes resource metrics.", Method: "kube/metrics", ReadOnly: true, Idempotent: true, Properties: map[string]any{"namespace": map[string]any{"type": "string"}, "resource": map[string]any{"type": "string"}, "name": map[string]any{"type": "string"}}},
		{Name: "get_pod_logs", Description: "Read a bounded tail of pod logs without following the stream.", Method: "pod/logs", ReadOnly: true, Idempotent: true, Properties: map[string]any{"namespace": map[string]any{"type": "string"}, "name": map[string]any{"type": "string"}, "container": map[string]any{"type": "string"}, "previous": map[string]any{"type": "boolean"}, "tailLines": map[string]any{"type": "integer", "minimum": 1, "maximum": 2000}}, Required: []string{"namespace", "name"}},
		{Name: "query_prometheus", Description: "Run a read-only Prometheus instant query when Prometheus is reachable.", Method: "prometheus/query", ReadOnly: true, Idempotent: true, Properties: map[string]any{"query": map[string]any{"type": "string", "maxLength": 2000}}, Required: []string{"query"}},
		resourceDefinition("create_resource", "Create a Kubernetes resource.", "resource/create", false, false, false, map[string]any{"object": map[string]any{"type": "object"}, "yaml": map[string]any{"type": "string"}}, "version", "resource"),
		resourceDefinition("update_resource", "Replace a Kubernetes resource using its resourceVersion.", "resource/update", false, false, true, map[string]any{"object": map[string]any{"type": "object"}, "yaml": map[string]any{"type": "string"}}, "version", "resource", "name"),
		resourceDefinition("patch_resource", "Apply a validated merge or strategic patch to a Kubernetes resource.", "resource/patch", false, false, false, map[string]any{"patch": map[string]any{"type": "object"}, "patchType": map[string]any{"type": "string", "enum": []string{"merge", "strategic"}}}, "version", "resource", "name", "patch"),
		resourceDefinition("json_patch_resource", "Apply a JSON Patch operation list to a Kubernetes resource.", "resource/patch", false, false, false, map[string]any{"patch": map[string]any{"type": "array", "items": map[string]any{"type": "object"}}}, "version", "resource", "name", "patch"),
		resourceDefinition("apply_resource", "Server-side apply a Kubernetes resource.", "resource/apply", false, false, true, map[string]any{"object": map[string]any{"type": "object"}, "yaml": map[string]any{"type": "string"}}, "version", "resource"),
		resourceDefinition("delete_resource", "Delete a Kubernetes resource.", "resource/delete", false, true, false, nil, "version", "resource", "name"),
		{Name: "restart_workload", Description: "Restart a Kubernetes workload.", Method: "workload/restart", ReadOnly: false, Idempotent: false, Properties: operationProperties(), Required: []string{"resource", "namespace", "name"}},
		{Name: "scale_workload", Description: "Scale a Kubernetes workload to a requested replica count.", Method: "workload/scale", ReadOnly: false, Idempotent: true, Properties: merge(operationProperties(), map[string]any{"replicas": map[string]any{"type": "integer", "minimum": 0, "maximum": 10000}}), Required: []string{"resource", "namespace", "name", "replicas"}},
		{Name: "rollback_workload", Description: "Rollback a Kubernetes deployment workload.", Method: "workload/rollback", ReadOnly: false, Idempotent: false, Properties: merge(operationProperties(), map[string]any{"revision": map[string]any{"type": "string"}}), Required: []string{"resource", "namespace", "name"}},
		{Name: "trigger_cronjob", Description: "Create a one-off job from a Kubernetes CronJob.", Method: "cronjob/trigger", ReadOnly: false, Idempotent: false, Properties: operationProperties(), Required: []string{"namespace", "name"}},
		{Name: "suspend_cronjob", Description: "Suspend or resume a Kubernetes CronJob.", Method: "cronjob/suspend", ReadOnly: false, Idempotent: true, Properties: merge(operationProperties(), map[string]any{"suspend": map[string]any{"type": "boolean"}}), Required: []string{"namespace", "name", "suspend"}},
		{Name: "cordon_node", Description: "Mark a Kubernetes node unschedulable.", Method: "node/cordon", ReadOnly: false, Idempotent: true, Properties: map[string]any{"name": map[string]any{"type": "string"}}, Required: []string{"name"}},
		{Name: "uncordon_node", Description: "Mark a Kubernetes node schedulable.", Method: "node/uncordon", ReadOnly: false, Idempotent: true, Properties: map[string]any{"name": map[string]any{"type": "string"}}, Required: []string{"name"}},
		{Name: "drain_node", Description: "Drain a Kubernetes node while respecting eviction and disruption rules.", Method: "node/drain", ReadOnly: false, Destructive: true, Idempotent: false, Properties: map[string]any{"name": map[string]any{"type": "string"}, "force": map[string]any{"type": "boolean"}, "ignoreDaemonSets": map[string]any{"type": "boolean"}, "deleteLocalData": map[string]any{"type": "boolean"}, "gracePeriod": map[string]any{"type": "integer"}, "timeoutSeconds": map[string]any{"type": "integer", "minimum": 1, "maximum": 120}}, Required: []string{"name"}},
	}
}

func operationProperties() map[string]any {
	return map[string]any{"resource": map[string]any{"type": "string"}, "namespace": map[string]any{"type": "string"}, "name": map[string]any{"type": "string"}}
}

func merge(a, b map[string]any) map[string]any {
	out := map[string]any{}
	for key, value := range a {
		out[key] = value
	}
	for key, value := range b {
		out[key] = value
	}
	return out
}

// Tools returns the DBX MCP discovery response.
func Tools() map[string]any {
	out := make([]any, 0, len(definitions()))
	for _, definition := range definitions() {
		properties := definition.Properties
		if properties == nil {
			properties = map[string]any{}
		}
		required := definition.Required
		if required == nil {
			required = []string{}
		}
		annotations := map[string]any{"title": definition.Name, "readOnlyHint": definition.ReadOnly, "destructiveHint": definition.Destructive, "idempotentHint": definition.Idempotent, "openWorldHint": true}
		out = append(out, map[string]any{
			"name":        definition.Name,
			"description": definition.Description,
			"inputSchema": map[string]any{"type": "object", "properties": properties, "required": required, "additionalProperties": false},
			"annotations": annotations,
		})
	}
	return map[string]any{"tools": out}
}

// Call dispatches one DBX MCP tool. The lifecycle payload is used only to
// establish an ephemeral client when the host has not already connected it.
func Call(ctx context.Context, manager *connection.Manager, raw json.RawMessage, emitters ...func(string, any)) (map[string]any, error) {
	var emit func(string, any)
	if len(emitters) > 0 {
		emit = emitters[0]
	}
	var params map[string]any
	if err := json.Unmarshal(raw, &params); err != nil {
		return toolError(fmt.Errorf("invalid mcp/call parameters: %w", err)), nil
	}
	tool, _ := params["tool"].(string)
	if tool == "" {
		return toolError(fmt.Errorf("tool is required")), nil
	}
	definition, ok := find(tool)
	if !ok {
		return toolError(fmt.Errorf("unknown MCP tool: %s", tool)), nil
	}
	args := map[string]any{}
	if rawArgs, present := params["arguments"]; present && rawArgs != nil {
		var ok bool
		args, ok = rawArgs.(map[string]any)
		if !ok {
			return toolError(fmt.Errorf("arguments must be a JSON object")), nil
		}
	}
	if rawLifecycle, present := params["lifecycle"]; present && rawLifecycle != nil {
		if _, ok := rawLifecycle.(map[string]any); !ok {
			return toolError(fmt.Errorf("lifecycle must be a JSON object")), nil
		}
	}
	client, connectionID, closeClient, err := resolveClient(manager, params, args)
	if err != nil {
		return toolError(err), nil
	}
	defer closeClient()
	args["connectionId"] = connectionID
	if _, exists := args["namespace"]; !exists && client.Namespace != "" && defaultsToNamespace(definition.Method, client, args) {
		args["namespace"] = client.Namespace
	}
	if definition.Name == "json_patch_resource" {
		args["patchType"] = "json"
	}
	if definition.Name == "drain_node" {
		timeout, present := args["timeoutSeconds"]
		if present {
			seconds, ok := number(timeout)
			if !ok || seconds < 1 || seconds > 120 {
				return toolError(fmt.Errorf("timeoutSeconds must be between 1 and 120 for MCP calls")), nil
			}
		} else {
			args["timeoutSeconds"] = 120
		}
	}

	var value any
	switch definition.Method {
	case "pod/logs":
		value, err = podLogs(ctx, client, args)
	case "prometheus/query":
		value, err = prometheusQuery(ctx, client, args)
	case "kube/overview", "kube/metrics", "kube/recent-events":
		value, err = operations.Handle(ctx, client, definition.Method, encode(args))
	default:
		value, err = resources.Handle(ctx, client, definition.Method, encode(args))
		if strings.HasPrefix(definition.Method, "workload/") || strings.HasPrefix(definition.Method, "node/") || strings.HasPrefix(definition.Method, "cronjob/") {
			value, err = operations.Handle(ctx, client, definition.Method, encode(args))
		}
	}
	if err != nil {
		return map[string]any{"content": []any{map[string]any{"type": "text", "text": safeError(err.Error())}}, "isError": true}, nil
	}
	if !definition.ReadOnly && emit != nil {
		resource, _ := args["resource"].(string)
		if resource == "" && strings.HasPrefix(definition.Method, "node/") {
			resource = "nodes"
		}
		if resource == "" && strings.HasPrefix(definition.Method, "cronjob/") {
			resource = "cronjobs"
		}
		emit("resource/changed", map[string]any{"connectionId": connectionID, "method": definition.Method, "resource": resource, "namespace": args["namespace"], "name": args["name"]})
	}
	text, truncated := boundedJSON(value)
	if truncated {
		text += "\n[tool result truncated]"
	}
	return map[string]any{"content": []any{map[string]any{"type": "text", "text": text}}, "isError": false}, nil
}

func defaultsToNamespace(method string, client *kube.Client, args map[string]any) bool {
	if !strings.HasPrefix(method, "resource/") || method == "resource/search" {
		return true
	}
	group, _ := args["group"].(string)
	version, _ := args["version"].(string)
	resource, _ := args["resource"].(string)
	if version == "" || resource == "" {
		return false
	}
	served, err := resources.ResolveResource(client, resources.Request{Group: group, Version: version, Resource: resource})
	return err == nil && served.Namespaced
}

func toolError(err error) map[string]any {
	message := "MCP tool call failed"
	if err != nil {
		message = safeError(err.Error())
	}
	return map[string]any{
		"content": []any{map[string]any{"type": "text", "text": message}},
		"isError": true,
	}
}

func find(name string) (definition, bool) {
	for _, definition := range definitions() {
		if definition.Name == name {
			return definition, true
		}
	}
	return definition{}, false
}

func encode(value any) []byte { data, _ := json.Marshal(value); return data }

func resolveClient(manager *connection.Manager, params, args map[string]any) (*kube.Client, string, func(), error) {
	if manager == nil {
		return nil, "", func() {}, fmt.Errorf("connection manager is unavailable")
	}
	id, _ := args["connectionId"].(string)
	if id == "" {
		id, _ = args["dbx_connection"].(string)
	}
	if id == "" {
		if selected, ok := args["dbx_connection"].(map[string]any); ok {
			id, _ = selected["connectionId"].(string)
			if id == "" {
				id, _ = selected["id"].(string)
			}
		}
	}
	if id == "" {
		id, _ = params["connectionId"].(string)
	}
	if lifecycle, ok := params["lifecycle"].(map[string]any); ok {
		if lifecycleID := connection.ID(lifecycle); lifecycleID != "" {
			id = lifecycleID
		}
	}
	if id != "" {
		if client, err := manager.Get(id); err == nil {
			return client, id, func() {}, nil
		}
	}
	if lifecycle, ok := params["lifecycle"].(map[string]any); ok {
		client, _, err := connection.Prepare(lifecycle)
		if err != nil {
			return nil, "", func() {}, err
		}
		if id == "" {
			id = connection.ID(lifecycle)
		}
		if id == "" {
			client.Close()
			return nil, "", func() {}, fmt.Errorf("lifecycle connection id is required")
		}
		return client, id, client.Close, nil
	}
	if id == "" {
		return nil, "", func() {}, fmt.Errorf("connectionId or lifecycle is required")
	}
	return nil, "", func() {}, fmt.Errorf("connection is not connected")
}

func podLogs(ctx context.Context, client *kube.Client, args map[string]any) (any, error) {
	namespace, _ := args["namespace"].(string)
	name, _ := args["name"].(string)
	if namespace == "" || name == "" {
		return nil, fmt.Errorf("namespace and name are required")
	}
	options := &corev1.PodLogOptions{}
	options.Container, _ = args["container"].(string)
	options.Previous, _ = args["previous"].(bool)
	if tail, ok := number(args["tailLines"]); ok {
		if tail < 1 || tail > 2000 {
			return nil, fmt.Errorf("tailLines must be between 1 and 2000")
		}
		t := int64(tail)
		options.TailLines = &t
	} else {
		t := int64(200)
		options.TailLines = &t
	}
	stream, err := client.Core.CoreV1().Pods(namespace).GetLogs(name, options).Stream(ctx)
	if err != nil {
		return nil, err
	}
	defer stream.Close()
	data, err := io.ReadAll(io.LimitReader(stream, maxToolResultBytes+1))
	if err != nil {
		return nil, err
	}
	truncated := len(data) > maxToolResultBytes
	if truncated {
		data = data[:maxToolResultBytes]
	}
	return map[string]any{"namespace": namespace, "name": name, "container": options.Container, "logs": string(data), "truncated": truncated}, nil
}

func prometheusQuery(ctx context.Context, client *kube.Client, args map[string]any) (any, error) {
	query, _ := args["query"].(string)
	if strings.TrimSpace(query) == "" {
		return nil, fmt.Errorf("query is required")
	}
	if len(query) > 2000 {
		return nil, fmt.Errorf("query is too long")
	}
	if client.Prometheus == nil || !client.PrometheusReachable {
		return nil, fmt.Errorf("Prometheus is unavailable for this connection")
	}
	value, warnings, err := client.Prometheus.Query(ctx, query, time.Now())
	if err != nil {
		return nil, err
	}
	return map[string]any{"query": query, "value": value, "warnings": warnings}, nil
}

func number(value any) (int, bool) {
	switch n := value.(type) {
	case float64:
		return int(n), true
	case int:
		return n, true
	case int64:
		return int(n), true
	default:
		return 0, false
	}
}

func boundedJSON(value any) (string, bool) {
	clean := sanitize(normalize(value))
	data, err := json.MarshalIndent(clean, "", "  ")
	if err != nil {
		return fmt.Sprint(clean), false
	}
	if len(data) <= maxToolResultBytes {
		return string(data), false
	}
	return string(data[:maxToolResultBytes]), true
}

func normalize(value any) any {
	data, err := json.Marshal(value)
	if err != nil {
		return value
	}
	var generic any
	if err := json.Unmarshal(data, &generic); err != nil {
		return value
	}
	return generic
}

func sanitize(value any) any {
	switch v := value.(type) {
	case map[string]any:
		out := map[string]any{}
		for key, item := range v {
			lower := strings.ToLower(key)
			if lower == "managedfields" || lower == "stringdata" || lower == "binarydata" || lower == "data" || strings.Contains(lower, "token") || strings.Contains(lower, "password") || strings.Contains(lower, "privatekey") || lower == "clientkey" {
				out[key] = "[REDACTED]"
			} else if lower == "env" {
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
		if len(v) > maxToolResultBytes {
			return v[:maxToolResultBytes] + "…[truncated]"
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

func safeError(message string) string {
	return redactText(message)
}
