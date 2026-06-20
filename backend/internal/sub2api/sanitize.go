package sub2api

import (
	"encoding/base64"
	"strings"

	"ov-image-studio/backend/internal/assets"
)

func sanitizeImageURLs(value any) any {
	return sanitizeImageURLsForKey("", value)
}

func sanitizeImageURLsForKey(key string, value any) any {
	switch typed := value.(type) {
	case map[string]any:
		for childKey, childValue := range typed {
			typed[childKey] = sanitizeImageURLsForKey(childKey, childValue)
		}
	case []any:
		for index, childValue := range typed {
			typed[index] = sanitizeImageURLsForKey(key, childValue)
		}
	case []string:
		for index, childValue := range typed {
			typed[index] = sanitizeImageURLsForKey(key, childValue).(string)
		}
	case string:
		if isImageURLKey(key) {
			return normalizeImageDataURLMIME(typed)
		}
	}
	return value
}

func isImageURLKey(key string) bool {
	switch strings.ToLower(strings.TrimSpace(key)) {
	case "image_url", "image_urls":
		return true
	default:
		return false
	}
}

func normalizeImageDataURLMIME(value string) string {
	if len(value) < len("data:") || !strings.EqualFold(value[:len("data:")], "data:") {
		return value
	}
	comma := strings.IndexByte(value, ',')
	if comma < 0 {
		return value
	}

	meta := value[:comma]
	payload := value[comma+1:]
	mime, suffix := splitDataURLMeta(meta)
	if assets.IsImageMIME(mime) || !strings.Contains(strings.ToLower(suffix), ";base64") {
		return value
	}

	header, ok := decodeBase64Header(payload)
	if !ok {
		return value
	}
	detected := assets.SniffMIME(header, mime)
	if !assets.IsImageMIME(detected) {
		return value
	}
	return "data:" + detected + ";base64," + payload
}

func splitDataURLMeta(meta string) (string, string) {
	rest := meta
	if len(rest) >= len("data:") && strings.EqualFold(rest[:len("data:")], "data:") {
		rest = rest[len("data:"):]
	}
	if index := strings.IndexByte(rest, ';'); index >= 0 {
		return strings.ToLower(strings.TrimSpace(rest[:index])), rest[index:]
	}
	return strings.ToLower(strings.TrimSpace(rest)), ""
}

func decodeBase64Header(payload string) ([]byte, bool) {
	var sample strings.Builder
	sample.Grow(64)
	for _, char := range payload {
		if char == '\r' || char == '\n' || char == '\t' || char == ' ' {
			continue
		}
		sample.WriteRune(char)
		if sample.Len() >= 64 {
			break
		}
	}

	encoded := sample.String()
	encoded = encoded[:len(encoded)-len(encoded)%4]
	if len(encoded) < 4 {
		return nil, false
	}
	decoded, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return nil, false
	}
	return decoded, true
}
