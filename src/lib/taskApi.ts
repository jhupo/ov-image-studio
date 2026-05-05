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
  priority?: number
  retryCount?: number
  maxRetries?: number
  errorCode?: string | null
  createdAt: number
  updatedAt: number
  queuedAt?: number | null
  startedAt: number | null
  finishedAt: number | null
  canceledAt?: number | null
  leaseExpiresAt?: number | null
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

export async function createImageTask(payload: ImageTaskRequest): Promise<ImageTask> {
  const response = await fetch('/api/tasks', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
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
