import type { EmbeddedSub2ApiKey, EmbeddedSub2ApiState } from '../types'

const EMBEDDED_UI_MODE = 'embedded'

function readQueryString(key: string): string {
  if (typeof window === 'undefined') return ''
  return new URLSearchParams(window.location.search).get(key)?.trim() ?? ''
}

export function detectEmbeddedSub2ApiContext(): Pick<EmbeddedSub2ApiState, 'active' | 'origin' | 'userId'> {
  const uiMode = readQueryString('ui_mode')
  const token = readQueryString('token')
  const userIdRaw = readQueryString('user_id')
  const userId = userIdRaw ? Number(userIdRaw) : Number.NaN

  return {
    active: uiMode === EMBEDDED_UI_MODE && token !== '' && Number.isFinite(userId),
    origin: '',
    userId: Number.isFinite(userId) ? userId : null,
  }
}

export function getEmbeddedSub2ApiToken(): string {
  return readQueryString('token')
}

export async function fetchEmbeddedSub2ApiKeys(token: string, userId: number): Promise<EmbeddedSub2ApiKey[]> {
  if (!token.trim()) return []

  const response = await fetch(`/api/embedded/keys?userId=${encodeURIComponent(String(userId))}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
    credentials: 'omit',
  })

  if (!response.ok) {
    throw new Error(`加载 Sub2API 密钥失败 (${response.status})`)
  }

  const payload = await response.json() as {
    code?: number
    message?: string
    items?: Array<{
      id?: number
      name?: string
      key?: string
      status?: string
    }>
    data?: Array<{
      id?: number
      name?: string
      key?: string
      status?: string
    }> | {
      items?: Array<{
        id?: number
        name?: string
        key?: string
        status?: string
      }>
    }
  }

  const rawItems = Array.isArray(payload.items)
    ? payload.items
    : Array.isArray(payload.data)
      ? payload.data
      : payload.data && typeof payload.data === 'object' && Array.isArray(payload.data.items)
        ? payload.data.items
      : []

  return rawItems
    .filter((item) => Number.isFinite(item.id) && typeof item.key === 'string' && item.key.trim() !== '')
    .map((item) => ({
      id: Number(item.id),
      name: typeof item.name === 'string' && item.name.trim() ? item.name : `Key #${item.id}`,
      key: String(item.key),
      status: typeof item.status === 'string' ? item.status : 'unknown',
    }))
}
