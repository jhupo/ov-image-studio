import type { ApiMode, ApiProfile, ApiProvider, AppSettings } from '../types'
import { readRuntimeEnv } from './runtimeEnv'

export const DEFAULT_IMAGE_API_BASE_URL = readRuntimeEnv(import.meta.env.VITE_DEFAULT_IMAGE_API_URL) || 'http://192.168.2.60:8080/v1'
export const DEFAULT_BASE_URL = DEFAULT_IMAGE_API_BASE_URL
export const DEFAULT_IMAGES_MODEL = 'gpt-image-2'
export const DEFAULT_RESPONSES_MODEL = 'gpt-5.5'
export const DEFAULT_FAL_BASE_URL = 'https://fal.run'
export const DEFAULT_FAL_MODEL = 'openai/gpt-image-2'
export const DEFAULT_OPENAI_PROFILE_ID = 'default-openai'
export const DEFAULT_API_TIMEOUT = 600

export function createDefaultOpenAIProfile(overrides: Partial<ApiProfile> = {}): ApiProfile {
  return {
    id: DEFAULT_OPENAI_PROFILE_ID,
    name: '默认',
    provider: 'openai',
    baseUrl: DEFAULT_BASE_URL,
    imageApiBaseUrl: DEFAULT_IMAGE_API_BASE_URL,
    apiKey: '',
    model: DEFAULT_IMAGES_MODEL,
    timeout: DEFAULT_API_TIMEOUT,
    apiMode: 'images',
    codexCli: false,
    ...overrides,
  }
}

