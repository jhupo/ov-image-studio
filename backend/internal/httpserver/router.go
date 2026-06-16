package httpserver

import (
	"net/http"

	"ov-image-studio/backend/internal/config"
)

func RegisterAppRoutes(mux *http.ServeMux, cfg config.Config) {
	mux.HandleFunc("/api/health", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			WriteJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": map[string]string{"message": "method not allowed"}})
			return
		}
		WriteJSON(w, http.StatusOK, map[string]any{
			"ok":              true,
			"businessBackend": cfg.BusinessBackendConfigured(),
		})
	})
	mux.HandleFunc("/api/app-config", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			WriteJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": map[string]string{"message": "method not allowed"}})
			return
		}
		WriteJSON(w, http.StatusOK, map[string]any{
			"siteName":     cfg.SiteName,
			"siteURL":      cfg.SiteURL,
			"siteIconURL":  cfg.SiteIconURL,
			"defaultModel": "gpt-image-2",
		})
	})
}
