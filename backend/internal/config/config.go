package config

import (
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	Host                   string
	Port                   string
	StaticDir              string
	DatabaseURL            string
	RedisURL               string
	Sub2APIBaseURL         string
	AppSecret              string
	AssetTTL               time.Duration
	DeleteAssetsOnAck      bool
	ImageWorkerCount       int
	AgentWorkerCount       int
	UpstreamTimeout        time.Duration
	KeysCacheTTL           time.Duration
	MaxUploadBytes         int64
	MaxResultBytes         int64
	MaxEventBodyBytes      int64
	SiteName               string
	SiteURL                string
	SiteIconURL            string
	LegacyProxyEnabled     bool
	MaxCreateRequestBytes  int64
	MaxUpstreamBodyBytes   int64
	MaxUpstreamResultBytes int64
	TaskTTL                time.Duration
	WorkerCount            int
}

func Load() Config {
	LoadDotEnv(".env")

	cfg := Config{
		Host:                   getenv("HOST", "0.0.0.0"),
		Port:                   getenv("PORT", "80"),
		StaticDir:              getenv("STATIC_DIR", "dist"),
		DatabaseURL:            strings.TrimSpace(os.Getenv("DATABASE_URL")),
		RedisURL:               strings.TrimSpace(os.Getenv("REDIS_URL")),
		Sub2APIBaseURL:         strings.TrimRight(getenv("SUB2API_BASE_URL", "http://127.0.0.1:8080"), "/"),
		AppSecret:              strings.TrimSpace(os.Getenv("APP_SECRET")),
		AssetTTL:               time.Duration(getenvInt("ASSET_TTL_SECONDS", 86400)) * time.Second,
		DeleteAssetsOnAck:      getenvBool("DELETE_ASSETS_ON_ACK", true),
		ImageWorkerCount:       getenvInt("IMAGE_WORKER_COUNT", getenvInt("WORKER_COUNT", 2)),
		AgentWorkerCount:       getenvInt("AGENT_WORKER_COUNT", 1),
		UpstreamTimeout:        time.Duration(getenvInt("UPSTREAM_TIMEOUT_SECONDS", 1800)) * time.Second,
		KeysCacheTTL:           time.Duration(getenvInt("KEYS_CACHE_TTL_SECONDS", 300)) * time.Second,
		MaxUploadBytes:         int64(getenvInt("MAX_UPLOAD_MB", 80)) * 1024 * 1024,
		MaxResultBytes:         int64(getenvInt("MAX_RESULT_MB", 600)) * 1024 * 1024,
		MaxEventBodyBytes:      int64(getenvInt("MAX_EVENT_BODY_KB", 1024)) * 1024,
		SiteName:               getenv("SITE_NAME", "链路云"),
		SiteURL:                getenv("SITE_URL", "https://dash.ovload.com"),
		SiteIconURL:            getenv("SITE_ICON_URL", "/pwa-icon.svg"),
		LegacyProxyEnabled:     getenvBool("LEGACY_PROXY_ENABLED", false),
		MaxCreateRequestBytes:  int64(getenvInt("MAX_CREATE_REQUEST_MB", 600)) * 1024 * 1024,
		MaxUpstreamBodyBytes:   int64(getenvInt("MAX_UPSTREAM_BODY_MB", 600)) * 1024 * 1024,
		MaxUpstreamResultBytes: int64(getenvInt("MAX_UPSTREAM_RESULT_MB", 600)) * 1024 * 1024,
		TaskTTL:                time.Duration(getenvInt("TASK_TTL_SECONDS", 3600)) * time.Second,
		WorkerCount:            getenvInt("WORKER_COUNT", 2),
	}
	if cfg.ImageWorkerCount < 1 {
		cfg.ImageWorkerCount = 1
	}
	if cfg.AgentWorkerCount < 1 {
		cfg.AgentWorkerCount = 1
	}
	if cfg.WorkerCount < 1 {
		cfg.WorkerCount = 1
	}
	return cfg
}

func (c Config) BusinessBackendConfigured() bool {
	return c.DatabaseURL != "" && c.RedisURL != "" && c.AppSecret != ""
}

func LoadDotEnv(file string) {
	data, err := os.ReadFile(file)
	if err != nil {
		return
	}
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		key = strings.TrimSpace(key)
		value = strings.Trim(strings.TrimSpace(value), `"'`)
		if key == "" {
			continue
		}
		if _, exists := os.LookupEnv(key); !exists {
			_ = os.Setenv(key, value)
		}
	}
}

func getenv(key, fallback string) string {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	return value
}

func getenvInt(key string, fallback int) int {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(value)
	if err != nil {
		return fallback
	}
	return parsed
}

func getenvBool(key string, fallback bool) bool {
	value := strings.ToLower(strings.TrimSpace(os.Getenv(key)))
	if value == "" {
		return fallback
	}
	return value == "1" || value == "true" || value == "yes" || value == "on"
}
