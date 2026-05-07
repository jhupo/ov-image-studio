import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type {
  AppSettings,
  TaskParams,
  InputImage,
  MaskDraft,
  TaskRecord,
  ExportData,
  EmbeddedSub2ApiState,
} from './types'
import { DEFAULT_PARAMS } from './types'
import { DEFAULT_SETTINGS, getRuntimeApiProfile, mergeImportedSettings, normalizeSettings, validateSettings } from './lib/apiProfiles'
import {
  getAllTasks,
  putTask,
  deleteTask as dbDeleteTask,
  clearTasks as dbClearTasks,
  getImage,
  getAllImages,
  putImage,
  deleteImage,
  clearImages,
  storeImage,
  getSettings as dbGetSettings,
  putSettings as dbPutSettings,
} from './lib/db'
import { cancelImageTask, createImageTask, getImageTask, retryImageTask, type ImageTask } from './lib/taskApi'
import { validateMaskMatchesImage } from './lib/canvasImage'
import { orderInputImagesForMask } from './lib/mask'
import { getChangedParams, normalizeParamsForSettings } from './lib/paramCompatibility'
import { getEmbeddedRequesterId, getLocalClientRequesterId } from './lib/clientIdentity'
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate'

// ===== Image cache =====
// 鍐呭瓨缂撳瓨锛宨d 鈫?dataUrl锛岄伩鍏嶆瘡娆′粠 IndexedDB 璇诲彇

const imageCache = new Map<string, string>()
const openAIWatchdogTimers = new Map<string, ReturnType<typeof setTimeout>>()
let localTaskPollTimer: ReturnType<typeof setInterval> | null = null
let localTaskPollActive = false
const localTaskPollInFlight = new Set<string>()
const LOCAL_TASK_POLL_INTERVAL_MS = 1500
const LOCAL_TASK_POLL_MAX_PARALLEL = 6
const OPENAI_INTERRUPTED_ERROR = '璇锋眰涓柇'
const SUBMISSION_DEDUP_WINDOW_MS = 5 * 60_000
const submissionLocks = new Map<string, { taskId: string; idempotencyKey: string; expiresAt: number }>()

function createOpenAITimeoutError(timeoutSeconds: number) {
  return `请求超时：超过 ${timeoutSeconds} 秒仍未完成，请稍后重试或提高超时时间。`
}

export function getCurrentRequesterId() {
  return getEmbeddedRequesterId(useStore.getState().embeddedSub2Api.userId) || getLocalClientRequesterId()
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function hashText(value: string): string {
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    h1 ^= code
    h1 = Math.imul(h1, 0x01000193)
    h2 ^= code
    h2 = Math.imul(h2, 0x27d4eb2d)
  }
  return `${(h1 >>> 0).toString(16).padStart(8, '0')}${(h2 >>> 0).toString(16).padStart(8, '0')}`
}

function createSubmissionKey(input: {
  prompt: string
  params: TaskParams
  profile: ReturnType<typeof getRuntimeApiProfile>
  inputImageIds: string[]
  maskTargetImageId: string | null
  maskDataUrl?: string | null
}) {
  return hashText(stableStringify({
    prompt: input.prompt.trim(),
    params: input.params,
    model: input.profile.model,
    apiMode: input.profile.apiMode,
    apiKeyHash: hashText(input.profile.apiKey.trim()),
    inputImageIds: input.inputImageIds,
    maskTargetImageId: input.maskTargetImageId,
    maskHash: input.maskDataUrl ? hashText(input.maskDataUrl) : '',
  }))
}

function clearExpiredSubmissionLocks(now = Date.now()) {
  for (const [key, lock] of submissionLocks.entries()) {
    if (lock.expiresAt <= now) submissionLocks.delete(key)
  }
}

export function getCachedImage(id: string): string | undefined {
  return imageCache.get(id)
}

export async function ensureImageCached(id: string): Promise<string | undefined> {
  if (imageCache.has(id)) return imageCache.get(id)
  const rec = await getImage(id)
  if (rec) {
    imageCache.set(id, rec.dataUrl)
    return rec.dataUrl
  }
  return undefined
}

function orderImagesWithMaskFirst(images: InputImage[], maskTargetImageId: string | null | undefined) {
  if (!maskTargetImageId) return images
  const maskIdx = images.findIndex((img) => img.id === maskTargetImageId)
  if (maskIdx <= 0) return images
  const next = [...images]
  const [maskImage] = next.splice(maskIdx, 1)
  next.unshift(maskImage)
  return next
}

// ===== Store 绫诲瀷 =====

interface AppState {
  // 璁剧疆
  settings: AppSettings
  setSettings: (s: Partial<AppSettings>) => void
  dismissedCodexCliPrompts: string[]
  dismissCodexCliPrompt: (key: string) => void
  embeddedSub2Api: EmbeddedSub2ApiState
  setEmbeddedSub2Api: (state: EmbeddedSub2ApiState) => void

  // 杈撳叆
  prompt: string
  setPrompt: (p: string) => void
  inputImages: InputImage[]
  addInputImage: (img: InputImage) => void
  removeInputImage: (idx: number) => void
  clearInputImages: () => void
  setInputImages: (imgs: InputImage[]) => void
  moveInputImage: (fromIdx: number, toIdx: number) => void
  maskDraft: MaskDraft | null
  setMaskDraft: (draft: MaskDraft | null) => void
  clearMaskDraft: () => void
  maskEditorImageId: string | null
  setMaskEditorImageId: (id: string | null) => void

  // 鍙傛暟
  params: TaskParams
  setParams: (p: Partial<TaskParams>) => void

  // 浠诲姟鍒楄〃
  tasks: TaskRecord[]
  setTasks: (t: TaskRecord[]) => void

  // 鎼滅储鍜岀瓫閫?
  searchQuery: string
  setSearchQuery: (q: string) => void
  filterStatus: 'all' | 'running' | 'done' | 'error'
  setFilterStatus: (status: AppState['filterStatus']) => void
  filterFavorite: boolean
  setFilterFavorite: (f: boolean) => void