export function createDefaultFalProfile(overrides: Partial<ApiProfile> = {}): ApiProfile {
  return {
    id: `fal-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    name: '新配置',
    provider: 'fal',
    baseUrl: DEFAULT_FAL_BASE_URL,
    imageApiBaseUrl: '',
    apiKey: '',
    model: DEFAULT_FAL_MODEL,
    timeout: DEFAULT_API_TIMEOUT,
    apiMode: 'images',
    codexCli: false,
    ...overrides,
  }
}

export function switchApiProfileProvider(profile: ApiProfile, provider: ApiProvider): ApiProfile {
  if (provider === 'fal') {
    return {
      ...profile,
      provider,
      baseUrl: DEFAULT_FAL_BASE_URL,
      model: DEFAULT_FAL_MODEL,
      apiMode: 'images',
      codexCli: false,
    }
  }

  return {
    ...profile,
    provider,
    baseUrl: DEFAULT_BASE_URL,
    model: DEFAULT_IMAGES_MODEL,
  }
}

export function normalizeApiProfile(input: unknown, fallback?: Partial<ApiProfile>): ApiProfile {
  const record = input && typeof input === 'object' ? input as Record<string, unknown> : {}
  const provider: ApiProvider = record.provider === 'fal' ? 'fal' : 'openai'
  const defaults = provider === 'fal' ? createDefaultFalProfile(fallback) : createDefaultOpenAIProfile(fallback)
  const apiMode: ApiMode = record.apiMode === 'responses' ? 'responses' : 'images'

  return {
    ...defaults,
    id: typeof record.id === 'string' && record.id.trim() ? record.id : defaults.id,
    name: typeof record.name === 'string' && record.name.trim() ? record.name : defaults.name,
    provider,
    baseUrl: provider === 'fal'
      ? (typeof record.baseUrl === 'string' ? record.baseUrl : defaults.baseUrl)
      : DEFAULT_BASE_URL,
    imageApiBaseUrl: typeof record.imageApiBaseUrl === 'string' ? record.imageApiBaseUrl : defaults.imageApiBaseUrl,
    apiKey: typeof record.apiKey === 'string' ? record.apiKey : defaults.apiKey,
    model: typeof record.model === 'string' && record.model.trim() ? record.model : defaults.model,
    timeout: typeof record.timeout === 'number' && Number.isFinite(record.timeout) ? record.timeout : defaults.timeout,
    apiMode,
    codexCli: Boolean(record.codexCli),
  }
}

export function normalizeSettings(input: Partial<AppSettings> | unknown): AppSettings {
  const record = input && typeof input === 'object' ? input as Record<string, unknown> : {}
  const legacyProfile = createDefaultOpenAIProfile({
    baseUrl: DEFAULT_BASE_URL,
    imageApiBaseUrl: typeof record.imageApiBaseUrl === 'string' ? record.imageApiBaseUrl : DEFAULT_IMAGE_API_BASE_URL,
    apiKey: typeof record.apiKey === 'string' ? record.apiKey : '',
    model: typeof record.model === 'string' && record.model.trim() ? record.model : DEFAULT_IMAGES_MODEL,
    timeout: typeof record.timeout === 'number' && Number.isFinite(record.timeout) ? record.timeout : DEFAULT_API_TIMEOUT,
    apiMode: record.apiMode === 'responses' ? 'responses' : 'images',
    codexCli: Boolean(record.codexCli),
  })
  const profiles = Array.isArray(record.profiles) && record.profiles.length
    ? record.profiles.map((profile) => normalizeApiProfile(profile))
    : [legacyProfile]
  const activeProfileId = typeof record.activeProfileId === 'string' && profiles.some((p) => p.id === record.activeProfileId)
    ? record.activeProfileId
    : profiles[0].id
  const active = profiles.find((p) => p.id === activeProfileId) ?? profiles[0]

  return {
    baseUrl: active.baseUrl,
    apiKey: active.apiKey,
    imageApiBaseUrl: active.imageApiBaseUrl ?? '',
    embeddedAdminBaseUrl: typeof record.embeddedAdminBaseUrl === 'string' ? record.embeddedAdminBaseUrl : '',
    embeddedAdminApiKey: typeof record.embeddedAdminApiKey === 'string' ? record.embeddedAdminApiKey : '',
    model: active.model,
    timeout: active.timeout,
    apiMode: active.apiMode,
    codexCli: active.codexCli,
    clearInputAfterSubmit: typeof record.clearInputAfterSubmit === 'boolean' ? record.clearInputAfterSubmit : false,
    embeddedApiKeyId: typeof record.embeddedApiKeyId === 'number' && Number.isFinite(record.embeddedApiKeyId)
      ? record.embeddedApiKeyId
      : null,
    profiles,
    activeProfileId,
  }
}

export function getActiveApiProfile(settings: Partial<AppSettings> | unknown): ApiProfile {
  const record = settings && typeof settings === 'object' ? settings as Record<string, unknown> : {}
  const normalized = normalizeSettings(settings)
  const profile = normalized.profiles.find((p) => p.id === normalized.activeProfileId) ?? normalized.profiles[0] ?? createDefaultOpenAIProfile()

  return {
    ...profile,
    baseUrl: profile.provider === 'fal'
      ? (typeof record.baseUrl === 'string' ? record.baseUrl : profile.baseUrl)
      : DEFAULT_BASE_URL,
    imageApiBaseUrl: typeof record.imageApiBaseUrl === 'string' ? record.imageApiBaseUrl : profile.imageApiBaseUrl,
    apiKey: typeof record.apiKey === 'string' ? record.apiKey : profile.apiKey,
    model: typeof record.model === 'string' && record.model.trim() ? record.model : profile.model,
    timeout: typeof record.timeout === 'number' && Number.isFinite(record.timeout) ? record.timeout : profile.timeout,
    apiMode: record.apiMode === 'images' || record.apiMode === 'responses' ? record.apiMode : profile.apiMode,
    codexCli: typeof record.codexCli === 'boolean' ? record.codexCli : profile.codexCli,
  }
}

export function validateApiProfile(profile: ApiProfile): string | null {
  if (!profile.name.trim()) return '缺少名称'
  if (profile.provider === 'openai' && !profile.baseUrl.trim()) return '缺少 API URL'
  if (!profile.apiKey.trim()) return '缺少 API Key'
  if (!profile.model.trim()) return '缺少模型 ID'
  return null
}

function isDefaultOpenAIProfile(profile: ApiProfile): boolean {
  return profile.id === DEFAULT_OPENAI_PROFILE_ID &&
    profile.name === '默认' &&
    profile.provider === 'openai' &&
    profile.baseUrl === DEFAULT_BASE_URL &&
    profile.apiKey === '' &&
    profile.model === DEFAULT_IMAGES_MODEL &&
    profile.timeout === DEFAULT_API_TIMEOUT &&
    profile.apiMode === 'images' &&
    profile.codexCli === false
}

function hasOnlyDefaultProfiles(settings: AppSettings): boolean {
  return settings.profiles.length === 1 &&
    settings.activeProfileId === DEFAULT_OPENAI_PROFILE_ID &&
    isDefaultOpenAIProfile(settings.profiles[0])
}

function createImportedProfileId(provider: ApiProvider, usedIds: Set<string>): string {
  let id = `${provider}-imported-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
  while (usedIds.has(id)) {
    id = `${provider}-imported-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
  }
  usedIds.add(id)
  return id
}

function getApiProfileDedupKey(profile: ApiProfile): string {
  return JSON.stringify([
    profile.provider,
    profile.provider === 'openai'
      ? DEFAULT_BASE_URL.trim().replace(/\/+$/, '').toLowerCase()
      : profile.baseUrl.trim().replace(/\/+$/, '').toLowerCase(),
    profile.apiKey.trim(),
    profile.model.trim(),
    profile.apiMode,
  ])
}

function dedupeApiProfiles(profiles: ApiProfile[]): ApiProfile[] {
  const seen = new Set<string>()
  return profiles.filter((profile) => {
    const key = getApiProfileDedupKey(profile)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function mergeImportedSettings(currentSettings: Partial<AppSettings> | unknown, importedSettings: Partial<AppSettings> | unknown): AppSettings {
  const current = normalizeSettings(currentSettings)
  const normalizedImported = normalizeSettings(importedSettings)
  const imported = normalizeSettings({
    ...normalizedImported,
    profiles: dedupeApiProfiles(normalizedImported.profiles),
  })

  if (hasOnlyDefaultProfiles(current)) {
    return imported
  }

  const usedIds = new Set(current.profiles.map((profile) => profile.id))
  const existingKeys = new Set(current.profiles.map(getApiProfileDedupKey))
  const importedProfiles = imported.profiles
    .filter((profile) => !existingKeys.has(getApiProfileDedupKey(profile)))
    .map((profile) => ({
      ...profile,
      id: createImportedProfileId(profile.provider, usedIds),
    }))
  const profiles = [...current.profiles, ...importedProfiles]

  return normalizeSettings({
    ...current,
    profiles,
    activeProfileId: current.activeProfileId,
  })
}

export const DEFAULT_SETTINGS: AppSettings = normalizeSettings({
  baseUrl: DEFAULT_BASE_URL,
  apiKey: '',
  embeddedAdminBaseUrl: '',
  embeddedAdminApiKey: '',
  model: DEFAULT_IMAGES_MODEL,
  timeout: DEFAULT_API_TIMEOUT,
  apiMode: 'images',
  codexCli: false,
  clearInputAfterSubmit: false,
  embeddedApiKeyId: null,
})
