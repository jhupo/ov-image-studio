package sub2api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"net/url"
	"path"
	"strings"
	"time"

	"ov-image-studio/backend/internal/apperror"
)

type Client struct {
	baseURL string
	http    *http.Client
	maxBody int64
}

func NewClient(baseURL string, timeout time.Duration, maxBody int64) *Client {
	return &Client{
		baseURL: strings.TrimRight(baseURL, "/"),
		http:    &http.Client{Timeout: timeout},
		maxBody: maxBody,
	}
}

func (c *Client) ImagesGeneration(ctx context.Context, apiKey string, body map[string]any) (map[string]any, error) {
	return c.postJSON(ctx, apiKey, "/images/generations", body)
}

func (c *Client) Responses(ctx context.Context, apiKey string, body map[string]any) (map[string]any, error) {
	return c.postJSON(ctx, apiKey, "/responses", body)
}

func (c *Client) ImagesEdit(ctx context.Context, apiKey string, fields map[string]string, files []MultipartFile) (map[string]any, error) {
	var buf bytes.Buffer
	writer := multipart.NewWriter(&buf)
	for key, value := range fields {
		if value == "" {
			continue
		}
		_ = writer.WriteField(key, value)
	}
	for _, file := range files {
		header := make(textproto.MIMEHeader)
		header.Set("Content-Disposition", fmt.Sprintf(`form-data; name="%s"; filename="%s"`, escapeMultipartValue(file.Field), escapeMultipartValue(file.Name)))
		if file.MIME != "" {
			header.Set("Content-Type", file.MIME)
		}
		part, err := writer.CreatePart(header)
		if err != nil {
			return nil, err
		}
		if _, err := part.Write(file.Data); err != nil {
			return nil, err
		}
	}
	if err := writer.Close(); err != nil {
		return nil, err
	}
	return c.doJSON(ctx, apiKey, "/images/edits", writer.FormDataContentType(), &buf)
}

type MultipartFile struct {
	Field string
	Name  string
	MIME  string
	Data  []byte
}

func escapeMultipartValue(value string) string {
	return strings.NewReplacer("\\", "\\\\", `"`, "\\\"").Replace(value)
}

func (c *Client) postJSON(ctx context.Context, apiKey string, requestPath string, body map[string]any) (map[string]any, error) {
	sanitizeImageURLs(body)
	raw, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	return c.doJSON(ctx, apiKey, requestPath, "application/json", bytes.NewReader(raw))
}

func (c *Client) doJSON(ctx context.Context, apiKey string, requestPath string, contentType string, body io.Reader) (map[string]any, error) {
	target, err := c.resolve(requestPath)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, target, body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+apiKey)
	req.Header.Set("Content-Type", contentType)
	req.Header.Set("Accept", "application/json")
	resp, err := c.http.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return nil, &apperror.Error{Code: "upstream_timeout", Message: "上游请求超时或被取消", Category: "timeout", HTTPStatus: http.StatusGatewayTimeout, Retryable: true}
		}
		return nil, &apperror.Error{Code: "upstream_request_failed", Message: err.Error(), Category: "network", HTTPStatus: http.StatusBadGateway, Retryable: true}
	}
	defer resp.Body.Close()
	limit := c.maxBody
	if limit <= 0 {
		limit = 600 * 1024 * 1024
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(raw)) > limit {
		return nil, &apperror.Error{Code: "upstream_result_too_large", Message: "上游响应过大", HTTPStatus: http.StatusBadGateway}
	}
	if resp.StatusCode >= 400 {
		return nil, apperror.Upstream(resp.StatusCode, resp.Status, raw)
	}
	var payload map[string]any
	if err := json.Unmarshal(raw, &payload); err != nil {
		return nil, &apperror.Error{Code: "invalid_upstream_json", Message: "上游返回的 JSON 无法解析", Category: "upstream", HTTPStatus: http.StatusBadGateway, Raw: string(raw)}
	}
	return payload, nil
}

func (c *Client) resolve(requestPath string) (string, error) {
	base, err := url.Parse(c.baseURL)
	if err != nil || base.Scheme == "" || base.Host == "" {
		return "", apperror.Internal("SUB2API_BASE_URL 无效")
	}
	target := *base
	target.Path = path.Join(strings.TrimRight(base.Path, "/"), "/"+strings.TrimLeft(requestPath, "/"))
	target.RawQuery = ""
	return target.String(), nil
}
