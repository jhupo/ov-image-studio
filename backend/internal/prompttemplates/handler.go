package prompttemplates

import (
	"io"
	"net/http"
	"strconv"
	"strings"

	"ov-image-studio/backend/internal/apperror"
	"ov-image-studio/backend/internal/httpserver"
)

type Handler struct {
	service *Service
}

func NewHandler(service *Service) *Handler {
	return &Handler{service: service}
}

func (h *Handler) Register(mux *http.ServeMux) {
	mux.HandleFunc("/api/prompt-templates", h.handleTemplates)
	mux.HandleFunc("/api/prompt-templates/", h.handleTemplate)
}

func (h *Handler) handleTemplates(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		page := queryInt(r, "page", 1)
		pageSize := queryInt(r, "page_size", queryInt(r, "pageSize", 24))
		result, err := h.service.List(r.Context(), r.URL.Query().Get("q"), r.URL.Query().Get("category"), queryIDs(r), page, pageSize)
		if err != nil {
			httpserver.WriteError(w, err)
			return
		}
		httpserver.WriteJSON(w, http.StatusOK, result)
	case http.MethodPost:
		if r.URL.Query().Get("sync") != "1" {
			httpserver.WriteError(w, apperror.NotFound("not found"))
			return
		}
		count, err := h.service.SyncNow(r.Context())
		if err != nil {
			httpserver.WriteError(w, err)
			return
		}
		httpserver.WriteJSON(w, http.StatusOK, map[string]any{"count": count})
	default:
		httpserver.WriteError(w, apperror.New(http.StatusMethodNotAllowed, "method_not_allowed", "method not allowed"))
	}
}

func (h *Handler) handleTemplate(w http.ResponseWriter, r *http.Request) {
	rest := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/prompt-templates/"), "/")
	parts := strings.Split(rest, "/")
	if len(parts) == 1 && parts[0] == "sync-status" && r.Method == http.MethodGet {
		status, err := h.service.Status(r.Context())
		if err != nil {
			httpserver.WriteError(w, err)
			return
		}
		httpserver.WriteJSON(w, http.StatusOK, status)
		return
	}
	if len(parts) == 3 && parts[1] == "images" && (r.Method == http.MethodGet || r.Method == http.MethodHead) {
		index, err := strconv.Atoi(parts[2])
		if err != nil {
			httpserver.WriteError(w, apperror.BadRequest("图片序号无效"))
			return
		}
		resp, err := h.service.ProxyImage(r.Context(), parts[0], index)
		if err != nil {
			httpserver.WriteError(w, err)
			return
		}
		defer resp.Body.Close()
		contentType := resp.Header.Get("Content-Type")
		if contentType == "" {
			contentType = "image/jpeg"
		}
		body, err := io.ReadAll(io.LimitReader(resp.Body, maxTemplateImageBytes+1))
		if err != nil {
			httpserver.WriteError(w, apperror.New(http.StatusBadGateway, "template_image_read_failed", "参考图读取失败"))
			return
		}
		if int64(len(body)) > maxTemplateImageBytes {
			httpserver.WriteError(w, apperror.New(http.StatusBadGateway, "template_image_too_large", "参考图过大"))
			return
		}
		w.Header().Set("Content-Type", contentType)
		w.Header().Set("Cache-Control", "public, max-age=86400")
		if r.Method == http.MethodGet {
			_, _ = w.Write(body)
		}
		return
	}
	httpserver.WriteError(w, apperror.NotFound("not found"))
}

func queryIDs(r *http.Request) []string {
	rawValues := r.URL.Query()["ids"]
	ids := make([]string, 0, len(rawValues))
	for _, raw := range rawValues {
		for _, id := range strings.Split(raw, ",") {
			if id = strings.TrimSpace(id); id != "" {
				ids = append(ids, id)
			}
		}
	}
	return ids
}

func queryInt(r *http.Request, key string, fallback int) int {
	value := strings.TrimSpace(r.URL.Query().Get(key))
	if value == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(value)
	if err != nil {
		return fallback
	}
	return parsed
}
