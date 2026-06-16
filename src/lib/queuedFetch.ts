interface QueuedFetchRequest {
  url: string
  method: string
  headers: Record<string, string>
  bodyBase64?: string
}

interface QueuedFetchTaskResponse {
  id: string
  status: 'queued' | 'running' | 'done' | 'error' | 'cancelled'
  error?: string
  errorDetail?: QueuedFetchTaskErrorDetail
  response?: {
    statusCode: number
    status: string
    headers: Record<string, string>
    bodyBase64: string
  }
}

interface QueuedFetchTaskErrorDetail {
  code: string
  message: string
  category?: string
  httpStatus?: number
  upstreamStatusCode?: number
  upstreamStatus?: string
  upstreamBodyBase64?: string
  upstreamBodyTruncated?: boolean
  retryable?: boolean
}

export class QueuedFetchError extends Error {
  code?: string
  category?: string
  upstreamStatusCode?: number
  upstreamStatus?: string
  rawResponsePayload?: string

  constructor(message: string, detail?: QueuedFetchTaskErrorDetail) {
    super(message)
    this.name = 'QueuedFetchError'
    this.code = detail?.code
    this.category = detail?.category
    this.upstreamStatusCode = detail?.upstreamStatusCode
    this.upstreamStatus = detail?.upstreamStatus
    this.rawResponsePayload = createRawResponsePayload(detail)
  }
}

const POLL_INTERVAL_MS = 1500

function headersToRecord(headers: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!headers) return out
  new Headers(headers).forEach((value, key) => {
    out[key] = value
  })
  return out
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const normalizedName = name.toLowerCase()
  return Object.keys(headers).some((key) => key.toLowerCase() === normalizedName)
}

function setHeader(headers: Record<string, string>, name: string, value: string) {
  const existingKey = Object.keys(headers).find((key) => key.toLowerCase() === name.toLowerCase())
  headers[existingKey ?? name] = value
}

function normalizeQueuedUrl(url: string): string {
  try {
    const parsed = new URL(url, window.location.origin)
    if (parsed.origin === window.location.origin) {
      return `${parsed.pathname}${parsed.search}`
    }
  } catch {
    // Keep invalid URLs unchanged so the queue service can return the upstream validation error.
  }
  return url
}

async function serializeBody(body: BodyInit | null | undefined): Promise<{
  bodyBase64?: string
  contentType?: string
}> {
  if (body == null) return {}

  let buffer: ArrayBuffer
  let contentType: string | undefined
  if (typeof body === 'string') {
    buffer = new TextEncoder().encode(body).buffer
  } else if (body instanceof Blob) {
    buffer = await body.arrayBuffer()
    contentType = body.type || undefined
  } else if (body instanceof FormData) {
    const response = new Response(body)
    contentType = response.headers.get('Content-Type') ?? undefined
    buffer = await response.arrayBuffer()
  } else if (body instanceof URLSearchParams) {
    buffer = new TextEncoder().encode(body.toString()).buffer
    contentType = 'application/x-www-form-urlencoded;charset=UTF-8'
  } else if (body instanceof ArrayBuffer) {
    buffer = body
  } else if (ArrayBuffer.isView(body)) {
    buffer = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)
  } else {
    throw new Error('不支持的请求体类型')
  }

  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return {
    bodyBase64: btoa(binary),
    contentType,
  }
}

function base64ToUint8Array(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function base64ToText(value: string): string {
  return new TextDecoder().decode(base64ToUint8Array(value))
}

function pickJsonMessage(value: unknown): string {
  if (!value || typeof value !== 'object') return ''
  const record = value as Record<string, unknown>
  const error = record.error
  if (typeof error === 'string') return error.trim()
  if (error && typeof error === 'object') {
    const nested = pickJsonMessage(error)
    if (nested) return nested
  }
  for (const key of ['message', 'detail', 'error_description']) {
    const text = record[key]
    if (typeof text === 'string' && text.trim()) return text.trim()
  }
  if (Array.isArray(record.detail)) {
    return record.detail
      .map((item) => typeof item === 'string' ? item : JSON.stringify(item))
      .join('\n')
      .trim()
  }
  return ''
}

function normalizeMessageText(text: string, maxLength = 1000): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  const chars = Array.from(normalized)
  return chars.length > maxLength ? `${chars.slice(0, maxLength).join('')}...` : normalized
}

function summarizeResponseText(text: string): string {
  const trimmed = text.trim()
  if (!trimmed) return ''
  try {
    const json = JSON.parse(trimmed)
    return normalizeMessageText(pickJsonMessage(json) || JSON.stringify(json))
  } catch {
    return normalizeMessageText(trimmed)
  }
}

