package apperror

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
)

type Error struct {
	Code               string `json:"code"`
	Message            string `json:"message"`
	Category           string `json:"category,omitempty"`
	HTTPStatus         int    `json:"-"`
	UpstreamStatusCode int    `json:"upstreamStatusCode,omitempty"`
	Retryable          bool   `json:"retryable"`
	Raw                any    `json:"raw,omitempty"`
}

func (e *Error) Error() string {
	return e.Message
}

func New(status int, code string, message string) *Error {
	return &Error{
		Code:       code,
		Message:    message,
		HTTPStatus: status,
	}
}

func BadRequest(message string) *Error {
	return New(http.StatusBadRequest, "bad_request", message)
}

func Unauthorized(message string) *Error {
	return New(http.StatusUnauthorized, "unauthorized", message)
}

func NotFound(message string) *Error {
	return New(http.StatusNotFound, "not_found", message)
}

func Internal(message string) *Error {
	return New(http.StatusInternalServerError, "internal_error", message)
}

func Upstream(statusCode int, status string, body []byte) *Error {
	message := fmt.Sprintf("上游返回 HTTP %d", statusCode)
	if strings.TrimSpace(status) != "" {
		message = fmt.Sprintf("上游返回 %s", status)
	}
	if summary := SummarizeBody(body); summary != "" {
		message = fmt.Sprintf("%s：%s", message, summary)
	}
	return &Error{
		Code:               "upstream_http_error",
		Message:            message,
		Category:           "upstream",
		HTTPStatus:         http.StatusBadGateway,
		UpstreamStatusCode: statusCode,
		Retryable:          statusCode == http.StatusTooManyRequests || statusCode >= 500,
		Raw: map[string]any{
			"status": status,
			"body":   string(body),
		},
	}
}

func Normalize(err error) *Error {
	if err == nil {
		return nil
	}
	var appErr *Error
	if errors.As(err, &appErr) {
		return appErr
	}
	return Internal(err.Error())
}

func SummarizeBody(body []byte) string {
	text := strings.TrimSpace(string(body))
	if text == "" {
		return ""
	}

	var payload any
	if err := json.Unmarshal(body, &payload); err == nil {
		if message := pickMessage(payload); message != "" {
			text = message
		} else if compact, err := json.Marshal(payload); err == nil {
			text = string(compact)
		}
	}

	text = strings.Join(strings.Fields(text), " ")
	const maxChars = 500
	runes := []rune(text)
	if len(runes) > maxChars {
		return string(runes[:maxChars]) + "..."
	}
	return text
}

func pickMessage(value any) string {
	record, ok := value.(map[string]any)
	if !ok {
		return ""
	}
	if errorValue, exists := record["error"]; exists {
		if message := pickMessage(errorValue); message != "" {
			return message
		}
		if text, ok := errorValue.(string); ok {
			return strings.TrimSpace(text)
		}
	}
	for _, key := range []string{"message", "detail", "error_description"} {
		if text, ok := record[key].(string); ok && strings.TrimSpace(text) != "" {
			return strings.TrimSpace(text)
		}
	}
	if detail, ok := record["detail"].([]any); ok {
		parts := make([]string, 0, len(detail))
		for _, item := range detail {
			if text, ok := item.(string); ok && strings.TrimSpace(text) != "" {
				parts = append(parts, strings.TrimSpace(text))
			}
		}
		if len(parts) > 0 {
			return strings.Join(parts, "\n")
		}
	}
	return ""
}
