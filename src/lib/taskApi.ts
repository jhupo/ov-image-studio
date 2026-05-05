import type { ApiProfile, TaskParams } from '../types'

export interface ImageTaskRequest {
  requesterId?: number | null
  prompt: string
  params: TaskParams
  profile: ApiProfile
  inputImageDataUrls: string[]
  maskDataUrl?: string
}

export interface ImageTaskResult {
  images?: string[]
  actualParams?: Partial<TaskParams>
  actualParamsList?: Array<Partial<TaskParams>>
  revisedPrompts?: Array<string | null>
}

export interface ImageTask {
  id: string
  requesterId?: number | null
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled'
  queuePosition: number | null
  queuePositions?: {
    global?: number | null
    user?: number | null
    apiKey?: number | null
    profile?: number | null
  } | null
  priority?: number
  retryCount?: number
  maxRetries?: number
  errorCode?: string | null
  errorCategory?: string | null
  createdAt: number
  updatedAt: number
  queuedAt?: number | null
  availableAt?: number | null
  startedAt: number | null
  finishedAt: number | null
  canceledAt?: number | null
  leaseOwner?: string | null
  leaseExpiresAt?: number | null
  phase?: 'queued' | 'retry_waiting' | 'running' | 'succeeded' | 'failed' | 'canceled' | string | null
  phaseStartedAt?: number | null
  queuedMs?: number | null
  runningMs?: number | null
  totalMs?: number | null
  payloadTtlSeconds?: number | null
  resultTtlSeconds?: number | null
  error: string | null
  result?: ImageTaskResult | null
}

export interface ImageTaskSummary {
  sampleSize: number
  latestCreatedAt: number | null
  byStatus: Partial<Record<ImageTask['status'], number>>
  byErrorCategory: Record<string, number>
  retrying: number
  averageQueuedMs: number | null
  averageRunningMs: number | null
}

async function parseResponse<T>(response: Response): Promise<T> {
  const payload = await response.json()
  if (!response.ok) {
    throw new Error(payload?.message || `Request failed (${response.status})`)
  }
  return payload.data as T
}

export async function createImageTask(payload: ImageTaskRequest, idempotencyKey?: string): Promise<ImageTask> {
  const response = await fetch('/api/tasks', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
    },
    body: JSON.stringify(payload),
  })
  return parseResponse<ImageTask>(response)
}

export async function getImageTask(taskId: string): Promise<ImageTask> {
  const response = await fetch(`/api/tasks/${taskId}`, {
    method: 'GET',
  })
  return parseResponse<ImageTask>(response)
}

export async function cancelImageTask(taskId: string): Promise<ImageTask> {
  const response = await fetch(`/api/tasks/${taskId}/cancel`, {
    method: 'POST',
  })
  return parseResponse<ImageTask>(response)
}

export async function retryImageTask(taskId: string): Promise<ImageTask> {
  const response = await fetch(`/api/tasks/${taskId}/retry`, {
    method: 'POST',
  })
  return parseResponse<ImageTask>(response)
}

export async function listImageTasks(limit = 30): Promise<{ items: ImageTask[]; nextBefore: number | null }> {
  const response = await fetch(`/api/tasks?limit=${encodeURIComponent(String(limit))}`, {
    method: 'GET',
  })
  return parseResponse<{ items: ImageTask[]; nextBefore: number | null }>(response)
}

export async function getImageTaskSummary(limit = 500): Promise<ImageTaskSummary> {
  const response = await fetch(`/api/tasks/summary?limit=${encodeURIComponent(String(limit))}`, {
    method: 'GET',
  })
  return parseResponse<ImageTaskSummary>(response)
}
