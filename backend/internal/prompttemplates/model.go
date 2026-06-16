package prompttemplates

import "time"

const (
	DefaultSource    = "awesome-gpt-image-2-readme-zh"
	DefaultSourceURL = "https://raw.githubusercontent.com/YouMind-OpenLab/awesome-gpt-image-2/main/README_zh.md"
)

type Template struct {
	ID               string    `json:"id"`
	Source           string    `json:"source"`
	SourceExternalID string    `json:"sourceExternalId"`
	Title            string    `json:"title"`
	Summary          string    `json:"summary"`
	Prompt           string    `json:"prompt"`
	Category         string    `json:"category"`
	Tags             []string  `json:"tags"`
	ImageURLs        []string  `json:"imageUrls"`
	Author           string    `json:"author"`
	SourceURL        string    `json:"sourceUrl"`
	DetailURL        string    `json:"detailUrl"`
	Featured         bool      `json:"featured"`
	Raycast          bool      `json:"raycast"`
	Language         string    `json:"language"`
	SortOrder        int       `json:"sortOrder"`
	SyncedAt         time.Time `json:"syncedAt"`
}

type ListResult struct {
	Items      []Template `json:"items"`
	Total      int        `json:"total"`
	Page       int        `json:"page"`
	PageSize   int        `json:"pageSize"`
	Categories []string   `json:"categories"`
}

type SyncStatus struct {
	Source    string    `json:"source"`
	SourceURL string    `json:"sourceUrl"`
	ItemCount int       `json:"itemCount"`
	LastError string    `json:"lastError"`
	SyncedAt  time.Time `json:"syncedAt"`
}

type StoreStats struct {
	ActiveItems    int
	ItemsWithImage int
}