  // 澶氶€?
  selectedTaskIds: string[]
  setSelectedTaskIds: (ids: string[] | ((prev: string[]) => string[])) => void
  toggleTaskSelection: (id: string, force?: boolean) => void
  clearSelection: () => void

  // UI
  detailTaskId: string | null
  setDetailTaskId: (id: string | null) => void
  lightboxImageId: string | null
  lightboxImageList: string[]
  setLightboxImageId: (id: string | null, list?: string[]) => void
  showSettings: boolean
  setShowSettings: (v: boolean) => void

  // Toast
  toast: { message: string; type: 'info' | 'success' | 'error' } | null
  showToast: (message: string, type?: 'info' | 'success' | 'error') => void

  // Confirm dialog
  confirmDialog: {
    title: string
    message: string
    confirmText?: string
    showCancel?: boolean
    icon?: 'info'
    minConfirmDelayMs?: number
    messageAlign?: 'left' | 'center'
    tone?: 'danger' | 'warning'
    action: () => void
    cancelAction?: () => void
  } | null
  setConfirmDialog: (d: AppState['confirmDialog']) => void
}

export const useStore = create<AppState>()(
  persist(
    (set, get) => ({
      // Settings
      settings: { ...DEFAULT_SETTINGS },
      setSettings: (s) => set((st) => {
        const previous = normalizeSettings(st.settings)
        const settings = normalizeSettings({ ...previous, ...s })
        void dbPutSettings(settings).catch((error) => {
          console.error('Failed to persist settings to IndexedDB', error)
        })
        return { settings }
      }),
      dismissedCodexCliPrompts: [],
      dismissCodexCliPrompt: (key) => set((st) => ({
        dismissedCodexCliPrompts: st.dismissedCodexCliPrompts.includes(key)
          ? st.dismissedCodexCliPrompts
          : [...st.dismissedCodexCliPrompts, key],
      })),
      embeddedSub2Api: {
        active: false,
        origin: '',
        userId: null,
        loading: false,
        error: null,
        apiKeys: [],
      },
      setEmbeddedSub2Api: (embeddedSub2Api) => set({ embeddedSub2Api }),

      // Input
      prompt: '',
      setPrompt: (prompt) => set({ prompt }),
      inputImages: [],
      addInputImage: (img) =>
        set((s) => {
          if (s.inputImages.find((i) => i.id === img.id)) return s
          return { inputImages: [...s.inputImages, img] }
        }),
      removeInputImage: (idx) =>
        set((s) => {
          const removed = s.inputImages[idx]
          const shouldClearMask = removed?.id === s.maskDraft?.targetImageId
          return {
            inputImages: s.inputImages.filter((_, i) => i !== idx),
            ...(shouldClearMask ? { maskDraft: null, maskEditorImageId: null } : {}),
          }
        }),
      clearInputImages: () =>
        set((s) => {
          for (const img of s.inputImages) imageCache.delete(img.id)
          return { inputImages: [], maskDraft: null, maskEditorImageId: null }
        }),
      setInputImages: (imgs) =>
        set((s) => {
          const inputImages = orderImagesWithMaskFirst(imgs, s.maskDraft?.targetImageId)
          const shouldClearMask =
            Boolean(s.maskDraft) && !inputImages.some((img) => img.id === s.maskDraft?.targetImageId)
          return {
            inputImages,
            ...(shouldClearMask ? { maskDraft: null, maskEditorImageId: null } : {}),
          }
        }),
      moveInputImage: (fromIdx, toIdx) =>
        set((s) => {
          const images = [...s.inputImages]
          if (fromIdx < 0 || fromIdx >= images.length) return s
          const maskTargetImageId = s.maskDraft?.targetImageId
          if (maskTargetImageId && images[fromIdx]?.id === maskTargetImageId) return s
          const minTargetIdx = maskTargetImageId && images.some((img) => img.id === maskTargetImageId) ? 1 : 0
          const targetIdx = Math.max(minTargetIdx, Math.min(images.length, toIdx))
          const insertIdx = fromIdx < targetIdx ? targetIdx - 1 : targetIdx
          if (insertIdx === fromIdx) return s
          const [moved] = images.splice(fromIdx, 1)
          images.splice(insertIdx, 0, moved)
          return { inputImages: images }
        }),
      maskDraft: null,
      setMaskDraft: (maskDraft) =>
        set((s) => ({
          maskDraft,
          inputImages: orderImagesWithMaskFirst(s.inputImages, maskDraft?.targetImageId),
        })),
      clearMaskDraft: () => set({ maskDraft: null }),
      maskEditorImageId: null,
      setMaskEditorImageId: (maskEditorImageId) => set({ maskEditorImageId }),

      // Params
      params: { ...DEFAULT_PARAMS },
      setParams: (p) => set((s) => ({ params: { ...s.params, ...p } })),

      // Tasks
      tasks: [],
      setTasks: (tasks) => set({ tasks }),

      // Search & Filter
      searchQuery: '',
      setSearchQuery: (searchQuery) => set({ searchQuery }),
      filterStatus: 'all',
      setFilterStatus: (filterStatus) => set({ filterStatus }),
      filterFavorite: false,
      setFilterFavorite: (filterFavorite) => set({ filterFavorite }),

      // Selection
      selectedTaskIds: [],
      setSelectedTaskIds: (updater) => set((s) => ({
        selectedTaskIds: typeof updater === 'function' ? updater(s.selectedTaskIds) : updater
      })),
      toggleTaskSelection: (id, force) => set((s) => {
        const isSelected = s.selectedTaskIds.includes(id)
        const shouldSelect = force !== undefined ? force : !isSelected
        if (shouldSelect === isSelected) return s
        return {
          selectedTaskIds: shouldSelect
            ? [...s.selectedTaskIds, id]
            : s.selectedTaskIds.filter((x) => x !== id)
        }
      }),
      clearSelection: () => set({ selectedTaskIds: [] }),

      // UI
      detailTaskId: null,
      setDetailTaskId: (detailTaskId) => set({ detailTaskId }),
      lightboxImageId: null,
      lightboxImageList: [],
      setLightboxImageId: (lightboxImageId, list) =>
        set({ lightboxImageId, lightboxImageList: list ?? (lightboxImageId ? [lightboxImageId] : []) }),
      showSettings: false,
      setShowSettings: (showSettings) => set({ showSettings }),

      // Toast
      toast: null,
      showToast: (message, type = 'info') => {
        set({ toast: { message, type } })
        setTimeout(() => {
          set((s) => (s.toast?.message === message ? { toast: null } : s))
        }, 3000)
      },

      // Confirm
      confirmDialog: null,
      setConfirmDialog: (confirmDialog) => set({ confirmDialog }),
    }),
    {
      name: 'gpt-image-playground',
      merge: (persisted, current) => {
        const persistedState = persisted as Partial<AppState> | null
        if (!persistedState) return current
        const { settings: _ignoredSettings, ...rest } = persistedState
        return {
          ...current,
          ...rest,
          settings: current.settings,
        }
      },
      partialize: (state) => ({
        params: state.params,
        prompt: state.prompt,
        inputImages: state.inputImages.map((img) => ({ id: img.id, dataUrl: '' })),
        dismissedCodexCliPrompts: state.dismissedCodexCliPrompts,
      }),
    },
  ),
)

