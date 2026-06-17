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
	cancelled, err := s.repo.Cancel(ctx, id)
	if err != nil {
		return err
	}
	if cancelled {
		return nil
	}
	if _, err := s.repo.Get(ctx, id); err != nil {
		if err == sql.ErrNoRows {
			return apperror.NotFound("Agent 任务不存在")
		}
		return err
	}
	return apperror.New(409, "agent_run_not_cancellable", "Agent 任务已结束，不能取消")
}

func (s *Service) Run(ctx context.Context, id string) {
	if err := s.run(ctx, id); err != nil {
		if s.isCancelled(context.Background(), id) {
			_, _ = s.repo.Cancel(context.Background(), id)
			return
		}
		_ = s.repo.MarkError(context.Background(), id, apperror.Normalize(err))
	}
}

func (s *Service) run(ctx context.Context, id string) error {
	run, request, err := s.repo.GetRequest(ctx, id)
	if err != nil {
		return err
	}
	if run.Status == StatusCancelled || s.isCancelled(ctx, id) {
		_, err := s.repo.Cancel(ctx, id)
		return err
	}
	claimed, err := s.repo.MarkRunning(ctx, id)
	if err != nil {
		return err
	}
	if !claimed {
		return nil
	}
	apiKey, err := s.loadAPIKey(ctx, id)
	if err != nil {
		return err
	}
	upstreamCtx, stopCancellationWatch := s.watchCancellation(ctx, id)
	defer stopCancellationWatch()
	response, err := s.sub2api.Responses(upstreamCtx, apiKey, request)
	if err != nil {
		return err
	}
	if s.isCancelled(ctx, id) {
		_, err := s.repo.Cancel(ctx, id)
		return err
	}
	_, err = s.repo.MarkDone(ctx, id, response)
	return err
}

func (s *Service) isCancelled(ctx context.Context, id string) bool {
	return s.queue != nil && s.queue.IsCancelled(ctx, "agent_run", id)
}

func (s *Service) watchCancellation(ctx context.Context, id string) (context.Context, func()) {
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
				if s.isCancelled(context.Background(), id) {
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
