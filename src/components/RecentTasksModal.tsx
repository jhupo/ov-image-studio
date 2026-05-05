import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { getImageTaskSummary, listImageTasks, type ImageTask, type ImageTaskSummary } from '../lib/taskApi'
import { BACKEND_STATUS_ORDER, formatBackendPhase, formatBackendStatus, formatDurationMs, formatDurationSeconds, formatErrorCategory, formatQueueScopePositions, getReadableTaskError, shortTaskId } from '../lib/taskDisplay'
import { useCloseOnEscape } from '../hooks/useCloseOnEscape'

interface Props {
  onClose: () => void
}

function formatTime(ts?: number | null) {
  return ts ? new Date(ts).toLocaleString('zh-CN') : '-'
}

function readableRemoteError(task: ImageTask) {
  return getReadableTaskError({
    backendErrorCode: task.errorCode ?? null,
    backendErrorCategory: task.errorCategory ?? null,
    error: task.error ?? null,
  })
}

export default function RecentTasksModal({ onClose }: Props) {
  const [items, setItems] = useState<ImageTask[]>([])
  const [summary, setSummary] = useState<ImageTaskSummary | null>(null)
  const [statusFilter, setStatusFilter] = useState<ImageTask['status'] | 'all'>('all')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useCloseOnEscape(true, onClose)

  const refresh = async () => {
    setLoading(true)
    setError('')
    try {
      const [data, summaryData] = await Promise.all([listImageTasks(50), getImageTaskSummary(500)])
      setItems(data.items)
      setSummary(summaryData)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    refresh()
    const timer = window.setInterval(refresh, 5000)
    return () => window.clearInterval(timer)
  }, [])

  const visibleItems = statusFilter === 'all' ? items : items.filter((task) => task.status === statusFilter)
  const topErrorCategories = Object.entries(summary?.byErrorCategory ?? {})
    .sort(([, a], [, b]) => b - a)
    .slice(0, 4)

  const modal = (
    <div
      data-no-drag-select
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm animate-fade-in"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="w-full max-w-4xl overflow-hidden rounded-2xl border border-white/60 bg-white/95 shadow-2xl ring-1 ring-black/5 dark:border-white/[0.08] dark:bg-gray-900/95 dark:ring-white/10">
        <div className="flex items-center justify-between border-b border-gray-100 px-5 py-4 dark:border-white/[0.08]">
          <div>
            <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">最近任务</h2>
            <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">每 5 秒刷新，显示后端队列与执行状态</p>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-2 text-gray-400 transition hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-white/[0.06] dark:hover:text-gray-200"
            title="关闭"
          >
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="max-h-[70vh] overflow-auto p-4 custom-scrollbar">
          {summary && (
            <div className="mb-4 space-y-3">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <div className="rounded-lg border border-gray-100 bg-gray-50 px-3 py-2 dark:border-white/[0.08] dark:bg-white/[0.03]">
                  <div className="text-[11px] text-gray-400 dark:text-gray-500">最近样本</div>
                  <div className="mt-0.5 text-sm font-semibold text-gray-900 dark:text-gray-100">{summary.sampleSize}</div>
                </div>
                <div className="rounded-lg border border-gray-100 bg-gray-50 px-3 py-2 dark:border-white/[0.08] dark:bg-white/[0.03]">
                  <div className="text-[11px] text-gray-400 dark:text-gray-500">重试中</div>
                  <div className="mt-0.5 text-sm font-semibold text-gray-900 dark:text-gray-100">{summary.retrying}</div>
                </div>
                <div className="rounded-lg border border-gray-100 bg-gray-50 px-3 py-2 dark:border-white/[0.08] dark:bg-white/[0.03]">
                  <div className="text-[11px] text-gray-400 dark:text-gray-500">平均排队</div>
                  <div className="mt-0.5 text-sm font-semibold text-gray-900 dark:text-gray-100">{formatDurationMs(summary.averageQueuedMs)}</div>
                </div>
                <div className="rounded-lg border border-gray-100 bg-gray-50 px-3 py-2 dark:border-white/[0.08] dark:bg-white/[0.03]">
                  <div className="text-[11px] text-gray-400 dark:text-gray-500">平均运行</div>
                  <div className="mt-0.5 text-sm font-semibold text-gray-900 dark:text-gray-100">{formatDurationMs(summary.averageRunningMs)}</div>
                </div>
              </div>
              {topErrorCategories.length > 0 && (
                <div className="flex flex-wrap gap-2 text-xs text-gray-500 dark:text-gray-400">
                  {topErrorCategories.map(([category, count]) => (
                    <span key={category} className="rounded-md bg-red-50 px-2 py-1 text-red-600 dark:bg-red-500/10 dark:text-red-300">
                      {formatErrorCategory(category)} {count}
                    </span>
                  ))}
                </div>
              )}
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={() => setStatusFilter('all')}
                  className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                    statusFilter === 'all'
                      ? 'bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900'
                      : 'bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-white/[0.06] dark:text-gray-300 dark:hover:bg-white/[0.1]'
                  }`}
                >
                  全部 {summary.sampleSize}
                </button>
                {BACKEND_STATUS_ORDER.map((status) => (
                  <button
                    key={status}
                    onClick={() => setStatusFilter(status)}
                    className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                      statusFilter === status
                        ? 'bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900'
                        : 'bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-white/[0.06] dark:text-gray-300 dark:hover:bg-white/[0.1]'
                    }`}
                  >
                    {formatBackendStatus(status)} {summary.byStatus[status] ?? 0}
                  </button>
                ))}
              </div>
            </div>
          )}
          {loading && !items.length && (
            <div className="py-10 text-center text-sm text-gray-500 dark:text-gray-400">加载中...</div>
          )}
          {error && (
            <div className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600 dark:bg-red-500/10 dark:text-red-300">
              {error}
            </div>
          )}
          {!loading && !error && !visibleItems.length && (
            <div className="py-10 text-center text-sm text-gray-500 dark:text-gray-400">暂无后端任务</div>
          )}
          <div className="space-y-2">
            {visibleItems.map((task) => {
              const phase = formatBackendPhase(task.phase) || formatBackendStatus(task.status)
              const scopedQueueLabels = formatQueueScopePositions(task.queuePositions)
              return (
                <div key={task.id} className="rounded-lg border border-gray-100 bg-gray-50 px-3 py-2 text-xs dark:border-white/[0.08] dark:bg-white/[0.03]">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="font-mono text-gray-700 dark:text-gray-200">{shortTaskId(task.id)}</span>
                    <span className="font-medium text-gray-800 dark:text-gray-100">
                      {phase}
                      {task.queuePosition ? ` #${task.queuePosition}` : ''}
                    </span>
                    <span className="text-gray-400 dark:text-gray-500">重试 {task.retryCount ?? 0}/{task.maxRetries ?? 0}</span>
                    {task.totalMs != null && <span className="text-gray-400 dark:text-gray-500">总耗时 {formatDurationMs(task.totalMs)}</span>}
                    <span className="text-gray-400 dark:text-gray-500">{formatTime(task.createdAt)}</span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-gray-400 dark:text-gray-500">
                    {scopedQueueLabels.map((label) => <span key={label}>{label}</span>)}
                    {task.queuedMs != null && <span>排队 {formatDurationMs(task.queuedMs)}</span>}
                    {task.runningMs != null && <span>运行 {formatDurationMs(task.runningMs)}</span>}
                    {task.payloadTtlSeconds != null && <span>输入缓存 {formatDurationSeconds(task.payloadTtlSeconds)}</span>}
                    {task.resultTtlSeconds != null && <span>结果缓存 {formatDurationSeconds(task.resultTtlSeconds)}</span>}
                    {task.errorCategory && <span>{formatErrorCategory(task.errorCategory)}</span>}
                    {task.errorCode && <span>{task.errorCode}</span>}
                    {(task.status === 'failed' || task.status === 'canceled') && <span className="text-red-500 dark:text-red-300">{readableRemoteError(task)}</span>}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )

  return createPortal(modal, document.body)
}
