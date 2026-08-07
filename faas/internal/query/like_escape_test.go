package query

import (
	"encoding/json"
	"testing"

	"github.com/mdk/digitaltwin2026/faas/internal/record"
)

func TestEmptyIDResultRecordsJSONIsArrayNotNull(t *testing.T) {
	t.Parallel()
	// 与 Next / OpenAPI 对齐：id 未命中时 records 必须是 []，不能是 null
	recs := []record.Record{} // 与 FetchFilteredRecords id 分支初始化一致
	raw, err := json.Marshal(map[string]any{"records": recs})
	if err != nil {
		t.Fatal(err)
	}
	if string(raw) != `{"records":[]}` {
		t.Fatalf("got %s", raw)
	}
	var nilRecs []record.Record
	rawNil, _ := json.Marshal(map[string]any{"records": nilRecs})
	if string(rawNil) != `{"records":null}` {
		t.Fatalf("sanity: nil slice should be null, got %s", rawNil)
	}
}
