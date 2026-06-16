package keys

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"path"
	"strings"
	"time"

	"ov-image-studio/backend/internal/apperror"
	"ov-image-studio/backend/internal/httpserver"
)

const maxKeysResponseBytes int64 = 10 * 1024 * 1024

type Handler struct {
	baseURL string
	client  *http.Client
}

func NewHandler(baseURL string) *Handler {
	return &Handler{
		baseURL: strings.TrimRight(baseURL, "/"),
		client:  &http.Client{},
	}
}

func (h *Handler) Register(mux *http.ServeMux) {
	mux.HandleFunc("/api/v1/keys", h.handleKeys)
	mux.HandleFunc("/api/v1/admin/users/", h.handleKeys)
	mux.HandleFunc("/api/keys", h.handleKeys)
}

func (h *Handler) handleKeys(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		httpserver.WriteError(w, apperror.New(http.StatusMethodNotAllowed, "method_not_allowed", "method not allowed"))
		return
	}
	authorization := strings.TrimSpace(r.Header.Get("Authorization"))
	if !strings.HasPrefix(strings.ToLower(authorization), "bearer ") {
		httpserver.WriteError(w, apperror.Unauthorized("missing bearer token"))
		return
	}
	if !isAllowedPath(r.URL.Path, authorization) {
		httpserver.WriteError(w, apperror.NotFound("not found"))
		return
	}
	target, err := h.resolve(r.URL.RequestURI())
	if err != nil {
		httpserver.WriteError(w, err)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		httpserver.WriteError(w, err)
		return
	}
	req.Header.Set("Authorization", authorization)
	req.Header.Set("Accept", "application/json")

	resp, err := h.client.Do(req)
	if err != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			httpserver.WriteError(w, &apperror.Error{Code: "upstream_timeout", Message: "keys upstream request timed out", Category: "timeout", HTTPStatus: http.StatusGatewayTimeout, Retryable: true})
			return
		}
		httpserver.WriteError(w, &apperror.Error{Code: "upstream_request_failed", Message: "keys upstream request failed", Category: "network", HTTPStatus: http.StatusBadGateway, Retryable: true})
		return
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxKeysResponseBytes+1))
	if err != nil {
		httpserver.WriteError(w, &apperror.Error{Code: "upstream_read_failed", Message: "keys upstream response read failed", Category: "upstream", HTTPStatus: http.StatusBadGateway})
		return
	}
	if int64(len(body)) > maxKeysResponseBytes {
		httpserver.WriteError(w, &apperror.Error{Code: "upstream_response_too_large", Message: "keys upstream response too large", Category: "upstream", HTTPStatus: http.StatusBadGateway})
		return
	}
	for key, values := range resp.Header {
		if shouldForwardResponseHeader(key) {
			for _, value := range values {
				w.Header().Add(key, value)
			}
		}
	}
	w.WriteHeader(resp.StatusCode)
	_, _ = w.Write(body)
}

func (h *Handler) resolve(requestURI string) (string, error) {
	base, err := url.Parse(h.baseURL)
	if err != nil || base.Scheme == "" || base.Host == "" {
		return "", apperror.Internal("SUB2API_BASE_URL 无效")
	}
	target, err := url.Parse(requestURI)
	if err != nil || target.IsAbs() {
		return "", apperror.BadRequest("keys path invalid")
	}
	joined := *base
	joined.Path = path.Join(strings.TrimRight(base.Path, "/"), path.Clean("/"+strings.TrimLeft(target.Path, "/")))
	joined.RawQuery = target.RawQuery
	joined.Fragment = ""
	return joined.String(), nil
}

func isAllowedPath(requestPath string, authorization string) bool {
	requestPath = path.Clean("/" + strings.TrimLeft(requestPath, "/"))
	if requestPath == "/api/v1/keys" || requestPath == "/api/keys" {
		return true
	}
	const prefix = "/api/v1/admin/users/"
	const suffix = "/api-keys"
	if !strings.HasPrefix(requestPath, prefix) || !strings.HasSuffix(requestPath, suffix) {
		return false
	}
	userID := strings.TrimSuffix(strings.TrimPrefix(requestPath, prefix), suffix)
	if userID == "" || strings.Contains(userID, "/") {
		return false
	}
	for _, char := range userID {
		if char < '0' || char > '9' {
			return false
		}
	}
	tokenUserID, ok := bearerTokenUserID(authorization)
	return ok && tokenUserID == userID
}

func bearerTokenUserID(authorization string) (string, bool) {
	fields := strings.Fields(authorization)
	if len(fields) != 2 || strings.ToLower(fields[0]) != "bearer" {
		return "", false
	}
	parts := strings.Split(fields[1], ".")
	if len(parts) < 2 {
		return "", false
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return "", false
	}
	var claims struct {
		UserID json.RawMessage `json:"user_id"`
	}
	if err := json.Unmarshal(payload, &claims); err != nil || len(claims.UserID) == 0 {
		return "", false
	}
	var numeric json.Number
	if err := json.Unmarshal(claims.UserID, &numeric); err == nil {
		if id := numeric.String(); id != "" {
			return id, true
		}
	}
	var text string
	if err := json.Unmarshal(claims.UserID, &text); err != nil || text == "" {
		return "", false
	}
	for _, char := range text {
		if char < '0' || char > '9' {
			return "", false
		}
	}
	return text, true
}

func shouldForwardResponseHeader(key string) bool {
	switch strings.ToLower(key) {
	case "connection", "content-length", "transfer-encoding", "content-encoding":
		return false
	default:
		return true
	}
}
