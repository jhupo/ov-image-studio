package assets

import (
	"context"
	"encoding/base64"
	"strings"
	"time"

	"ov-image-studio/backend/internal/apperror"
)

type Service struct {
	repo        *Repository
	ttl         time.Duration
	maxBytes    int64
	deleteOnAck bool
}

func NewService(repo *Repository, ttl time.Duration, maxBytes int64, deleteOnAck bool) *Service {
	return &Service{
		repo:        repo,
		ttl:         ttl,
		maxBytes:    maxBytes,
		deleteOnAck: deleteOnAck,
	}
}

func (s *Service) CreateFromBase64(ctx context.Context, req UploadRequest) (Asset, error) {
	kind := strings.TrimSpace(req.Kind)
	if kind != "input" && kind != "mask" && kind != "output" && kind != "partial" {
		return Asset{}, apperror.BadRequest("资产类型无效")
	}
	raw, err := decodeBase64Payload(req.DataBase64)
	if err != nil {
		return Asset{}, apperror.BadRequest("图片数据不是有效 base64")
	}
	if s.maxBytes > 0 && int64(len(raw)) > s.maxBytes {
		return Asset{}, apperror.New(413, "asset_too_large", "图片文件过大")
	}
	mime := SniffMIME(raw, req.MIME)
	return s.repo.Create(ctx, CreateAssetParams{
		Kind:      kind,
		MIME:      mime,
		Data:      raw,
		ExpiresAt: time.Now().Add(s.ttl),
	})
}

func (s *Service) CreateOutput(ctx context.Context, mime string, data []byte, jobID string) (Asset, error) {
	if s.maxBytes > 0 && int64(len(data)) > s.maxBytes {
		return Asset{}, apperror.New(502, "upstream_result_too_large", "上游返回图片过大")
	}
	mime = SniffMIME(data, mime)
	return s.repo.Create(ctx, CreateAssetParams{
		Kind:        "output",
		MIME:        mime,
		Data:        data,
		SourceJobID: &jobID,
		ExpiresAt:   time.Now().Add(s.ttl),
	})
}

func (s *Service) Get(ctx context.Context, id string) (Asset, error) {
	asset, err := s.repo.Get(ctx, id)
	if err != nil {
		return Asset{}, apperror.NotFound("图片不存在或已过期")
	}
	if asset.Status == "deleted" {
		return Asset{}, apperror.NotFound("图片已删除")
	}
	return asset, nil
}

func (s *Service) Data(ctx context.Context, id string) (Asset, []byte, error) {
	asset, err := s.Get(ctx, id)
	if err != nil {
		return Asset{}, nil, err
	}
	data, err := s.repo.GetData(ctx, id)
	if err != nil {
		return Asset{}, nil, apperror.NotFound("图片数据不存在或已被清理")
	}
	return asset, data, nil
}

func (s *Service) Read(ctx context.Context, id string) (Asset, []byte, error) {
	asset, data, err := s.Data(ctx, id)
	if err != nil {
		return Asset{}, nil, err
	}
	_ = s.repo.MarkDelivered(ctx, id)
	return asset, data, nil
}

func (s *Service) DeleteAssets(ctx context.Context, ids []string) error {
	if len(ids) == 0 {
		return nil
	}
	return s.repo.MarkDeleted(ctx, ids)
}

func (s *Service) DeleteAssetsOnAck(ctx context.Context, ids []string) error {
	if len(ids) == 0 || !s.deleteOnAck {
		return nil
	}
	return s.repo.MarkDeleted(ctx, ids)
}

func (s *Service) StartCleanup(ctx context.Context) {
	s.deleteExpired(ctx)
	ticker := time.NewTicker(10 * time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.deleteExpired(ctx)
		}
	}
}

func (s *Service) deleteExpired(ctx context.Context) {
	for {
		count, err := s.repo.DeleteExpired(ctx, time.Now(), 200)
		if err != nil || count == 0 {
			return
		}
	}
}

func decodeBase64Payload(value string) ([]byte, error) {
	value = strings.TrimSpace(value)
	if comma := strings.Index(value, ","); comma >= 0 && strings.HasPrefix(value[:comma], "data:") {
		value = value[comma+1:]
	}
	return base64.StdEncoding.DecodeString(value)
}
