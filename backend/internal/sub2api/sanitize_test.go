package sub2api

import (
	"strings"
	"testing"
)

const tinyPNGBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII="

func preview(value string) string {
	if len(value) <= 64 {
		return value
	}
	return value[:64]
}

func TestSanitizeImageURLsNormalizesOctetStreamDataURL(t *testing.T) {
	body := map[string]any{
		"input": []any{
			map[string]any{
				"content": []any{
					map[string]any{
						"type":      "input_image",
						"image_url": "data:application/octet-stream;base64," + tinyPNGBase64,
					},
				},
			},
		},
	}

	sanitizeImageURLs(body)

	content := body["input"].([]any)[0].(map[string]any)["content"].([]any)[0].(map[string]any)
	imageURL := content["image_url"].(string)
	if !strings.HasPrefix(imageURL, "data:image/png;base64,") {
		t.Fatalf("expected image/png data URL, got %q", preview(imageURL))
	}
}

func TestSanitizeImageURLsNormalizesImageURLArrays(t *testing.T) {
	body := map[string]any{
		"image_urls": []any{
			"data:application/octet-stream;base64," + tinyPNGBase64,
		},
	}

	sanitizeImageURLs(body)

	imageURL := body["image_urls"].([]any)[0].(string)
	if !strings.HasPrefix(imageURL, "data:image/png;base64,") {
		t.Fatalf("expected image/png data URL, got %q", preview(imageURL))
	}
}
