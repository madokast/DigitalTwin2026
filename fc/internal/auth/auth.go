package auth

import (
	"net/http"
	"os"
	"strings"
)

const UnauthorizedMessage = "Unauthorized: Invalid or missing token"

// Tokens holds configured bearer secrets (env DIGITAL_TWIN_*).
type Tokens struct {
	AI    string
	Admin string
}

func TokensFromEnv() Tokens {
	return Tokens{
		AI:    os.Getenv("DIGITAL_TWIN_TOKEN"),
		Admin: os.Getenv("DIGITAL_TWIN_ADMIN_TOKEN"),
	}
}

func BearerToken(r *http.Request) string {
	h := r.Header.Get("Authorization")
	if !strings.HasPrefix(h, "Bearer ") {
		return ""
	}
	return strings.TrimSpace(h[len("Bearer "):])
}

func isConfiguredToken(token, expected string) bool {
	return expected != "" && token == expected
}

// VerifyAPIAccess: AI or Admin token (non-admin /api/*).
func (t Tokens) VerifyAPIAccess(r *http.Request) bool {
	token := BearerToken(r)
	if token == "" {
		return false
	}
	return isConfiguredToken(token, t.AI) || isConfiguredToken(token, t.Admin)
}

// VerifyAdminAccess: Admin token only (/api/admin/*).
func (t Tokens) VerifyAdminAccess(r *http.Request) bool {
	token := BearerToken(r)
	if token == "" {
		return false
	}
	return isConfiguredToken(token, t.Admin)
}
