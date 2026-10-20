package sessions

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/eryajf/dbx-plugin-k8s/internal/kube"
	core "k8s.io/api/core/v1"
	rbac "k8s.io/api/rbac/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/kubernetes"
)

func writeAgentAPIError(w http.ResponseWriter, code int, reason metav1.StatusReason) {
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(&metav1.Status{
		TypeMeta: metav1.TypeMeta{APIVersion: "v1", Kind: "Status"},
		Status:   "Failure", Reason: reason, Code: int32(code), Message: fmt.Sprintf("test API failure %d", code),
	})
}

func createCleanupTestResource(ctx context.Context, client *kube.Client, resources *agentResources, kind string) error {
	meta := metav1.ObjectMeta{Name: "owned-test", Namespace: "ops"}
	switch kind {
	case "Pod":
		return createOwnedAgentResource(ctx, resources, client.Core.CoreV1().Pods("ops"), kind, &core.Pod{ObjectMeta: meta})
	case "ServiceAccount":
		return createOwnedAgentResource(ctx, resources, client.Core.CoreV1().ServiceAccounts("ops"), kind, &core.ServiceAccount{ObjectMeta: meta})
	case "ClusterRoleBinding":
		meta.Namespace = ""
		return createOwnedAgentResource(ctx, resources, client.Core.RbacV1().ClusterRoleBindings(), kind, &rbac.ClusterRoleBinding{ObjectMeta: meta})
	default:
		return fmt.Errorf("unknown kind %s", kind)
	}
}

func TestAgentCleanupAmbiguousCreatePersisted(t *testing.T) {
	for _, kind := range []string{"Pod", "ServiceAccount", "ClusterRoleBinding"} {
		for _, failure := range []string{"EOF", "timeout", "503"} {
			t.Run(kind+"/"+failure, func(t *testing.T) {
				var mu sync.Mutex
				var stored map[string]any
				var methods []string
				client := agentTestClient(t, func(w http.ResponseWriter, req *http.Request) {
					mu.Lock()
					methods = append(methods, req.Method)
					mu.Unlock()
					switch req.Method {
					case http.MethodPost:
						var object map[string]any
						if err := json.NewDecoder(req.Body).Decode(&object); err != nil {
							t.Error(err)
						}
						object["metadata"].(map[string]any)["uid"] = "persisted-uid"
						mu.Lock()
						stored = object
						mu.Unlock()
						switch failure {
						case "EOF":
							conn, _, err := w.(http.Hijacker).Hijack()
							if err != nil {
								t.Error(err)
								return
							}
							_ = conn.Close()
						case "timeout":
							<-req.Context().Done()
						case "503":
							writeAgentAPIError(w, 503, metav1.StatusReasonServiceUnavailable)
						}
					case http.MethodGet:
						mu.Lock()
						defer mu.Unlock()
						if stored == nil {
							writeAgentAPIError(w, 404, metav1.StatusReasonNotFound)
							return
						}
						_ = json.NewEncoder(w).Encode(stored)
					case http.MethodDelete:
						var options metav1.DeleteOptions
						if err := json.NewDecoder(req.Body).Decode(&options); err != nil {
							t.Error(err)
						}
						if options.Preconditions == nil || options.Preconditions.UID == nil || *options.Preconditions.UID != "persisted-uid" {
							t.Errorf("delete lacks owned UID precondition: %+v", options)
						}
						mu.Lock()
						stored = nil
						mu.Unlock()
						_ = json.NewEncoder(w).Encode(&metav1.Status{Status: "Success"})
					}
				})
				if failure == "timeout" {
					config := *client.Config
					config.Timeout = 100 * time.Millisecond
					var err error
					client.Core, err = kubernetes.NewForConfig(&config)
					if err != nil {
						t.Fatal(err)
					}
				}
				resources, err := newAgentResources()
				if err != nil {
					t.Fatal(err)
				}
				if err := createCleanupTestResource(context.Background(), client, resources, kind); err == nil {
					t.Fatal("expected ambiguous create error")
				}
				if err := resources.cleanup(); err != nil {
					t.Fatal(err)
				}
				if err := resources.cleanup(); err != nil {
					t.Fatal(err)
				}
				mu.Lock()
				defer mu.Unlock()
				if !reflect.DeepEqual(methods, []string{"POST", "GET", "DELETE", "GET"}) {
					t.Fatalf("expected once-only compensation: %v", methods)
				}
			})
		}
	}
}

