package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"mime"
	"net"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

type config struct {
	Host                   string
	Port                   string
	StaticDir              string
	Sub2APIBaseURL         string
	WorkerCount            int
	TaskTTL                time.Duration
	UpstreamTimeout        time.Duration
	MaxCreateRequestBytes  int64
	MaxUpstreamBodyBytes   int64
	MaxUpstreamResultBytes int64
}

type upstreamRequest struct {
	URL        string            `json:"url"`
	Method     string            `json:"method"`
	Headers    map[string]string `json:"headers"`
	BodyBase64 string            `json:"bodyBase64,omitempty"`
}

type upstreamResponse struct {
	StatusCode int               `json:"statusCode"`
	Status     string            `json:"status"`
	Headers    map[string]string `json:"headers"`
	BodyBase64 string            `json:"bodyBase64"`
}

type taskStatus string

const (
	statusQueued    taskStatus = "queued"
	statusRunning   taskStatus = "running"
	statusDone      taskStatus = "done"
	statusError     taskStatus = "error"
	statusCancelled taskStatus = "cancelled"
)

type task struct {
	ID          string
	Status      taskStatus
	Request     upstreamRequest
	Response    *upstreamResponse
	Error       string
	CreatedAt   time.Time
	StartedAt   *time.Time
	FinishedAt  *time.Time
	cancel      context.CancelFunc
	cancelledAt *time.Time
}

type taskStore struct {
	cfg   config
	mu    sync.RWMutex
	tasks map[string]*task
	queue chan string
}

type taskView struct {
	ID         string            `json:"id"`
	Status     taskStatus        `json:"status"`
	Error      string            `json:"error,omitempty"`
	CreatedAt  string            `json:"createdAt"`
	StartedAt  string            `json:"startedAt,omitempty"`
	FinishedAt string            `json:"finishedAt,omitempty"`
	Response   *upstreamResponse `json:"response,omitempty"`
}

func main() {
	cfg := loadConfig()
	store := newTaskStore(cfg)
	for i := 0; i < cfg.WorkerCount; i++ {
		go store.worker()
	}
	go store.cleanupLoop()

	mux := http.NewServeMux()
	mux.HandleFunc("/api/tasks", store.handleTasks)
	mux.HandleFunc("/api/tasks/", store.handleTask)
	mux.Handle("/", spaHandler(cfg.StaticDir))

	addr := net.JoinHostPort(cfg.Host, cfg.Port)
	log.Printf("OV Image Studio server listening on http://%s", addr)
	log.Printf("Sub2API upstream: %s", cfg.Sub2APIBaseURL)
	if err := http.ListenAndServe(addr, withSecurityHeaders(mux)); err != nil {
		log.Fatal(err)
	}
}

func loadConfig() config {
	loadDotEnv(".env")

	cfg := config{
		Host:                   getenv("HOST", "0.0.0.0"),
		Port:                   getenv("PORT", "80"),
		StaticDir:              getenv("STATIC_DIR", "dist"),
		Sub2APIBaseURL:         strings.TrimRight(getenv("SUB2API_BASE_URL", "http://127.0.0.1:8080"), "/"),
		WorkerCount:            getenvInt("WORKER_COUNT", 2),
		TaskTTL:                time.Duration(getenvInt("TASK_TTL_SECONDS", 3600)) * time.Second,
		UpstreamTimeout:        time.Duration(getenvInt("UPSTREAM_TIMEOUT_SECONDS", 1800)) * time.Second,
		MaxCreateRequestBytes:  int64(getenvInt("MAX_CREATE_REQUEST_MB", 600)) * 1024 * 1024,
		MaxUpstreamBodyBytes:   int64(getenvInt("MAX_UPSTREAM_BODY_MB", 600)) * 1024 * 1024,
		MaxUpstreamResultBytes: int64(getenvInt("MAX_UPSTREAM_RESULT_MB", 600)) * 1024 * 1024,
	}
	if cfg.WorkerCount < 1 {
		cfg.WorkerCount = 1
	}
	return cfg
}

func loadDotEnv(file string) {
	data, err := os.ReadFile(file)
	if err != nil {
		return
	}
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		key = strings.TrimSpace(key)
		value = strings.Trim(strings.TrimSpace(value), `"'`)
		if key == "" {
			continue
		}
		if _, exists := os.LookupEnv(key); !exists {
			_ = os.Setenv(key, value)
		}
	}
}

func getenv(key, fallback string) string {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	return value
}

func getenvInt(key string, fallback int) int {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(value)
	if err != nil {
		return fallback
	}
	return parsed
}

func newTaskStore(cfg config) *taskStore {
	return &taskStore{
		cfg:   cfg,
		tasks: make(map[string]*task),
		queue: make(chan string, max(1, cfg.WorkerCount*8)),
	}
}

