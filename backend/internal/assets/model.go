package assets

import "time"

type Asset struct {
	ID               string     `json:"id"`
	UserID           *string    `json:"userId,omitempty"`
	Kind             string     `json:"kind"`
	MIME             string     `json:"mime"`
	FileSize         int64      `json:"fileSize"`
	Width            *int       `json:"width,omitempty"`
	Height           *int       `json:"height,omitempty"`
	SHA256           string     `json:"sha256,omitempty"`
	Status           string     `json:"status"`
	SourceJobID      *string    `json:"sourceJobId,omitempty"`
	SourceAgentRunID *string    `json:"sourceAgentRunId,omitempty"`
	DeliveredAt      *time.Time `json:"deliveredAt,omitempty"`
	DeletedAt        *time.Time `json:"deletedAt,omitempty"`
	ExpiresAt        time.Time  `json:"expiresAt"`
	CreatedAt        time.Time  `json:"createdAt"`
}

type UploadRequest struct {
	Kind       string `json:"kind"`
	MIME       string `json:"mime"`
	DataBase64 string `json:"dataBase64"`
}

type UploadResponse struct {
	Asset Asset `json:"asset"`
}
