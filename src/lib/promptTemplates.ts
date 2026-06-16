export interface PromptTemplate {
  id: string
  source: string
  sourceExternalId: string
  title: string
  prompt: string
  summary: string
  category: string
  tags: string[]
  imageUrls: string[]
  author: string
  sourceUrl: string
  detailUrl: string
  featured: boolean
  raycast: boolean
  language: string
  sortOrder: number
  syncedAt: string
}

export interface PromptTemplateListResult {
  items: PromptTemplate[]
  total: number
  page: number
  pageSize: number
  categories: string[]
}

export interface FetchPromptTemplatesOptions {
  page?: number
  pageSize?: number
  q?: string
  category?: string
  ids?: string[]
}

type PromptPrimitive = string | number | boolean | null
type PromptValue = PromptPrimitive | PromptValue[] | { [key: string]: PromptValue }

const ARGUMENT_PATTERN = /\{argument\s+name=(?:\\?")([^"\\]+)(?:\\?")\s+default=(?:\\?")([\s\S]*?)(?:\\?")\}/g

function replaceArgumentDefaults(value: string) {
  return value.replace(ARGUMENT_PATTERN, (_, _name: string, defaultValue: string) => defaultValue)
}

function normalizeWhitespace(value: string) {
  return value.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

function stringifyPromptValue(value: PromptValue): string {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) {
    if (value.every((item) => item == null || ['string', 'number', 'boolean'].includes(typeof item))) {
      return value.map((item) => stringifyPromptValue(item)).filter(Boolean).join(', ')
    }
    return value.map((item, index) => `${index + 1}. ${stringifyPromptValue(item)}`).join('\n')
  }
  return Object.entries(value)
    .map(([key, item]) => `${key}: ${stringifyPromptValue(item)}`)
    .join('\n')
}

export function formatTemplatePrompt(prompt: string): string {
  const withDefaults = normalizeWhitespace(replaceArgumentDefaults(prompt))
  try {
    const parsed = JSON.parse(withDefaults) as PromptValue
    return normalizeWhitespace(stringifyPromptValue(parsed))
  } catch {
    return withDefaults
  }
}

export function getPromptCategoryLabel(category: string) {
  return category
}

export function promptTemplateImageURL(template: PromptTemplate, index = 0) {
  if (!template.imageUrls.length) return ''
  return `/api/prompt-templates/${encodeURIComponent(template.id)}/images/${index}`
}

type RawPromptTemplate = PromptTemplate & {
  imageUrl?: string
  image_url?: string
  image_urls?: string[]
}

function normalizeTemplate(template: RawPromptTemplate): PromptTemplate {
  const imageUrls = Array.isArray(template.imageUrls)
    ? template.imageUrls
    : Array.isArray(template.image_urls)
      ? template.image_urls
      : [template.imageUrl, template.image_url].filter((value): value is string => typeof value === 'string' && value.length > 0)
  return {
    ...template,
    prompt: formatTemplatePrompt(template.prompt || ''),
    tags: Array.isArray(template.tags) ? template.tags : [],
    imageUrls,
  }
}

export async function fetchPromptTemplates(options: FetchPromptTemplatesOptions = {}): Promise<PromptTemplateListResult> {
  const params = new URLSearchParams()
  params.set('page', String(options.page ?? 1))
  params.set('page_size', String(options.pageSize ?? 24))
  if (options.q?.trim()) params.set('q', options.q.trim())
  if (options.category?.trim()) params.set('category', options.category.trim())
  for (const id of options.ids ?? []) {
    if (id.trim()) params.append('ids', id.trim())
  }

  const response = await fetch(`/api/prompt-templates?${params.toString()}`)
  if (!response.ok) {
    throw new Error(`模板加载失败: HTTP ${response.status}`)
  }
  const result = (await response.json()) as PromptTemplateListResult & { items?: RawPromptTemplate[] }
  return {
    items: (result.items ?? []).map(normalizeTemplate),
    total: Number(result.total) || 0,
    page: Number(result.page) || 1,
    pageSize: Number(result.pageSize) || (options.pageSize ?? 24),
    categories: Array.isArray(result.categories) ? result.categories.filter(Boolean) : [],
  }
}
