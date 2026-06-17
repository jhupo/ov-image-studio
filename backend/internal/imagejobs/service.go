package imagejobs

import (
	"context"
	"database/sql"
	"encoding/base64"
	"log"
	"strconv"
	"strings"
	"time"

	"ov-image-studio/backend/internal/apperror"
	"ov-image-studio/backend/internal/assets"
	"ov-image-studio/backend/internal/queue"
	"ov-image-studio/backend/internal/security"
	"ov-image-studio/backend/internal/sub2api"
)

type Service struct {
	repo    *Repository
	assets  *assets.Service
	queue   *queue.Queue
	secrets *security.Secrets
	sub2api *sub2api.Client
}

func NewService(repo *Repository, assetService *assets.Service, queue *queue.Queue, secrets *security.Secrets, sub2apiClient *sub2api.Client) *Service {
	return &Service{
		repo:    repo,
		assets:  assetService,
		queue:   queue,
		secrets: secrets,
		sub2api: sub2apiClient,
	}
}

func (s *Service) Create(ctx context.Context, req CreateRequest) (Job, error) {
	if strings.TrimSpace(req.Prompt) == "" {
		return Job{}, apperror.BadRequest("请输入提示词")
	}
	if strings.TrimSpace(req.Model) == "" {
		return Job{}, apperror.BadRequest("缺少模型")
	}
	if strings.TrimSpace(req.ManualAPIKey) == "" {
		return Job{}, apperror.BadRequest("缺少 API Key")
	}
	req.APIMode = normalizeAPIMode(req.APIMode)
	req.Params = normalizeParams(req.Params)

	ciphertext, nonce, err := s.secrets.Encrypt(req.ManualAPIKey)
	if err != nil {
		return Job{}, err
	}
	job, err := s.repo.Create(ctx, CreateParams{
		UserID:            req.UserID,
		SourceMode:        req.SourceMode,
		APIMode:           req.APIMode,
		Model:             strings.TrimSpace(req.Model),
		Prompt:            strings.TrimSpace(req.Prompt),
		Params:            req.Params,
		InputAssetIDs:     req.InputAssetIDs,
		MaskAssetID:       req.MaskAssetID,
		APIKeyFingerprint: security.Fingerprint(req.ManualAPIKey),
		APIKeyCiphertext:  ciphertext,
		APIKeyNonce:       nonce,
	})
	if err != nil {
		return Job{}, err
	}
	if err := s.queue.EnqueueImageJob(ctx, job.ID); err != nil {
		return Job{}, err
	}
	return job, nil
}

func (s *Service) Get(ctx context.Context, id string) (JobView, error) {
	job, err := s.repo.Get(ctx, id)
	if err != nil {
		if err == sql.ErrNoRows {
			return JobView{}, apperror.NotFound("任务不存在")
		}
		return JobView{}, err
	}
	view := JobView{Job: job}
	if len(job.ResultAssetIDs) > 0 {
		result := &JobResult{Assets: make([]ResultAsset, 0, len(job.ResultAssetIDs))}
		for _, assetID := range job.ResultAssetIDs {
			asset, err := s.assets.Get(ctx, assetID)
			if err != nil {
				continue
			}
			result.Assets = append(result.Assets, ResultAsset{
				ID:     asset.ID,
				URL:    "/api/assets/" + asset.ID,
				MIME:   asset.MIME,
				Size:   asset.FileSize,
				Actual: job.ActualParams,
			})
		}
		view.Result = result
	}
	return view, nil
}

func (s *Service) Cancel(ctx context.Context, id string) error {
	if err := s.queue.MarkCancelled(ctx, "image_job", id, time.Hour); err != nil {
		return err
	}
	return s.repo.Cancel(ctx, id)
}

func (s *Service) Ack(ctx context.Context, id string) error {
	job, err := s.repo.Ack(ctx, id)
	if err != nil {
		return err
	}
	assetIDs := make([]string, 0, len(job.ResultAssetIDs)+len(job.InputAssetIDs)+1)
	assetIDs = append(assetIDs, job.ResultAssetIDs...)
	assetIDs = append(assetIDs, job.InputAssetIDs...)
	if job.MaskAssetID != nil {
		assetIDs = append(assetIDs, *job.MaskAssetID)
	}
	return s.assets.DeleteAssetsOnAck(ctx, assetIDs)
}

