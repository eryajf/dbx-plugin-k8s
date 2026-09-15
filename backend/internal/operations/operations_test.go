package operations

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/eryajf/dbx-plugin-k8s/internal/kube"
	appsv1 "k8s.io/api/apps/v1"
	autoscalingv1 "k8s.io/api/autoscaling/v1"
	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	policyv1 "k8s.io/api/policy/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/kubernetes/fake"
	ktesting "k8s.io/client-go/testing"
)

func TestRestartPreservesTemplate(t *testing.T) {
	d := &appsv1.Deployment{ObjectMeta: metav1.ObjectMeta{Name: "web", Namespace: "default"}, Spec: appsv1.DeploymentSpec{Template: corev1.PodTemplateSpec{ObjectMeta: metav1.ObjectMeta{Annotations: map[string]string{"existing": "yes"}}}}}
	c := &kube.Client{Core: fake.NewSimpleClientset(d)}
	_, err := Handle(context.Background(), c, "workload/restart", json.RawMessage(`{"namespace":"default","name":"web","resource":"deployments"}`))
	if err != nil {
		t.Fatal(err)
	}
	updated, err := c.Core.AppsV1().Deployments("default").Get(context.Background(), "web", metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if updated.Spec.Template.Annotations["existing"] != "yes" || updated.Spec.Template.Annotations["kubectl.kubernetes.io/restartedAt"] == "" {
		t.Fatal("restart lost annotations or omitted timestamp")
	}
}
func TestScaleUsesSubresourceAndRejectsDaemonSet(t *testing.T) {
	f := fake.NewSimpleClientset()
	c := &kube.Client{Core: f}
	replicas := int32(3)
	_, err := scale(context.Background(), c, Request{Resource: "daemonsets", Replicas: &replicas})
	if err == nil || len(f.Actions()) != 0 {
		t.Fatal("daemonset scale should fail before API access")
	}
	f.PrependReactor("get", "deployments", func(a ktesting.Action) (bool, runtime.Object, error) {
		if a.GetSubresource() != "scale" {
			t.Fatal("expected scale subresource")
		}
		return true, &autoscalingv1.Scale{ObjectMeta: metav1.ObjectMeta{Name: "web", ResourceVersion: "7"}}, nil
	})
	f.PrependReactor("update", "deployments", func(a ktesting.Action) (bool, runtime.Object, error) {
		s := a.(ktesting.UpdateAction).GetObject().(*autoscalingv1.Scale)
		if a.GetSubresource() != "scale" || s.Spec.Replicas != 3 || s.ResourceVersion != "7" {
			t.Fatal("invalid scale update")
		}
		return true, s, nil
	})
	if _, err = scale(context.Background(), c, Request{Resource: "deployments", Name: "web", Namespace: "default", Replicas: &replicas}); err != nil {
		t.Fatal(err)
	}
}
func TestDrainPreflightDefaults(t *testing.T) {
	controller := true
	for _, tc := range []struct {
		name string
		pod  corev1.Pod
	}{
		{"unmanaged", corev1.Pod{}},
		{"daemonset", corev1.Pod{ObjectMeta: metav1.ObjectMeta{OwnerReferences: []metav1.OwnerReference{{Kind: "DaemonSet", Controller: &controller}}}}},
		{"emptyDir", corev1.Pod{ObjectMeta: metav1.ObjectMeta{OwnerReferences: []metav1.OwnerReference{{Kind: "ReplicaSet", Controller: &controller}}}, Spec: corev1.PodSpec{Volumes: []corev1.Volume{{VolumeSource: corev1.VolumeSource{EmptyDir: &corev1.EmptyDirVolumeSource{}}}}}}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			tc.pod.Name = "p"
			tc.pod.Namespace = "default"
			tc.pod.Spec.NodeName = "node"
			f := fake.NewSimpleClientset(&tc.pod)
			_, err := drain(context.Background(), &kube.Client{Core: f}, Request{Name: "node"})
			if err == nil {
				t.Fatal("unsafe drain permitted")
			}
			for _, a := range f.Actions() {
				if a.GetVerb() != "list" {
					t.Fatalf("preflight mutated cluster: %v", a)
				}
			}
		})
	}
}
func TestEvictionRespectsPDBAndCancellation(t *testing.T) {
	f := fake.NewSimpleClientset()
	uid := types.UID("pod-uid")
	p := corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: "p", Namespace: "default", UID: uid}}
	f.PrependReactor("create", "pods", func(a ktesting.Action) (bool, runtime.Object, error) {
		e, ok := a.(ktesting.CreateAction).GetObject().(*policyv1.Eviction)
		if !ok || a.GetSubresource() != "eviction" || *e.DeleteOptions.Preconditions.UID != uid {
			t.Fatal("eviction must have UID precondition")
		}
		return true, nil, apierrors.NewTooManyRequests("PDB blocks eviction", 1)
	})
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()
	err := evictAndWait(ctx, &kube.Client{Core: f}, p, Request{Force: true})
	if err == nil || !strings.Contains(err.Error(), "disruption budget") {
		t.Fatalf("unexpected error: %v", err)
	}
	for _, a := range f.Actions() {
		if a.GetVerb() == "delete" {
			t.Fatal("PDB bypass")
		}
	}
}
func TestCronJobTriggerCopiesTemplate(t *testing.T) {
	cj := &batchv1.CronJob{ObjectMeta: metav1.ObjectMeta{Name: "nightly", Namespace: "default", UID: types.UID("cron-uid")}, Spec: batchv1.CronJobSpec{JobTemplate: batchv1.JobTemplateSpec{ObjectMeta: metav1.ObjectMeta{Labels: map[string]string{"source": "template"}}, Spec: batchv1.JobSpec{Template: corev1.PodTemplateSpec{Spec: corev1.PodSpec{Containers: []corev1.Container{{Name: "task", Image: "busybox"}}, RestartPolicy: corev1.RestartPolicyNever}}}}}}
	f := fake.NewSimpleClientset(cj)
	f.PrependReactor("create", "jobs", func(a ktesting.Action) (bool, runtime.Object, error) {
		j := a.(ktesting.CreateAction).GetObject().(*batchv1.Job)
		if j.Name != "" || j.GenerateName != "nightly-manual-" || j.Labels["source"] != "template" || j.Spec.Template.Spec.Containers[0].Image != "busybox" || j.OwnerReferences[0].UID != cj.UID {
			t.Fatal("invalid job template or ownership")
		}
		j.Name = j.GenerateName + "123"
		return true, j, nil
	})
	if _, err := trigger(context.Background(), &kube.Client{Core: f}, Request{Name: "nightly", Namespace: "default"}); err != nil {
		t.Fatal(err)
	}
}
func TestRollbackRequiresCurrentVersion(t *testing.T) {
	d := &appsv1.Deployment{ObjectMeta: metav1.ObjectMeta{Name: "web", Namespace: "default", ResourceVersion: "2"}}
	f := fake.NewSimpleClientset(d)
	_, err := rollback(context.Background(), &kube.Client{Core: f}, Request{Name: "web", Namespace: "default", Revision: "1", ResourceVersion: "1"})
	if !apierrors.IsConflict(err) {
		t.Fatalf("expected conflict: %v", err)
	}
	for _, a := range f.Actions() {
		if a.GetVerb() == "update" {
			t.Fatal("stale rollback mutated deployment")
		}
	}
}

func TestRecentEventsSortsAndLimits(t *testing.T) {
	now := time.Now()
	old := &corev1.Event{ObjectMeta: metav1.ObjectMeta{Name: "old", Namespace: "default"}, LastTimestamp: metav1.Time{Time: now.Add(-time.Hour)}}
	fresh := &corev1.Event{ObjectMeta: metav1.ObjectMeta{Name: "fresh", Namespace: "default"}, LastTimestamp: metav1.Time{Time: now}}
	c := &kube.Client{Core: fake.NewSimpleClientset(old, fresh)}
	got, err := Handle(context.Background(), c, "kube/recent-events", json.RawMessage(`{"namespace":"default"}`))
	if err != nil {
		t.Fatal(err)
	}
	items := got.(map[string]any)["items"].([]corev1.Event)
	if len(items) != 2 || items[0].Name != "fresh" {
		t.Fatalf("unexpected ordering: %#v", items)
	}
}
