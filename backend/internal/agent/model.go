package agent

import (
	"time"

	"ov-image-studio/backend/internal/apperror"
)

const (
	StatusQueued    = "queued"
	StatusRunning   = "running"
	StatusDone      = "done"
	StatusError     = "error"
	StatusCancelled = "cancelled"
)

type CreateRunRequest struct {
	ManualAPIKey string         `json:"manualApiKey"`
	Model        string         `json:"model"`
	Request      map[string]any `json:"request"`
}

type Run struct {
	ID         string          `json:"id"`
	Status     string          `json:"status"`
	Stage      string          `json:"stage"`
	Model      string          `json:"model"`
	Response   map[string]any  `json:"response,omitempty"`
	Error      *apperror.Error `json:"error,omitempty"`
	CreatedAt  time.Time       `json:"createdAt"`
	StartedAt  *time.Time      `json:"startedAt,omitempty"`
	FinishedAt *time.Time      `json:"finishedAt,omitempty"`
}

type RunView struct {
	Run Run `json:"run"`
}
