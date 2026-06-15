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
  response?: {
    statusCode: number
    status: string
    headers: Record<string, string>
    bodyBase64: string
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

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }
    const timer = window.setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      window.clearTimeout(timer)
      reject(new DOMException('Aborted', 'AbortError'))
    }, { once: true })
  })
}

async function readTask(taskId: string, signal?: AbortSignal): Promise<QueuedFetchTaskResponse> {
  const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}`, {
    cache: 'no-store',
    signal,
  })
  if (!response.ok) throw new Error(`任务查询失败：HTTP ${response.status}`)
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
    const message = await created.text()
    throw new Error(message || `任务创建失败：HTTP ${created.status}`)
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
      if (current.status === 'error') throw new Error(current.error || '任务执行失败')
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
