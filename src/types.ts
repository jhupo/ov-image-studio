// ===== 设置 =====

export type ApiMode = 'images' | 'responses'

export interface UserSettings {
  apiKey: string
  apiMode: ApiMode
  codexCli: boolean
  clearInputAfterSubmit: boolean
  embeddedApiKeyId: number | null
}

export interface RuntimeApiProfile {
  name: string
  provider: 'openai'
  baseUrl: string
  imageApiBaseUrl: string
  apiKey: string
  model: string
  timeout: number
  apiMode: ApiMode
  codexCli: boolean
}

export type AppSettings = UserSettings

export interface EmbeddedSub2ApiKey {
  id: number
  name: string
  key: string
  status: string
}

export interface EmbeddedSub2ApiState {
  active: boolean
  origin: string
  userId: number | null
  loading: boolean
  error: string | null
  apiKeys: EmbeddedSub2ApiKey[]
}

// ===== 任务参数 =====

export interface TaskParams {
  size: string
  quality: 'auto' | 'low' | 'medium' | 'high'
  output_format: 'png' | 'jpeg' | 'webp'
  output_compression: number | null
  moderation: 'auto' | 'low'
  n: number
}

export const DEFAULT_PARAMS: TaskParams = {
  size: 'auto',
  quality: 'auto',
  output_format: 'png',
  output_compression: null,
  moderation: 'auto',
  n: 1,
}

// ===== 输入图片（UI 层面） =====

export interface InputImage {
  /** IndexedDB image store 的 id（SHA-256 hash） */
  id: string
  /** data URL，用于预览 */
  dataUrl: string
}

export interface MaskDraft {
  targetImageId: string
  maskDataUrl: string
  updatedAt: number
}

// ===== 任务记录 =====

export type TaskStatus = 'running' | 'done' | 'error'

export interface TaskRecord {
  id: string
  submissionKey?: string | null
  backendIdempotencyKey?: string | null
  backendTaskId?: string | null
  backendStatus?: 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled' | null
  backendQueuePosition?: number | null
  backendQueuePositions?: {
    global?: number | null
    user?: number | null
    apiKey?: number | null
    profile?: number | null
  } | null
  backendRetryCount?: number | null
  backendMaxRetries?: number | null
  backendErrorCode?: string | null
  backendErrorCategory?: string | null
  backendQueuedAt?: number | null
  backendAvailableAt?: number | null
  backendStartedAt?: number | null
  backendFinishedAt?: number | null
  backendPhase?: string | null
  backendPhaseStartedAt?: number | null
  backendQueuedMs?: number | null
  backendRunningMs?: number | null
  backendTotalMs?: number | null
  backendPayloadTtlSeconds?: number | null
  backendResultTtlSeconds?: number | null
  prompt: string
  params: TaskParams
  /** 生成时使用的模型 ID */
  apiModel?: string
  /** API 返回的实际生效参数，用于标记与请求值不一致的情况 */
  actualParams?: Partial<TaskParams>
  /** 输出图片对应的实际生效参数，key 为 outputImages 中的图片 id */
  actualParamsByImage?: Record<string, Partial<TaskParams>>
  /** 输出图片对应的 API 改写提示词，key 为 outputImages 中的图片 id */
  revisedPromptByImage?: Record<string, string>
  /** 输入图片的 image store id 列表 */
  inputImageIds: string[]
  maskTargetImageId?: string | null
  maskImageId?: string | null
  /** 输出图片的 image store id 列表 */
  outputImages: string[]
  status: TaskStatus
  error: string | null
  createdAt: number
  finishedAt: number | null
  /** 总耗时毫秒 */
  elapsed: number | null
  /** 是否收藏 */
  isFavorite?: boolean
}

export interface BackendTaskEvent {
  id: number
  type: string
  message?: string | null
  metadata?: Record<string, string | number | boolean | null>
  createdAt: number
}

// ===== IndexedDB 存储的图片 =====

export interface StoredImage {
  id: string
  dataUrl: string
  /** 图片首次存储时间（ms） */
  createdAt?: number
  /** 图片来源：用户上传 / API 生成 / 遮罩 */
  source?: 'upload' | 'generated' | 'mask'
}

// ===== API 请求体 =====

export interface ImageGenerationRequest {
  model: string
  prompt: string
  size: string
  quality: string
  output_format: string
  moderation: string
  output_compression?: number
  n?: number
}

// ===== API 响应 =====

export interface ImageResponseItem {
  b64_json?: string
  url?: string
  revised_prompt?: string
  size?: string
  quality?: string
  output_format?: string
  output_compression?: number
  moderation?: string
}

export interface ImageApiResponse {
  data: ImageResponseItem[]
  size?: string
  quality?: string
  output_format?: string
  output_compression?: number
  moderation?: string
  n?: number
}

export interface ResponsesOutputItem {
  type?: string
  result?: string | {
    b64_json?: string
    image?: string
    data?: string
  }
  size?: string
  quality?: string
  output_format?: string
  output_compression?: number
  moderation?: string
  revised_prompt?: string
}

export interface ResponsesApiResponse {
  output?: ResponsesOutputItem[]
  tools?: Array<{
    type?: string
    size?: string
    quality?: string
    output_format?: string
    output_compression?: number
    moderation?: string
    n?: number
  }>
}

// ===== 导出数据 =====

/** ZIP manifest.json 格式 */
export interface ExportData {
  version: number
  exportedAt: string
  settings: AppSettings
  tasks: TaskRecord[]
  /** imageId → 图片信息 */
  imageFiles: Record<string, {
    path: string
    createdAt?: number
    source?: 'upload' | 'generated' | 'mask'
  }>
}