func TestAgentCleanupDefiniteCreateFailureDoesNotAdopt(t *testing.T) {
	for _, kind := range []string{"Pod", "ServiceAccount", "ClusterRoleBinding"} {
		for _, tc := range []struct {
			code   int
			reason metav1.StatusReason
		}{{403, metav1.StatusReasonForbidden}, {422, metav1.StatusReasonInvalid}, {401, metav1.StatusReasonUnauthorized}} {
			t.Run(fmt.Sprintf("%s/%d", kind, tc.code), func(t *testing.T) {
				client := agentTestClient(t, func(w http.ResponseWriter, req *http.Request) {
					if req.Method != http.MethodPost {
						t.Errorf("definite failure must not Get/Delete namesake: %s %s", req.Method, req.URL)
					}
					writeAgentAPIError(w, tc.code, tc.reason)
				})
				resources, err := newAgentResources()
				if err != nil {
					t.Fatal(err)
				}
				err = createCleanupTestResource(context.Background(), client, resources, kind)
				if err == nil {
					t.Fatal("expected create failure")
				}
				if len(resources.resources) != 0 {
					t.Fatal("definite failure adopted resource")
				}
				if err := resources.cleanup(); err != nil {
					t.Fatal(err)
				}
			})
		}
	}
}

func TestAgentCleanupIdentityAndRetries(t *testing.T) {
	for _, tc := range []struct {
		name                          string
		observedUID, owner            string
		getCode, deleteCode, failures int
		wantDeletes                   int
		wantError                     string
	}{
		{name: "503 then success", observedUID: "created-uid", owner: "owner", deleteCode: 503, failures: 1, wantDeletes: 2},
		{name: "503 exhaustion", observedUID: "created-uid", owner: "owner", deleteCode: 503, failures: 5, wantDeletes: 3, wantError: "503"},
		{name: "403 visible without retry", observedUID: "created-uid", owner: "owner", deleteCode: 403, failures: 5, wantDeletes: 1, wantError: "403"},
		{name: "delete NotFound", observedUID: "created-uid", owner: "owner", deleteCode: 404, failures: 5, wantDeletes: 1},
		{name: "get NotFound", getCode: 404},
		{name: "get Forbidden", getCode: 403, wantError: "403"},
		{name: "only plugin label", observedUID: "created-uid", wantError: "owner token mismatch"},
		{name: "foreign owner", observedUID: "created-uid", owner: "different", wantError: "owner token mismatch"},
		{name: "UID replacement", observedUID: "replacement-uid", owner: "owner", wantError: "UID mismatch"},
		{name: "missing UID", owner: "owner", wantError: "no UID"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var gets, deletes int
			deleted := false
			client := agentTestClient(t, func(w http.ResponseWriter, req *http.Request) {
				switch req.Method {
				case http.MethodGet:
					gets++
					if deleted {
						writeAgentAPIError(w, 404, metav1.StatusReasonNotFound)
						return
					}
					if tc.getCode != 0 {
						writeAgentAPIError(w, tc.getCode, metav1.StatusReasonUnknown)
						return
					}
					_ = json.NewEncoder(w).Encode(&core.Pod{ObjectMeta: metav1.ObjectMeta{UID: types.UID(tc.observedUID), Labels: map[string]string{agentOwnerLabel: tc.owner, "dbx.kubernetes/plugin": "true"}}})
				case http.MethodDelete:
					deletes++
					var options metav1.DeleteOptions
					_ = json.NewDecoder(req.Body).Decode(&options)
					if options.Preconditions == nil || options.Preconditions.UID == nil || *options.Preconditions.UID != "created-uid" {
						t.Errorf("missing created UID precondition: %+v", options)
					}
					if deletes <= tc.failures {
						writeAgentAPIError(w, tc.deleteCode, metav1.StatusReasonUnknown)
						return
					}
					deleted = true
					_ = json.NewEncoder(w).Encode(&metav1.Status{Status: "Success"})
				}
			})
			pods := client.Core.CoreV1().Pods("ops")
			resources := &agentResources{owner: "owner", resources: []*ownedAgentResource{{
				kind: "Pod", namespace: "ops", name: "pod", uid: "created-uid",
				get:    func(ctx context.Context) (metav1.Object, error) { return pods.Get(ctx, "pod", metav1.GetOptions{}) },
				delete: func(ctx context.Context, options metav1.DeleteOptions) error { return pods.Delete(ctx, "pod", options) },
			}}}
			err := resources.cleanup()
			if tc.wantError == "" && err != nil || tc.wantError != "" && (err == nil || !strings.Contains(err.Error(), tc.wantError)) {
				t.Fatalf("cleanup error=%v want=%q", err, tc.wantError)
			}
			if resources.cleanup() != err {
				t.Fatal("cleanup did not retain its result")
			}
			if deletes != tc.wantDeletes {
				t.Fatalf("delete attempts=%d want=%d", deletes, tc.wantDeletes)
			}
			wantGets := tc.wantDeletes
			if deleted {
				wantGets++
			}
			if wantGets == 0 {
				wantGets = 1
			}
			if gets != wantGets {
				t.Fatalf("get attempts=%d want=%d", gets, wantGets)
			}
		})
	}
}

