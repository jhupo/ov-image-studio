package prompttemplates

import (
	"context"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"strconv"
	"time"

	"ov-image-studio/backend/internal/apperror"
)

const maxReadmeBytes int64 = 2 * 1024 * 1024
const maxTemplateImageBytes int64 = 12 * 1024 * 1024

type Service struct {
	repo      *Repository
	sourceURL string
	client    *http.Client
}

func NewService(repo *Repository, sourceURL string) *Service {
	if sourceURL == "" {
		sourceURL = DefaultSourceURL
	}
	return &Service{
		repo:      repo,
		sourceURL: sourceURL,
		client:    &http.Client{Timeout: 30 * time.Second},
	}
}

func (s *Service) SyncNow(ctx context.Context) (int, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.sourceURL, nil)
	if err != nil {
		return 0, err
	}
	req.Header.Set("User-Agent", "ov-image-studio-prompt-template-sync")
	resp, err := s.client.Do(req)
	if err != nil {
		s.repo.MarkSyncError(ctx, DefaultSource, s.sourceURL, err.Error())
		return 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		err := fmt.Errorf("sync source returned %d", resp.StatusCode)
		s.repo.MarkSyncError(ctx, DefaultSource, s.sourceURL, err.Error())
		return 0, err
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxReadmeBytes+1))
	if err != nil {
		s.repo.MarkSyncError(ctx, DefaultSource, s.sourceURL, err.Error())
		return 0, err
	}
	if int64(len(body)) > maxReadmeBytes {
		err := fmt.Errorf("sync source too large")
		s.repo.MarkSyncError(ctx, DefaultSource, s.sourceURL, err.Error())
		return 0, err
	}
	templates := ParseReadme(string(body))
	if len(templates) == 0 {
		err := fmt.Errorf("sync source contained no templates")
		s.repo.MarkSyncError(ctx, DefaultSource, s.sourceURL, err.Error())
		return 0, err
	}
	if err := s.repo.ReplaceSource(ctx, DefaultSource, s.sourceURL, templates); err != nil {
		s.repo.MarkSyncError(ctx, DefaultSource, s.sourceURL, err.Error())
		return 0, err
	}
	return len(templates), nil
}

func (s *Service) SyncOnStartup(ctx context.Context) {
	go func() {
		syncCtx, cancel := context.WithTimeout(ctx, 45*time.Second)
		defer cancel()
		count, err := s.SyncNow(syncCtx)
		if err != nil {
			log.Printf("prompt template sync failed: %v", err)
			return
		}
		log.Printf("prompt template sync imported %d templates", count)
	}()
}

func (s *Service) List(ctx context.Context, query string, category string, ids []string, page int, pageSize int) (ListResult, error) {
	if err := s.ensureReady(ctx); err != nil {
		log.Printf("prompt template lazy sync failed: %v", err)
	}
	return s.repo.List(ctx, query, category, ids, page, pageSize)
}

func (s *Service) ensureReady(ctx context.Context) error {
	stats, err := s.repo.Stats(ctx)
	if err != nil {
		return err
	}
	if stats.ActiveItems > 0 && stats.ItemsWithImage > 0 {
		return nil
	}
	syncCtx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	_, err = s.SyncNow(syncCtx)
	return err
}

func (s *Service) Status(ctx context.Context) (SyncStatus, error) {
	return s.repo.Status(ctx, DefaultSource)
}

func (s *Service) ProxyImage(ctx context.Context, id string, imageIndex int) (*http.Response, error) {
	if imageIndex < 0 {
		return nil, apperror.BadRequest("图片序号无效")
	}
	template, err := s.repo.Get(ctx, id)
	if err != nil {
		return nil, err
	}
	if imageIndex >= len(template.ImageURLs) {
		return nil, apperror.NotFound("参考图不存在")
	}
	rawURL := template.ImageURLs[imageIndex]
	parsed, err := url.Parse(rawURL)
	if err != nil || parsed.Scheme != "https" {
		return nil, apperror.BadRequest("参考图地址无效")
	}
	switch parsed.Hostname() {
	case "cms-assets.youmind.com", "marketing-assets.youmind.com":
	default:
		return nil, apperror.BadRequest("参考图来源不允许")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "ov-image-studio-template-image-proxy")
	resp, err := s.client.Do(req)
	if err != nil {
		return nil, &apperror.Error{Code: "template_image_request_failed", Message: "参考图请求失败", Category: "network", HTTPStatus: http.StatusBadGateway, Retryable: true}
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		resp.Body.Close()
		return nil, &apperror.Error{Code: "template_image_upstream_failed", Message: "参考图上游返回异常", Category: "upstream", HTTPStatus: http.StatusBadGateway, Retryable: true}
	}
	if length := resp.Header.Get("Content-Length"); length != "" {
		if size, err := strconv.ParseInt(length, 10, 64); err == nil && size > maxTemplateImageBytes {
			resp.Body.Close()
			return nil, &apperror.Error{Code: "template_image_too_large", Message: "参考图过大", Category: "upstream", HTTPStatus: http.StatusBadGateway}
		}
	}
	return resp, nil
}