func (s *Service) Run(ctx context.Context, jobID string) {
	if err := s.run(ctx, jobID); err != nil {
		log.Printf("image job %s failed: %v", jobID, err)
		_ = s.repo.MarkError(context.Background(), jobID, apperror.Normalize(err))
	}
}

func (s *Service) run(ctx context.Context, jobID string) error {
	job, err := s.repo.Get(ctx, jobID)
	if err != nil {
		return err
	}
	if job.Status == StatusCancelled || s.queue.IsCancelled(ctx, "image_job", jobID) {
		return s.repo.Cancel(ctx, jobID)
	}
	if err := s.repo.MarkRunning(ctx, jobID); err != nil {
		return err
	}

	apiKey, err := s.loadAPIKey(ctx, jobID)
	if err != nil {
		return err
	}
	payload, err := s.callUpstream(ctx, job, apiKey)
	if err != nil {
		return err
	}
	if s.queue.IsCancelled(ctx, "image_job", jobID) {
		return s.repo.Cancel(ctx, jobID)
	}
	images, err := sub2api.ExtractImages(ctx, payload, 0)
	if err != nil {
		return err
	}
	resultAssetIDs := make([]string, 0, len(images))
	actual := map[string]any{}
	for i, image := range images {
		asset, err := s.assets.CreateOutput(ctx, image.MIME, image.Bytes, jobID)
		if err != nil {
			return err
		}
		resultAssetIDs = append(resultAssetIDs, asset.ID)
		if i == 0 {
			actual = image.ActualParams
		}
	}
	actual["n"] = len(resultAssetIDs)
	return s.repo.MarkDone(ctx, jobID, resultAssetIDs, actual)
}

func (s *Service) loadAPIKey(ctx context.Context, jobID string) (string, error) {
	var ciphertext []byte
	var nonce []byte
	err := s.repo.db.QueryRowContext(ctx, `SELECT api_key_ciphertext, api_key_nonce FROM image_jobs WHERE id = $1`, jobID).Scan(&ciphertext, &nonce)
	if err != nil {
		return "", err
	}
	if len(ciphertext) == 0 || len(nonce) == 0 {
		return "", apperror.BadRequest("任务缺少 API Key")
	}
	return s.secrets.Decrypt(ciphertext, nonce)
}

func (s *Service) callUpstream(ctx context.Context, job Job, apiKey string) (map[string]any, error) {
	if job.APIMode == "responses" {
		return s.callResponses(ctx, job, apiKey)
	}
	if len(job.InputAssetIDs) > 0 {
		return s.callImageEdit(ctx, job, apiKey)
	}
	body := map[string]any{
		"model":           job.Model,
		"prompt":          job.Prompt,
		"size":            job.Params.Size,
		"quality":         job.Params.Quality,
		"output_format":   job.Params.OutputFormat,
		"moderation":      job.Params.Moderation,
		"n":               job.Params.N,
		"response_format": "b64_json",
	}
	if job.Params.OutputCompression != nil {
		body["output_compression"] = *job.Params.OutputCompression
	}
	return s.sub2api.ImagesGeneration(ctx, apiKey, body)
}

func (s *Service) callResponses(ctx context.Context, job Job, apiKey string) (map[string]any, error) {
	input, err := s.responsesInput(ctx, job)
	if err != nil {
		return nil, err
	}
	tool := map[string]any{
		"type":          "image_generation",
		"action":        "generate",
		"size":          job.Params.Size,
		"quality":       job.Params.Quality,
		"output_format": job.Params.OutputFormat,
		"moderation":    job.Params.Moderation,
	}
	if len(job.InputAssetIDs) > 0 {
		tool["action"] = "edit"
	}
	if job.Params.OutputCompression != nil && job.Params.OutputFormat != "png" {
		tool["output_compression"] = *job.Params.OutputCompression
	}
	if job.MaskAssetID != nil {
		maskURL, err := s.assetDataURL(ctx, *job.MaskAssetID)
		if err != nil {
			return nil, err
		}
		tool["input_image_mask"] = map[string]any{"image_url": maskURL}
	}
	return s.sub2api.Responses(ctx, apiKey, map[string]any{
		"model":       job.Model,
		"input":       input,
		"tools":       []map[string]any{tool},
		"tool_choice": "required",
	})
}