func TestKubectlAccessFailureCleansOnlyOwnedResources(t *testing.T) {
	for _, mode := range []string{"conflict", "forbidden", "binding-delete-forbidden"} {
		t.Run(mode, func(t *testing.T) {
			var serviceAccount core.ServiceAccount
			var binding rbac.ClusterRoleBinding
			var deleted []string
			saDeleted := false
			client := agentTestClient(t, func(w http.ResponseWriter, req *http.Request) {
				isBinding := strings.Contains(req.URL.Path, "clusterrolebindings")
				switch req.Method {
				case http.MethodPost:
					if !isBinding {
						_ = json.NewDecoder(req.Body).Decode(&serviceAccount)
						serviceAccount.UID = "sa-uid"
						_ = json.NewEncoder(w).Encode(&serviceAccount)
						return
					}
					if mode == "conflict" {
						writeAgentAPIError(w, 409, metav1.StatusReasonAlreadyExists)
						return
					}
					if mode == "forbidden" {
						writeAgentAPIError(w, 403, metav1.StatusReasonForbidden)
						return
					}
					_ = json.NewDecoder(req.Body).Decode(&binding)
					binding.UID = "binding-uid"
					_ = json.NewEncoder(w).Encode(&binding)
				case http.MethodGet:
					if isBinding {
						if mode == "conflict" {
							_ = json.NewEncoder(w).Encode(&rbac.ClusterRoleBinding{ObjectMeta: metav1.ObjectMeta{UID: "foreign", Labels: map[string]string{agentOwnerLabel: "foreign"}}})
							return
						}
						_ = json.NewEncoder(w).Encode(&binding)
					} else {
						if saDeleted {
							writeAgentAPIError(w, 404, metav1.StatusReasonNotFound)
							return
						}
						_ = json.NewEncoder(w).Encode(&serviceAccount)
					}
				case http.MethodDelete:
					var options metav1.DeleteOptions
					_ = json.NewDecoder(req.Body).Decode(&options)
					wantUID := types.UID("sa-uid")
					kind := "SA"
					if isBinding {
						wantUID = "binding-uid"
						kind = "CRB"
					}
					if options.Preconditions == nil || options.Preconditions.UID == nil || *options.Preconditions.UID != wantUID {
						t.Errorf("unsafe delete: %+v", options)
					}
					deleted = append(deleted, kind)
					if isBinding {
						writeAgentAPIError(w, 403, metav1.StatusReasonForbidden)
						return
					}
					saDeleted = true
					_ = json.NewEncoder(w).Encode(&metav1.Status{Status: "Success"})
				}
			})
			_, resources, err := ensureKubectlAccess(context.Background(), client, "ops")
			wantDeleted := []string{"SA"}
			if mode == "binding-delete-forbidden" {
				if err != nil {
					t.Fatal(err)
				}
				err = resources.cleanup()
				wantDeleted = []string{"CRB", "SA"}
			}
			if err == nil {
				t.Fatal("failure was swallowed")
			}
			if mode != "conflict" && !apierrors.IsForbidden(err) {
				t.Fatalf("lost original Forbidden: %v", err)
			}
			if mode == "conflict" && !apierrors.IsAlreadyExists(err) {
				t.Fatalf("lost conflict: %v", err)
			}
			if !reflect.DeepEqual(deleted, wantDeleted) {
				t.Fatalf("wrong compensation sequence: %v", deleted)
			}
		})
	}
}

