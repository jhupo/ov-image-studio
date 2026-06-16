package sub2api

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"

	"ov-image-studio/backend/internal/apperror"
)

type ImageResult struct {
	Bytes         []byte
	MIME          string
	ActualParams  map[string]any
	RevisedPrompt string
}

func ExtractImages(ctx context.Context, payload map[string]any, maxBytes int64) ([]ImageResult, error) {
	results := make([]ImageResult, 0)
	mime := mimeFromPayload(payload)
	for _, item := range extractImageItems(payload) {
		image, err := imageFromItem(ctx, item, mime, maxBytes)
		if err != nil {
			return nil, err
		}
		if len(image.Bytes) == 0 {
			continue
		}
		image.ActualParams = PickActualParams(item)
		if revised, ok := item["revised_prompt"].(string); ok {
			image.RevisedPrompt = revised
		}
		results = append(results, image)
	}
	if len(results) == 0 {
		raw, _ := json.Marshal(payload)
		return nil, &apperror.Error{Code: "no_images_in_response", Message: "上游没有返回可识别的图片数据", Category: "upstream", HTTPStatus: http.StatusBadGateway, Raw: string(raw)}
	}
	return results, nil
}

func extractImageItems(payload map[string]any) []map[string]any {
	items := make([]map[string]any, 0)
	if data, ok := payload["data"].([]any); ok {
		for _, raw := range data {
			if item, ok := raw.(map[string]any); ok {
				items = append(items, item)
			}
		}
	}
	if output, ok := payload["output"].([]any); ok {
		for _, raw := range output {
			item, ok := raw.(map[string]any)
			if !ok || item["type"] != "image_generation_call" {
				continue
			}
			items = append(items, item)
		}
	}
	return items
}

func imageFromItem(ctx context.Context, item map[string]any, fallbackMime string, maxBytes int64) (ImageResult, error) {
	for _, key := range []string{"b64_json", "base64", "image", "data"} {
		if value, ok := item[key].(string); ok && strings.TrimSpace(value) != "" {
			raw, mime, err := decodeImageString(value, fallbackMime)
			return ImageResult{Bytes: raw, MIME: mime}, err
		}
	}
	if result, ok := item["result"].(string); ok && strings.TrimSpace(result) != "" {
		raw, mime, err := decodeImageString(result, fallbackMime)
		return ImageResult{Bytes: raw, MIME: mime}, err
	}
	if result, ok := item["result"].(map[string]any); ok {
		return imageFromItem(ctx, result, fallbackMime, maxBytes)
	}
	if imageURL, ok := item["url"].(string); ok && strings.HasPrefix(imageURL, "http") {
		raw, mime, err := downloadImageURL(ctx, imageURL, maxBytes)
		return ImageResult{Bytes: raw, MIME: mime}, err
	}
	return ImageResult{}, nil
}

func decodeImageString(value string, fallbackMime string) ([]byte, string, error) {
	value = strings.TrimSpace(value)
	mime := fallbackMime
	if strings.HasPrefix(value, "data:") {
		meta, payload, ok := strings.Cut(value, ",")
		if !ok {
			return nil, "", apperror.BadRequest("图片 data URL 无效")
		}
		value = payload
		if strings.HasPrefix(meta, "data:") {
			mime = strings.TrimPrefix(strings.Split(meta, ";")[0], "data:")
		}
	}
	raw, err := base64.StdEncoding.DecodeString(value)
	if err != nil {
		return nil, "", err
	}
	return raw, mime, nil
}

func downloadImageURL(ctx context.Context, imageURL string, maxBytes int64) ([]byte, string, error) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, imageURL, nil)
	if err != nil {
		return nil, "", err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return nil, "", apperror.Upstream(resp.StatusCode, resp.Status, nil)
	}
	if maxBytes <= 0 {
		maxBytes = 600 * 1024 * 1024
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxBytes+1))
	if err != nil {
		return nil, "", err
	}
	if int64(len(raw)) > maxBytes {
		return nil, "", &apperror.Error{Code: "image_download_too_large", Message: "图片下载结果过大", HTTPStatus: http.StatusBadGateway}
	}
	mime := resp.Header.Get("Content-Type")
	if mime == "" {
		mime = http.DetectContentType(raw)
	}
	return raw, mime, nil
}

func mimeFromPayload(payload map[string]any) string {
	if format, ok := payload["output_format"].(string); ok {
		switch format {
		case "jpeg", "jpg":
			return "image/jpeg"
		case "webp":
			return "image/webp"
		}
	}
	return "image/png"
}

func PickActualParams(source map[string]any) map[string]any {
	out := map[string]any{}
	for _, key := range []string{"size", "quality", "output_format", "output_compression", "moderation", "n"} {
		if value, ok := source[key]; ok {
			out[key] = value
		}
	}
	return out
}
