package assets

import (
	"net/http"
	"strings"
)

func SniffMIME(data []byte, fallback string) string {
	fallback = strings.TrimSpace(fallback)
	if fallback != "" {
		return fallback
	}
	return http.DetectContentType(data)
}