func TestAgentCleanupJoinedErrorsAndIndependentBudget(t *testing.T) {
	first := apierrors.NewForbidden(schema.GroupResource{Resource: "clusterrolebindings"}, "binding", errors.New("binding denied"))
	second := errors.New("SA deletion failed")
	var order []string
	makeResource := func(name string, failure error) *ownedAgentResource {
		return &ownedAgentResource{kind: name, name: name, uid: "uid",
			get: func(ctx context.Context) (metav1.Object, error) {
				if ctx.Err() != nil {
					t.Errorf("independent context already canceled: %v", ctx.Err())
				}
				deadline, ok := ctx.Deadline()
				if !ok || time.Until(deadline) > agentCleanupTimeout {
					t.Error("cleanup context not bounded")
				}
				return &core.Pod{ObjectMeta: metav1.ObjectMeta{UID: "uid", Labels: map[string]string{agentOwnerLabel: "owner"}}}, nil
			},
			delete: func(context.Context, metav1.DeleteOptions) error { order = append(order, name); return failure },
		}
	}
	resources := &agentResources{owner: "owner", resources: []*ownedAgentResource{makeResource("SA", second), makeResource("CRB", first)}}
	err := resources.cleanup()
	if !errors.Is(err, first) || !errors.Is(err, second) {
		t.Fatalf("joined cleanup lost original errors: %v", err)
	}
	if !reflect.DeepEqual(order, []string{"CRB", "SA"}) {
		t.Fatalf("early cleanup abort: %v", order)
	}
}

func TestAgentCleanupSharedBudgetAndContinuesAfterTimeout(t *testing.T) {
	var podDeadline, saDeadline time.Time
	resources := &agentResources{owner: "owner", resources: []*ownedAgentResource{
		{kind: "SA", name: "sa", uid: "sa-uid", get: func(ctx context.Context) (metav1.Object, error) {
			saDeadline, _ = ctx.Deadline()
			return nil, apierrors.NewNotFound(schema.GroupResource{Resource: "serviceaccounts"}, "sa")
		}},
		{kind: "Pod", name: "pod", get: func(ctx context.Context) (metav1.Object, error) {
			podDeadline, _ = ctx.Deadline()
			<-ctx.Done()
			return nil, ctx.Err()
		}},
	}}
	started := time.Now()
	err := resources.cleanup()
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("lost deadline: %v", err)
	}
	if podDeadline.IsZero() || saDeadline.IsZero() {
		t.Fatal("timed-out resource prevented next cleanup")
	}
	if !saDeadline.After(podDeadline) || saDeadline.After(started.Add(agentCleanupTimeout+100*time.Millisecond)) {
		t.Fatalf("cleanup did not share/reserve total budget: pod=%s sa=%s", podDeadline, saDeadline)
	}
	if elapsed := time.Since(started); elapsed > agentCleanupTimeout+time.Second {
		t.Fatalf("exceeded shared budget: %s", elapsed)
	}
}

