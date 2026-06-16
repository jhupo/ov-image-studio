import type { ApiProfile, TaskParams } from '../types'
import type { CallApiResult } from './imageApiShared'
import { getApiErrorMessage, MIME_MAP } from './imageApiShared'

interface ImageJobAsset {
  id: string
  url: string
  mime: string
  fileSize: number
  actualParams?: Partial<TaskParams>
}

interface ImageJobView {
  job: {
    id: string
    status: 'queued' | 'running' | 'done' | 'error' | 'cancelled'
    error?: {
      code: string
      message: string
      category?: string
      upstreamStatusCode?: number
      retryable?: boolean
      raw?: unknown
    }
    actualParams?: Partial<TaskParams>
  }
  result?: {
    assets: ImageJobAsset[]
  }
}

const POLL_INTERVAL_MS = 1500

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError'))
      return
    }
    const timer = window.setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      window.clearTimeout(timer)
      reject(signal.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError'))
    }, { once: true })
  })
}

async function readError(response: Response, fallback: string) {
  const textResponse = response.clone()
  try {
    const payload = await response.json()
    return payload?.error?.message || payload?.message || fallback
  } catch {
    try {
      return (await textResponse.text()) || fallback
    } catch {
      return fallback
    }
  }
}

function dataUrlToBase64(dataUrl: string) {
  const comma = dataUrl.indexOf(',')
  return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl
}

function dataUrlMime(dataUrl: string) {
  const match = dataUrl.match(/^data:([^;,]+)[;,]/)
  return match?.[1] || 'image/png'
}

async function blobToDataUrl(blob: Blob, fallbackMime: string): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return `data:${blob.type || fallbackMime};base64,${btoa(binary)}`
}

async function uploadAsset(kind: 'input' | 'mask', dataUrl: string, signal?: AbortSignal): Promise<string> {
  const response = await fetch('/api/assets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    cache: 'no-store',
    signal,
    body: JSON.stringify({
      kind,
      mime: dataUrlMime(dataUrl),
      dataBase64: dataUrlToBase64(dataUrl),
    }),
  })
  if (!response.ok) throw new Error(await readError(response, `上传图片失败：HTTP ${response.status}`))
  const payload = await response.json() as { asset?: { id?: string } }
  const id = payload.asset?.id
  if (!id) throw new Error('上传图片后没有返回 asset id')
  return id
}

async function getJob(jobId: string, signal?: AbortSignal): Promise<ImageJobView> {
  const response = await fetch(`/api/image/jobs/${encodeURIComponent(jobId)}`, {
    cache: 'no-store',
    signal,
  })
  if (!response.ok) throw new Error(await readError(response, `查询任务失败：HTTP ${response.status}`))
  return response.json() as Promise<ImageJobView>
}

async function ackJob(jobId: string) {
  try {
    await fetch(`/api/image/jobs/${encodeURIComponent(jobId)}/ack`, {
      method: 'POST',
      cache: 'no-store',
    })
  } catch {
    // 临时资产有 TTL，ACK 失败不影响前端已缓存图片。
  }
}

async function downloadAsset(asset: ImageJobAsset, signal?: AbortSignal) {
  const response = await fetch(asset.url, {
    cache: 'no-store',
    signal,
  })
  if (!response.ok) throw new Error(await getApiErrorMessage(response))
  return blobToDataUrl(await response.blob(), asset.mime || 'image/png')
}

export async function callImageJobApi(opts: {
  profile: ApiProfile
  prompt: string
  params: TaskParams
  inputImageDataUrls: string[]
  maskDataUrl?: string
  signal?: AbortSignal
}): Promise<CallApiResult> {
  const inputAssetIds: string[] = []
  for (const dataUrl of opts.inputImageDataUrls) {
    inputAssetIds.push(await uploadAsset('input', dataUrl, opts.signal))
  }
  const maskAssetId = opts.maskDataUrl ? await uploadAsset('mask', opts.maskDataUrl, opts.signal) : null
  const response = await fetch('/api/image/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    cache: 'no-store',
    signal: opts.signal,
    body: JSON.stringify({
      manualApiKey: opts.profile.apiKey,
      apiMode: opts.profile.apiMode,
      model: opts.profile.model,
      prompt: opts.prompt,
      params: {
        size: opts.params.size,
        quality: opts.params.quality,
        output_format: opts.params.output_format,
        output_compression: opts.params.output_compression,
        moderation: opts.params.moderation,
        n: opts.params.n,
      },
      inputAssetIds,
      maskAssetId,
      sourceMode: 'gallery',
    }),
  })
  if (!response.ok) throw new Error(await readError(response, `创建任务失败：HTTP ${response.status}`))
  const created = await response.json() as { job?: { id?: string } }
  const jobId = created.job?.id
  if (!jobId) throw new Error('创建任务后没有返回 job id')

  while (true) {
    await sleep(POLL_INTERVAL_MS, opts.signal)
    const view = await getJob(jobId, opts.signal)
    if (view.job.status === 'queued' || view.job.status === 'running') continue
    if (view.job.status === 'cancelled') throw new DOMException('Aborted', 'AbortError')
    if (view.job.status === 'error') throw new Error(view.job.error?.message || '任务执行失败')
    const assets = view.result?.assets ?? []
    if (!assets.length) throw new Error('任务完成但没有返回图片')
    const images = await Promise.all(assets.map((asset) => downloadAsset(asset, opts.signal)))
    const actualParamsList = assets.map((asset) => asset.actualParams || view.job.actualParams)
    return {
      images,
      cleanup: () => ackJob(jobId),
      actualParams: {
        ...(view.job.actualParams ?? actualParamsList[0] ?? {}),
        n: images.length,
      },
      actualParamsList,
    }
  }
}
