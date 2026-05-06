export interface PromptTemplate {
  id: string
  title: string
  prompt: string
  summary: string
  category: string
  imageUrl: string
  author: string
}

export const PROMPT_TEMPLATE_SOURCE_URL =
  'https://raw.githubusercontent.com/gpt-image2/awesome-gptimage2-prompts/main/prompts.json'
const PROMPT_TEMPLATE_CONTENTS_URL =
  'https://api.github.com/repos/gpt-image2/awesome-gptimage2-prompts/contents/prompts.json?ref=main'

const FALLBACK_TEMPLATES: PromptTemplate[] = [
  {
    id: 'fallback-portrait',
    title: 'Convenience Store Neon Portrait',
    prompt:
      '35mm film photography with harsh convenience store fluorescent lighting mixed with colorful neon signs from outside, authentic film grain, high contrast, candid fashion portrait, cinematic street snapshot.',
    summary: '35mm film neon street portrait with cinematic color and authentic grain.',
    category: 'Portrait & Photography',
    imageUrl: '',
    author: '@BubbleBrain',
  },
  {
    id: 'fallback-poster',
    title: 'Cinematic Product Poster',
    prompt:
      'A premium cinematic product advertising poster, dramatic studio lighting, strong visual hierarchy, polished commercial photography, bold readable typography, clean composition.',
    summary: 'Premium cinematic product poster with polished commercial lighting.',
    category: 'Poster & Illustration',
    imageUrl: '',
    author: '@community',
  },
  {
    id: 'fallback-ui',
    title: 'Mobile App Mockup',
    prompt:
      'Create a polished mobile app interface mockup with realistic device framing, refined spacing, modern typography, crisp UI details, product-focused layout, high-end SaaS visual design.',
    summary: 'Polished mobile app UI mockup with device framing and modern spacing.',
    category: 'UI & Social Media Mockup',
    imageUrl: '',
    author: '@community',
  },
]

const CATEGORY_LABELS: Record<string, string> = {
  'Portrait & Photography': '人像摄影',
  'Poster & Illustration': '海报插画',
  'UI & Social Media Mockup': '界面与社媒',
  'Character Design': '角色设计',
  'Comparison & Community': '对比与社区',
  General: '通用模板',
}

export function getPromptCategoryLabel(category: string) {
  return CATEGORY_LABELS[category] ?? category
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function findString(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = readString(record[key])
    if (value) return value
  }
  return ''
}

function findCategory(record: Record<string, unknown>): string {
  const direct = findString(record, ['category', 'group', 'section', 'type', 'tag'])
  if (direct) return direct
  const tags = record.tags
  if (Array.isArray(tags)) {
    const first = tags.find((item) => typeof item === 'string' && item.trim())
    if (first) return first.trim()
  }

  const promptCategories = record.promptCategories
  if (Array.isArray(promptCategories)) {
    const first = promptCategories.find((item) => typeof item === 'string' && item.trim())
    if (first) return first.trim()
  }

  return inferCategory(record)
}

function inferCategory(record: Record<string, unknown>): string {
  const haystack = [
    findString(record, ['title', 'name']),
    findString(record, ['description', 'translatedDescription']),
    findString(record, ['content', 'translatedContent']),
  ].join(' ').toLowerCase()

  if (/portrait|photography|photo|headshot|street|fashion|film|camera|selfie|人物|写真|摄影|肖像/.test(haystack)) {
    return 'Portrait & Photography'
  }
  if (/ui|ux|app|dashboard|mockup|social media|instagram|website|landing page|interface|界面|社交/.test(haystack)) {
    return 'UI & Social Media Mockup'
  }
  if (/character|mascot|avatar|creature|hero|warrior|角色|人物设定|头像/.test(haystack)) {
    return 'Character Design'
  }
  if (/poster|illustration|infographic|comic|manga|anime|sticker|logo|book cover|海报|插画|漫画|图标/.test(haystack)) {
    return 'Poster & Illustration'
  }
  if (/compare|comparison|before and after|chart|benchmark|community|对比|榜单/.test(haystack)) {
    return 'Comparison & Community'
  }
  return 'General'
}

