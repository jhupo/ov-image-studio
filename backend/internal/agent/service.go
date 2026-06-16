package agent

import (
	"context"
	"database/sql"
	"strings"
	"time"

	"ov-image-studio/backend/internal/apperror"
	"ov-image-studio/backend/internal/queue"
	"ov-image-studio/backend/internal/security"
	"ov-image-studio/backend/internal/sub2api"
)

type Service struct {
	repo    *Repository
	queue   *queue.Queue
	secrets *security.Secrets
	sub2api *sub2api.Client
}

func NewService(repo *Repository, queue *queue.Queue, secrets *security.Secrets, sub2apiClient *sub2api.Client) *Service {
	return &Service{
		repo:    repo,
		queue:   queue,
		secrets: secrets,
		sub2api: sub2apiClient,
	}
}

func (s *Service) Create(ctx context.Context, req CreateRunRequest) (Run, error) {
	if strings.TrimSpace(req.ManualAPIKey) == "" {
		return Run{}, apperror.BadRequest("缺少 API Key")
	}
	model := strings.TrimSpace(req.Model)
	if model == "" {
		if value, ok := req.Request["model"].(string); ok {
			model = strings.TrimSpace(value)
		}
	}
	if model == "" {
		return Run{}, apperror.BadRequest("缺少模型")
	}
	if req.Request == nil {
		return Run{}, apperror.BadRequest("缺少 Agent 请求")
	}
	req.Request["model"] = model
	delete(req.Request, "stream")

	ciphertext, nonce, err := s.secrets.Encrypt(req.ManualAPIKey)
	if err != nil {
		return Run{}, err
	}
	run, err := s.repo.Create(ctx, CreateParams{
		Model:             model,
		Request:           req.Request,
		APIKeyFingerprint: security.Fingerprint(req.ManualAPIKey),
		APIKeyCiphertext:  ciphertext,
		APIKeyNonce:       nonce,
	})
	if err != nil {
		return Run{}, err
	}
	if err := s.queue.EnqueueAgentRun(ctx, run.ID); err != nil {
		return Run{}, err
	}
	return run, nil
}

func (s *Service) Get(ctx context.Context, id string) (RunView, error) {
	run, err := s.repo.Get(ctx, id)
	if err != nil {
		if err == sql.ErrNoRows {
			return RunView{}, apperror.NotFound("Agent 任务不存在")
		}
		return RunView{}, err
	}
	return RunView{Run: run}, nil
}

func (s *Service) Cancel(ctx context.Context, id string) error {
	if err := s.queue.MarkCancelled(ctx, "agent_run", id, time.Hour); err != nil {
		return err
	}
	return s.repo.Cancel(ctx, id)
}

func (s *Service) Run(ctx context.Context, id string) {
	if err := s.run(ctx, id); err != nil {
		_ = s.repo.MarkError(context.Background(), id, apperror.Normalize(err))
	}
}

func (s *Service) run(ctx context.Context, id string) error {
	run, request, err := s.repo.GetRequest(ctx, id)
	if err != nil {
		return err
	}
	if run.Status == StatusCancelled || s.queue.IsCancelled(ctx, "agent_run", id) {
		return s.repo.Cancel(ctx, id)
	}
	if err := s.repo.MarkRunning(ctx, id); err != nil {
		return err
	}
	apiKey, err := s.loadAPIKey(ctx, id)
	if err != nil {
		return err
	}
	response, err := s.sub2api.Responses(ctx, apiKey, request)
	if err != nil {
		return err
	}
	if s.queue.IsCancelled(ctx, "agent_run", id) {
		return s.repo.Cancel(ctx, id)
	}
	return s.repo.MarkDone(ctx, id, response)
}

func (s *Service) loadAPIKey(ctx context.Context, id string) (string, error) {
	ciphertext, nonce, err := s.repo.LoadAPIKey(ctx, id)
	if err != nil {
		return "", err
	}
	if len(ciphertext) == 0 || len(nonce) == 0 {
		return "", apperror.BadRequest("Agent 任务缺少 API Key")
	}
	return s.secrets.Decrypt(ciphertext, nonce)
}
