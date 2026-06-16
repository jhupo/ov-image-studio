package httpserver

import (
	"encoding/json"
	"io"
	"net/http"

	"ov-image-studio/backend/internal/apperror"
)

func WriteJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func WriteError(w http.ResponseWriter, err error) {
	appErr := apperror.Normalize(err)
	status := appErr.HTTPStatus
	if status == 0 {
		status = http.StatusInternalServerError
	}
	WriteJSON(w, status, map[string]any{
		"error": appErr,
	})
}

func DecodeJSON(r *http.Request, value any, maxBytes int64) error {
	defer r.Body.Close()
	var reader io.Reader = r.Body
	if maxBytes > 0 {
		reader = io.LimitReader(r.Body, maxBytes+1)
	}
	if err := json.NewDecoder(reader).Decode(value); err != nil {
		return apperror.BadRequest("请求体不是有效 JSON")
	}
	return nil
}