// ===== Actions =====

let uid = 0
function genId(): string {
  return Date.now().toString(36) + (++uid).toString(36) + Math.random().toString(36).slice(2, 6)
}

export function getCodexCliPromptKey(settings: AppSettings): string {
  return settings.apiKey
}

function isOpenAITask(task: TaskRecord) {
  void task
  return true
}

function isRunningOpenAITask(task: TaskRecord) {
  return task.status === 'running' && isOpenAITask(task)
}

export function markInterruptedOpenAIRunningTasks(tasks: TaskRecord[], now = Date.now()) {
  const interruptedTasks: TaskRecord[] = []
  const updatedTasks = tasks.map((task) => {
    if (!isRunningOpenAITask(task) || task.backendTaskId) return task

    const updated: TaskRecord = {
      ...task,
      status: 'error',
      error: OPENAI_INTERRUPTED_ERROR,
      finishedAt: now,
      elapsed: Math.max(0, now - task.createdAt),
    }
    interruptedTasks.push(updated)
    return updated
  })

  return { tasks: updatedTasks, interruptedTasks }
}

function clearOpenAIWatchdogTimer(taskId: string) {
  const timer = openAIWatchdogTimers.get(taskId)
  if (timer) clearTimeout(timer)
  openAIWatchdogTimers.delete(taskId)
}

function hasRunningLocalBackendTasks() {
  return useStore.getState().tasks.some((task) => task.status === 'running' && Boolean(task.backendTaskId))
}

function stopLocalTaskPollerIfIdle() {
  if (!localTaskPollTimer || hasRunningLocalBackendTasks() || localTaskPollInFlight.size > 0) return
  clearInterval(localTaskPollTimer)
  localTaskPollTimer = null
}

function clearLocalTaskPollTimer(taskId?: string) {
  if (taskId) localTaskPollInFlight.delete(taskId)
  stopLocalTaskPollerIfIdle()
}

function backendTaskPatch(remoteTask: ImageTask): Partial<TaskRecord> {
  return {
    backendStatus: remoteTask.status,
    backendQueuePosition: remoteTask.queuePosition,
    backendQueuePositions: remoteTask.queuePositions ?? null,
    backendRetryCount: remoteTask.retryCount ?? null,
    backendMaxRetries: remoteTask.maxRetries ?? null,
    backendErrorCode: remoteTask.errorCode ?? null,
    backendErrorCategory: remoteTask.errorCategory ?? null,
    backendQueuedAt: remoteTask.queuedAt ?? null,
    backendAvailableAt: remoteTask.availableAt ?? null,
    backendStartedAt: remoteTask.startedAt ?? null,
    backendFinishedAt: remoteTask.finishedAt ?? null,
    backendPhase: remoteTask.phase ?? null,
    backendPhaseStartedAt: remoteTask.phaseStartedAt ?? null,
    backendQueuedMs: remoteTask.queuedMs ?? null,
    backendRunningMs: remoteTask.runningMs ?? null,
    backendTotalMs: remoteTask.totalMs ?? null,
    backendPayloadTtlSeconds: remoteTask.payloadTtlSeconds ?? null,
    backendResultTtlSeconds: remoteTask.resultTtlSeconds ?? null,
  }
}

function failOpenAITaskIfStillRunning(taskId: string, error: string, now = Date.now()) {
  const task = useStore.getState().tasks.find((item) => item.id === taskId)
  if (!task || !isRunningOpenAITask(task)) return false

  updateTaskInStore(taskId, {
    status: 'error',
    error,
    finishedAt: now,
    elapsed: Math.max(0, now - task.createdAt),
  })
  return true
}

function scheduleOpenAIWatchdog(taskId: string, timeoutSeconds: number) {
  clearOpenAIWatchdogTimer(taskId)
  const task = useStore.getState().tasks.find((item) => item.id === taskId)
  if (!task || !isRunningOpenAITask(task)) return

  const timeoutMs = Math.max(0, timeoutSeconds * 1000)
  const remainingMs = Math.max(0, timeoutMs - (Date.now() - task.createdAt))
  const timer = setTimeout(() => {
    openAIWatchdogTimers.delete(taskId)
    const failed = failOpenAITaskIfStillRunning(taskId, createOpenAITimeoutError(timeoutSeconds))
    if (failed) useStore.getState().showToast('OpenAI 浠诲姟璇锋眰瓒呮椂', 'error')
  }, remainingMs)
  openAIWatchdogTimers.set(taskId, timer)
}

