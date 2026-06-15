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
    origin: typeof window === 'undefined' ? '' : window.location.origin,
    userId: Number.isFinite(userId) ? userId : null,
  }
}

export function getEmbeddedSub2ApiToken(): string {
  return readQueryString('token')
}

async function fetchKeysFromPath(path: string, token: string): Promise<Response> {
  return fetch(path, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
    credentials: 'omit',
  })
}

export async function fetchEmbeddedSub2ApiKeys(token: string, userId: number): Promise<EmbeddedSub2ApiKey[]> {
  if (!token.trim()) return []

  const params = 'page=1&page_size=100'
  let response = await fetchKeysFromPath(`/api/v1/keys?${params}`, token)
  if (!response.ok) {
    response = await fetchKeysFromPath(`/api/v1/admin/users/${encodeURIComponent(String(userId))}/api-keys?${params}`, token)
  }

  if (!response.ok) {
    throw new Error(`Failed to load Sub2API keys (${response.status})`)
  }

  const payload = await response.json() as {
    items?: Array<{ id?: number; name?: string; key?: string; status?: string }>
    data?: Array<{ id?: number; name?: string; key?: string; status?: string }> | {
      items?: Array<{ id?: number; name?: string; key?: string; status?: string }>
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
