package queue

import (
	"context"
	"fmt"
	"net/url"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

type Queue struct {
	client *redis.Client
}

func Open(ctx context.Context, redisURL string) (*Queue, error) {
	if redisURL == "" {
		return nil, fmt.Errorf("REDIS_URL is required")
	}
	opts, err := redis.ParseURL(redisURL)
	if err != nil {
		if strings.Contains(redisURL, "://") {
			return nil, err
		}
		opts = &redis.Options{Addr: redisURL}
	} else if opts.Addr == "" {
		parsed, _ := url.Parse(redisURL)
		opts.Addr = parsed.Host
	}
	client := redis.NewClient(opts)
	if err := client.Ping(ctx).Err(); err != nil {
		_ = client.Close()
		return nil, err
	}
	return &Queue{client: client}, nil
}

func (q *Queue) Close() error {
	return q.client.Close()
}

func (q *Queue) EnqueueImageJob(ctx context.Context, jobID string) error {
	return q.client.XAdd(ctx, &redis.XAddArgs{
		Stream: "image_jobs",
		Values: map[string]any{"job_id": jobID},
	}).Err()
}

func (q *Queue) EnqueueAgentRun(ctx context.Context, runID string) error {
	return q.client.XAdd(ctx, &redis.XAddArgs{
		Stream: "agent_runs",
		Values: map[string]any{"run_id": runID},
	}).Err()
}

func (q *Queue) EnsureGroup(ctx context.Context, stream string, group string) error {
	err := q.client.XGroupCreateMkStream(ctx, stream, group, "0").Err()
	if err != nil && strings.Contains(err.Error(), "BUSYGROUP") {
		return nil
	}
	return err
}

func (q *Queue) ReadImageJobs(ctx context.Context, group string, consumer string, count int, block time.Duration) ([]redis.XMessage, error) {
	return q.readGroup(ctx, "image_jobs", group, consumer, count, block)
}

func (q *Queue) ReadAgentRuns(ctx context.Context, group string, consumer string, count int, block time.Duration) ([]redis.XMessage, error) {
	return q.readGroup(ctx, "agent_runs", group, consumer, count, block)
}

func (q *Queue) AckImageJob(ctx context.Context, group string, messageID string) error {
	return q.client.XAck(ctx, "image_jobs", group, messageID).Err()
}

func (q *Queue) AckAgentRun(ctx context.Context, group string, messageID string) error {
	return q.client.XAck(ctx, "agent_runs", group, messageID).Err()
}

func (q *Queue) MarkCancelled(ctx context.Context, kind string, id string, ttl time.Duration) error {
	return q.client.Set(ctx, kind+":"+id+":cancel", "1", ttl).Err()
}

func (q *Queue) IsCancelled(ctx context.Context, kind string, id string) bool {
	return q.client.Exists(ctx, kind+":"+id+":cancel").Val() > 0
}

func (q *Queue) readGroup(ctx context.Context, stream string, group string, consumer string, count int, block time.Duration) ([]redis.XMessage, error) {
	result, err := q.client.XReadGroup(ctx, &redis.XReadGroupArgs{
		Group:    group,
		Consumer: consumer,
		Streams:  []string{stream, ">"},
		Count:    int64(count),
		Block:    block,
	}).Result()
	if err == redis.Nil {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if len(result) == 0 {
		return nil, nil
	}
	return result[0].Messages, nil
}
