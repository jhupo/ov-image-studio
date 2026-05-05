import { fal } from '@fal-ai/client'
import type { ApiProfile, FalApiResponse, TaskParams } from '../types'
import {
  assertImageInputPayloadSize,
  assertMaskEditFileSize,
  type CallApiOptions,
  type CallApiResult,
  fetchImageUrlAsDataUrl,
  getDataUrlDecodedByteSize,
  getDataUrlEncodedByteSize,
  isDataUrl,
  isHttpUrl,
  mergeActualParams,
  MIME_MAP,
  normalizeBase64Image,
} from './imageApiShared'

const DEFAULT_FAL_IMAGE_SIZE = { width: 1360, height: 1024 }

function mapFalEndpoint(model: string, isEdit: boolean): string {
  const normalized = model.trim().replace(/^\/+/, '').replace(/\/+$/, '') || 'openai/gpt-image-2'
  return isEdit && !normalized.endsWith('/edit') ? `${normalized}/edit` : normalized
}

async function mapFalImageSize(size: string): Promise<{ width: number; height: number }> {
  const match = size.match(/^(\d+)x(\d+)$/)
  if (match) {
    return { width: Number(match[1]), height: Number(match[2]) }
  }

  return DEFAULT_FAL_IMAGE_SIZE
}

function mapFalQuality(quality: TaskParams['quality']): 'low' | 'medium' | 'high' {
  return quality === 'auto' ? 'high' : quality
}

function configureFal(profile: ApiProfile) {
  fal.config({
    credentials: profile.apiKey,
    suppressLocalCredentialsWarning: true,
  })
}

async function createFalRequestInput(opts: CallApiOptions): Promise<Record<string, unknown>> {
  const isEdit = opts.inputImageDataUrls.length > 0
  const input: Record<string, unknown> = {
    prompt: opts.prompt,
    image_size: await mapFalImageSize(opts.params.size),
    quality: mapFalQuality(opts.params.quality),
    num_images: Math.min(4, Math.max(1, opts.params.n || 1)),
    output_format: opts.params.output_format,
  }

  if (isEdit) {
    input.image_urls = opts.inputImageDataUrls
  }

  if (opts.maskDataUrl) {
    input.mask_url = opts.maskDataUrl
  }

  return input
}

function readFalImageValue(value: unknown, fallbackMime: string): string | null {
  if (typeof value === 'string') {
    if (isHttpUrl(value) || isDataUrl(value)) return value
    return normalizeBase64Image(value, fallbackMime)
  }
  if (!value || typeof value !== 'object') return null

  const record = value as Record<string, unknown>
  if (isHttpUrl(record.url) || isDataUrl(record.url)) return record.url
  if (typeof record.b64_json === 'string') return normalizeBase64Image(record.b64_json, fallbackMime)
  if (typeof record.base64 === 'string') return normalizeBase64Image(record.base64, fallbackMime)
  if (typeof record.data === 'string') return normalizeBase64Image(record.data, fallbackMime)
  return null
}

async function parseFalImages(payload: FalApiResponse, fallbackMime: string, signal?: AbortSignal): Promise<string[]> {
  const candidates: unknown[] = []
  if (Array.isArray(payload.images)) candidates.push(...payload.images)
  if (payload.image) candidates.push(payload.image)
  if (payload.url) candidates.push(payload.url)

  const images: string[] = []
  for (const candidate of candidates) {
    const value = readFalImageValue(candidate, fallbackMime)
    if (!value) continue
    images.push(isHttpUrl(value) ? await fetchImageUrlAsDataUrl(value, fallbackMime, signal) : value)
  }

  if (!images.length) throw new Error('fal.ai 未返回可用图片数据')
  return images
}

async function parseFalResult(payload: FalApiResponse, params: TaskParams, signal?: AbortSignal): Promise<CallApiResult> {
  const mime = MIME_MAP[params.output_format] || 'image/png'
  const images = await parseFalImages(payload, mime, signal)
  return {
    images,
    revisedPrompts: images.map(() => undefined),
  }
}

export function getFalErrorMessage(err: unknown): string | null {
  const body = err && typeof err === 'object' && 'body' in err ? (err as { body?: unknown }).body : null
  if (!body || typeof body !== 'object') return null

  const detail = (body as Record<string, unknown>).detail
  if (typeof detail === 'string' && detail.trim()) return detail
  if (Array.isArray(detail)) {
    const messages = detail
      .map((item) => {
        if (typeof item === 'string') return item
        if (item && typeof item === 'object') {
          const record = item as Record<string, unknown>
          if (typeof record.msg === 'string' && record.msg.trim()) return record.msg
          if (typeof record.message === 'string' && record.message.trim()) return record.message
        }
        return null
      })
      .filter((message): message is string => Boolean(message))
    if (messages.length) return messages.join('\n')
  }

  const message = (body as Record<string, unknown>).message
  return typeof message === 'string' && message.trim() ? message : null
}

export async function getFalQueueStatus(profile: ApiProfile, endpoint: string, requestId: string) {
  configureFal(profile)
  return fal.queue.status(endpoint, { requestId, logs: true })
}

export async function getFalQueuedImageResult(
  profile: ApiProfile,
  endpoint: string,
  requestId: string,
  params: TaskParams,
): Promise<CallApiResult> {
  configureFal(profile)
  const result = await fal.queue.result(endpoint, { requestId })
  return parseFalResult(result.data as FalApiResponse, params)
}

export async function callFalAiImageApi(opts: CallApiOptions, profile: ApiProfile): Promise<CallApiResult> {
  const mime = MIME_MAP[opts.params.output_format] || 'image/png'

  try {
    if (opts.maskDataUrl) {
      assertMaskEditFileSize('遮罩主图文件', getDataUrlDecodedByteSize(opts.inputImageDataUrls[0] ?? ''))
      assertMaskEditFileSize('遮罩文件', getDataUrlDecodedByteSize(opts.maskDataUrl))
    }
    assertImageInputPayloadSize(
      opts.inputImageDataUrls.reduce((sum, dataUrl) => sum + getDataUrlEncodedByteSize(dataUrl), 0) +
        (opts.maskDataUrl ? getDataUrlEncodedByteSize(opts.maskDataUrl) : 0),
    )

    // 使用当前配置保存的 API Key，避免 fal SDK 额外输出前端凭据警告。
    configureFal(profile)

    const isEdit = opts.inputImageDataUrls.length > 0
    const endpoint = mapFalEndpoint(profile.model, isEdit)
    const input = await createFalRequestInput(opts)
    const result = await fal.subscribe(endpoint, {
      input,
      logs: true,
      onEnqueue: (requestId) => {
        opts.onFalRequestEnqueued?.({ requestId, endpoint })
      },
    })
    const payload = result.data as FalApiResponse
    opts.onFalRequestEnqueued?.({ requestId: result.requestId, endpoint })
    const images = await parseFalImages(payload, mime)
    const actualFalSize = await mapFalImageSize(opts.params.size)
    const actualParams = mergeActualParams({
      size: `${actualFalSize.width}x${actualFalSize.height}`,
      quality: mapFalQuality(opts.params.quality),
      output_format: opts.params.output_format,
      n: images.length,
    })
    return {
      images,
      actualParams,
      actualParamsList: images.map(() => actualParams),
      revisedPrompts: images.map(() => undefined),
    }
  } catch (err) {
    const falMessage = getFalErrorMessage(err)
    if (falMessage) throw new Error(falMessage)
    throw err
  }
}
