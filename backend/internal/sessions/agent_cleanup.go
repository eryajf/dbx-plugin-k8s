package sessions

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"sync"
	"syscall"
	"time"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/apimachinery/pkg/util/validation"
)

const (
	agentOwnerLabel     = "dbx.kubernetes/owner-token"
	agentCleanupTimeout = 8 * time.Second
	agentCleanupTries   = 3
)

// agentResources is local to one terminal setup. Plugin/component labels are
// descriptive only; they never authorize deleting a resource.
type agentResources struct {
	owner     string
	resources []*ownedAgentResource
	once      sync.Once
	err       error
}

type ownedAgentResource struct {
	kind, namespace, name string
	uid                   types.UID
	get                   func(context.Context) (metav1.Object, error)
	delete                func(context.Context, metav1.DeleteOptions) error
}

type agentResourceClient[T metav1.Object] interface {
	Create(context.Context, T, metav1.CreateOptions) (T, error)
	Get(context.Context, string, metav1.GetOptions) (T, error)
	Delete(context.Context, string, metav1.DeleteOptions) error
}

func newAgentResources() (*agentResources, error) {
	var token [24]byte
	if _, err := rand.Read(token[:]); err != nil {
		return nil, fmt.Errorf("generate terminal resource owner token: %w", err)
	}
	return &agentResources{owner: hex.EncodeToString(token[:])}, nil
}

// Track ambiguous outcomes, including a conflict after client-go's internal POST
// retry. Only the per-attempt owner token (never the name alone) permits adoption.
func createOwnedAgentResource[T metav1.Object](ctx context.Context, resources *agentResources, client agentResourceClient[T], kind string, object T) error {
	// Reject locally before sending: an invalid path/name is not evidence that
	// the API server may have committed a request.
	if err := ctx.Err(); err != nil {
		return err
	}
	if problems := validation.IsDNS1123Subdomain(object.GetName()); len(problems) != 0 {
		return fmt.Errorf("invalid agent resource name: %v", problems)
	}
	if ns := object.GetNamespace(); ns != "" {
		if problems := validation.IsDNS1123Label(ns); len(problems) != 0 {
			return fmt.Errorf("invalid agent resource namespace: %v", problems)
		}
	}
	if resources.owner == "" {
		return fmt.Errorf("missing agent resource owner token")
	}
	labels := object.GetLabels()
	if labels == nil {
		labels = make(map[string]string)
	}
	labels[agentOwnerLabel] = resources.owner
	object.SetLabels(labels)
	name := object.GetName()
	created, err := client.Create(ctx, object, metav1.CreateOptions{})
	if err != nil && !ambiguousAgentCreate(err) {
		return err
	}
	resource := &ownedAgentResource{
		kind: kind, namespace: object.GetNamespace(), name: name,
		get: func(ctx context.Context) (metav1.Object, error) {
			return client.Get(ctx, name, metav1.GetOptions{})
		},
		delete: func(ctx context.Context, options metav1.DeleteOptions) error {
			return client.Delete(ctx, name, options)
		},
	}
	if err == nil {
		if created.GetUID() == "" || created.GetName() != name || created.GetNamespace() != object.GetNamespace() || created.GetLabels()[agentOwnerLabel] != resources.owner {
			err = fmt.Errorf("uncertain create outcome: response missing expected resource identity")
		} else {
			resource.uid = created.GetUID()
		}
	}
	resources.resources = append(resources.resources, resource)
	return err
}