export function showCodexCliPrompt(force = false, reason = '鎺ュ彛杩斿洖鐨勬彁绀鸿瘝宸茶鏀瑰啓') {
  const state = useStore.getState()
  const settings = state.settings
  const promptKey = getCodexCliPromptKey(settings)
  if (!force && (settings.codexCli || state.dismissedCodexCliPrompts.includes(promptKey))) return

  state.setConfirmDialog({
    title: '检测到 Codex CLI API',
    message: `${reason}，当前 API 来源很可能是 Codex CLI。\n\n是否开启 Codex CLI 兼容模式？开启后会禁用在此处无效的质量参数，并在 Images API 多图生成时使用并发请求，解决该 API 数量参数无效的问题。同时，提示词文本开头会加入简短的不改写要求，避免模型重写提示词，偏离原意。`,
    confirmText: '开启',
    action: () => {
      const state = useStore.getState()
      state.dismissCodexCliPrompt(promptKey)
      state.setSettings({ codexCli: true })
    },
    cancelAction: () => useStore.getState().dismissCodexCliPrompt(promptKey),
  })
}

async function applyLocalBackendTaskState(taskId: string) {
  const localTask = useStore.getState().tasks.find((item) => item.id === taskId)
  if (!localTask?.backendTaskId) {
    clearLocalTaskPollTimer(taskId)
    return
  }

  // Ignore stale poll ticks after a task has already settled locally.
  if (localTask.status !== 'running') {
    clearLocalTaskPollTimer(taskId)
    return
  }

  const remoteTask = await getImageTask(localTask.backendTaskId, getCurrentRequesterId(), localTask.outputImages.length === 0)
  if (remoteTask.status === 'queued' || remoteTask.status === 'running') {
    updateTaskInStore(taskId, {
      ...backendTaskPatch(remoteTask),
      status: 'running',
      error: null,
      finishedAt: null,
      elapsed: null,
    })
    return
  }

  if (remoteTask.status === 'succeeded' && remoteTask.result?.images?.length) {
    const outputIds: string[] = []
    for (const dataUrl of remoteTask.result.images) {
      const imgId = await storeImage(dataUrl, 'generated')
      imageCache.set(imgId, dataUrl)
      outputIds.push(imgId)
    }

    const actualParamsByImage = remoteTask.result.actualParamsList?.reduce<Record<string, Partial<TaskParams>>>((acc, params, index) => {
      const imgId = outputIds[index]
      if (imgId && params && Object.keys(params).length > 0) acc[imgId] = params
      return acc
    }, {})
    const revisedPromptByImage = remoteTask.result.revisedPrompts?.reduce<Record<string, string>>((acc, revisedPrompt, index) => {
      const imgId = outputIds[index]
      if (imgId && revisedPrompt && revisedPrompt.trim()) acc[imgId] = revisedPrompt
      return acc
    }, {})

    updateTaskInStore(taskId, {
      ...backendTaskPatch(remoteTask),
      status: 'done',
      backendQueuePosition: null,
      outputImages: outputIds,
      actualParams: remoteTask.result.actualParams ? { ...remoteTask.result.actualParams, n: outputIds.length } : undefined,
      actualParamsByImage: actualParamsByImage && Object.keys(actualParamsByImage).length > 0 ? actualParamsByImage : undefined,
      revisedPromptByImage: revisedPromptByImage && Object.keys(revisedPromptByImage).length > 0 ? revisedPromptByImage : undefined,
      error: null,
      finishedAt: remoteTask.finishedAt ?? Date.now(),
      elapsed: remoteTask.finishedAt ? Math.max(0, remoteTask.finishedAt - localTask.createdAt) : null,
    })
    clearLocalTaskPollTimer(taskId)
    useStore.getState().showToast(`生成完成，共 ${outputIds.length} 张图片`, 'success')
    return
  }

  updateTaskInStore(taskId, {
    ...backendTaskPatch(remoteTask),
    status: 'error',
    backendQueuePosition: null,
    error: remoteTask.status === 'succeeded'
      ? '浠诲姟缁撴灉鍥剧墖宸茶繃鏈燂紝璇蜂粠鏈湴璁板綍閲嶈瘯鐢熸垚'
      : remoteTask.error || '鏈湴浠诲姟鎵ц澶辫触',
    finishedAt: remoteTask.finishedAt ?? Date.now(),
    elapsed: remoteTask.finishedAt ? Math.max(0, remoteTask.finishedAt - localTask.createdAt) : null,
  })
  clearLocalTaskPollTimer(taskId)
}

async function pollRunningLocalBackendTasks() {
  if (localTaskPollActive) return
  localTaskPollActive = true
  try {
    const candidates = useStore
      .getState()
      .tasks
      .filter((task) => task.status === 'running' && task.backendTaskId && !localTaskPollInFlight.has(task.id))
      .slice(0, Math.max(1, LOCAL_TASK_POLL_MAX_PARALLEL - localTaskPollInFlight.size))

    await Promise.all(candidates.map(async (task) => {
      localTaskPollInFlight.add(task.id)
      try {
        await applyLocalBackendTaskState(task.id)
      } catch (error) {
        updateTaskInStore(task.id, {
          status: 'error',
          error: error instanceof Error ? error.message : String(error),
          finishedAt: Date.now(),
        })
      } finally {
        localTaskPollInFlight.delete(task.id)
      }
    }))
  } finally {
    localTaskPollActive = false
    stopLocalTaskPollerIfIdle()
  }
}

function scheduleLocalTaskPoll(_taskId?: string, delayMs = 0) {
  if (!localTaskPollTimer) {
    localTaskPollTimer = setInterval(() => {
      void pollRunningLocalBackendTasks()
    }, LOCAL_TASK_POLL_INTERVAL_MS)
  }
  if (delayMs <= 0) {
    void pollRunningLocalBackendTasks()
  } else {
    window.setTimeout(() => void pollRunningLocalBackendTasks(), delayMs)
  }
}

