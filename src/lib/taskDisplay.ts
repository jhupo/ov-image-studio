import type { TaskRecord } from '../types'

export const BACKEND_STATUS_LABELS: Record<string, string> = {
  queued: '排队中',
  running: '生成中',
  succeeded: '已完成',
  failed: '失败',
  canceled: '已取消',
}

export const BACKEND_PHASE_LABELS: Record<string, string> = {
  queued: '排队中',
  retry_waiting: '等待重试',
  running: '请求上游',
  succeeded: '已完成',
  failed: '失败',
  canceled: '已取消',
}

const ERROR_LABELS: Record<string, string> = {
  UPSTREAM_NO_AVAILABLE_ACCOUNTS: '当前账号池无可用账号',
  UPSTREAM_RATE_LIMITED: '上游限流，请稍后重试',
  UPSTREAM_TIMEOUT: '上游请求超时',
  UPSTREAM_NETWORK: '上游网络不可用',
  UPSTREAM_5XX: '上游服务异常',
  UPSTREAM_EMPTY_RESULT: '上游没有返回可用图片',
  UPSTREAM_BAD_RESPONSE: '上游返回异常',
  IMAGE_DOWNLOAD_TIMEOUT: '图片下载超时',
  IMAGE_DOWNLOAD_FAILED: '图片下载失败',
  PAYLOAD_EXPIRED: '任务输入已过期，请重新创建任务',
  LEASE_EXPIRED: 'Worker 租约过期，任务已重新排队',
  INTERNAL_WORKER_ERROR: '后端 Worker 内部错误',
  USER_CANCELED: '任务已取消',
}

const CATEGORY_LABELS: Record<string, string> = {
  account_unavailable: '账号不可用',
  rate_limited: '限流',
  upstream_unavailable: '上游不可用',
  image_download_failed: '图片下载失败',
  payload_expired: '输入已过期',
  upstream_bad_response: '上游响应异常',
  canceled: '已取消',
  worker_recovered: 'Worker 已恢复',
  internal_error: '内部错误',
  unknown: '未知错误',
}

export const BACKEND_STATUS_ORDER = ['queued', 'running', 'succeeded', 'failed', 'canceled'] as const

const EVENT_LABELS: Record<string, string> = {
  created: '已创建',
  claimed: '已进入运行',
  upstream_request: '正在请求上游',
  succeeded: '生成成功',
  failed: '生成失败',
  canceled: '已取消',
  retry_scheduled: '已安排重试',
  retry_requested: '已重新提交',
  cancel_requested: '已请求取消',
}

export function formatBackendStatus(status?: string | null) {
  if (!status) return '等待后端'
  return BACKEND_STATUS_LABELS[status] ?? status
}

export function formatBackendPhase(phase?: string | null) {
  if (!phase) return ''
  return BACKEND_PHASE_LABELS[phase] ?? phase
}

export function formatDurationMs(ms?: number | null) {
  if (ms == null) return ''
  const seconds = Math.max(0, Math.floor(ms / 1000))
  const mm = String(Math.floor(seconds / 60)).padStart(2, '0')
  const ss = String(seconds % 60).padStart(2, '0')
  return `${mm}:${ss}`
}

export function formatDurationSeconds(seconds?: number | null) {
  if (seconds == null) return ''
  return formatDurationMs(seconds * 1000)
}

export function shortTaskId(id?: string | null) {
  if (!id) return ''
  return id.length > 12 ? `${id.slice(0, 8)}...${id.slice(-4)}` : id
}

export function formatErrorCategory(category?: string | null) {
  if (!category) return ''
  return CATEGORY_LABELS[category] ?? category
}

export function getReadableTaskError(task: Pick<TaskRecord, 'backendErrorCode' | 'backendErrorCategory' | 'error'>) {
  const raw = task.error?.trim() || ''
  const code = task.backendErrorCode?.trim() || ''
  if (code && ERROR_LABELS[code]) return ERROR_LABELS[code]
  if (/no available accounts/i.test(raw)) return ERROR_LABELS.UPSTREAM_NO_AVAILABLE_ACCOUNTS
  if (/rate limit|429/i.test(raw)) return ERROR_LABELS.UPSTREAM_RATE_LIMITED
  if (/timeout|timed out/i.test(raw)) return ERROR_LABELS.UPSTREAM_TIMEOUT
  return raw || (code ? ERROR_LABELS[code] ?? code : '生成失败')
}

export function getRunningTaskLabel(task: TaskRecord) {
  if (task.backendStatus === 'queued') {
    if (task.backendPhase === 'retry_waiting') return '正在重试'
    return task.backendQueuePosition ? `排队 #${task.backendQueuePosition}` : '排队中'
  }
  if (task.backendStatus === 'running') return '生成中'
  return task.backendTaskId ? formatBackendStatus(task.backendStatus) : '生成中'
}

export function getTaskStageDuration(task: TaskRecord) {
  if (task.backendStatus === 'queued') return formatDurationMs(task.backendQueuedMs)
  if (task.backendStatus === 'running') return formatDurationMs(task.backendRunningMs)
  return formatDurationMs(task.backendTotalMs ?? task.elapsed)
}

export function formatQueueScopePositions(queuePositions?: {
  global?: number | null
  user?: number | null
  apiKey?: number | null
  profile?: number | null
} | null) {
  if (!queuePositions) return []
  return queuePositions.user ? [`当前队列 #${queuePositions.user}`] : []
}

export function formatTaskEventType(type?: string | null) {
  if (!type) return ''
  return EVENT_LABELS[type] ?? type
}
