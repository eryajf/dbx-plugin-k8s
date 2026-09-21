package main

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net"
	"strings"
	"time"

	"github.com/eryajf/dbx-plugin-k8s/internal/connection"
	"github.com/eryajf/dbx-plugin-k8s/internal/operations"
	"github.com/eryajf/dbx-plugin-k8s/internal/resources"
	"github.com/eryajf/dbx-plugin-k8s/internal/sessions"
	dbx "github.com/t8y2/dbx/plugins/sdk/go/dbx-plugin-sdk"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
)

type plugin struct {
	connections *connection.Manager
	sessions    *sessions.Manager
	favorites   favoriteStore
	preferences preferenceStore
}

func (p *plugin) Handle(_ dbx.RequestContext, method string, raw json.RawMessage, emitter *dbx.Emitter) (any, *dbx.PluginError) {
	if !knownMethod(method) {
		return nil, dbx.MethodNotFound(method)
	}
	v := map[string]any{}
	if len(raw) > 0 && string(raw) != "null" {
		if e := json.Unmarshal(raw, &v); e != nil {
			return nil, dbx.NewError(-32602, "invalid JSON parameters")
		}
	}
	if v == nil {
		v = map[string]any{}
	}
	if len(raw) == 0 || string(raw) == "null" {
		raw = json.RawMessage(`{}`)
	}
	for _, key := range []string{"connectionId", "connection_id"} {
		if value, ok := v[key]; ok {
			if _, ok := value.(string); !ok {
				return nil, dbx.NewError(-32602, key+" must be a string")
			}
		}
	}
	switch method {
	case "connection/test":
		c, i, e := connection.Prepare(v)
		if e != nil {
			return map[string]any{"success": false, "message": e.Error()}, nil
		}
		c.Close()
		return i, nil
	case "connection/connect":
		id := connection.ID(v)
		if id == "" {
			return nil, dbx.NewError(-32602, "missing connection id")
		}
		c, i, e := connection.Prepare(v)
		if e != nil {
			return nil, classify(e)
		}
		p.sessions.CloseConnection(id)
		p.connections.Put(id, c)
		i.ConnectionID = id
		return i, nil
	case "connection/disconnect":
		id := connection.ID(v)
		if id == "" {
			return nil, dbx.NewError(-32602, "missing connectionId")
		}
		p.sessions.CloseConnection(id)
		p.connections.Remove(id)
		return map[string]any{"success": true}, nil
	case "dbx-plugin-k8s/ping":
		return map[string]any{"ok": true, "plugin": "io.dbx.k8s", "language": "go"}, nil
	case "favorite/list", "favorite/update":
		return p.handleFavorites(method, v, raw)
	case "ui/preferences-get", "ui/preferences-set":
		return p.handlePreferences(method, v, raw)
	}
	if (strings.HasSuffix(method, "-read") && method != "pod/file-read") || strings.HasSuffix(method, "-close") || method == "session/read" || method == "session/close" || method == "pod/exec-write" || method == "pod/exec-resize" || method == "terminal/exec-write" || method == "terminal/exec-resize" || method == "port-forward/close" {
		sid, ok := v["sessionId"].(string)
		if !ok || strings.TrimSpace(sid) == "" {
			return nil, dbx.NewError(-32602, "sessionId is required")
		}
	}
	id := connection.ID(v)
	if id == "" {
		return nil, dbx.NewError(-32602, "missing connectionId")
	}
	c, e := p.connections.Get(id)
	if e != nil {
		return nil, classify(e)
	}
	timeout := 60 * time.Second
	if method == "node/drain" {
		var req operations.Request
		if err := json.Unmarshal(raw, &req); err != nil {
			return nil, dbx.NewError(-32602, "invalid drain parameters")
		}
		if req.TimeoutSeconds < 0 || req.TimeoutSeconds > 3600 {
			return nil, dbx.NewError(-32602, "timeoutSeconds must be between 0 and 3600")
		}
		timeout = 5 * time.Minute
		if req.TimeoutSeconds > 0 {
			timeout = time.Duration(req.TimeoutSeconds) * time.Second
		}
	}
	ctx, cancel := c.RequestContext(timeout)
	defer cancel()
	var out any
	switch {
	case method == "kube/cluster-info":
		out, e = connection.Probe(ctx, c)
		if info, ok := out.(*connection.Info); ok && info != nil {
			info.ConnectionID = id
		}
	case method == "resource/watch" || method == "resource/watch-read" || method == "resource/watch-close":
		out, e = p.sessions.Handle(ctx, c, id, method, raw)
	case strings.HasPrefix(method, "resource/"), strings.HasPrefix(method, "kube/"), strings.HasPrefix(method, "prometheus/"):
		out, e = resources.Handle(ctx, c, method, raw)
		if method == "kube/overview" || method == "kube/metrics" || method == "kube/recent-events" || strings.HasPrefix(method, "prometheus/") {
			out, e = operations.Handle(ctx, c, method, raw)
		}
	case strings.HasPrefix(method, "workload/"), strings.HasPrefix(method, "node/"), strings.HasPrefix(method, "cronjob/"):
		if method == "node/exec-open" {
			out, e = p.sessions.Handle(ctx, c, id, method, raw)
		} else {
			out, e = operations.Handle(ctx, c, method, raw)
		}
	case strings.HasPrefix(method, "pod/"), strings.HasPrefix(method, "session/"), strings.HasPrefix(method, "port-forward/"), strings.HasPrefix(method, "terminal/"), strings.HasPrefix(method, "kubectl/"):
		out, e = p.sessions.Handle(ctx, c, id, method, raw)
	default:
		return nil, dbx.MethodNotFound(method)
	}
	pe := classify(e)
	if pe != nil {
		data := pe.Data.(map[string]any)
		for _, key := range []string{"resource", "namespace", "name"} {
			if value, ok := v[key].(string); ok {
				data[key] = value
			}
		}
		data["verb"] = rpcVerb(method)
		if _, exists := data["resource"]; !exists {
			if strings.HasPrefix(method, "node/") {
				data["resource"] = "nodes"
			}
			if strings.HasPrefix(method, "cronjob/") {
				data["resource"] = "cronjobs"
			}
		}
		if out != nil {
			data["partialResult"] = out
		}
	}
	if pe == nil && emitter != nil && (strings.HasPrefix(method, "resource/") || strings.HasPrefix(method, "workload/") || strings.HasPrefix(method, "node/") || strings.HasPrefix(method, "cronjob/")) && method != "resource/list" && method != "resource/get" && method != "resource/describe" && method != "resource/related" && method != "resource/search" {
		_ = emitter.Event("resource/changed", map[string]any{"connectionId": id, "method": method, "resource": v["resource"], "namespace": v["namespace"], "name": v["name"]})
	}
	return out, pe
}
func knownMethod(method string) bool {
	switch method {
	case "connection/test", "connection/connect", "connection/disconnect", "dbx-plugin-k8s/ping",
		"ui/preferences-get", "ui/preferences-set",
		"kube/cluster-info", "kube/discover", "prometheus/resource-usage-history", "prometheus/pods-metrics", "kube/namespaces", "kube/overview", "kube/metrics", "kube/recent-events", "kube/search",
		"resource/list", "resource/get", "resource/create", "resource/update", "resource/patch", "resource/delete", "resource/describe", "resource/related", "resource/apply", "resource/search", "resource/watch", "resource/watch-read", "resource/watch-close",
		"node/cordon", "node/uncordon", "node/drain", "workload/restart", "workload/scale", "workload/history", "workload/rollback", "cronjob/trigger", "cronjob/suspend",
		"pod/files-list", "pod/file-read", "pod/file-write", "pod/file-delete", "pod/logs-open", "pod/logs-read", "pod/logs-close", "pod/exec-open", "pod/exec-read", "pod/exec-write", "pod/exec-resize", "pod/exec-close", "node/exec-open", "kubectl/exec-open", "terminal/exec-write", "terminal/exec-resize", "session/read", "session/close", "port-forward/open", "port-forward/list", "port-forward/close", "favorite/list", "favorite/update":
		return true
	}
	return false
}
func rpcVerb(method string) string {
	switch method {
	case "resource/describe", "resource/related", "workload/history", "pod/logs-open":
		return "get"
	case "resource/apply", "workload/restart", "workload/scale", "workload/rollback", "cronjob/suspend", "node/cordon", "node/uncordon":
		return "patch"
	case "cronjob/trigger", "pod/exec-open", "node/exec-open", "kubectl/exec-open", "port-forward/open", "node/drain":
		return "create"
	}
	_, verb, _ := strings.Cut(method, "/")
	return verb
}
func classify(e error) *dbx.PluginError {
	if e == nil {
		return nil
	}
	code, retryable, rpcCode := "internal", false, -32000
	var netErr net.Error
	switch {
	case apierrors.IsUnauthorized(e):
		code = "unauthorized"
	case apierrors.IsForbidden(e):
		code = "forbidden"
	case apierrors.IsNotFound(e):
		code = "not_found"
	case apierrors.IsConflict(e), apierrors.IsAlreadyExists(e):
		code = "conflict"
	case apierrors.IsInvalid(e), apierrors.IsBadRequest(e):
		code = "invalid_params"
		rpcCode = -32602
	case apierrors.IsTimeout(e), apierrors.IsServerTimeout(e), errors.Is(e, context.DeadlineExceeded):
		code = "timeout"
		retryable = true
	case apierrors.IsTooManyRequests(e), apierrors.IsServiceUnavailable(e):
		code = "unavailable"
		retryable = true
	case errors.Is(e, context.Canceled):
		code = "canceled"
	case errors.As(e, &netErr):
		code = "network"
		retryable = true
	case strings.Contains(e.Error(), "connection is not connected"):
		code = "not_connected"
	default:
		// Domain handlers currently return plain errors for validation failures.
		for _, marker := range []string{"is required", "are required", "resource required", "must be", "invalid request:", "invalid operation request:", "invalid Kubernetes resource path", "cannot unmarshal", "unexpected end of JSON"} {
			if strings.Contains(e.Error(), marker) {
				code = "invalid_params"
				rpcCode = -32602
				break
			}
		}
	}
	data := map[string]any{"code": code, "retryable": retryable}
	var status apierrors.APIStatus
	if errors.As(e, &status) {
		s := status.Status()
		data["status"] = s.Code
		if s.Details != nil {
			data["resource"] = s.Details.Kind
			data["name"] = s.Details.Name
			data["group"] = s.Details.Group
		}
	}
	return &dbx.PluginError{Code: rpcCode, Message: e.Error(), Data: data}
}
func main() {
	p := &plugin{connections: connection.New(), sessions: sessions.New()}
	defer p.connections.Close()
	defer p.sessions.Close()
	s := dbx.NewServer(dbx.Metadata{ID: "io.dbx.k8s", Version: "0.1.3", Capabilities: []string{"connections", "events"}}, p)
	if e := s.Serve(); e != nil {
		log.Fatal(e)
	}
}