export function ensureLocalBackendTaskPoll(taskId: string, delayMs = 0) {
  const task = useStore.getState().tasks.find((item) => item.id === taskId)
  if (!task?.backendTaskId || task.status !== 'running') return
  scheduleLocalTaskPoll(taskId, delayMs)
}

async function executeTaskViaLocalBackend(taskId: string) {
  const state = useStore.getState()
  const task = state.tasks.find((item) => item.id === taskId)
  if (!task) return
  const activeProfile = getRuntimeApiProfile(state.settings)
  const inputImageDataUrls: string[] = []
  for (const imgId of task.inputImageIds) {
    const dataUrl = await ensureImageCached(imgId)
    if (!dataUrl) throw new Error('杈撳叆鍥剧墖宸蹭笉瀛樺湪')
    inputImageDataUrls.push(dataUrl)
  }
  const maskDataUrl = task.maskImageId ? await ensureImageCached(task.maskImageId) : undefined
  const remoteTask = await createImageTask({
    requesterId: getCurrentRequesterId(),
    prompt: task.prompt,
    params: task.params,
    profile: activeProfile,
    inputImageDataUrls,
    maskDataUrl: maskDataUrl || undefined,
  }, task.backendIdempotencyKey ?? taskId)

  updateTaskInStore(taskId, {
    ...backendTaskPatch(remoteTask),
    backendTaskId: remoteTask.id,
    status: 'running',
    error: null,
  })
  scheduleLocalTaskPoll(taskId, 300)
}

export async function cancelBackendTask(task: TaskRecord) {
  if (!task.backendTaskId || task.status !== 'running') return
  try {
    const remoteTask = await cancelImageTask(task.backendTaskId, getCurrentRequesterId())
    updateTaskInStore(task.id, {
      ...backendTaskPatch(remoteTask),
      status: 'error',
      backendQueuePosition: null,
      backendErrorCode: remoteTask.errorCode ?? 'USER_CANCELED',
      error: remoteTask.error || '任务已取消',
      finishedAt: remoteTask.finishedAt ?? Date.now(),
      elapsed: Math.max(0, (remoteTask.finishedAt ?? Date.now()) - task.createdAt),
    })
    clearLocalTaskPollTimer(task.id)
    useStore.getState().showToast('任务已取消', 'success')
  } catch (error) {
    useStore.getState().showToast(error instanceof Error ? error.message : String(error), 'error')
  }
}

/** 鍒濆鍖栵細浠?IndexedDB 鍔犺浇浠诲姟鍜屽浘鐗囩紦瀛橈紝娓呯悊瀛ょ珛鍥剧墖 */
export async function initStore() {
  const storedSettings = await dbGetSettings()
  if (storedSettings) {
    useStore.getState().setSettings(storedSettings)
  } else {
    await dbPutSettings(useStore.getState().settings)
  }

  const storedTasks = await getAllTasks()
  const { tasks, interruptedTasks } = markInterruptedOpenAIRunningTasks(storedTasks)
  await Promise.all(interruptedTasks.map((task) => putTask(task)))
  useStore.getState().setTasks(tasks)
  for (const task of tasks) {
    if (task.backendTaskId && task.status === 'running') {
      scheduleLocalTaskPoll(task.id, 0)
    }
  }

  // 鏀堕泦鎵€鏈変换鍔″紩鐢ㄧ殑鍥剧墖 id
  const referencedIds = new Set<string>()
  const persistedInputImages = useStore.getState().inputImages
  for (const img of persistedInputImages) referencedIds.add(img.id)
  for (const t of tasks) {
    for (const id of t.inputImageIds || []) referencedIds.add(id)
    if (t.maskImageId) referencedIds.add(t.maskImageId)
    for (const id of t.outputImages || []) {
      referencedIds.add(id)
    }
  }

  // 棰勫姞杞芥墍鏈夊浘鐗囧埌缂撳瓨锛屽悓鏃舵竻鐞嗗绔嬪浘鐗?
  const images = await getAllImages()
  const imageById = new Map(images.map((img) => [img.id, img]))
  for (const img of images) {
    if (referencedIds.has(img.id)) {
      imageCache.set(img.id, img.dataUrl)
    } else {
      await deleteImage(img.id)
    }
  }
  const restoredInputImages = persistedInputImages
    .map((img) => ({ ...img, dataUrl: img.dataUrl || imageById.get(img.id)?.dataUrl || '' }))
    .filter((img) => img.dataUrl)
  if (restoredInputImages.length !== persistedInputImages.length || restoredInputImages.some((img, index) => img.dataUrl !== persistedInputImages[index]?.dataUrl)) {
    useStore.getState().setInputImages(restoredInputImages)
  }
}

