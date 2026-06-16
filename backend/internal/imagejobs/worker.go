package imagejobs

import (
	"context"
	"log"
	"strconv"
	"time"

	"ov-image-studio/backend/internal/queue"
)

const imageWorkerGroup = "image-workers"

type Worker struct {
	index   int
	queue   *queue.Queue
	service *Service
}

func NewWorker(index int, queue *queue.Queue, service *Service) *Worker {
	return &Worker{index: index, queue: queue, service: service}
}

func (w *Worker) Start(ctx context.Context) {
	consumer := "image-worker-" + strconv.Itoa(w.index)
	if err := w.queue.EnsureGroup(ctx, "image_jobs", imageWorkerGroup); err != nil {
		log.Printf("image worker group init failed: %v", err)
		return
	}
	for {
		select {
		case <-ctx.Done():
			return
		default:
		}
		messages, err := w.queue.ReadImageJobs(ctx, imageWorkerGroup, consumer, 1, 5*time.Second)
		if err != nil {
			log.Printf("image worker read failed: %v", err)
			time.Sleep(time.Second)
			continue
		}
		for _, message := range messages {
			jobID, _ := message.Values["job_id"].(string)
			if jobID == "" {
				_ = w.queue.AckImageJob(ctx, imageWorkerGroup, message.ID)
				continue
			}
			w.service.Run(ctx, jobID)
			if err := w.queue.AckImageJob(ctx, imageWorkerGroup, message.ID); err != nil {
				log.Printf("image worker ack failed: %v", err)
			}
		}
	}
}