func (s *Service) responsesInput(ctx context.Context, job Job) (any, error) {
	if len(job.InputAssetIDs) == 0 {
		return job.Prompt, nil
	}
	content := []map[string]any{{"type": "input_text", "text": job.Prompt}}
	for _, assetID := range job.InputAssetIDs {
		dataURL, err := s.assetDataURL(ctx, assetID)
		if err != nil {
			return nil, err
		}
		content = append(content, map[string]any{
			"type":      "input_image",
			"image_url": dataURL,
		})
	}
	return []map[string]any{{
		"role":    "user",
		"content": content,
	}}, nil
}

func (s *Service) assetDataURL(ctx context.Context, assetID string) (string, error) {
	asset, err := s.assets.Get(ctx, assetID)
	if err != nil {
		return "", err
	}
	_, data, err := s.assets.Data(ctx, asset.ID)
	if err != nil {
		return "", err
	}
	mime := strings.TrimSpace(strings.Split(asset.MIME, ";")[0])
	if mime == "" {
		mime = "image/png"
	}
	return "data:" + mime + ";base64," + base64.StdEncoding.EncodeToString(data), nil
}

func (s *Service) callImageEdit(ctx context.Context, job Job, apiKey string) (map[string]any, error) {
	fields := map[string]string{
		"model":           job.Model,
		"prompt":          job.Prompt,
		"size":            job.Params.Size,
		"quality":         job.Params.Quality,
		"output_format":   job.Params.OutputFormat,
		"moderation":      job.Params.Moderation,
		"n":               strconv.Itoa(job.Params.N),
		"response_format": "b64_json",
	}
	if job.Params.OutputCompression != nil {
		fields["output_compression"] = strconv.Itoa(*job.Params.OutputCompression)
	}
	files := make([]sub2api.MultipartFile, 0, len(job.InputAssetIDs)+1)
	for index, assetID := range job.InputAssetIDs {
		asset, err := s.assets.Get(ctx, assetID)
		if err != nil {
			return nil, err
		}
		_, data, err := s.assets.Data(ctx, asset.ID)
		if err != nil {
			return nil, err
		}
		files = append(files, sub2api.MultipartFile{
			Field: "image[]",
			Name:  "input-" + strconv.Itoa(index+1) + extensionForMIME(asset.MIME),
			Data:  data,
		})
	}
	if job.MaskAssetID != nil {
		mask, err := s.assets.Get(ctx, *job.MaskAssetID)
		if err != nil {
			return nil, err
		}
		_, data, err := s.assets.Data(ctx, mask.ID)
		if err != nil {
			return nil, err
		}
		files = append(files, sub2api.MultipartFile{
			Field: "mask",
			Name:  "mask" + extensionForMIME(mask.MIME),
			Data:  data,
		})
	}
	return s.sub2api.ImagesEdit(ctx, apiKey, fields, files)
}

func normalizeAPIMode(value string) string {
	if value == "responses" {
		return "responses"
	}
	return "images"
}

func normalizeParams(params ImageParams) ImageParams {
	if params.Size == "" {
		params.Size = "auto"
	}
	if params.Quality == "" {
		params.Quality = "auto"
	}
	if params.OutputFormat == "" {
		params.OutputFormat = "png"
	}
	if params.Moderation == "" {
		params.Moderation = "auto"
	}
	if params.N <= 0 {
		params.N = 1
	}
	if params.N > 4 {
		params.N = 4
	}
	return params
}

func extensionForMIME(mime string) string {
	switch strings.ToLower(strings.TrimSpace(strings.Split(mime, ";")[0])) {
	case "image/jpeg":
		return ".jpg"
	case "image/webp":
		return ".webp"
	case "image/png":
		return ".png"
	default:
		return ".bin"
	}
}
