package sub2api

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestImagesEditSendsImagePartContentType(t *testing.T) {
	var fileContentType string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reader, err := r.MultipartReader()
		if err != nil {
			t.Fatalf("expected multipart request: %v", err)
		}
		for {
			part, err := reader.NextPart()
			if err == io.EOF {
				break
			}
			if err != nil {
				t.Fatalf("read multipart part: %v", err)
			}
			if part.FormName() == "image[]" {
				fileContentType = part.Header.Get("Content-Type")
			}
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":[]}`))
	}))
	defer server.Close()

	client := NewClient(server.URL, time.Second, 1024*1024)
	_, err := client.ImagesEdit(context.Background(), "test-key", map[string]string{"model": "gpt-image-2"}, []MultipartFile{{
		Field: "image[]",
		Name:  "input-1.png",
		MIME:  "image/png",
		Data:  []byte{0x89, 0x50, 0x4e, 0x47},
	}})
	if err != nil {
		t.Fatalf("ImagesEdit returned error: %v", err)
	}
	if !strings.EqualFold(fileContentType, "image/png") {
		t.Fatalf("expected image/png part content type, got %q", fileContentType)
	}
}