// cleanup is independent of the canceled request/session, bounded across all
// resources, and idempotent even when multiple session shutdown paths race.
func (r *agentResources) cleanup() error {
	r.once.Do(func() {
		ctx, cancel := context.WithTimeout(context.Background(), agentCleanupTimeout)
		defer cancel()
		var failures []error
		for i := len(r.resources) - 1; i >= 0; i-- {
			// Reserve a fair share for every remaining resource: a stuck Pod or
			// binding must not consume the ServiceAccount's entire opportunity.
			deadline, _ := ctx.Deadline()
			resourceCtx, resourceCancel := context.WithTimeout(ctx, time.Until(deadline)/time.Duration(i+1))
			err := r.resources[i].cleanup(resourceCtx, r.owner)
			resourceCancel()
			if err != nil {
				resource := r.resources[i]
				failures = append(failures, fmt.Errorf("cleanup %s %s/%s (UID %q): %w", resource.kind, resource.namespace, resource.name, resource.uid, err))
			}
		}
		r.err = errors.Join(failures...)
	})
	return r.err
}

func (r *ownedAgentResource) cleanup(ctx context.Context, owner string) error {
	var failures []error
	deleteAccepted := false
	lastStatus := "uncertain create outcome: resource not yet observed"
	for {
		if ctx.Err() != nil {
			return errors.Join(fmt.Errorf("%s: %w", lastStatus, ctx.Err()), errors.Join(failures...))
		}
		object, err := r.get(ctx)
		if apierrors.IsNotFound(err) {
			if r.uid != "" {
				return nil
			}
			// A failed POST can still commit after the first GET returns 404.
			// Absence alone cannot resolve an unknown create, even at deadline.
			err = nil
		} else if err == nil {
			uid := object.GetUID()
			if deleteAccepted && uid != "" && uid != r.uid {
				// The original UID is gone. Never touch the replacement.
				return nil
			}
			if owner == "" || object.GetLabels()[agentOwnerLabel] != owner {
				return fmt.Errorf("refusing deletion: owner token mismatch")
			}
			if uid == "" {
				return fmt.Errorf("refusing deletion: resource has no UID")
			}
			if r.uid != "" && r.uid != uid {
				return fmt.Errorf("refusing deletion: UID mismatch (created %s, observed %s)", r.uid, uid)
			}
			r.uid = uid
			lastStatus = fmt.Sprintf("original UID %q still present (deletionTimestamp=%v finalizers=%v)", uid, object.GetDeletionTimestamp(), object.GetFinalizers())
			if !deleteAccepted {
				err = r.delete(ctx, metav1.DeleteOptions{Preconditions: &metav1.Preconditions{UID: &uid}})
				if apierrors.IsNotFound(err) {
					return nil
				}
				deleteAccepted = err == nil
				if deleteAccepted {
					// DELETE success only acknowledges acceptance. Confirm disappearance.
					continue
				}
			}
		}
		if err != nil {
			failures = append(failures, err)
			if !transientAgentError(err) || len(failures) >= agentCleanupTries || ctx.Err() != nil {
				return errors.Join(fmt.Errorf("%s", lastStatus), errors.Join(failures...))
			}
		}
		// Observation polls do not consume the transient-operation retry limit.
		timer := time.NewTimer(50 * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
		case <-timer.C:
		}
	}
}

func ambiguousAgentCreate(err error) bool {
	// These responses conclusively reject the create, even if wrapped.
	if apierrors.IsForbidden(err) || apierrors.IsUnauthorized(err) || apierrors.IsInvalid(err) || apierrors.IsBadRequest(err) || apierrors.IsNotFound(err) || apierrors.IsMethodNotSupported(err) {
		return false
	}
	// Decode errors (including an empty/malformed HTTP 201 body) and a final
	// 409/429 can conceal a committed internal retry. Unknown errors therefore
	// get read-only ownership verification; they never authorize blind deletion.
	return true
}

func transientAgentError(err error) bool {
	// Permanent API responses take precedence over transport classification.
	var status apierrors.APIStatus
	if errors.As(err, &status) {
		code := status.Status().Code
		return code == 408 || code == 429 || code >= 500 && code <= 599
	}
	var networkError net.Error
	return errors.Is(err, context.DeadlineExceeded) || errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) || errors.Is(err, net.ErrClosed) || errors.Is(err, syscall.ECONNRESET) || errors.Is(err, syscall.EPIPE) || errors.As(err, &networkError)
}
