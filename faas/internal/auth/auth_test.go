package auth

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestBearerToken(t *testing.T) {
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	if BearerToken(r) != "" {
		t.Fatal("expected empty")
	}
	r.Header.Set("Authorization", "Token abc")
	if BearerToken(r) != "" {
		t.Fatal("expected empty for non-Bearer")
	}
	r.Header.Set("Authorization", "Bearer secret")
	if got := BearerToken(r); got != "secret" {
		t.Fatalf("got %q", got)
	}
	r.Header.Set("Authorization", "Bearer secret ")
	if got := BearerToken(r); got != "secret" {
		t.Fatalf("trailing space: got %q", got)
	}
	r.Header.Set("Authorization", "Bearer  secret")
	if got := BearerToken(r); got != "secret" {
		t.Fatalf("extra space after Bearer: got %q", got)
	}
}

func TestVerifyAPIAccess(t *testing.T) {
	tok := Tokens{AI: "ai-tok", Admin: "admin-tok"}

	req := httptest.NewRequest(http.MethodGet, "/api/query", nil)
	if tok.VerifyAPIAccess(req) {
		t.Fatal("missing auth should fail")
	}

	req.Header.Set("Authorization", "Bearer wrong")
	if tok.VerifyAPIAccess(req) {
		t.Fatal("wrong token should fail")
	}

	req.Header.Set("Authorization", "Bearer ai-tok")
	if !tok.VerifyAPIAccess(req) {
		t.Fatal("AI token should pass")
	}

	req.Header.Set("Authorization", "Bearer admin-tok")
	if !tok.VerifyAPIAccess(req) {
		t.Fatal("admin token should pass API access")
	}
}

func TestVerifyAdminAccess(t *testing.T) {
	tok := Tokens{AI: "ai-tok", Admin: "admin-tok"}

	req := httptest.NewRequest(http.MethodPost, "/api/admin/tags/normalize", nil)
	req.Header.Set("Authorization", "Bearer ai-tok")
	if tok.VerifyAdminAccess(req) {
		t.Fatal("AI token must not pass admin")
	}

	req.Header.Set("Authorization", "Bearer admin-tok")
	if !tok.VerifyAdminAccess(req) {
		t.Fatal("admin token should pass")
	}

	empty := Tokens{}
	req.Header.Set("Authorization", "Bearer ")
	if empty.VerifyAdminAccess(req) {
		t.Fatal("empty configured tokens should fail")
	}
}
