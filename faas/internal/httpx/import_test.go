package httpx_test

import (
	"bytes"
	"encoding/json"
	"fmt"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/textproto"
	"strings"
	"testing"
	"time"

	"github.com/mdk/digitaltwin2026/faas/internal/auth"
	"github.com/mdk/digitaltwin2026/faas/internal/httpx"
	"github.com/mdk/digitaltwin2026/faas/internal/importapi"
)

func buildImportMultipart(t *testing.T, filename, contentType, content string, extraFile bool) (*bytes.Buffer, string) {
	t.Helper()
	var body bytes.Buffer
	w := multipart.NewWriter(&body)
	h := make(textproto.MIMEHeader)
	h.Set("Content-Disposition", fmt.Sprintf(`form-data; name="file"; filename="%s"`, filename))
	if contentType != "" {
		h.Set("Content-Type", contentType)
	}
	part, err := w.CreatePart(h)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write([]byte(content)); err != nil {
		t.Fatal(err)
	}
	if extraFile {
		h2 := make(textproto.MIMEHeader)
		h2.Set("Content-Disposition", `form-data; name="file"; filename="other.jsonl"`)
		h2.Set("Content-Type", "application/x-ndjson")
		p2, err := w.CreatePart(h2)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = p2.Write([]byte("x"))
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	return &body, w.FormDataContentType()
}

func importTestServer() *httpx.Server {
	return &httpx.Server{
		Pool:   nil,
		Tokens: auth.Tokens{AI: "ai-tok", Admin: "admin-tok"},
		Now:    time.Now,
	}
}

func TestImportRecordsRejectsAIToken(t *testing.T) {
	h := importTestServer().Handler()
	body, ct := buildImportMultipart(t, "records.jsonl", "application/x-ndjson", "", false)
	req := httptest.NewRequest(http.MethodPost, "/api/admin/import/records", body)
	req.Header.Set("Authorization", "Bearer ai-tok")
	req.Header.Set("Content-Type", ct)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != 401 {
		t.Fatalf("status %d body %s", rr.Code, rr.Body.String())
	}
}

func TestImportRecordsMultipartValidation(t *testing.T) {
	h := importTestServer().Handler()

	// non-multipart
	req := httptest.NewRequest(http.MethodPost, "/api/admin/import/records", strings.NewReader("{}"))
	req.Header.Set("Authorization", "Bearer admin-tok")
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != 400 {
		t.Fatalf("json status %d", rr.Code)
	}
	var errBody map[string]any
	_ = json.Unmarshal(rr.Body.Bytes(), &errBody)
	if errBody["detail"] != importapi.ErrMultipartContentType.Error() {
		t.Fatalf("json error %v", errBody)
	}

	// missing file
	var emptyBody bytes.Buffer
	w := multipart.NewWriter(&emptyBody)
	_ = w.WriteField("other", "x")
	_ = w.Close()
	req2 := httptest.NewRequest(http.MethodPost, "/api/admin/import/records", &emptyBody)
	req2.Header.Set("Authorization", "Bearer admin-tok")
	req2.Header.Set("Content-Type", w.FormDataContentType())
	rr2 := httptest.NewRecorder()
	h.ServeHTTP(rr2, req2)
	if rr2.Code != 400 {
		t.Fatalf("missing status %d body %s", rr2.Code, rr2.Body.String())
	}
	_ = json.Unmarshal(rr2.Body.Bytes(), &errBody)
	if errBody["detail"] != importapi.ErrMultipartRequired.Error() {
		t.Fatalf("missing error %v", errBody)
	}

	// multiple file
	body, ct := buildImportMultipart(t, "records.jsonl", "application/x-ndjson", "", true)
	req3 := httptest.NewRequest(http.MethodPost, "/api/admin/import/records", body)
	req3.Header.Set("Authorization", "Bearer admin-tok")
	req3.Header.Set("Content-Type", ct)
	rr3 := httptest.NewRecorder()
	h.ServeHTTP(rr3, req3)
	if rr3.Code != 400 {
		t.Fatalf("multi status %d", rr3.Code)
	}
	_ = json.Unmarshal(rr3.Body.Bytes(), &errBody)
	if errBody["detail"] != importapi.ErrMultipartMultipleFile.Error() {
		t.Fatalf("multi error %v", errBody)
	}

	// unsupported content-type
	body4, ct4 := buildImportMultipart(t, "records.txt", "text/plain", "x", false)
	req4 := httptest.NewRequest(http.MethodPost, "/api/admin/import/records", body4)
	req4.Header.Set("Authorization", "Bearer admin-tok")
	req4.Header.Set("Content-Type", ct4)
	rr4 := httptest.NewRecorder()
	h.ServeHTTP(rr4, req4)
	if rr4.Code != 400 {
		t.Fatalf("ctype status %d", rr4.Code)
	}
	_ = json.Unmarshal(rr4.Body.Bytes(), &errBody)
	if errBody["detail"] != importapi.ErrUnsupportedFileContentType.Error() {
		t.Fatalf("ctype error %v", errBody)
	}
}

func TestImportRecordsDoesNotUseMaxBodyGate(t *testing.T) {
	// file part > MaxBodyBytes（256KiB）且 > 4MiB：须 400 limits，不得 413 readBody 门闸。
	h := importTestServer().Handler()
	payload := strings.Repeat("a", importapi.MaxImportFileBytes+1)
	body, ct := buildImportMultipart(t, "records.jsonl", "application/x-ndjson", payload, false)
	req := httptest.NewRequest(http.MethodPost, "/api/admin/import/records", body)
	req.Header.Set("Authorization", "Bearer admin-tok")
	req.Header.Set("Content-Type", ct)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code == 413 {
		t.Fatalf("must not 413 from MaxBodyBytes gate; body %s", rr.Body.String())
	}
	if rr.Code != 400 {
		t.Fatalf("status %d body %s", rr.Code, rr.Body.String())
	}
	var errBody map[string]any
	_ = json.Unmarshal(rr.Body.Bytes(), &errBody)
	if errBody["detail"] != importapi.ErrImportLimitsError.Error() {
		t.Fatalf("error %v", errBody)
	}
	if errBody["detail"] == httpx.BodyTooLargeMessage {
		t.Fatalf("must not use body-too-large gate")
	}
}

func TestImportRecordsRejectsOversizedNonFilePart(t *testing.T) {
	h := importTestServer().Handler()
	var body bytes.Buffer
	w := multipart.NewWriter(&body)
	// 先写超大非 file 字段，须 400 且有界丢弃（不得无界 Copy）。
	if err := w.WriteField("noise", strings.Repeat("x", importapi.MaxImportFileBytes+1)); err != nil {
		t.Fatal(err)
	}
	hPart := make(textproto.MIMEHeader)
	hPart.Set("Content-Disposition", `form-data; name="file"; filename="records.jsonl"`)
	hPart.Set("Content-Type", "application/x-ndjson")
	part, err := w.CreatePart(hPart)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write([]byte("")); err != nil {
		t.Fatal(err)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodPost, "/api/admin/import/records", &body)
	req.Header.Set("Authorization", "Bearer admin-tok")
	req.Header.Set("Content-Type", w.FormDataContentType())
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != 400 {
		t.Fatalf("status %d body %s", rr.Code, rr.Body.String())
	}
	var errBody map[string]any
	_ = json.Unmarshal(rr.Body.Bytes(), &errBody)
	if errBody["detail"] != importapi.ErrMultipartPartTooLarge.Error() {
		t.Fatalf("error %v", errBody)
	}
}

// D5：文本 part 名为 file → Go 视作 filename="" / CT="" → 400 unsupported Content-Type
// （与 Next route 对齐：非 file-required 文案）。
func TestImportRecordsTextPartNamedFile(t *testing.T) {
	h := importTestServer().Handler()
	var b bytes.Buffer
	w := multipart.NewWriter(&b)
	_ = w.WriteField("file", `{"id":"01900000-0000-7000-8000-000000000001","happened_at":"2026-07-30T00:00:00.000Z","numeric_value":"1","tags":["weight"],"objective_context":"x"}`)
	_ = w.Close()

	req := httptest.NewRequest(http.MethodPost, "/api/admin/import/records", &b)
	req.Header.Set("Authorization", "Bearer admin-tok")
	req.Header.Set("Content-Type", w.FormDataContentType())
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != 400 {
		t.Fatalf("status %d body %s", rr.Code, rr.Body.String())
	}
	var errBody map[string]any
	_ = json.Unmarshal(rr.Body.Bytes(), &errBody)
	if errBody["detail"] != importapi.ErrUnsupportedFileContentType.Error() {
		t.Fatalf("error %v", errBody)
	}
}
