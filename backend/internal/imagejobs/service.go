package imagejobs

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/base64"
	"image"
	_ "image/jpeg"
	"image/png"
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

const (
	promptRewriteGuardPrefix = "Use the following text as the complete prompt. Do not rewrite it:"
	defaultImagesModel       = "gpt-image-2"
	defaultResponsesModel    = "gpt-5.5"
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
	if req.MaskAssetID != nil && len(req.InputAssetIDs) == 0 {
		return Job{}, apperror.BadRequest("遮罩编辑需要同时提供原图")
	}
	req.APIMode = normalizeAPIMode(req.APIMode)
	if len(req.InputAssetIDs) > 0 || req.MaskAssetID != nil {
		req.APIMode = "images"
	}
	req.Model = normalizeModelForMode(req.APIMode, req.Model)
	if err := validateModelForMode(req.APIMode, req.Model); err != nil {
		return Job{}, err
	}
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
	cancelled, err := s.repo.Cancel(ctx, id)
	if err != nil {
		return err
	}
	if cancelled {
		return nil
	}
	if _, err := s.repo.Get(ctx, id); err != nil {
		if err == sql.ErrNoRows {
			return apperror.NotFound("任务不存在")
		}
		return err
	}
	return apperror.New(409, "job_not_cancellable", "任务已结束，不能取消")
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
		if s.isCancelled(context.Background(), jobID) {
			_, _ = s.repo.Cancel(context.Background(), jobID)
			return
		}
		log.Printf("image job %s failed: %v", jobID, err)
		_ = s.repo.MarkError(context.Background(), jobID, apperror.Normalize(err))
	}
}

func (s *Service) run(ctx context.Context, jobID string) error {
	job, err := s.repo.Get(ctx, jobID)
	if err != nil {
		return err
	}
	if job.Status == StatusCancelled || s.isCancelled(ctx, jobID) {
		_, err := s.repo.Cancel(ctx, jobID)
		return err
	}
	job.APIMode = normalizeAPIMode(job.APIMode)
	if len(job.InputAssetIDs) > 0 || job.MaskAssetID != nil {
		job.APIMode = "images"
	}
	job.Model = normalizeModelForMode(job.APIMode, job.Model)
	if err := validateModelForMode(job.APIMode, job.Model); err != nil {
		return err
	}
	claimed, err := s.repo.MarkRunning(ctx, jobID)
	if err != nil {
		return err
	}
	if !claimed {
		return nil
	}

	apiKey, err := s.loadAPIKey(ctx, jobID)
	if err != nil {
		return err
	}
	upstreamCtx, stopCancellationWatch := s.watchCancellation(ctx, jobID)
	defer stopCancellationWatch()
	payload, err := s.callUpstream(upstreamCtx, job, apiKey)
	if err != nil {
		return err
	}
	if s.isCancelled(ctx, jobID) {
		_, err := s.repo.Cancel(ctx, jobID)
		return err
	}
	images, err := sub2api.ExtractImagesWithFallback(ctx, payload, mimeForOutputFormat(job.Params.OutputFormat), 0)
	if err != nil {
		return err
	}
	resultAssetIDs := make([]string, 0, len(images))
	actual := map[string]any{}
	for i, image := range images {
		if s.isCancelled(ctx, jobID) {
			_ = s.assets.DeleteAssets(ctx, resultAssetIDs)
			_, err := s.repo.Cancel(ctx, jobID)
			return err
		}
		asset, err := s.assets.CreateOutput(ctx, image.MIME, image.Bytes, jobID)
		if err != nil {
			_ = s.assets.DeleteAssets(ctx, resultAssetIDs)
			return err
		}
		resultAssetIDs = append(resultAssetIDs, asset.ID)
		if i == 0 {
			actual = image.ActualParams
		}
	}
	actual["n"] = len(resultAssetIDs)
	done, err := s.repo.MarkDone(ctx, jobID, resultAssetIDs, actual)
	if err != nil {
		_ = s.assets.DeleteAssets(ctx, resultAssetIDs)
		return err
	}
	if !done {
		_ = s.assets.DeleteAssets(ctx, resultAssetIDs)
	}
	return nil
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

func (s *Service) isCancelled(ctx context.Context, jobID string) bool {
	return s.queue != nil && s.queue.IsCancelled(ctx, "image_job", jobID)
}

func (s *Service) watchCancellation(ctx context.Context, jobID string) (context.Context, func()) {
	if s.queue == nil {
		return ctx, func() {}
	}
	watchCtx, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() {
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-done:
				return
			case <-watchCtx.Done():
				return
			case <-ticker.C:
				if s.isCancelled(context.Background(), jobID) {
					cancel()
					return
				}
			}
		}
	}()
	return watchCtx, func() {
		close(done)
		cancel()
	}
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
	if job.Params.OutputCompression != nil && job.Params.OutputFormat != "png" {
		body["output_compression"] = *job.Params.OutputCompression
	}
	return s.sub2api.ImagesGeneration(ctx, apiKey, body)
}

