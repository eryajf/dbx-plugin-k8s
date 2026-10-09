package resources

import (
	"context"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"testing"
)

func TestReducedListPreservesDetailAndTableFields(t *testing.T) {
	object := pod("demo", "default", map[string]string{"app": "demo"})
	object.SetManagedFields([]metav1.ManagedFieldsEntry{{Manager: "controller"}})
	object.SetAnnotations(map[string]string{"note": "keep"})
	object.Object["spec"] = map[string]any{"nodeName": "node-1"}
	c := searchClient(object)
	defer c.Close()
	out, err := Handle(context.Background(), c, "resource/list", []byte(`{"version":"v1","resource":"pods","namespace":"default","reduce":true}`))
	if err != nil {
		t.Fatal(err)
	}
	list := out.(*unstructured.UnstructuredList)
	if len(list.Items) != 1 || len(list.Items[0].GetManagedFields()) != 0 {
		t.Fatalf("reduced list = %v", list)
	}
	if list.Items[0].GetAnnotations()["note"] != "keep" || list.Items[0].GetLabels()["app"] != "demo" || list.Items[0].Object["spec"] == nil {
		t.Fatal("table fields removed")
	}
	detail, err := Handle(context.Background(), c, "resource/get", []byte(`{"version":"v1","resource":"pods","namespace":"default","name":"demo"}`))
	if err != nil {
		t.Fatal(err)
	}
	if len(detail.(*unstructured.Unstructured).GetManagedFields()) != 1 {
		t.Fatal("detail lost managed fields")
	}
}