function findImageUrl(record: Record<string, unknown>): string {
  const direct = findString(record, [
    'image',
    'image_url',
    'imageUrl',
    'cover',
    'cover_url',
    'preview',
    'preview_url',
    'output',
    'output_image',
    'outputImage',
    'thumbnail',
  ])
  if (direct) return direct

  for (const key of ['mediaThumbnails', 'media', 'referenceImages', 'images', 'outputs', 'previews', 'gallery']) {
    const value = record[key]
    if (!Array.isArray(value)) continue
    const firstString = value.find((item) => typeof item === 'string' && item.trim())
    if (firstString) return firstString.trim()
    const firstRecord = value.find((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
    if (firstRecord) {
      const nested = findImageUrl(firstRecord)
      if (nested) return nested
    }
  }

  return ''
}

function flattenRecords(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value.flatMap((item) => flattenRecords(item))
  if (!value || typeof value !== 'object') return []
  const record = value as Record<string, unknown>
  const prompt = findString(record, ['prompt', 'description', 'translatedDescription', 'text', 'content'])
  if (prompt) return [record]

  for (const key of ['prompts', 'items', 'data', 'templates', 'cases', 'examples', 'entries']) {
    const nested = flattenRecords(record[key])
    if (nested.length) return nested
  }
  return []
}

function normalizeTemplate(record: Record<string, unknown>, index: number): PromptTemplate | null {
  const prompt = findDisplayPrompt(record)
  if (!prompt) return null
  const summary = findSummary(record, prompt)
  const title = findString(record, ['title', 'name', 'case_title', 'caseTitle', 'heading']) || `Prompt ${index + 1}`
  const id = findString(record, ['id', 'slug', 'key']) || `${title}-${index}`
  const rawAuthor = record.author
  const nestedAuthor = rawAuthor && typeof rawAuthor === 'object' && !Array.isArray(rawAuthor)
    ? findString(rawAuthor as Record<string, unknown>, ['name', 'title', 'handle'])
    : ''
  const author = nestedAuthor || findString(record, ['author', 'creator', 'source', 'by', 'sourcePlatform']) || ''
  return {
    id,
    title,
    prompt,
    summary,
    category: findCategory(record),
    imageUrl: findImageUrl(record),
    author,
  }
}

function findDisplayPrompt(record: Record<string, unknown>): string {
  const content = findString(record, ['content', 'translatedContent', 'prompt', 'text'])
  if (!content) return ''
  return formatTemplatePrompt(content) || findString(record, ['description', 'translatedDescription', 'text'])
}

export function formatTemplatePrompt(content: string): string {
  const trimmed = content.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return replaceArgumentPlaceholders(trimmed)

  try {
    return formatJsonPromptText(replaceJsonPromptPlaceholders(JSON.parse(trimmed)))
  } catch {
    return replaceArgumentPlaceholders(trimmed)
  }
}

function findSummary(record: Record<string, unknown>, prompt: string): string {
  return findString(record, ['description', 'translatedDescription']) || prompt
}

function replaceArgumentPlaceholders(value: string): string {
  return value.replace(/\{argument\b[^}]*\bdefault=(["'])(.*?)\1[^}]*\}/g, '$2').trim()
}

function replaceJsonPromptPlaceholders(value: unknown): unknown {
  if (typeof value === 'string') return replaceArgumentPlaceholders(value)
  if (Array.isArray(value)) return value.map(replaceJsonPromptPlaceholders)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      replaceJsonPromptPlaceholders(item),
    ]),
  )
}

function formatJsonPromptText(value: unknown, depth = 0): string {
  const indent = '  '.repeat(depth)
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) {
    if (value.every((item) => typeof item !== 'object' || item == null)) {
      return value.map((item) => formatJsonPromptText(item, depth)).join(', ')
    }
    return value
      .map((item) => {
        const formatted = formatJsonPromptText(item, depth + 1)
        return `${indent}- ${formatted.replace(/\n/g, `\n${indent}  `)}`
      })
      .join('\n')
  }
  if (!value || typeof value !== 'object') return ''

  return Object.entries(value as Record<string, unknown>)
    .map(([key, item]) => {
      const formatted = formatJsonPromptText(item, depth + 1)
      if (!formatted.includes('\n')) return `${indent}${formatPromptKey(key)}: ${formatted}`
      return `${indent}${formatPromptKey(key)}:\n${formatted}`
    })
    .join('\n')
}

function formatPromptKey(key: string) {
  return key.replace(/_/g, ' ')
}

export async function fetchPromptTemplates(): Promise<PromptTemplate[]> {
  try {
    const payload = await fetchPromptTemplatePayload()
    const templates = flattenRecords(payload)
      .map((record, index) => normalizeTemplate(record, index))
      .filter((item): item is PromptTemplate => Boolean(item))
    return templates.length ? templates : FALLBACK_TEMPLATES
  } catch {
    return FALLBACK_TEMPLATES
  }
}

async function fetchPromptTemplatePayload(): Promise<unknown> {
  try {
    const response = await fetch(PROMPT_TEMPLATE_SOURCE_URL, { cache: 'force-cache' })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return await response.json()
  } catch {
    return fetchPromptTemplatePayloadViaGitHubApi()
  }
}

async function fetchPromptTemplatePayloadViaGitHubApi(): Promise<unknown> {
  const metaResponse = await fetch(PROMPT_TEMPLATE_CONTENTS_URL, { cache: 'force-cache' })
  if (!metaResponse.ok) throw new Error(`HTTP ${metaResponse.status}`)
  const meta = await metaResponse.json() as { git_url?: string }
  if (!meta.git_url) throw new Error('Missing GitHub blob URL')

  const blobResponse = await fetch(meta.git_url, { cache: 'force-cache' })
  if (!blobResponse.ok) throw new Error(`HTTP ${blobResponse.status}`)
  const blob = await blobResponse.json() as { content?: string; encoding?: string }
  if (blob.encoding !== 'base64' || !blob.content) throw new Error('Unsupported GitHub blob payload')

  const binary = atob(blob.content.replace(/\s/g, ''))
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }

  const json = new TextDecoder().decode(bytes)
  return JSON.parse(json)
}
