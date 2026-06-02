import type { BackendTaskEvent, RuntimeApiProfile, TaskParams } from '../types'

export interface ImageTaskRequest {
  requesterId: string
  prompt: string
  params: TaskParams
  profile: RuntimeApiProfile
  inputImageDataUrls: string[]
  maskDataUrl?: string
  upscale?: {
    enabled: boolean
  }
}

export interface ImageTaskResult {
  images?: string[]
  requestedCount?: number | null
  failedCount?: number
  partialErrors?: Array<{
    index?: number
    errorCode?: string
    message?: string
  }>
  actualParams?: Partial<TaskParams>
  actualParamsList?: Array<Partial<TaskParams>>
  revisedPrompts?: Array<string | null>
  upscale?: {
    processedCount?: number
    targetSize?: string
    serviceUrl?: string
  } | null
}

export interface ImageTask {
  id: string
  requesterId?: string | null
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

function taskUrl(taskId: string, requesterId: string, includeResult = false) {
  const params = new URLSearchParams({ requesterId })
  if (includeResult) params.set('includeResult', '1')
  return `/api/tasks/${encodeURIComponent(taskId)}?${params.toString()}`
}

export async function getImageTask(taskId: string, requesterId: string, includeResult = false): Promise<ImageTask> {
  const response = await fetch(taskUrl(taskId, requesterId, includeResult), {
    method: 'GET',
  })
  return parseResponse<ImageTask>(response)
}

export async function cancelImageTask(taskId: string, requesterId: string): Promise<ImageTask> {
  const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/cancel?requesterId=${encodeURIComponent(requesterId)}`, {
    method: 'POST',
  })
  return parseResponse<ImageTask>(response)
}

export async function retryImageTask(taskId: string, requesterId: string): Promise<ImageTask> {
  const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/retry?requesterId=${encodeURIComponent(requesterId)}`, {
    method: 'POST',
  })
  return parseResponse<ImageTask>(response)
}

export async function getImageTaskEvents(taskId: string, requesterId: string): Promise<BackendTaskEvent[]> {
  const params = new URLSearchParams({ requesterId })
  const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/events?${params.toString()}`, {
    method: 'GET',
  })
  return parseResponse<BackendTaskEvent[]>(response)
}