func TestKubectlPodAmbiguousCreateCompensatesAllResources(t *testing.T) {
	t.Setenv("NAMESPACE", "ops")
	var serviceAccount core.ServiceAccount
	var binding rbac.ClusterRoleBinding
	var pod core.Pod
	var deleted []string
	removed := map[string]bool{}
	client := agentTestClient(t, func(w http.ResponseWriter, req *http.Request) {
		kind := "Pod"
		if strings.Contains(req.URL.Path, "serviceaccounts") {
			kind = "ServiceAccount"
		}
		if strings.Contains(req.URL.Path, "clusterrolebindings") {
			kind = "ClusterRoleBinding"
		}
		switch req.Method {
		case http.MethodPost:
			switch kind {
			case "ServiceAccount":
				_ = json.NewDecoder(req.Body).Decode(&serviceAccount)
				serviceAccount.UID = "sa-uid"
				_ = json.NewEncoder(w).Encode(&serviceAccount)
			case "ClusterRoleBinding":
				_ = json.NewDecoder(req.Body).Decode(&binding)
				binding.UID = "binding-uid"
				_ = json.NewEncoder(w).Encode(&binding)
			case "Pod":
				_ = json.NewDecoder(req.Body).Decode(&pod)
				pod.UID = "pod-uid"
				writeAgentAPIError(w, 503, metav1.StatusReasonServiceUnavailable)
			}
		case http.MethodGet:
			if removed[kind] {
				writeAgentAPIError(w, 404, metav1.StatusReasonNotFound)
				return
			}
			switch kind {
			case "ServiceAccount":
				_ = json.NewEncoder(w).Encode(&serviceAccount)
			case "ClusterRoleBinding":
				_ = json.NewEncoder(w).Encode(&binding)
			case "Pod":
				_ = json.NewEncoder(w).Encode(&pod)
			}
		case http.MethodDelete:
			deleted = append(deleted, kind)
			if kind == "ClusterRoleBinding" {
				writeAgentAPIError(w, 403, metav1.StatusReasonForbidden)
				return
			}
			removed[kind] = true
			_ = json.NewEncoder(w).Encode(&metav1.Status{Status: "Success"})
		}
	})
	manager := New()
	defer manager.Close()
	_, err := manager.kubectlExec(context.Background(), client, "conn", []byte(`{}`))
	joined, ok := err.(interface{ Unwrap() []error })
	if !ok || len(joined.Unwrap()) != 2 || !strings.Contains(err.Error(), "create kubectl terminal agent") || !apierrors.IsServiceUnavailable(joined.Unwrap()[0]) || !apierrors.IsForbidden(joined.Unwrap()[1]) {
		t.Fatalf("lost primary or cleanup error: %v", err)
	}
	if !reflect.DeepEqual(deleted, []string{"Pod", "ClusterRoleBinding", "ServiceAccount"}) {
		t.Fatalf("incomplete cleanup: %v", deleted)
	}
	if binding.RoleRef.Name != "cluster-admin" || pod.Spec.ServiceAccountName != serviceAccount.Name {
		t.Fatal("existing kubectl identity behavior changed")
	}
	if pod.Labels[agentOwnerLabel] == "" || pod.Labels[agentOwnerLabel] != binding.Labels[agentOwnerLabel] || pod.Labels[agentOwnerLabel] != serviceAccount.Labels[agentOwnerLabel] {
		t.Fatal("kubectl resources do not share this session's owner token")
	}
}

func TestNodeStartupFailureJoinsCleanupForbidden(t *testing.T) {
	t.Setenv("NAMESPACE", "ops")
	var pod core.Pod
	client := agentTestClient(t, func(w http.ResponseWriter, req *http.Request) {
		switch {
		case strings.Contains(req.URL.Path, "/nodes/"):
			_ = json.NewEncoder(w).Encode(&core.Node{})
		case req.Method == http.MethodPost:
			_ = json.NewDecoder(req.Body).Decode(&pod)
			pod.UID = "node-uid"
			_ = json.NewEncoder(w).Encode(&pod)
		case strings.HasSuffix(req.URL.Path, "/log"):
			writeAgentAPIError(w, 403, metav1.StatusReasonForbidden)
		case req.Method == http.MethodDelete:
			writeAgentAPIError(w, 403, metav1.StatusReasonForbidden)
		case req.Method == http.MethodGet:
			pod.Status = core.PodStatus{Phase: core.PodFailed, Reason: "StartupRootCause"}
			_ = json.NewEncoder(w).Encode(&pod)
		}
	})
	manager := New()
	defer manager.Close()
	_, err := manager.nodeExec(context.Background(), client, "conn", []byte(`{"node":"node-1"}`))
	if err == nil || !strings.Contains(err.Error(), "StartupRootCause") || !strings.Contains(err.Error(), "cleanup Pod") || !apierrors.IsForbidden(err) {
		t.Fatalf("lost primary or cleanup error: %v", err)
	}
}