/** 鎻愪氦鏂颁换鍔?*/
export async function submitTask(options: { allowFullMask?: boolean } = {}) {
  const { settings, prompt, inputImages, maskDraft, params, showToast, setConfirmDialog } =
    useStore.getState()

  const activeProfile = getRuntimeApiProfile(settings)
  const settingsError = validateSettings(settings)
  if (settingsError) {
    showToast(`请先完善设置：${settingsError}`, 'error')
    useStore.getState().setShowSettings(true)
    return
  }

  if (!prompt.trim()) {
    showToast('璇疯緭鍏ユ彁绀鸿瘝', 'error')
    return
  }

  const normalizedParams = normalizeParamsForSettings(params, settings)
  let orderedInputImages = inputImages
  let maskImageId: string | null = null
  let maskTargetImageId: string | null = null

  if (maskDraft) {
    try {
      orderedInputImages = orderInputImagesForMask(inputImages, maskDraft.targetImageId)
      const coverage = await validateMaskMatchesImage(maskDraft.maskDataUrl, orderedInputImages[0].dataUrl)
      if (coverage === 'full' && !options.allowFullMask) {
        setConfirmDialog({
          title: '确认编辑整张图片？',
          message: '当前遮罩覆盖了整张图片，提交后可能会重绘全部内容。是否继续？',
          confirmText: '继续提交',
          tone: 'warning',
          action: () => {
            void submitTask({ allowFullMask: true })
          },
        })
        return
      }
      maskImageId = await storeImage(maskDraft.maskDataUrl, 'mask')
      imageCache.set(maskImageId, maskDraft.maskDataUrl)
      maskTargetImageId = maskDraft.targetImageId
    } catch (err) {
      if (!inputImages.some((img) => img.id === maskDraft.targetImageId)) {
        useStore.getState().clearMaskDraft()
      }
      showToast(err instanceof Error ? err.message : String(err), 'error')
      return
    }
  }

  const submissionKey = createSubmissionKey({
    prompt,
    params: normalizedParams,
    profile: activeProfile,
    inputImageIds: orderedInputImages.map((image) => image.id),
    maskTargetImageId,
    maskDataUrl: maskDraft?.maskDataUrl ?? null,
  })
  const now = Date.now()
  clearExpiredSubmissionLocks(now)
  const lockedSubmission = submissionLocks.get(submissionKey)
  if (lockedSubmission) {
    useStore.getState().setDetailTaskId(lockedSubmission.taskId)
    showToast('鐩稿悓浠诲姟姝ｅ湪鎻愪氦涓紝宸蹭负浣犲畾浣嶅埌宸叉湁浠诲姟', 'info')
    return
  }
  const runningDuplicate = useStore.getState().tasks.find((task) =>
    task.status === 'running' &&
    task.submissionKey === submissionKey &&
    now - task.createdAt < SUBMISSION_DEDUP_WINDOW_MS
  )
  if (runningDuplicate) {
    useStore.getState().setDetailTaskId(runningDuplicate.id)
    showToast('鐩稿悓浠诲姟浠嶅湪杩愯涓紝宸蹭负浣犲畾浣嶅埌宸叉湁浠诲姟', 'info')
    return
  }

  const taskId = genId()
  const submissionWindow = Math.floor(now / SUBMISSION_DEDUP_WINDOW_MS)
  const backendIdempotencyKey = `image-studio-${submissionKey}-${submissionWindow}`
  submissionLocks.set(submissionKey, {
    taskId,
    idempotencyKey: backendIdempotencyKey,
    expiresAt: now + SUBMISSION_DEDUP_WINDOW_MS,
  })

  // 持久化输入图片到 IndexedDB。
  for (const img of orderedInputImages) {
    await storeImage(img.dataUrl)
  }

  const normalizedParamPatch = getChangedParams(params, normalizedParams)
  if (Object.keys(normalizedParamPatch).length) {
    useStore.getState().setParams(normalizedParamPatch)
  }

  const task: TaskRecord = {
    id: taskId,
    submissionKey,
    backendIdempotencyKey,
    prompt: prompt.trim(),
    params: normalizedParams,
    apiModel: activeProfile.model,
    inputImageIds: orderedInputImages.map((i) => i.id),
    maskTargetImageId,
    maskImageId,
    outputImages: [],
    status: 'running',
    error: null,
    createdAt: Date.now(),
    finishedAt: null,
    elapsed: null,
  }

  const latestTasks = useStore.getState().tasks
  useStore.getState().setTasks([task, ...latestTasks])
  await putTask(task)

  if (settings.clearInputAfterSubmit) {
    useStore.getState().setPrompt('')
    useStore.getState().clearInputImages()
  }
  await executeTaskViaLocalBackend(taskId)
}

export function updateTaskInStore(taskId: string, patch: Partial<TaskRecord>) {
  const { tasks, setTasks } = useStore.getState()
  const updated = tasks.map((t) =>
    t.id === taskId ? { ...t, ...patch } : t,
  )
  setTasks(updated)
  const task = updated.find((t) => t.id === taskId)
  if (task) {
    if (task.submissionKey && task.status !== 'running') {
      const lock = submissionLocks.get(task.submissionKey)
      if (lock?.taskId === task.id) submissionLocks.delete(task.submissionKey)
    }
    putTask(task)
  }
}

async function retryExistingBackendTask(task: TaskRecord) {
  if (!task.backendTaskId) return false
  try {
    const remoteTask = await retryImageTask(task.backendTaskId, getCurrentRequesterId())
    updateTaskInStore(task.id, {
      ...backendTaskPatch(remoteTask),
      status: 'running',
      outputImages: [],
      actualParams: undefined,
      actualParamsByImage: undefined,
      revisedPromptByImage: undefined,
      error: null,
      finishedAt: null,
      elapsed: null,
    })
    scheduleLocalTaskPoll(task.id, 300)
    useStore.getState().showToast('任务已重新排队', 'success')
    return true
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!/expired|杩囨湡|PAYLOAD_EXPIRED/i.test(message)) {
      useStore.getState().showToast(message, 'error')
      return true
    }
    return false
  }
}

/** 閲嶈瘯澶辫触鐨勪换鍔★細浼樺厛澶嶇敤鍚庣浠诲姟锛宲ayload 杩囨湡鍚庡垱寤烘柊浠诲姟 */
export async function retryTask(task: TaskRecord) {
  if (await retryExistingBackendTask(task)) return

  const { settings } = useStore.getState()
  const activeProfile = getRuntimeApiProfile(settings)
  const normalizedParams = normalizeParamsForSettings(task.params, settings)
  const taskId = genId()
  const newTask: TaskRecord = {
    id: taskId,
    prompt: task.prompt,
    params: normalizedParams,
    apiModel: activeProfile.model,
    inputImageIds: [...task.inputImageIds],
    maskTargetImageId: task.maskTargetImageId ?? null,
    maskImageId: task.maskImageId ?? null,
    outputImages: [],
    status: 'running',
    error: null,
    createdAt: Date.now(),
    finishedAt: null,
    elapsed: null,
  }

  const latestTasks = useStore.getState().tasks
  useStore.getState().setTasks([newTask, ...latestTasks])
  await putTask(newTask)

  await executeTaskViaLocalBackend(taskId)
}

