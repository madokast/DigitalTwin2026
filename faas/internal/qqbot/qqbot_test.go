package qqbot

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func configuredGetenv(k string) string {
	switch k {
	case "QQBOT_APP_ID":
		return "app-1"
	case "QQBOT_APP_SECRET":
		return "sec-1"
	case "QQBOT_USER_OPENID":
		return "openid-1"
	}
	return ""
}

func TestLoadConfig(t *testing.T) {
	cfg := LoadConfig(func(k string) string { return "" })
	if cfg.Configured() {
		t.Fatal("expected not configured")
	}
	if ConfigError(cfg) != "QQ Bot is not configured (QQBOT_APP_ID / QQBOT_APP_SECRET / QQBOT_USER_OPENID)" {
		t.Fatalf("error: %q", ConfigError(cfg))
	}

	cfg = LoadConfig(func(k string) string {
		if k == "QQBOT_APP_ID" {
			return " a "
		}
		return ""
	})
	if ConfigError(cfg) != "QQ Bot is not configured (missing QQBOT_APP_SECRET, QQBOT_USER_OPENID)" {
		t.Fatalf("error: %q", ConfigError(cfg))
	}

	cfg = LoadConfig(func(k string) string {
		switch k {
		case "QQBOT_APP_ID":
			return "  app  "
		case "QQBOT_APP_SECRET":
			return "  sec  "
		case "QQBOT_USER_OPENID":
			return "  open  "
		}
		return ""
	})
	if !cfg.Configured() || cfg.AppID != "app" || cfg.AppSecret != "sec" || cfg.UserOpenID != "open" {
		t.Fatalf("cfg: %+v", cfg)
	}
	if ConfigError(cfg) != "" {
		t.Fatalf("expected empty ConfigError, got %q", ConfigError(cfg))
	}
}

func TestSendMessageSuccess(t *testing.T) {
	var tokenCalls, sendCalls int32
	var sawAuth string
	var sawBody map[string]any

	tokenSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&tokenCalls, 1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"access_token":"tok-1","expires_in":7200}`))
	}))
	defer tokenSrv.Close()

	sendSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&sendCalls, 1)
		if !strings.HasSuffix(r.URL.Path, "/v2/users/openid-1/messages") {
			t.Fatalf("path %s", r.URL.Path)
		}
		sawAuth = r.Header.Get("Authorization")
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &sawBody)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"id":"m1"}`))
	}))
	defer sendSrv.Close()

	s := &Sender{
		HTTPClient: sendSrv.Client(),
		TokenURL:   tokenSrv.URL,
		APIBases:   []string{sendSrv.URL},
		Getenv:     configuredGetenv,
	}
	if err := s.SendMessage("DigitalTwin2026 probe"); err != nil {
		t.Fatal(err)
	}
	if sawAuth != "QQBot tok-1" {
		t.Fatalf("auth: %q", sawAuth)
	}
	if sawBody["content"] != "DigitalTwin2026 probe" || sawBody["msg_type"] != float64(0) {
		t.Fatalf("body: %#v", sawBody)
	}
	if _, ok := sawBody["msg_id"]; ok {
		t.Fatal("proactive C2C must not include msg_id")
	}
	if atomic.LoadInt32(&tokenCalls) != 1 || atomic.LoadInt32(&sendCalls) != 1 {
		t.Fatalf("calls token=%d send=%d", tokenCalls, sendCalls)
	}
}

func TestSendMessageReusesCachedToken(t *testing.T) {
	var tokenCalls int32
	tokenSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&tokenCalls, 1)
		_, _ = w.Write([]byte(`{"access_token":"tok-cached","expires_in":7200}`))
	}))
	defer tokenSrv.Close()

	sendSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{}`))
	}))
	defer sendSrv.Close()

	s := &Sender{
		HTTPClient: sendSrv.Client(),
		TokenURL:   tokenSrv.URL,
		APIBases:   []string{sendSrv.URL},
		Getenv:     configuredGetenv,
	}
	if err := s.SendMessage("a"); err != nil {
		t.Fatal(err)
	}
	if err := s.SendMessage("b"); err != nil {
		t.Fatal(err)
	}
	if atomic.LoadInt32(&tokenCalls) != 1 {
		t.Fatalf("tokenCalls=%d want 1", tokenCalls)
	}
}

func TestSendMessageFallsBackToSecondBase(t *testing.T) {
	tokenSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"access_token":"tok-1","expires_in":7200}`))
	}))
	defer tokenSrv.Close()

	failSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"message":"upstream"}`))
	}))
	defer failSrv.Close()

	okSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{}`))
	}))
	defer okSrv.Close()

	s := &Sender{
		HTTPClient: okSrv.Client(),
		TokenURL:   tokenSrv.URL,
		APIBases:   []string{failSrv.URL, okSrv.URL},
		Getenv:     configuredGetenv,
	}
	if err := s.SendMessage("hi"); err != nil {
		t.Fatal(err)
	}
}

func TestSendMessageTransportError(t *testing.T) {
	s := &Sender{
		HTTPClient: &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
			return nil, fmt.Errorf("dial tcp: i/o timeout")
		})},
		TokenURL: "http://example.invalid/token",
		APIBases: []string{"http://example.invalid"},
		Getenv:   configuredGetenv,
	}
	err := s.SendMessage("x")
	if err == nil || err.Error() != TransportFailedMessage.Error() {
		t.Fatalf("err: %v", err)
	}
	if strings.Contains(err.Error(), "sec-1") {
		t.Fatal("must not leak secret")
	}
}

func TestSendMessageBothBasesFail(t *testing.T) {
	tokenSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"access_token":"tok-1","expires_in":7200}`))
	}))
	defer tokenSrv.Close()

	failSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"message":"invalid openid"}`))
	}))
	defer failSrv.Close()

	s := &Sender{
		HTTPClient: failSrv.Client(),
		TokenURL:   tokenSrv.URL,
		APIBases:   []string{failSrv.URL, failSrv.URL},
		Getenv:     configuredGetenv,
	}
	err := s.SendMessage("x")
	if err == nil || err.Error() != "QQ Bot sendMessage failed: invalid openid" {
		t.Fatalf("err: %v", err)
	}
}

func TestSendMessageNotConfigured(t *testing.T) {
	s := &Sender{Getenv: func(string) string { return "" }}
	err := s.SendMessage("x")
	if err == nil || !strings.Contains(err.Error(), "QQBOT_APP_ID") {
		t.Fatalf("err: %v", err)
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