func TestAgentCleanupConcurrentOnceAndGetRetry(t *testing.T) {
	var gets, deletes int
	resources := &agentResources{owner: "owner", resources: []*ownedAgentResource{{
		kind: "Pod", name: "pod", uid: "uid",
		get: func(context.Context) (metav1.Object, error) {
			gets++
			if deletes > 0 {
				return nil, apierrors.NewNotFound(schema.GroupResource{Resource: "pods"}, "pod")
			}
			if gets == 1 {
				return nil, apierrors.NewServiceUnavailable("read transient failure")
			}
			return &core.Pod{ObjectMeta: metav1.ObjectMeta{UID: "uid", Labels: map[string]string{agentOwnerLabel: "owner"}}}, nil
		},
		delete: func(context.Context, metav1.DeleteOptions) error { deletes++; return nil },
	}}}
	var callers sync.WaitGroup
	for i := 0; i < 8; i++ {
		callers.Add(1)
		go func() {
			defer callers.Done()
			if err := resources.cleanup(); err != nil {
				t.Errorf("transient recovery failed: %v", err)
			}
		}()
	}
	callers.Wait()
	if gets != 3 || deletes != 1 {
		t.Fatalf("concurrent cleanup duplicated work: gets=%d deletes=%d", gets, deletes)
	}
}

func TestAgentOwnerToken(t *testing.T) {
	first, err := newAgentResources()
	if err != nil {
		t.Fatal(err)
	}
	second, err := newAgentResources()
	if err != nil {
		t.Fatal(err)
	}
	if len(first.owner) != 48 || len(second.owner) != 48 || first.owner == second.owner {
		t.Fatal("invalid or reused 192-bit owner token")
	}
}

func TestAgentAmbiguousCreateClassification(t *testing.T) {
	for _, err := range []error{io.EOF, io.ErrUnexpectedEOF, context.DeadlineExceeded, context.Canceled, apierrors.NewInternalError(errors.New("internal")), apierrors.NewTimeoutError("timeout", 1), apierrors.NewAlreadyExists(schema.GroupResource{}, "name"), errors.New("decode error")} {
		if !ambiguousAgentCreate(fmt.Errorf("wrapped: %w", err)) {
			t.Errorf("ambiguous outcome misclassified: %v", err)
		}
	}
	for _, err := range []error{apierrors.NewForbidden(schema.GroupResource{}, "name", errors.New("denied"))} {
		if ambiguousAgentCreate(fmt.Errorf("wrapped: %w", err)) {
			t.Errorf("definite outcome adopted: %v", err)
		}
	}
}

func TestAgentCleanupLateCreateAfterFirstNotFound(t *testing.T) {
	var stored, pending *core.Pod
	var gets, deletes int
	client := agentTestClient(t, func(w http.ResponseWriter, req *http.Request) {
		switch req.Method {
		case http.MethodPost:
			pending = new(core.Pod)
			_ = json.NewDecoder(req.Body).Decode(pending)
			pending.UID = "late-uid"
			conn, _, err := w.(http.Hijacker).Hijack()
			if err != nil {
				t.Error(err)
				return
			}
			_ = conn.Close()
		case http.MethodGet:
			gets++
			if gets == 5 {
				stored = pending
			}
			// Four absent observations must not consume the three transient attempts.
			if gets <= 4 || stored == nil {
				writeAgentAPIError(w, 404, metav1.StatusReasonNotFound)
				return
			}
			_ = json.NewEncoder(w).Encode(stored)
		case http.MethodDelete:
			deletes++
			stored = nil
			_ = json.NewEncoder(w).Encode(&metav1.Status{Status: "Success"})
		}
	})
	resources, _ := newAgentResources()
	if err := createCleanupTestResource(context.Background(), client, resources, "Pod"); err == nil {
		t.Fatal("expected ambiguous create")
	}
	if err := resources.cleanup(); err != nil {
		t.Fatal(err)
	}
	if stored != nil || gets != 6 || deletes != 1 {
		t.Fatalf("late commit escaped cleanup: gets=%d deletes=%d stored=%v", gets, deletes, stored)
	}
}

func TestAgentCleanupUnknownCreateStaysUncertain(t *testing.T) {
	gets := 0
	resource := &ownedAgentResource{get: func(context.Context) (metav1.Object, error) {
		gets++
		return nil, apierrors.NewNotFound(schema.GroupResource{Resource: "pods"}, "pod")
	}, delete: func(context.Context, metav1.DeleteOptions) error {
		t.Fatal("must not delete unobserved object")
		return nil
	}}
	ctx, cancel := context.WithTimeout(context.Background(), 220*time.Millisecond)
	defer cancel()
	err := resource.cleanup(ctx, "owner")
	if !errors.Is(err, context.DeadlineExceeded) || !strings.Contains(err.Error(), "uncertain") || gets <= 3 {
		t.Fatalf("unknown create reported success or stopped observing early: gets=%d err=%v", gets, err)
	}
}