function createRawResponsePayload(detail?: QueuedFetchTaskErrorDetail): string | undefined {
  if (!detail?.upstreamBodyBase64) return undefined
  const bodyText = base64ToText(detail.upstreamBodyBase64)
  try {
    return JSON.stringify({
      statusCode: detail.upstreamStatusCode,
      status: detail.upstreamStatus,
      body: JSON.parse(bodyText),
      ...(detail.upstreamBodyTruncated ? { bodyTruncated: true } : {}),
    }, null, 2)
  } catch {
    return bodyText
  }
}

function formatTaskError(task: QueuedFetchTaskResponse): string {
  const detail = task.errorDetail
  if (!detail) return task.error || '任务执行失败'

  if (detail.upstreamStatusCode) {
    const status = detail.upstreamStatus || `HTTP ${detail.upstreamStatusCode}`
    const bodySummary = detail.upstreamBodyBase64 ? summarizeResponseText(base64ToText(detail.upstreamBodyBase64)) : ''
    const suffix = detail.upstreamBodyTruncated ? '（响应体已截断）' : ''
    return bodySummary ? `上游返回 ${status}：${bodySummary}${suffix}` : `上游返回 ${status}`
  }

  if (detail.code === 'upstream_timeout') return '上游请求超时，请稍后重试或调高超时时间。'
  if (detail.category === 'network') return `上游请求失败：${detail.message || task.error || '网络异常'}`
  return detail.message || task.error || '任务执行失败'
}

async function readErrorMessage(response: Response, fallback: string): Promise<string> {
  const text = await response.text()
  if (!text.trim()) return fallback
  try {
    const json = JSON.parse(text)
    return pickJsonMessage(json) || text
  } catch {
    return text
  }
}

function sleep(ms: number, signal?: AbortSignal) {
  const abortError = () => signal?.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError')
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError())
      return
    }
    const timer = window.setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      window.clearTimeout(timer)
      reject(abortError())
    }, { once: true })
  })
}

async function readTask(taskId: string, signal?: AbortSignal): Promise<QueuedFetchTaskResponse> {
  const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}`, {
    cache: 'no-store',
    signal,
  })
  if (!response.ok) throw new Error(await readErrorMessage(response, `任务查询失败：HTTP ${response.status}`))
  return response.json() as Promise<QueuedFetchTaskResponse>
}

async function cancelTask(taskId: string) {
  try {
    await fetch(`/api/tasks/${encodeURIComponent(taskId)}`, {
      method: 'DELETE',
      cache: 'no-store',
    })
  } catch {
    // Ignore cancellation cleanup failures.
  }
}

export async function queuedFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const url = typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.toString()
      : input.url
  const method = (init.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
  const headers = headersToRecord(init.headers ?? (input instanceof Request ? input.headers : undefined))
  const { bodyBase64, contentType } = await serializeBody(init.body)
  if (contentType && !hasHeader(headers, 'Content-Type')) {
    setHeader(headers, 'Content-Type', contentType)
  }
  const request: QueuedFetchRequest = {
    url: normalizeQueuedUrl(url),
    method,
    headers,
    ...(bodyBase64 ? { bodyBase64 } : {}),
  }

  const created = await fetch('/api/tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify(request),
    signal: init.signal,
  })
  if (!created.ok) {
    throw new Error(await readErrorMessage(created, `任务创建失败：HTTP ${created.status}`))
  }

  const task = await created.json() as QueuedFetchTaskResponse
  const signal = init.signal
  const abortListener = () => {
    void cancelTask(task.id)
  }
  signal?.addEventListener('abort', abortListener, { once: true })

  try {
    while (true) {
      await sleep(POLL_INTERVAL_MS, signal ?? undefined)
      const current = await readTask(task.id, signal ?? undefined)
      if (current.status === 'queued' || current.status === 'running') continue
      if (current.status === 'cancelled') throw new DOMException('Aborted', 'AbortError')
      if (current.status === 'error') throw new QueuedFetchError(formatTaskError(current), current.errorDetail)
      if (!current.response) throw new Error('任务结果为空')

      const bytes = base64ToUint8Array(current.response.bodyBase64)
      const body = new ArrayBuffer(bytes.byteLength)
      new Uint8Array(body).set(bytes)
      return new Response(body, {
        status: current.response.statusCode,
        statusText: current.response.status,
        headers: current.response.headers,
      })
    }
  } finally {
    signal?.removeEventListener('abort', abortListener)
  }
}
