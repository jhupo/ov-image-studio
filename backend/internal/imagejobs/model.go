package imagejobs

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

type ImageParams struct {
	Size              string `json:"size"`
	Quality           string `json:"quality"`
	OutputFormat      string `json:"output_format"`
	OutputCompression *int   `json:"output_compression,omitempty"`
	Moderation        string `json:"moderation"`
	N                 int    `json:"n"`
	Stream            bool   `json:"stream,omitempty"`
	PartialImages     int    `json:"partial_images,omitempty"`
}

type CreateRequest struct {
	UserID        *string     `json:"userId,omitempty"`
	APIKeyID      *int64      `json:"apiKeyId,omitempty"`
	ManualAPIKey  string      `json:"manualApiKey,omitempty"`
	APIMode       string      `json:"apiMode"`
	Model         string      `json:"model"`
	Prompt        string      `json:"prompt"`
	Params        ImageParams `json:"params"`
	InputAssetIDs []string    `json:"inputAssetIds"`
	MaskAssetID   *string     `json:"maskAssetId,omitempty"`
	SourceMode    string      `json:"sourceMode,omitempty"`
}

type Job struct {
	ID             string          `json:"id"`
	UserID         *string         `json:"userId,omitempty"`
	Status         string          `json:"status"`
	Stage          string          `json:"stage"`
	SourceMode     string          `json:"sourceMode"`
	APIMode        string          `json:"apiMode"`
	Model          string          `json:"model"`
	Prompt         string          `json:"prompt"`
	Params         ImageParams     `json:"params"`
	InputAssetIDs  []string        `json:"inputAssetIds"`
	MaskAssetID    *string         `json:"maskAssetId,omitempty"`
	ResultAssetIDs []string        `json:"resultAssetIds"`
	ActualParams   map[string]any  `json:"actualParams,omitempty"`
	Error          *apperror.Error `json:"error,omitempty"`
	CreatedAt      time.Time       `json:"createdAt"`
	StartedAt      *time.Time      `json:"startedAt,omitempty"`
	FinishedAt     *time.Time      `json:"finishedAt,omitempty"`
	CancelledAt    *time.Time      `json:"cancelledAt,omitempty"`
	AckedAt        *time.Time      `json:"ackedAt,omitempty"`
}

type JobView struct {
	Job    Job        `json:"job"`
	Result *JobResult `json:"result,omitempty"`
}

type JobResult struct {
	Assets []ResultAsset `json:"assets"`
}

type ResultAsset struct {
	ID     string         `json:"id"`
	URL    string         `json:"url"`
	MIME   string         `json:"mime"`
	Size   int64          `json:"fileSize"`
	Actual map[string]any `json:"actualParams,omitempty"`
}
