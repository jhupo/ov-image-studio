package agent

import (
	"context"
	"log"
	"strconv"
	"time"

	"ov-image-studio/backend/internal/queue"
)

const workerGroup = "agent-workers"

type Worker struct {
	index   int
	queue   *queue.Queue
	service *Service
}

func NewWorker(index int, queue *queue.Queue, service *Service) *Worker {
	return &Worker{index: index, queue: queue, service: service}
}

func (w *Worker) Start(ctx context.Context) {
	consumer := "agent-worker-" + strconv.Itoa(w.index)
	if err := w.queue.EnsureGroup(ctx, "agent_runs", workerGroup); err != nil {
		log.Printf("agent worker group init failed: %v", err)
		return
	}
	for {
		select {
		case <-ctx.Done():
			return
		default:
		}
		messages, err := w.queue.ReadAgentRuns(ctx, workerGroup, consumer, 1, 5*time.Second)
		if err != nil {
			log.Printf("agent worker read failed: %v", err)
			time.Sleep(time.Second)
			continue
		}
		for _, message := range messages {
			runID, _ := message.Values["run_id"].(string)
			if runID == "" {
				_ = w.queue.AckAgentRun(ctx, workerGroup, message.ID)
				continue
			}
			w.service.Run(ctx, runID)
			if err := w.queue.AckAgentRun(ctx, workerGroup, message.ID); err != nil {
				log.Printf("agent worker ack failed: %v", err)
			}
		}
	}
}
