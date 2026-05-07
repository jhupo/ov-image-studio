import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { copyTextToClipboard, getClipboardFailureMessage } from '../lib/clipboard'
import { fetchPromptTemplates, getPromptCategoryLabel, type PromptTemplate } from '../lib/promptTemplates'
import { useCloseOnEscape } from '../hooks/useCloseOnEscape'
import { useStore } from '../store'

interface PromptTemplatesModalProps {
  onClose: () => void
}

const ALL_CATEGORY = 'All'
const FAVORITES_CATEGORY = 'Favorites'
const RECENT_CATEGORY = 'Recent'
const FAVORITES_STORAGE_KEY = 'chaincloud.promptTemplateFavorites'
const RECENT_STORAGE_KEY = 'chaincloud.promptTemplateRecent'
const MAX_RECENT_TEMPLATES = 12

function readStoredIds(key: string) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || '[]')
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

export default function PromptTemplatesModal({ onClose }: PromptTemplatesModalProps) {
  const setPrompt = useStore((s) => s.setPrompt)
  const showToast = useStore((s) => s.showToast)
  const [templates, setTemplates] = useState<PromptTemplate[]>([])
  const [loading, setLoading] = useState(true)
  const [activeCategory, setActiveCategory] = useState(ALL_CATEGORY)
  const [searchQuery, setSearchQuery] = useState('')
  const [preview, setPreview] = useState<PromptTemplate | null>(null)
  const [favoriteIds, setFavoriteIds] = useState<string[]>(() => readStoredIds(FAVORITES_STORAGE_KEY))
  const [recentIds, setRecentIds] = useState<string[]>(() => readStoredIds(RECENT_STORAGE_KEY))

  useCloseOnEscape(true, () => {
    if (preview) {
      setPreview(null)
      return
    }
    onClose()
  })

  useEffect(() => {
    let cancelled = false
    void (async () => {
      setLoading(true)
      const nextTemplates = await fetchPromptTemplates()
      if (cancelled) return
      setTemplates(nextTemplates)
      setLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const categories = useMemo(() => {
    const unique = Array.from(new Set(templates.map((item) => item.category).filter(Boolean)))
    return [ALL_CATEGORY, FAVORITES_CATEGORY, RECENT_CATEGORY, ...unique]
  }, [templates])

  const visibleTemplates = useMemo(() => {
    const normalizedQuery = searchQuery.trim().toLowerCase()
    return templates.filter((item) => {
      if (activeCategory === FAVORITES_CATEGORY && !favoriteIds.includes(item.id)) return false
      if (activeCategory === RECENT_CATEGORY && !recentIds.includes(item.id)) return false
      if (![ALL_CATEGORY, FAVORITES_CATEGORY, RECENT_CATEGORY].includes(activeCategory) && item.category !== activeCategory) return false
      if (!normalizedQuery) return true
      return [item.title, item.summary, item.prompt, item.category, item.author]
        .join(' ')
        .toLowerCase()
        .includes(normalizedQuery)
    })
  }, [activeCategory, favoriteIds, recentIds, searchQuery, templates])

  const orderedVisibleTemplates = useMemo(() => {
    if (activeCategory !== RECENT_CATEGORY) return visibleTemplates
    const order = new Map(recentIds.map((id, index) => [id, index]))
    return [...visibleTemplates].sort((a, b) => (order.get(a.id) ?? 999) - (order.get(b.id) ?? 999))
  }, [activeCategory, recentIds, visibleTemplates])

  const rememberTemplate = (template: PromptTemplate) => {
    setRecentIds((prev) => {
      const next = [template.id, ...prev.filter((id) => id !== template.id)].slice(0, MAX_RECENT_TEMPLATES)
      localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(next))
      return next
    })
  }

  const useTemplate = (template: PromptTemplate) => {
    rememberTemplate(template)
    setPrompt(template.prompt)
    showToast('已填入提示词', 'success')
    onClose()
  }

  const toggleFavorite = (template: PromptTemplate) => {
    setFavoriteIds((prev) => {
      const next = prev.includes(template.id)
        ? prev.filter((id) => id !== template.id)
        : [template.id, ...prev]
      localStorage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify(next))
      return next
    })
  }

  const categoryLabel = (category: string) => {
    if (category === ALL_CATEGORY) return '全部'
    if (category === FAVORITES_CATEGORY) return '收藏'
    if (category === RECENT_CATEGORY) return '最近'
    return getPromptCategoryLabel(category)
  }

  const copyTemplate = async (template: PromptTemplate) => {
    try {
      await copyTextToClipboard(template.prompt)
      showToast('提示词已复制', 'success')
    } catch (err) {
      showToast(getClipboardFailureMessage('复制失败', err), 'error')
    }
  }

  const modal = (
    <div data-no-drag-select className="fixed inset-0 z-[72] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/45 backdrop-blur-sm animate-overlay-in" onClick={onClose} />
      <div className="relative z-10 flex h-[86vh] w-[min(1120px,calc(100vw-32px))] flex-col overflow-hidden rounded-2xl border border-white/50 bg-white/95 shadow-2xl ring-1 ring-black/5 animate-modal-in dark:border-white/[0.08] dark:bg-gray-900/95 dark:ring-white/10">
        <div className="flex shrink-0 items-center justify-between gap-4 border-b border-gray-200/70 px-6 py-5 dark:border-white/[0.08]">
          <h3 className="text-xl font-bold text-gray-900 dark:text-gray-100">提示词模板</h3>
          <button onClick={onClose} className="rounded-full p-1.5 text-gray-400 transition hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-white/[0.06] dark:hover:text-gray-100" aria-label="关闭">
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col px-6 pb-6">
          <div className="mb-4 flex shrink-0 flex-col gap-3">
            <div className="relative">
              <svg className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35M10.5 18a7.5 7.5 0 1 1 0-15 7.5 7.5 0 0 1 0 15z" />
              </svg>
              <input
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="搜索模板、作者、分类、提示词..."
                className="w-full rounded-xl border border-gray-200/70 bg-white/80 py-2.5 pl-10 pr-9 text-sm text-gray-700 outline-none transition placeholder:text-gray-400 focus:border-blue-400 focus:bg-white dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-gray-100 dark:placeholder:text-gray-500 dark:focus:border-blue-500/60 dark:focus:bg-white/[0.06]"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery('')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full p-1 text-gray-500 transition hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-white/[0.06] dark:hover:text-gray-200"
                  aria-label="清空搜索"
                >
                  <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              )}
            </div>
            <div className="flex gap-2 overflow-x-auto pb-1 custom-scrollbar">
            {categories.map((category) => (
              <button
                key={category}
                onClick={() => setActiveCategory(category)}
                className={`shrink-0 rounded px-4 py-2 text-sm font-semibold transition ${activeCategory === category ? 'bg-blue-500 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200 hover:text-gray-900 dark:bg-white/[0.04] dark:text-gray-300 dark:hover:bg-white/[0.08] dark:hover:text-gray-100'}`}
              >
                {categoryLabel(category)}
              </button>
            ))}
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto pr-1 custom-scrollbar">
            {loading ? (
              <div className="flex h-full min-h-[360px] items-center justify-center text-sm text-gray-500 dark:text-gray-400">正在加载模板...</div>
            ) : orderedVisibleTemplates.length ? (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {orderedVisibleTemplates.map((template) => (
                  <article key={template.id} className="group overflow-hidden rounded-lg border border-gray-200/70 bg-white/80 transition hover:border-blue-400/70 dark:border-white/[0.08] dark:bg-white/[0.03] dark:hover:border-blue-500/45">
                    <div className="relative aspect-[16/10] w-full overflow-hidden bg-gray-100 dark:bg-gray-900">
                    <button type="button" onClick={() => setPreview(template)} className="block h-full w-full text-left">
                      {template.imageUrl ? (
                        <img src={template.imageUrl} alt={template.title} loading="lazy" className="h-full w-full object-cover transition duration-300 group-hover:scale-[1.03]" />
                      ) : (
                        <div className="flex h-full w-full items-center justify-center bg-gray-100 text-sm font-semibold text-gray-500 dark:bg-gray-900">
                          GPT Image 2
                        </div>
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => toggleFavorite(template)}
                      className={`absolute right-2 top-2 rounded-full bg-black/50 p-1.5 backdrop-blur transition ${favoriteIds.includes(template.id) ? 'text-yellow-300' : 'text-white/70 hover:text-yellow-200'}`}
                      title={favoriteIds.includes(template.id) ? '取消收藏' : '收藏模板'}
                    >
                      <svg className="h-4 w-4" fill={favoriteIds.includes(template.id) ? 'currentColor' : 'none'} stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" />
                      </svg>
                    </button>
                    </div>
                    <div className="space-y-3 p-3">
                      <button type="button" onClick={() => setPreview(template)} className="line-clamp-1 text-left text-base font-bold text-gray-900 dark:text-gray-100" title={template.title}>
                        {template.title}
                      </button>
                      <p className="line-clamp-3 min-h-[60px] text-sm leading-5 text-gray-600 dark:text-gray-300">{template.summary}</p>
                      <div className="flex items-center justify-between gap-3 text-xs text-gray-500 dark:text-gray-500">
                        <span className="min-w-0 truncate">{template.author || template.category}</span>
                        <div className="flex shrink-0 items-center gap-3">
                          <button onClick={() => copyTemplate(template)} className="transition hover:text-gray-900 dark:hover:text-gray-100">复制</button>
                          <button onClick={() => useTemplate(template)} className="font-semibold text-blue-400 transition hover:text-blue-300">使用</button>
                        </div>
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <div className="flex h-full min-h-[360px] items-center justify-center text-sm text-gray-500 dark:text-gray-400">没有匹配的模板</div>
            )}
          </div>
        </div>

        {preview && (
          <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/76 p-5" onClick={() => setPreview(null)}>
            <div
              className="grid max-h-full w-full max-w-5xl overflow-hidden rounded-2xl border border-white/50 bg-white shadow-2xl ring-1 ring-black/5 dark:border-white/[0.1] dark:bg-gray-950 dark:ring-white/[0.08] lg:grid-cols-[minmax(0,1.35fr)_minmax(320px,0.65fr)]"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex min-h-[280px] items-center justify-center bg-gray-100 dark:bg-black lg:min-h-[620px]">
                {preview.imageUrl ? (
                  <img src={preview.imageUrl} alt={preview.title} className="max-h-[72vh] w-full object-contain" />
                ) : (
                  <div className="flex h-full min-h-[360px] w-full items-center justify-center bg-gray-100 px-8 text-center text-xl font-bold text-gray-500 dark:bg-gray-900 dark:text-gray-400">
                    {preview.title}
                  </div>
                )}
              </div>

              <aside className="flex min-h-0 flex-col border-t border-gray-200/70 bg-white dark:border-white/[0.08] dark:bg-gray-950 lg:border-l lg:border-t-0">
                <div className="flex shrink-0 items-start justify-between gap-4 border-b border-gray-200/70 p-5 dark:border-white/[0.08]">
                  <div className="min-w-0">
                    <div className="mb-2 flex flex-wrap items-center gap-2">
                      <span className="rounded bg-blue-500/15 px-2 py-1 text-xs font-semibold text-blue-300">{getPromptCategoryLabel(preview.category)}</span>
                      {preview.author && <span className="text-xs text-gray-500">{preview.author}</span>}
                    </div>
                    <h4 className="text-lg font-bold leading-snug text-gray-900 dark:text-gray-100">{preview.title}</h4>
                  </div>
                  <button
                    onClick={() => setPreview(null)}
                    className="rounded-full p-1.5 text-gray-500 transition hover:bg-gray-100 hover:text-gray-900 dark:hover:bg-white/[0.06] dark:hover:text-gray-100"
                    aria-label="关闭预览"
                  >
                    <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>

                <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5 custom-scrollbar">
                  <section>
                    <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">效果说明</div>
                    <p className="text-sm leading-6 text-gray-600 dark:text-gray-300">{preview.summary}</p>
                  </section>
                  <section>
                    <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">完整提示词</div>
                    <pre data-selectable-text className="box-border max-h-72 w-full max-w-full overflow-y-auto overflow-x-hidden whitespace-pre-wrap break-words rounded-xl border border-gray-200/70 bg-gray-50 p-3 text-sm leading-6 text-gray-700 custom-scrollbar [overflow-wrap:anywhere] dark:border-white/[0.08] dark:bg-white/[0.035] dark:text-gray-200">
                      {preview.prompt}
                    </pre>
                  </section>
                </div>

                <div className="flex shrink-0 items-center justify-end gap-3 border-t border-gray-200/70 p-4 dark:border-white/[0.08]">
                  <button
                    onClick={() => copyTemplate(preview)}
                    className="rounded-lg border border-gray-200/70 px-4 py-2 text-sm font-medium text-gray-600 transition hover:bg-gray-100 hover:text-gray-900 dark:border-white/[0.08] dark:text-gray-300 dark:hover:bg-white/[0.06] dark:hover:text-gray-100"
                  >
                    复制
                  </button>
                  <button
                    onClick={() => useTemplate(preview)}
                    className="rounded-lg bg-blue-500 px-5 py-2 text-sm font-bold text-white transition hover:bg-blue-400"
                  >
                    使用
                  </button>
                </div>
              </aside>
            </div>
          </div>
        )}
      </div>
    </div>
  )

  return createPortal(modal, document.body)
}

