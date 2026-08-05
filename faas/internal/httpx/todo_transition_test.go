package httpx

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/mdk/digitaltwin2026/faas/internal/auth"
	"github.com/mdk/digitaltwin2026/faas/internal/logapi"
	"github.com/mdk/digitaltwin2026/faas/internal/tododraft"
)

func TestLogTodoTransitionSuccessBodyAndNotify(t *testing.T) {
	const (
		todoID     = "01900000-0000-7000-8000-000000000003"
		notifyText = "Complete a to-do 01900000-0000-7000-8000-000000000003 created at 2026-08-02T02:00:00.000Z: Buy milk"
	)
	var notified []string
	s := &Server{
		Tokens: auth.Tokens{AI: "ai-tok", Admin: "admin-tok"},
		TransitionTodo: func(_ context.Context, _ *pgxpool.Pool, _ []byte) (logapi.TransitionResult, int, error) {
			return logapi.TransitionResult{
				ID:                  todoID,
				From:                tododraft.TodoStateInProgress,
				To:                  tododraft.TodoStateCompleted,
				TodoAuditNotifyText: notifyText,
			}, 200, nil
		},
		NotifyUser: func(text string) {
			notified = append(notified, text)
		},
	}
	h := s.Handler()

	req := httptest.NewRequest(http.MethodPost, "/api/log/todo/transition", strings.NewReader(`{
		"id":"01900000-0000-7000-8000-000000000003",
		"target":"completed",
		"happened_at":"2026-08-02T12:00:00+08:00"
	}`))
	req.Header.Set("Authorization", "Bearer ai-tok")
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)

	if rr.Code != 200 {
		t.Fatalf("status %d body %s", rr.Code, rr.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["success"] != true || body["id"] != todoID {
		t.Fatalf("body=%v", body)
	}
	tr, ok := body["transition"].(map[string]any)
	if !ok || tr["from"] != "in_progress" || tr["to"] != "completed" {
		t.Fatalf("transition=%v", body["transition"])
	}
	if _, has := body["record"]; has {
		t.Fatal("must not include record")
	}
	if _, has := body["audit_record"]; has {
		t.Fatal("must not include audit_record")
	}
	if len(notified) != 1 || notified[0] != notifyText {
		t.Fatalf("notified=%v want [%q]", notified, notifyText)
	}
}

func TestLogTodoTransitionRejectsSuppressAsUnknownKey(t *testing.T) {
	// 不注入 TransitionTodo：走真实 parse（rejectUnknownKeys）后才触达 DB。
	s := &Server{
		Tokens: auth.Tokens{AI: "ai-tok", Admin: "admin-tok"},
	}
	h := s.Handler()

	req := httptest.NewRequest(http.MethodPost, "/api/log/todo/transition", strings.NewReader(`{
		"id":"01900000-0000-7000-8000-000000000003",
		"target":"completed",
		"happened_at":"2026-08-02T12:00:00+08:00",
		"suppress_notification":true
	}`))
	req.Header.Set("Authorization", "Bearer ai-tok")
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)

	if rr.Code != 400 {
		t.Fatalf("status %d body %s", rr.Code, rr.Body.String())
	}
	assertProblemDetail(t, rr, "Unknown JSON key: suppress_notification")
}

func TestLogTodoTransitionDomainErrorsWithoutDB(t *testing.T) {
	cases := []struct {
		name   string
		status int
		err    string
	}{
		{"not found", 404, tododraft.ErrTodoNotFound.Error()},
		{"not a todo", 400, tododraft.ErrNotATodo.Error()},
		{"audit", 400, tododraft.ErrAuditTransition.Error()},
		{"already", 400, tododraft.ErrAlreadyTarget.Error()},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			wantStatus := c.status
			wantErr := c.err
			s := &Server{
				Tokens: auth.Tokens{AI: "ai-tok", Admin: "admin-tok"},
				TransitionTodo: func(_ context.Context, _ *pgxpool.Pool, _ []byte) (logapi.TransitionResult, int, error) {
					return logapi.TransitionResult{}, wantStatus, errString(wantErr)
				},
			}
			h := s.Handler()
			req := httptest.NewRequest(http.MethodPost, "/api/log/todo/transition", strings.NewReader(`{
				"id":"01900000-0000-7000-8000-000000000003",
				"target":"completed",
				"happened_at":"2026-08-02T12:00:00+08:00"
			}`))
			req.Header.Set("Authorization", "Bearer ai-tok")
			req.Header.Set("Content-Type", "application/json")
			rr := httptest.NewRecorder()
			h.ServeHTTP(rr, req)
			if rr.Code != wantStatus {
				t.Fatalf("status %d body %s", rr.Code, rr.Body.String())
			}
			assertProblemDetail(t, rr, wantErr)
		})
	}
}

type errString string

func (e errString) Error() string { return string(e) }
