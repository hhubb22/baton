package identity

import "testing"

func TestUUIDRoundTrip(t *testing.T) {
	id, err := NewUUID()
	if err != nil {
		t.Fatal(err)
	}
	got, err := ParseUUID(id)
	if err != nil {
		t.Fatal(err)
	}
	if got != id {
		t.Fatalf("规范形式变化: %s %s", id, got)
	}
	upper, err := ParseUUID("AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE")
	if err != nil {
		t.Fatal(err)
	}
	if upper != "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" {
		t.Fatalf("未规范为小写: %s", upper)
	}
	if _, err := ParseUUID("not-a-uuid"); err == nil {
		t.Fatal("非法 UUID 被接受")
	}
}