func TestAgentCleanupDeleteAcceptanceRequiresDisappearance(t *testing.T) {
	for _, mode := range []string{"finalizer timeout", "eventually gone", "replacement"} {
		t.Run(mode, func(t *testing.T) {
			var gets, deletes int
			deleted := false
			resource := &ownedAgentResource{uid: "original", get: func(context.Context) (metav1.Object, error) {
				gets++
				if deleted && mode == "eventually gone" && gets > 4 {
					return nil, apierrors.NewNotFound(schema.GroupResource{Resource: "pods"}, "pod")
				}
				pod := &core.Pod{ObjectMeta: metav1.ObjectMeta{UID: "original", Labels: map[string]string{agentOwnerLabel: "owner"}, Finalizers: []string{"example.test/cleanup"}}}
				if deleted {
					now := metav1.Now()
					pod.DeletionTimestamp = &now
				}
				if deleted && mode == "replacement" {
					pod.UID = "replacement"
					pod.Labels[agentOwnerLabel] = "foreign"
				}
				return pod, nil
			}, delete: func(_ context.Context, options metav1.DeleteOptions) error {
				deletes++
				deleted = true
				if options.Preconditions == nil || options.Preconditions.UID == nil || *options.Preconditions.UID != "original" || options.GracePeriodSeconds != nil {
					t.Errorf("unsafe/force delete options: %+v", options)
				}
				return nil
			}}
			ctx, cancel := context.WithTimeout(context.Background(), 250*time.Millisecond)
			defer cancel()
			err := resource.cleanup(ctx, "owner")
			if mode == "finalizer timeout" {
				if !errors.Is(err, context.DeadlineExceeded) || !strings.Contains(err.Error(), "finalizers=[example.test/cleanup]") || !strings.Contains(err.Error(), "deletionTimestamp=") {
					t.Fatalf("finalizer timeout hidden: %v", err)
				}
			} else if err != nil {
				t.Fatal(err)
			}
			if deletes != 1 || gets < 2 {
				t.Fatalf("delete acknowledgement was sufficient or repeated DELETE: gets=%d deletes=%d", gets, deletes)
			}
		})
	}
}

func TestAgentCleanupRetryConflictAndUnreadableCreate(t *testing.T) {
	for _, kind := range []string{"Pod", "ServiceAccount", "ClusterRoleBinding"} {
		for _, mode := range []string{"retry conflict owned", "retry conflict foreign", "empty 201", "malformed 201", "incomplete 201"} {
			t.Run(kind+"/"+mode, func(t *testing.T) {
				var stored map[string]any
				var posts, gets, deletes int
				client := agentTestClient(t, func(w http.ResponseWriter, req *http.Request) {
					switch req.Method {
					case http.MethodPost:
						posts++
						if posts > 1 {
							writeAgentAPIError(w, 409, metav1.StatusReasonAlreadyExists)
							return
						}
						_ = json.NewDecoder(req.Body).Decode(&stored)
						meta := stored["metadata"].(map[string]any)
						meta["uid"] = "committed-uid"
						switch mode {
						case "retry conflict owned", "retry conflict foreign":
							if mode == "retry conflict foreign" {
								meta["labels"].(map[string]any)[agentOwnerLabel] = "foreign"
							}
							w.Header().Set("Retry-After", "0")
							writeAgentAPIError(w, 503, metav1.StatusReasonServiceUnavailable)
						case "empty 201":
							w.WriteHeader(http.StatusCreated)
						case "incomplete 201":
							w.WriteHeader(http.StatusCreated)
							_, _ = fmt.Fprint(w, `{}`)
						case "malformed 201":
							w.WriteHeader(http.StatusCreated)
							_, _ = fmt.Fprint(w, `{"apiVersion":"v1","metadata":`)
						}
					case http.MethodGet:
						gets++
						if stored == nil {
							writeAgentAPIError(w, 404, metav1.StatusReasonNotFound)
							return
						}
						_ = json.NewEncoder(w).Encode(stored)
					case http.MethodDelete:
						deletes++
						var options metav1.DeleteOptions
						_ = json.NewDecoder(req.Body).Decode(&options)
						if options.Preconditions == nil || options.Preconditions.UID == nil || *options.Preconditions.UID != "committed-uid" {
							t.Errorf("missing committed UID: %+v", options)
						}
						stored = nil
						_ = json.NewEncoder(w).Encode(&metav1.Status{Status: "Success"})
					}
				})
				resources, _ := newAgentResources()
				err := createCleanupTestResource(context.Background(), client, resources, kind)
				if err == nil {
					t.Fatal("expected create failure")
				}
				if strings.HasPrefix(mode, "retry") && (!apierrors.IsAlreadyExists(err) || posts != 2) {
					t.Fatalf("client-go retry not exercised: posts=%d err=%v", posts, err)
				}
				cleanupErr := resources.cleanup()
				if mode == "retry conflict foreign" {
					if cleanupErr == nil || !strings.Contains(cleanupErr.Error(), "owner token mismatch") || deletes != 0 || stored == nil || gets != 1 {
						t.Fatalf("adopted foreign resource: err=%v gets=%d deletes=%d", cleanupErr, gets, deletes)
					}
				} else if cleanupErr != nil || deletes != 1 || gets != 2 || stored != nil {
					t.Fatalf("committed resource not compensated: err=%v gets=%d deletes=%d", cleanupErr, gets, deletes)
				}
			})
		}
	}
}

