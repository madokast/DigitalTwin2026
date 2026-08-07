package httpx

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/mdk/digitaltwin2026/faas/internal/myerr"
	"github.com/mdk/digitaltwin2026/faas/internal/recordrepo"
)

// handleLogTagsAdd/Remove 纯 handler 测试（fake TagsService，校验失败/成功路径零 DB）。
func TestHandleLogTagsEdit(t *testing.T) {
	t.Parallel()
	var (
		mu   sync.Mutex
		opID string
		op   string
	)
	fakeSvc := &fakeTagsService{
		attachTag: func(_ context.Context, id, tag string) (recordrepo.EditTagsResult, *myerr.MyError) {
			mu.Lock()
			opID = id
			op = "attach"
			mu.Unlock()
			return recordrepo.EditTagsResult{From: []string{"exercise"}, To: []string{"exercise", tag}, Changed: true}, nil
		},
		detachTag: func(_ context.Context, id, tag string) (recordrepo.EditTagsResult, *myerr.MyError) {
			mu.Lock()
			opID = id
			op = "detach"
			mu.Unlock()
			return recordrepo.EditTagsResult{From: []string{"exercise", tag}, To: []string{"exercise"}, Changed: true}, nil
		},
	}
	notifier := &fakeNotifier{}
	s := &Server{TagsSvc: fakeSvc, Notifier: notifier}

	const validID = "01900000-0000-7000-8000-000000000003"

	post := func(path, body string) (*httptest.ResponseRecorder, map[string]any) {
		req := httptest.NewRequest(http.MethodPost, path, bytes.NewReader([]byte(body)))
		rr := httptest.NewRecorder()
		if path == "/api/log/tags/add" {
			s.handleLogTagsAdd(rr, req)
		} else {
			s.handleLogTagsRemove(rr, req)
		}
		var got map[string]any
		_ = json.Unmarshal(rr.Body.Bytes(), &got)
		return rr, got
	}

	t.Run("add success notifies", func(t *testing.T) {
		rr, got := post("/api/log/tags/add", `{"id":"`+validID+`","tag":"workout:arm"}`)
		if rr.Code != 200 {
			t.Fatalf("status=%d body=%s", rr.Code, rr.Body.String())
		}
		if got["success"] != true || got["id"] != validID || got["changed"] != true {
			t.Fatalf("body=%v", got)
		}
		tags := got["tags"].(map[string]any)
		join := func(v any) string {
			parts := v.([]any)
			out := make([]string, 0, len(parts))
			for _, p := range parts {
				out = append(out, p.(string))
			}
			return strings.Join(out, ",")
		}
		if join(tags["from"]) != "exercise" || join(tags["to"]) != "exercise,workout:arm" {
			t.Fatalf("tags=%v", tags)
		}
		texts := notifier.waitTexts(1)
		want := "Tags updated\nid: " + validID + "\naction: add\ntag: workout:arm\ntags: from [exercise] to [exercise, workout:arm]"
		if len(texts) != 1 || texts[0] != want {
			t.Fatalf("notify=%q want=%q", texts, want)
		}
		mu.Lock()
		defer mu.Unlock()
		if op != "attach" || opID != validID {
			t.Fatalf("op=%s id=%s", op, opID)
		}
	})

	t.Run("remove success notifies", func(t *testing.T) {
		rr, _ := post("/api/log/tags/remove", `{"id":"`+validID+`","tag":"workout:arm"}`)
		if rr.Code != 200 {
			t.Fatalf("status=%d body=%s", rr.Code, rr.Body.String())
		}
		texts := notifier.waitTexts(2)
		if len(texts) != 2 || !strings.Contains(texts[1], "action: remove") {
			t.Fatalf("notify=%q", texts)
		}
	})

	t.Run("changed false skips notify", func(t *testing.T) {
		before := len(notifier.textsLocked())
		fakeSvc.attachTag = func(_ context.Context, id, tag string) (recordrepo.EditTagsResult, *myerr.MyError) {
			return recordrepo.EditTagsResult{From: []string{"a"}, To: []string{"a"}, Changed: false}, nil
		}
		defer func() {
			fakeSvc.attachTag = nil
		}()
		rr, got := post("/api/log/tags/add", `{"id":"`+validID+`","tag":"a"}`)
		if rr.Code != 200 || got["changed"] != false {
			t.Fatalf("status=%d body=%v", rr.Code, got)
		}
		if n := len(notifier.textsLocked()); n != before {
			t.Fatalf("notify fired on changed=false: %d", n)
		}
	})
}

