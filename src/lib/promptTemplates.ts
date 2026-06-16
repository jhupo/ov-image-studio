import { GENERATED_PROMPT_TEMPLATES } from './promptTemplates.generated'

export interface PromptTemplate {
  id: string
  title: string
  prompt: string
  summary: string
  category: string
  tags: string[]
  imageUrl: string
  author: string
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

const PROMPT_TEMPLATES: PromptTemplate[] = GENERATED_PROMPT_TEMPLATES.map((template) => ({
  ...template,
  tags: [...template.tags],
}))

const CATEGORY_LABELS: Record<string, string> = {
  精选: '精选',
  社区提示词: '社区提示词',
  '个人资料 / 头像': '个人资料 / 头像',
  社交媒体帖子: '社交媒体帖子',
  '信息图 / 教育视觉图': '信息图 / 教育视觉图',
  'YouTube 缩略图': 'YouTube 缩略图',
  '漫画 / 故事板': '漫画 / 故事板',
  产品营销: '产品营销',
  电商主图: '电商主图',
  游戏素材: '游戏素材',
  '海报 / 传单': '海报 / 传单',
  'App / 网页设计': 'App / 网页设计',
  摄影: '摄影',
  '电影 / 电影剧照': '电影 / 电影剧照',
  '动漫 / 漫画': '动漫 / 漫画',
  插画: '插画',
  '草图 / 线稿': '草图 / 线稿',
  '3D 渲染': '3D 渲染',
  'Q 版 / Q 萌风': 'Q 版 / Q 萌风',
  等距: '等距',
  像素艺术: '像素艺术',
  油画: '油画',
  水彩画: '水彩画',
  '水墨 / 中国风': '水墨 / 中国风',
  '复古 / 怀旧': '复古 / 怀旧',
  '赛博朋克 / 科幻': '赛博朋克 / 科幻',
  极简主义: '极简主义',
  '人像 / 自拍': '人像 / 自拍',
  产品: '产品',
  '食品 / 饮料': '食品 / 饮料',
  '建筑 / 室内设计': '建筑 / 室内设计',
  '风景 / 自然': '风景 / 自然',
  '文本 / 排版': '文本 / 排版',
}

export function getPromptCategoryLabel(category: string) {
  return CATEGORY_LABELS[category] ?? category
}

export async function fetchPromptTemplates(): Promise<PromptTemplate[]> {
  return PROMPT_TEMPLATES.map((template) => ({
    ...template,
    prompt: formatTemplatePrompt(template.prompt),
  }))
}