func (s *Service) callResponses(ctx context.Context, job Job, apiKey string) (map[string]any, error) {
	n := job.Params.N
	if n <= 1 {
		return s.callResponsesOnce(ctx, job, apiKey)
	}
	payloads := make([]map[string]any, 0, n)
	for i := 0; i < n; i++ {
		payload, err := s.callResponsesOnce(ctx, job, apiKey)
		if err != nil {
			return nil, err
		}
		payloads = append(payloads, payload)
	}
	return mergeResponsePayloads(payloads), nil
}

func (s *Service) callResponsesOnce(ctx context.Context, job Job, apiKey string) (map[string]any, error) {
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

func mergeResponsePayloads(payloads []map[string]any) map[string]any {
	if len(payloads) == 0 {
		return map[string]any{}
	}
	if len(payloads) == 1 {
		return payloads[0]
	}
	merged := map[string]any{}
	for key, value := range payloads[0] {
		if key != "data" && key != "output" {
			merged[key] = value
		}
	}
	data := make([]any, 0, len(payloads))
	output := make([]any, 0, len(payloads))
	for _, payload := range payloads {
		if items, ok := payload["data"].([]any); ok {
			data = append(data, items...)
		}
		if items, ok := payload["output"].([]any); ok {
			output = append(output, items...)
		}
	}
	if len(data) > 0 {
		merged["data"] = data
	}
	if len(output) > 0 {
		merged["output"] = output
	}
	if len(data) == 0 && len(output) == 0 {
		return payloads[0]
	}
	return merged
}

func (s *Service) responsesInput(ctx context.Context, job Job) (any, error) {
	prompt := guardedPrompt(job.Prompt)
	if len(job.InputAssetIDs) == 0 {
		return prompt, nil
	}
	content := []map[string]any{{"type": "input_text", "text": prompt}}
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

func guardedPrompt(prompt string) string {
	return promptRewriteGuardPrefix + "\n" + prompt
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
	if job.Params.OutputCompression != nil && job.Params.OutputFormat != "png" {
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
		name := "input-" + strconv.Itoa(index+1) + extensionForMIME(asset.MIME)
		if job.MaskAssetID != nil && index == 0 {
			converted, err := encodeImagePNG(data)
			if err != nil {
				return nil, apperror.BadRequest("遮罩编辑的主图必须是可解码的 PNG 或 JPEG，请先转换为 PNG 后再提交")
			}
			data = converted
			name = "input-" + strconv.Itoa(index+1) + ".png"
		}
		files = append(files, sub2api.MultipartFile{
			Field: "image[]",
			Name:  name,
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
		converted, err := encodeImagePNG(data)
		if err != nil {
			return nil, apperror.BadRequest("遮罩图片必须是可解码的 PNG 或 JPEG，请重新绘制或转换为 PNG 后再提交")
		}
		data = converted
		files = append(files, sub2api.MultipartFile{
			Field: "mask",
			Name:  "mask.png",
			Data:  data,
		})
	}
	return s.sub2api.ImagesEdit(ctx, apiKey, fields, files)
}

func encodeImagePNG(data []byte) ([]byte, error) {
	source, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, source); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func normalizeAPIMode(value string) string {
	if value == "responses" {
		return "responses"
	}
	return "images"
}

func isImageModel(model string) bool {
	model = strings.ToLower(strings.TrimSpace(model))
	return strings.Contains(model, "image") || strings.Contains(model, "dall-e") || strings.Contains(model, "imagen")
}

func normalizeModelForMode(apiMode string, model string) string {
	model = strings.TrimSpace(model)
	if apiMode == "images" {
		if isImageModel(model) {
			return model
		}
		return defaultImagesModel
	}
	if isImageModel(model) {
		return defaultResponsesModel
	}
	if model == "" {
		return defaultResponsesModel
	}
	return model
}

func validateModelForMode(apiMode string, model string) error {
	model = strings.TrimSpace(model)
	if apiMode == "images" && !isImageModel(model) {
		return apperror.BadRequest("Images API 需要使用图片模型，例如 gpt-image-2")
	}
	if apiMode == "responses" && isImageModel(model) {
		return apperror.BadRequest("Responses API 需要使用支持工具调用的文本模型，例如 gpt-5.5")
	}
	return nil
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
	if params.N > 10 {
		params.N = 10
	}
	return params
}

func mimeForOutputFormat(format string) string {
	switch strings.ToLower(strings.TrimSpace(format)) {
	case "jpeg", "jpg":
		return "image/jpeg"
	case "webp":
		return "image/webp"
	default:
		return "image/png"
	}
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
