import type { ApiMode, AppSettings, RuntimeApiProfile } from '../types'
import { readRuntimeEnv } from './runtimeEnv'

export const DEFAULT_IMAGE_API_BASE_URL = readRuntimeEnv(import.meta.env.VITE_DEFAULT_IMAGE_API_URL) || 'https://dash.ovload.com/v1'
export const DEFAULT_BASE_URL = DEFAULT_IMAGE_API_BASE_URL
export const DEFAULT_IMAGES_MODEL = 'gpt-image-2'
export const DEFAULT_RESPONSES_MODEL = 'gpt-5.5'
export const DEFAULT_API_TIMEOUT = 600

export const DEFAULT_SETTINGS: AppSettings = {
  apiKey: '',
  apiMode: 'images',
  codexCli: false,
  clearInputAfterSubmit: false,
  losslessUpscale: false,
  embeddedApiKeyId: null,
}

function asRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' ? input as Record<string, unknown> : {}
}

function readApiMode(value: unknown): ApiMode {
  return value === 'responses' ? 'responses' : 'images'
}

function readLegacyActiveProfile(record: Record<string, unknown>): Record<string, unknown> | null {
  if (!Array.isArray(record.profiles) || record.profiles.length === 0) return null
  const profiles = record.profiles.filter((profile): profile is Record<string, unknown> =>
    Boolean(profile && typeof profile === 'object'),
  )
  if (!profiles.length) return null

  const activeProfileId = typeof record.activeProfileId === 'string' ? record.activeProfileId : ''
  return profiles.find((profile) => profile.id === activeProfileId && profile.provider !== 'fal')
    ?? profiles.find((profile) => profile.provider !== 'fal')
    ?? null
}

export function normalizeSettings(input: Partial<AppSettings> | unknown): AppSettings {
  const record = asRecord(input)
  const legacyProfile = readLegacyActiveProfile(record)
  const apiKey = typeof record.apiKey === 'string'
    ? record.apiKey
    : typeof legacyProfile?.apiKey === 'string'
      ? legacyProfile.apiKey
      : DEFAULT_SETTINGS.apiKey
  const apiMode = record.apiMode === 'images' || record.apiMode === 'responses'
    ? readApiMode(record.apiMode)
    : readApiMode(legacyProfile?.apiMode)
  const codexCli = typeof record.codexCli === 'boolean'
    ? record.codexCli
    : Boolean(legacyProfile?.codexCli)

  return {
    apiKey,
    apiMode,
    codexCli,
    clearInputAfterSubmit: typeof record.clearInputAfterSubmit === 'boolean'
      ? record.clearInputAfterSubmit
      : DEFAULT_SETTINGS.clearInputAfterSubmit,
    losslessUpscale: typeof record.losslessUpscale === 'boolean'
      ? record.losslessUpscale
      : DEFAULT_SETTINGS.losslessUpscale,
    embeddedApiKeyId: typeof record.embeddedApiKeyId === 'number' && Number.isFinite(record.embeddedApiKeyId)
      ? record.embeddedApiKeyId
      : DEFAULT_SETTINGS.embeddedApiKeyId,
  }
}

export function getRuntimeApiProfile(settings: Partial<AppSettings> | unknown): RuntimeApiProfile {
  const normalized = normalizeSettings(settings)
  return {
    name: '默认',
    provider: 'openai',
    baseUrl: DEFAULT_BASE_URL,
    imageApiBaseUrl: DEFAULT_IMAGE_API_BASE_URL,
    apiKey: normalized.apiKey,
    model: normalized.apiMode === 'responses' ? DEFAULT_RESPONSES_MODEL : DEFAULT_IMAGES_MODEL,
    timeout: DEFAULT_API_TIMEOUT,
    apiMode: normalized.apiMode,
    codexCli: normalized.codexCli,
  }
}

export function validateSettings(settings: Partial<AppSettings> | unknown): string | null {
  const normalized = normalizeSettings(settings)
  if (!normalized.apiKey.trim()) return '缺少 API Key'
  return null
}

export function mergeImportedSettings(currentSettings: Partial<AppSettings> | unknown, importedSettings: Partial<AppSettings> | unknown): AppSettings {
  const current = normalizeSettings(currentSettings)
  const imported = normalizeSettings(importedSettings)
  return normalizeSettings({
    ...current,
    ...imported,
    apiKey: imported.apiKey.trim() ? imported.apiKey : current.apiKey,
  })
}
