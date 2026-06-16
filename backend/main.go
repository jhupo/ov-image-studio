package main

import (
	"context"
	"log"
	"mime"
	"net"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strings"

	"ov-image-studio/backend/internal/agent"
	"ov-image-studio/backend/internal/assets"
	"ov-image-studio/backend/internal/config"
	"ov-image-studio/backend/internal/db"
	"ov-image-studio/backend/internal/httpserver"
	"ov-image-studio/backend/internal/imagejobs"
	"ov-image-studio/backend/internal/keys"
	"ov-image-studio/backend/internal/queue"
	"ov-image-studio/backend/internal/security"
	"ov-image-studio/backend/internal/sub2api"
)

func main() {
	cfg := config.Load()
	mux := http.NewServeMux()
	httpserver.RegisterAppRoutes(mux, cfg)
	keys.NewHandler(cfg.Sub2APIBaseURL).Register(mux)

	if cfg.BusinessBackendConfigured() {
		ctx := context.Background()
		database, err := db.Open(ctx, cfg.DatabaseURL)
		if err != nil {
			log.Fatalf("connect postgres failed: %v", err)
		}
		defer database.Close()
		if err := db.Migrate(ctx, database); err != nil {
			log.Fatalf("migrate postgres failed: %v", err)
		}
		redisQueue, err := queue.Open(ctx, cfg.RedisURL)
		if err != nil {
			log.Fatalf("connect redis failed: %v", err)
		}
		defer redisQueue.Close()
		secrets, err := security.NewSecrets(cfg.AppSecret)
		if err != nil {
			log.Fatalf("APP_SECRET invalid: %v", err)
		}

		assetRepo := assets.NewRepository(database)
		assetService := assets.NewService(assetRepo, cfg.AssetTTL, cfg.MaxUploadBytes, cfg.DeleteAssetsOnAck)
		assets.NewHandler(assetService, cfg.MaxUploadBytes*2).Register(mux)

		sub2apiClient := sub2api.NewClient(cfg.Sub2APIBaseURL, cfg.UpstreamTimeout, cfg.MaxResultBytes)
		agentRepo := agent.NewRepository(database)
		agentService := agent.NewService(agentRepo, redisQueue, secrets, sub2apiClient)
		agent.NewHandler(agentService, cfg.MaxCreateRequestBytes).Register(mux)

		jobRepo := imagejobs.NewRepository(database)
		jobService := imagejobs.NewService(jobRepo, assetService, redisQueue, secrets, sub2apiClient)
		imagejobs.NewHandler(jobService, cfg.MaxCreateRequestBytes).Register(mux)

		if ids, err := jobRepo.RequeueUnfinished(ctx); err == nil {
			for _, id := range ids {
				_ = redisQueue.EnqueueImageJob(ctx, id)
			}
			if len(ids) > 0 {
				log.Printf("requeued %d unfinished image jobs", len(ids))
			}
		} else {
			log.Printf("requeue unfinished image jobs failed: %v", err)
		}
		if ids, err := agentRepo.RequeueUnfinished(ctx); err == nil {
			for _, id := range ids {
				_ = redisQueue.EnqueueAgentRun(ctx, id)
			}
			if len(ids) > 0 {
				log.Printf("requeued %d unfinished agent runs", len(ids))
			}
		} else {
			log.Printf("requeue unfinished agent runs failed: %v", err)
		}
		for i := 0; i < cfg.ImageWorkerCount; i++ {
			go imagejobs.NewWorker(i+1, redisQueue, jobService).Start(ctx)
		}
		for i := 0; i < cfg.AgentWorkerCount; i++ {
			go agent.NewWorker(i+1, redisQueue, agentService).Start(ctx)
		}
		go assetService.StartCleanup(ctx)
		log.Printf("business backend enabled: postgres + redis")
	} else {
		log.Printf("business backend disabled: set DATABASE_URL, REDIS_URL and APP_SECRET to enable /api/image/jobs")
	}

	mux.Handle("/", spaHandler(cfg.StaticDir))
	addr := net.JoinHostPort(cfg.Host, cfg.Port)
	log.Printf("OV Image Studio server listening on http://%s", addr)
	log.Printf("Sub2API upstream: %s", cfg.Sub2APIBaseURL)
	if err := http.ListenAndServe(addr, withSecurityHeaders(mux)); err != nil {
		log.Fatal(err)
	}
}

func withSecurityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Referrer-Policy", "unsafe-url")
		next.ServeHTTP(w, r)
	})
}

func spaHandler(staticDir string) http.Handler {
	root := http.Dir(staticDir)
	fileServer := http.FileServer(root)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			httpserver.WriteJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": map[string]string{"message": "method not allowed"}})
			return
		}
		requestPath := path.Clean("/" + strings.TrimLeft(r.URL.Path, "/"))
		if requestPath == "/api" || strings.HasPrefix(requestPath, "/api/") {
			httpserver.WriteJSON(w, http.StatusNotFound, map[string]any{"error": map[string]string{"message": "not found"}})
			return
		}
		localPath := filepath.Join(staticDir, filepath.FromSlash(requestPath))
		if info, err := os.Stat(localPath); err == nil && !info.IsDir() {
			setStaticContentType(w, localPath)
			setStaticCacheControl(w, requestPath)
			fileServer.ServeHTTP(w, r)
			return
		}
		r2 := new(http.Request)
		*r2 = *r
		r2.URL = new(url.URL)
		*r2.URL = *r.URL
		r2.URL.Path = "/"
		setStaticContentType(w, filepath.Join(staticDir, "index.html"))
		setStaticCacheControl(w, "/index.html")
		fileServer.ServeHTTP(w, r2)
	})
}

func setStaticCacheControl(w http.ResponseWriter, requestPath string) {
	if strings.HasPrefix(requestPath, "/assets/") {
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		return
	}
	switch requestPath {
	case "/", "/index.html", "/sw.js", "/manifest.webmanifest":
		w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
		w.Header().Set("Pragma", "no-cache")
		w.Header().Set("Expires", "0")
	default:
		w.Header().Set("Cache-Control", "no-cache")
	}
}

func setStaticContentType(w http.ResponseWriter, filePath string) {
	if contentType := mime.TypeByExtension(filepath.Ext(filePath)); contentType != "" {
		w.Header().Set("Content-Type", contentType)
	}
}