/** 澶嶇敤閰嶇疆 */
export async function reuseConfig(task: TaskRecord) {
  const { settings, setPrompt, setParams, setInputImages, setMaskDraft, clearMaskDraft, showToast } = useStore.getState()
  setPrompt(task.prompt)
  setParams(normalizeParamsForSettings(task.params, settings))

  // 鎭㈠杈撳叆鍥剧墖
  const imgs: InputImage[] = []
  for (const imgId of task.inputImageIds) {
    const dataUrl = await ensureImageCached(imgId)
    if (dataUrl) {
      imgs.push({ id: imgId, dataUrl })
    }
  }
  setInputImages(imgs)
  const maskTargetImageId = task.maskTargetImageId ?? (task.maskImageId ? task.inputImageIds[0] : null)
  if (maskTargetImageId && task.maskImageId && imgs.some((img) => img.id === maskTargetImageId)) {
    const maskDataUrl = await ensureImageCached(task.maskImageId)
    if (maskDataUrl) {
      setMaskDraft({
        targetImageId: maskTargetImageId,
        maskDataUrl,
        updatedAt: Date.now(),
      })
    } else {
      clearMaskDraft()
    }
  } else {
    clearMaskDraft()
  }
  showToast('已复用配置到输入框', 'success')
}

/** 缂栬緫杈撳嚭锛氬皢杈撳嚭鍥惧姞鍏ヨ緭鍏?*/
export async function editOutputs(task: TaskRecord) {
  const { inputImages, addInputImage, showToast } = useStore.getState()
  if (!task.outputImages?.length) return

  let added = 0
  for (const imgId of task.outputImages) {
    if (inputImages.find((i) => i.id === imgId)) continue
    const dataUrl = await ensureImageCached(imgId)
    if (dataUrl) {
      addInputImage({ id: imgId, dataUrl })
      added++
    }
  }
  showToast(`已添加 ${added} 张输出图到输入`, 'success')
}

/** 鍒犻櫎澶氭潯浠诲姟 */
export async function removeMultipleTasks(taskIds: string[]) {
  const { tasks, setTasks, inputImages, showToast, clearSelection, selectedTaskIds } = useStore.getState()
  
  if (!taskIds.length) return
  for (const id of taskIds) clearLocalTaskPollTimer(id)

  const toDelete = new Set(taskIds)
  const remaining = tasks.filter(t => !toDelete.has(t.id))

  // 鏀堕泦鎵€鏈夎鍒犻櫎浠诲姟鐨勫叧鑱斿浘鐗?
  const deletedImageIds = new Set<string>()
  for (const t of tasks) {
    if (toDelete.has(t.id)) {
      for (const id of t.inputImageIds || []) deletedImageIds.add(id)
      if (t.maskImageId) deletedImageIds.add(t.maskImageId)
      for (const id of t.outputImages || []) deletedImageIds.add(id)
    }
  }

  setTasks(remaining)
  for (const id of taskIds) {
    await dbDeleteTask(id)
  }

  // 鎵惧嚭鍏朵粬浠诲姟浠嶅紩鐢ㄧ殑鍥剧墖
  const stillUsed = new Set<string>()
  for (const t of remaining) {
    for (const id of t.inputImageIds || []) stillUsed.add(id)
    if (t.maskImageId) stillUsed.add(t.maskImageId)
    for (const id of t.outputImages || []) stillUsed.add(id)
  }
  for (const img of inputImages) stillUsed.add(img.id)

  // 鍒犻櫎瀛ょ珛鍥剧墖
  for (const imgId of deletedImageIds) {
    if (!stillUsed.has(imgId)) {
      await deleteImage(imgId)
      imageCache.delete(imgId)
    }
  }

  // 濡傛灉鍒犻櫎鐨勪换鍔″湪閫変腑鍒楄〃涓紝鍒欑Щ闄?
  const newSelection = selectedTaskIds.filter(id => !toDelete.has(id))
  if (newSelection.length !== selectedTaskIds.length) {
    useStore.getState().setSelectedTaskIds(newSelection)
  }

  showToast(`已删除 ${taskIds.length} 条记录`, 'success')
}

/** 鍒犻櫎鍗曟潯浠诲姟 */
export async function removeTask(task: TaskRecord) {
  const { tasks, setTasks, inputImages, showToast } = useStore.getState()

  clearLocalTaskPollTimer(task.id)
  // 鏀堕泦姝や换鍔″叧鑱旂殑鍥剧墖
  const taskImageIds = new Set([
    ...(task.inputImageIds || []),
    ...(task.maskImageId ? [task.maskImageId] : []),
    ...(task.outputImages || []),
  ])

  // 浠庡垪琛ㄧЩ闄?
  const remaining = tasks.filter((t) => t.id !== task.id)
  setTasks(remaining)
  await dbDeleteTask(task.id)

  // 鎵惧嚭鍏朵粬浠诲姟浠嶅紩鐢ㄧ殑鍥剧墖
  const stillUsed = new Set<string>()
  for (const t of remaining) {
    for (const id of t.inputImageIds || []) stillUsed.add(id)
    if (t.maskImageId) stillUsed.add(t.maskImageId)
    for (const id of t.outputImages || []) stillUsed.add(id)
  }
  for (const img of inputImages) stillUsed.add(img.id)

  // 鍒犻櫎瀛ょ珛鍥剧墖
  for (const imgId of taskImageIds) {
    if (!stillUsed.has(imgId)) {
      await deleteImage(imgId)
      imageCache.delete(imgId)
    }
  }

  showToast('记录已删除', 'success')
}

