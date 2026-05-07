const CLIENT_ID_STORAGE_KEY = 'chaincloud.imageStudioClientId'

function createClientId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
}

export function getLocalClientRequesterId() {
  try {
    const existing = localStorage.getItem(CLIENT_ID_STORAGE_KEY)?.trim()
    if (existing) return `client:${existing}`
    const next = createClientId()
    localStorage.setItem(CLIENT_ID_STORAGE_KEY, next)
    return `client:${next}`
  } catch {
    return `client:${createClientId()}`
  }
}

export function getEmbeddedRequesterId(userId?: number | null) {
  return userId && Number.isFinite(userId) ? `sub2api:${userId}` : ''
}