func TestHandleLogTagsEditValidation(t *testing.T) {
	t.Parallel()
	// 校验失败零 DB：TagsSvc 不注入（调用即 panic，可证明未进入业务层）
	s := &Server{}
	const validID = "01900000-0000-7000-8000-000000000003"

	cases := []struct {
		name, path, body, wantDetail string
		wantStatus                   int
	}{
		{"unknown key", "/api/log/tags/add", `{"id":"` + validID + `","tag":"ok","extra":1}`, `Unknown JSON key: extra`, 400},
		{"bad json", "/api/log/tags/add", `{`, "invalid JSON body", 400},
		{"invalid id", "/api/log/tags/add", `{"id":"not-a-uuid","tag":"ok"}`, "invalid record id", 400},
		{"invalid tag", "/api/log/tags/add", `{"id":"` + validID + `","tag":"bad tag"}`, "invalid tag: \"bad tag\". Tags must contain only letters, numbers, underscores, and cannot start with a number", 400},
		{"reserved tag", "/api/log/tags/add", `{"id":"` + validID + `","tag":"body:weight"}`, "tag \"body:weight\" is reserved; use the dedicated log API for this record type", 400},
		{"reserved remove", "/api/log/tags/remove", `{"id":"` + validID + `","tag":"todo:in_progress"}`, "tag \"todo:in_progress\" is reserved; use the dedicated log API for this record type", 400},
		{"not found", "/api/log/tags/add", `{"id":"` + validID + `","tag":"ok"}`, "", 404},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if c.wantDetail != "" {
				// 校验路径：不注入 service，若进业务层会 panic
				req := httptest.NewRequest(http.MethodPost, c.path, bytes.NewReader([]byte(c.body)))
				rr := httptest.NewRecorder()
				if c.path == "/api/log/tags/add" {
					s.handleLogTagsAdd(rr, req)
				} else {
					s.handleLogTagsRemove(rr, req)
				}
				if rr.Code != c.wantStatus {
					t.Fatalf("status=%d body=%s", rr.Code, rr.Body.String())
				}
				var got map[string]any
				_ = json.Unmarshal(rr.Body.Bytes(), &got)
				if got["detail"] != c.wantDetail {
					t.Fatalf("detail=%q want=%q", got["detail"], c.wantDetail)
				}
				return
			}
			// 404 路径：注入 fake 返回 not found
			s2 := &Server{TagsSvc: &fakeTagsService{attachTag: func(_ context.Context, id, tag string) (recordrepo.EditTagsResult, *myerr.MyError) {
				return recordrepo.EditTagsResult{}, myerr.NewNotFound("record " + id + " not found")
			}}}
			req := httptest.NewRequest(http.MethodPost, c.path, bytes.NewReader([]byte(c.body)))
			rr := httptest.NewRecorder()
			s2.handleLogTagsAdd(rr, req)
			if rr.Code != 404 {
				t.Fatalf("status=%d body=%s", rr.Code, rr.Body.String())
			}
			var got map[string]any
			_ = json.Unmarshal(rr.Body.Bytes(), &got)
			if got["detail"] != "record "+validID+" not found" {
				t.Fatalf("detail=%q", got["detail"])
			}
		})
	}
}
