package imagejobs

import (
	"net/http"
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
	mux.HandleFunc("/api/image/jobs", h.handleJobs)
	mux.HandleFunc("/api/image/jobs/", h.handleJob)
}

func (h *Handler) handleJobs(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		httpserver.WriteError(w, apperror.New(http.StatusMethodNotAllowed, "method_not_allowed", "method not allowed"))
		return
	}
	var req CreateRequest
	if err := httpserver.DecodeJSON(r, &req, h.maxBody); err != nil {
		httpserver.WriteError(w, err)
		return
	}
	job, err := h.service.Create(r.Context(), req)
	if err != nil {
		httpserver.WriteError(w, err)
		return
	}
	httpserver.WriteJSON(w, http.StatusAccepted, map[string]any{"job": job})
}

func (h *Handler) handleJob(w http.ResponseWriter, r *http.Request) {
	id, action := splitJobPath(r.URL.Path)
	if id == "" {
		httpserver.WriteError(w, apperror.NotFound("任务不存在"))
		return
	}
	switch {
	case r.Method == http.MethodGet && action == "":
		view, err := h.service.Get(r.Context(), id)
		if err != nil {
			httpserver.WriteError(w, err)
			return
		}
		httpserver.WriteJSON(w, http.StatusOK, view)
	case r.Method == http.MethodPost && action == "cancel":
		if err := h.service.Cancel(r.Context(), id); err != nil {
			httpserver.WriteError(w, err)
			return
		}
		httpserver.WriteJSON(w, http.StatusOK, map[string]string{"id": id, "status": StatusCancelled})
	case r.Method == http.MethodPost && action == "ack":
		if err := h.service.Ack(r.Context(), id); err != nil {
			httpserver.WriteError(w, err)
			return
		}
		httpserver.WriteJSON(w, http.StatusOK, map[string]string{"id": id, "status": "acked"})
	default:
		httpserver.WriteError(w, apperror.New(http.StatusMethodNotAllowed, "method_not_allowed", "method not allowed"))
	}
}

func splitJobPath(path string) (string, string) {
	rest := strings.Trim(strings.TrimPrefix(path, "/api/image/jobs/"), "/")
	if rest == "" {
		return "", ""
	}
	parts := strings.Split(rest, "/")
	if len(parts) == 1 {
		return parts[0], ""
	}
	if len(parts) == 2 {
		return parts[0], parts[1]
	}
	return "", ""
}