func TestAgentCreateLocalValidationDoesNotTrack(t *testing.T) {
	client := agentTestClient(t, func(http.ResponseWriter, *http.Request) { t.Error("local validation sent an API request") })
	for _, meta := range []metav1.ObjectMeta{{Name: "bad/name", Namespace: "ops"}, {Name: "pod", Namespace: "bad/namespace"}, {Namespace: "ops"}} {
		resources, _ := newAgentResources()
		if err := createOwnedAgentResource(context.Background(), resources, client.Core.CoreV1().Pods(meta.Namespace), "Pod", &core.Pod{ObjectMeta: meta}); err == nil || len(resources.resources) != 0 {
			t.Fatalf("local error was tracked: err=%v", err)
		}
	}
	resources, _ := newAgentResources()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := createCleanupTestResource(ctx, client, resources, "Pod"); !errors.Is(err, context.Canceled) || len(resources.resources) != 0 {
		t.Fatalf("pre-canceled create tracked: %v", err)
	}
}

func TestAgentCleanupHTTP202FinalizerIsNotSuccess(t *testing.T) {
	var pod core.Pod
	gets, deletes := 0, 0
	client := agentTestClient(t, func(w http.ResponseWriter, req *http.Request) {
		switch req.Method {
		case http.MethodPost:
			_ = json.NewDecoder(req.Body).Decode(&pod)
			pod.UID = "finalized-uid"
			pod.Finalizers = []string{"example.test/cleanup"}
			_ = json.NewEncoder(w).Encode(&pod)
		case http.MethodGet:
			gets++
			_ = json.NewEncoder(w).Encode(&pod)
		case http.MethodDelete:
			deletes++
			now := metav1.Now()
			pod.DeletionTimestamp = &now
			w.WriteHeader(http.StatusAccepted)
			_ = json.NewEncoder(w).Encode(&pod)
		default:
			t.Errorf("must not PATCH away finalizers: %s", req.Method)
		}
	})
	resources, _ := newAgentResources()
	if err := createCleanupTestResource(context.Background(), client, resources, "Pod"); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 180*time.Millisecond)
	defer cancel()
	err := resources.resources[0].cleanup(ctx, resources.owner)
	if !errors.Is(err, context.DeadlineExceeded) || !strings.Contains(err.Error(), "finalizers=[example.test/cleanup]") || gets < 3 || deletes != 1 || pod.DeletionTimestamp == nil || len(pod.Finalizers) != 1 {
		t.Fatalf("accepted DELETE hid finalizer: err=%v gets=%d deletes=%d pod=%+v", err, gets, deletes, pod.ObjectMeta)
	}
}