/** 娓呯┖鎵€鏈夋暟鎹紙鍚厤缃噸缃級 */
export async function clearAllData() {
  await dbClearTasks()
  await clearImages()
  imageCache.clear()
  if (localTaskPollTimer) {
    clearInterval(localTaskPollTimer)
    localTaskPollTimer = null
  }
  localTaskPollInFlight.clear()
  const { setTasks, clearInputImages, clearMaskDraft, setSettings, setParams, showToast } = useStore.getState()
  setTasks([])
  clearInputImages()
  useStore.setState({ dismissedCodexCliPrompts: [] })
  clearMaskDraft()
  setSettings({ ...DEFAULT_SETTINGS })
  setParams({ ...DEFAULT_PARAMS })
  showToast('所有数据已清空', 'success')
}

/** 浠?dataUrl 瑙ｆ瀽鍑?MIME 鎵╁睍鍚嶅拰浜岃繘鍒舵暟鎹?*/
function dataUrlToBytes(dataUrl: string): { ext: string; bytes: Uint8Array } {
  const match = dataUrl.match(/^data:image\/(\w+);base64,/)
  const ext = match?.[1] ?? 'png'
  const b64 = dataUrl.replace(/^data:[^;]+;base64,/, '')
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return { ext, bytes }
}

/** 灏嗕簩杩涘埗鏁版嵁杩樺師涓?dataUrl */
function bytesToDataUrl(bytes: Uint8Array, filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? 'png'
  const mimeMap: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' }
  const mime = mimeMap[ext] ?? 'image/png'
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return `data:${mime};base64,${btoa(binary)}`
}

/** 瀵煎嚭鏁版嵁涓?ZIP */
export async function exportData() {
  try {
    const tasks = await getAllTasks()
    const images = await getAllImages()
    const { settings } = useStore.getState()
    const exportedAt = Date.now()
    const imageCreatedAtFallback = new Map<string, number>()

    for (const task of tasks) {
      for (const id of [
        ...(task.inputImageIds || []),
        ...(task.maskImageId ? [task.maskImageId] : []),
        ...(task.outputImages || []),
      ]) {
        const prev = imageCreatedAtFallback.get(id)
        if (prev == null || task.createdAt < prev) {
          imageCreatedAtFallback.set(id, task.createdAt)
        }
      }
    }

    const imageFiles: ExportData['imageFiles'] = {}
    const zipFiles: Record<string, Uint8Array | [Uint8Array, { mtime: Date }]> = {}

    for (const img of images) {
      const { ext, bytes } = dataUrlToBytes(img.dataUrl)
      const path = `images/${img.id}.${ext}`
      const createdAt = img.createdAt ?? imageCreatedAtFallback.get(img.id) ?? exportedAt
      imageFiles[img.id] = { path, createdAt, source: img.source }
      zipFiles[path] = [bytes, { mtime: new Date(createdAt) }]
    }

    const manifest: ExportData = {
      version: 2,
      exportedAt: new Date(exportedAt).toISOString(),
      settings,
      tasks,
      imageFiles,
    }

    zipFiles['manifest.json'] = [strToU8(JSON.stringify(manifest, null, 2)), { mtime: new Date(exportedAt) }]

    const zipped = zipSync(zipFiles, { level: 6 })
    const blob = new Blob([zipped.buffer as ArrayBuffer], { type: 'application/zip' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `gpt-image-playground-${Date.now()}.zip`
    a.click()
    URL.revokeObjectURL(url)
    useStore.getState().showToast('数据已导出', 'success')
  } catch (e) {
    useStore
      .getState()
      .showToast(
        `导出失败：${e instanceof Error ? e.message : String(e)}`,
        'error',
      )
  }
}

/** 瀵煎叆 ZIP 鏁版嵁 */
export async function importData(file: File): Promise<boolean> {
  try {
    const buffer = await file.arrayBuffer()
    const unzipped = unzipSync(new Uint8Array(buffer))

    const manifestBytes = unzipped['manifest.json']
    if (!manifestBytes) throw new Error('ZIP 涓己灏?manifest.json')

    const data: ExportData = JSON.parse(strFromU8(manifestBytes))
    if (!data.tasks || !data.imageFiles) throw new Error('无效的数据格式')

    // 杩樺師鍥剧墖
    for (const [id, info] of Object.entries(data.imageFiles)) {
      const bytes = unzipped[info.path]
      if (!bytes) continue
      const dataUrl = bytesToDataUrl(bytes, info.path)
      await putImage({ id, dataUrl, createdAt: info.createdAt, source: info.source })
      imageCache.set(id, dataUrl)
    }

    for (const task of data.tasks) {
      await putTask(task)
    }

    if (data.settings) {
      const state = useStore.getState()
      state.setSettings(mergeImportedSettings(state.settings, data.settings))
    }

    const tasks = await getAllTasks()
    useStore.getState().setTasks(tasks)
    useStore
      .getState()
      .showToast(`已导入 ${data.tasks.length} 条记录`, 'success')
    return true
  } catch (e) {
    useStore
      .getState()
      .showToast(
        `导入失败：${e instanceof Error ? e.message : String(e)}`,
        'error',
      )
    return false
  }
}

/** 娣诲姞鍥剧墖鍒拌緭鍏ワ紙鏂囦欢涓婁紶锛?*/
export async function addImageFromFile(file: File): Promise<void> {
  if (!file.type.startsWith('image/')) return
  const dataUrl = await fileToDataUrl(file)
  const id = await storeImage(dataUrl, 'upload')
  imageCache.set(id, dataUrl)
  useStore.getState().addInputImage({ id, dataUrl })
}

/** 娣诲姞鍥剧墖鍒拌緭鍏ワ紙鍙抽敭鑿滃崟锛夆€斺€?鏀寔 data/blob/http URL */
export async function addImageFromUrl(src: string): Promise<void> {
  const res = await fetch(src)
  const blob = await res.blob()
  if (!blob.type.startsWith('image/')) throw new Error('不是有效的图片')
  const dataUrl = await blobToDataUrl(blob)
  const id = await storeImage(dataUrl, 'upload')
  imageCache.set(id, dataUrl)
  useStore.getState().addInputImage({ id, dataUrl })
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = reject
    reader.readAsDataURL(blob)
  })
}





