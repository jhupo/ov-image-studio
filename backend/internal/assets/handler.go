package assets

import (
	"net/http"
	"strconv"
	"strings"

	"ov-image-studio/backend/internal/apperror"
	"ov-image-studio/backend/internal/httpserver"
)

type Handler struct {
	service *Service
	maxBody int64
}

func NewHandler(service *Service, maxBody int64) *Handler {
	return &Handler{service: service, maxBody: maxBody}
}

func (h *Handler) Register(mux *http.ServeMux) {
	mux.HandleFunc("/api/assets", h.handleAssets)
	mux.HandleFunc("/api/assets/", h.handleAsset)
}

func (h *Handler) handleAssets(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		httpserver.WriteError(w, apperror.New(http.StatusMethodNotAllowed, "method_not_allowed", "method not allowed"))
		return
	}
	var req UploadRequest
	if err := httpserver.DecodeJSON(r, &req, h.maxBody); err != nil {
		httpserver.WriteError(w, err)
		return
	}
	asset, err := h.service.CreateFromBase64(r.Context(), req)
	if err != nil {
		httpserver.WriteError(w, err)
		return
	}
	httpserver.WriteJSON(w, http.StatusCreated, UploadResponse{Asset: asset})
}

func (h *Handler) handleAsset(w http.ResponseWriter, r *http.Request) {
	id := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/assets/"), "/")
	if id == "" || strings.Contains(id, "/") {
		httpserver.WriteError(w, apperror.NotFound("图片不存在"))
		return
	}
	switch r.Method {
	case http.MethodGet:
		asset, data, err := h.service.Read(r.Context(), id)
		if err != nil {
			httpserver.WriteError(w, err)
			return
		}
		w.Header().Set("Content-Type", asset.MIME)
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Length", strconv.FormatInt(int64(len(data)), 10))
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(data)
	case http.MethodDelete:
		if err := h.service.DeleteAssets(r.Context(), []string{id}); err != nil {
			httpserver.WriteError(w, err)
			return
		}
		httpserver.WriteJSON(w, http.StatusOK, map[string]string{"id": id, "status": "deleted"})
	default:
		httpserver.WriteError(w, apperror.New(http.StatusMethodNotAllowed, "method_not_allowed", "method not allowed"))
	}
}