func (s *taskStore) handleTasks(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSONError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	defer r.Body.Close()
	var req upstreamRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, s.cfg.MaxCreateRequestBytes)).Decode(&req); err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid task payload")
		return
	}
	normalizedReq, err := validateUpstreamRequest(req)
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, err.Error())
		return
	}
	if normalizedReq.BodyBase64 != "" {
		if int64(base64.StdEncoding.DecodedLen(len(normalizedReq.BodyBase64))) > s.cfg.MaxUpstreamBodyBytes {
			writeJSONError(w, http.StatusRequestEntityTooLarge, "request body too large")
			return
		}
	}

	t := &task{
		ID:        newID(),
		Status:    statusQueued,
		Request:   normalizedReq,
		CreatedAt: time.Now(),
	}

	s.mu.Lock()
	s.tasks[t.ID] = t
	s.mu.Unlock()

	select {
	case s.queue <- t.ID:
		writeJSON(w, http.StatusAccepted, viewTask(t, false))
	default:
		s.mu.Lock()
		delete(s.tasks, t.ID)
		s.mu.Unlock()
		writeJSONError(w, http.StatusServiceUnavailable, "task queue is full")
	}
}

func (s *taskStore) handleTask(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimPrefix(r.URL.Path, "/api/tasks/")
	id = strings.Trim(id, "/")
	if id == "" || strings.Contains(id, "/") {
		writeJSONError(w, http.StatusNotFound, "task not found")
		return
	}

	switch r.Method {
	case http.MethodGet:
		s.mu.RLock()
		t := s.tasks[id]
		s.mu.RUnlock()
		if t == nil {
			writeJSONError(w, http.StatusNotFound, "task not found")
			return
		}
		writeJSON(w, http.StatusOK, viewTask(t, true))
	case http.MethodDelete:
		if !s.cancelTask(id) {
			writeJSONError(w, http.StatusNotFound, "task not found")
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"id": id, "status": string(statusCancelled)})
	default:
		writeJSONError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (s *taskStore) worker() {
	client := &http.Client{}
	for id := range s.queue {
		s.runTask(client, id)
	}
}

func (s *taskStore) runTask(client *http.Client, id string) {
	s.mu.Lock()
	t := s.tasks[id]
	if t == nil {
		s.mu.Unlock()
		return
	}
	if t.Status == statusCancelled {
		s.mu.Unlock()
		return
	}
	now := time.Now()
	ctx, cancel := context.WithTimeout(context.Background(), s.cfg.UpstreamTimeout)
	t.Status = statusRunning
	t.StartedAt = &now
	t.cancel = cancel
	reqPayload := t.Request
	s.mu.Unlock()

	resp, runErr := s.executeUpstream(ctx, client, reqPayload)
	cancel()

	finishedAt := time.Now()
	s.mu.Lock()
	defer s.mu.Unlock()
	if t.cancelledAt != nil || errors.Is(runErr, context.Canceled) {
		t.Status = statusCancelled
		t.FinishedAt = &finishedAt
		t.cancel = nil
		return
	}
	t.FinishedAt = &finishedAt
	t.cancel = nil
	if runErr != nil {
		t.Status = statusError
		t.Error = runErr.Error()
		return
	}
	t.Status = statusDone
	t.Response = resp
}

func (s *taskStore) executeUpstream(ctx context.Context, client *http.Client, payload upstreamRequest) (*upstreamResponse, error) {
	target, err := resolveUpstreamURL(s.cfg.Sub2APIBaseURL, payload.URL)
	if err != nil {
		return nil, err
	}

	var body io.Reader
	if payload.BodyBase64 != "" {
		raw, err := base64.StdEncoding.DecodeString(payload.BodyBase64)
		if err != nil {
			return nil, fmt.Errorf("invalid request body encoding")
		}
		if int64(len(raw)) > s.cfg.MaxUpstreamBodyBytes {
			return nil, fmt.Errorf("request body too large")
		}
		body = bytes.NewReader(raw)
	}

	req, err := http.NewRequestWithContext(ctx, payload.Method, target, body)
	if err != nil {
		return nil, err
	}
	for key, value := range payload.Headers {
		if shouldForwardRequestHeader(key) {
			req.Header.Set(key, value)
		}
	}

	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	limited := io.LimitReader(resp.Body, s.cfg.MaxUpstreamResultBytes+1)
	responseBody, err := io.ReadAll(limited)
	if err != nil {
		return nil, err
	}
	if int64(len(responseBody)) > s.cfg.MaxUpstreamResultBytes {
		return nil, fmt.Errorf("upstream response too large")
	}

	return &upstreamResponse{
		StatusCode: resp.StatusCode,
		Status:     resp.Status,
		Headers:    flattenHeaders(resp.Header),
		BodyBase64: base64.StdEncoding.EncodeToString(responseBody),
	}, nil
}

func (s *taskStore) cancelTask(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	t := s.tasks[id]
	if t == nil {
		return false
	}
	now := time.Now()
	t.cancelledAt = &now
	if t.cancel != nil {
		t.cancel()
	}
	if t.Status == statusQueued {
		t.Status = statusCancelled
		t.FinishedAt = &now
	}
	return true
}

func (s *taskStore) cleanupLoop() {
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	for range ticker.C {
		cutoff := time.Now().Add(-s.cfg.TaskTTL)
		s.mu.Lock()
		for id, t := range s.tasks {
			if t.FinishedAt != nil && t.FinishedAt.Before(cutoff) {
				delete(s.tasks, id)
			}
		}
		s.mu.Unlock()
	}
}

func validateUpstreamRequest(req upstreamRequest) (upstreamRequest, error) {
	method := strings.ToUpper(strings.TrimSpace(req.Method))
	if method == "" {
		method = http.MethodGet
	}
	if method != http.MethodGet && method != http.MethodPost {
		return req, fmt.Errorf("unsupported method")
	}
	if strings.TrimSpace(req.URL) == "" {
		return req, fmt.Errorf("missing upstream URL")
	}
	if strings.HasPrefix(strings.TrimSpace(req.URL), "http://") || strings.HasPrefix(strings.TrimSpace(req.URL), "https://") {
		return req, fmt.Errorf("absolute upstream URLs are not allowed")
	}
	req.Method = method
	return req, nil
}

func resolveUpstreamURL(baseURL string, requestURL string) (string, error) {
	base, err := url.Parse(baseURL)
	if err != nil || base.Scheme == "" || base.Host == "" {
		return "", fmt.Errorf("invalid SUB2API_BASE_URL")
	}
	target, err := url.Parse(requestURL)
	if err != nil {
		return "", fmt.Errorf("invalid upstream URL")
	}
	if target.IsAbs() {
		return "", fmt.Errorf("absolute upstream URLs are not allowed")
	}
	if !strings.HasPrefix(target.Path, "/") {
		target.Path = "/" + target.Path
	}

	joined := *base
	basePath := strings.TrimRight(base.Path, "/")
	targetPath := path.Clean("/" + strings.TrimLeft(target.Path, "/"))
	if basePath == "" || basePath == "/" {
		joined.Path = targetPath
	} else {
		joined.Path = path.Join(basePath, targetPath)
	}
	joined.RawQuery = target.RawQuery
	joined.Fragment = ""
	return joined.String(), nil
}

func shouldForwardRequestHeader(key string) bool {
	switch strings.ToLower(key) {
	case "host", "connection", "content-length", "accept-encoding", "cf-connecting-ip", "cf-ray", "x-forwarded-for", "x-forwarded-proto":
		return false
	default:
		return true
	}
}

func flattenHeaders(headers http.Header) map[string]string {
	out := make(map[string]string, len(headers))
	for key, values := range headers {
		if shouldForwardResponseHeader(key) {
			out[key] = strings.Join(values, ", ")
		}
	}
	return out
}

func shouldForwardResponseHeader(key string) bool {
	switch strings.ToLower(key) {
	case "connection", "content-length", "transfer-encoding", "content-encoding":
		return false
	default:
		return true
	}
}

func viewTask(t *task, includeResponse bool) taskView {
	view := taskView{
		ID:        t.ID,
		Status:    t.Status,
		Error:     t.Error,
		CreatedAt: t.CreatedAt.Format(time.RFC3339Nano),
	}
	if t.StartedAt != nil {
		view.StartedAt = t.StartedAt.Format(time.RFC3339Nano)
	}
	if t.FinishedAt != nil {
		view.FinishedAt = t.FinishedAt.Format(time.RFC3339Nano)
	}
	if includeResponse && t.Response != nil {
		view.Response = t.Response
	}
	return view
}

func newID() string {
	var buf [16]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return strconv.FormatInt(time.Now().UnixNano(), 36)
	}
	return hex.EncodeToString(buf[:])
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeJSONError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]any{
		"error": map[string]string{"message": message},
	})
}

func withSecurityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Referrer-Policy", "unsafe-url")
		next.ServeHTTP(w, r)
	})
}

func spaHandler(staticDir string) http.Handler {
	root := http.Dir(staticDir)
	fileServer := http.FileServer(root)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			writeJSONError(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		requestPath := path.Clean("/" + strings.TrimLeft(r.URL.Path, "/"))
		if requestPath == "/api" || strings.HasPrefix(requestPath, "/api/") {
			writeJSONError(w, http.StatusNotFound, "not found")
			return
		}
		localPath := filepath.Join(staticDir, filepath.FromSlash(requestPath))
		if info, err := os.Stat(localPath); err == nil && !info.IsDir() {
			setStaticContentType(w, localPath)
			if strings.HasPrefix(requestPath, "/assets/") {
				w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
			}
			fileServer.ServeHTTP(w, r)
			return
		}
		r2 := new(http.Request)
		*r2 = *r
		r2.URL = new(url.URL)
		*r2.URL = *r.URL
		r2.URL.Path = "/"
		setStaticContentType(w, filepath.Join(staticDir, "index.html"))
		fileServer.ServeHTTP(w, r2)
	})
}

func setStaticContentType(w http.ResponseWriter, filePath string) {
	if contentType := mime.TypeByExtension(filepath.Ext(filePath)); contentType != "" {
		w.Header().Set("Content-Type", contentType)
	}
}
