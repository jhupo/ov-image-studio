import type { ApiMode, AppSettings } from '../types'
import { normalizeBaseUrl } from './devProxy'
import {
  createDefaultOpenAIProfile,
  DEFAULT_IMAGES_MODEL,
  DEFAULT_RESPONSES_MODEL,
  findEquivalentApiProfile,
  isDefaultConfigOnlyEnabled,
  mergeImportedSettings,
  normalizeSettings,
} from './apiProfiles'

const URL_SETTING_KEYS = ['settings', 'apiKey', 'apiMode', 'model', 'profileName']

function getProfileDedupKey(profile: Pick<AppSettings['profiles'][number], 'provider' | 'apiKey' | 'model' | 'apiMode'>) {
  return JSON.stringify([
    profile.provider,
    profile.apiKey.trim(),
    profile.model.trim(),
    profile.apiMode,
  ])
}

function createUrlProfileId(usedIds: Set<string>) {
  let id = `openai-url-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
  while (usedIds.has(id)) {
    id = `openai-url-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
  }
  return id
}

function pickUrlSettingsPayload(value: unknown): unknown | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  return {
    customProviders: record.customProviders,
    profiles: record.profiles,
  }
}

function getUrlSettingsPayload(searchParams: URLSearchParams): unknown | null {
  const raw = searchParams.get('settings')
  if (!raw) return null

  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && 'settings' in parsed) {
      return pickUrlSettingsPayload((parsed as { settings?: unknown }).settings ?? null)
    }
    return pickUrlSettingsPayload(parsed)
  } catch {
    return null
  }
}

export function activateFirstImportedProfile(settings: AppSettings, importedSettings: unknown): AppSettings {
  if (!importedSettings || typeof importedSettings !== 'object' || Array.isArray(importedSettings)) return settings

  const record = importedSettings as Record<string, unknown>
  if (!Array.isArray(record.profiles) || record.profiles.length === 0) return settings

  const imported = normalizeSettings({
    customProviders: record.customProviders,
    profiles: record.profiles,
  })
  const importedProfile = imported.profiles[0]
  const activeProfile = findEquivalentApiProfile(settings, importedProfile, imported.customProviders)

  return activeProfile
    ? normalizeSettings({ ...settings, activeProfileId: activeProfile.id })
    : settings
}

/**
 * 仅展示默认配置模式：从 URL 参数中提取可覆盖的字段，patch 到当前活跃配置上。
 * 不新建配置、不导入自定义服务商、不切换 provider。
 */
function buildDefaultConfigOnlySettingsFromUrlParams(currentSettings: Partial<AppSettings> | unknown, searchParams: URLSearchParams): Partial<AppSettings> {
  const settings = normalizeSettings(currentSettings)
  const activeProfile = settings.profiles.find((profile) => profile.id === settings.activeProfileId) ?? settings.profiles[0]
  if (!activeProfile) return {}

  const isOpenAI = activeProfile.provider === 'openai'
  const patch: Partial<typeof activeProfile> = {}

  // 从 ?settings= JSON 中提取同 provider 的 profile 字段
  const importedSettings = getUrlSettingsPayload(searchParams)
  if (importedSettings && typeof importedSettings === 'object' && !Array.isArray(importedSettings)) {
    const profiles = (importedSettings as Record<string, unknown>).profiles
    if (Array.isArray(profiles)) {
      const matched = profiles.find((item) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return false
        const p = (item as Record<string, unknown>).provider
        return p === undefined || p === activeProfile.provider
      }) as Record<string, unknown> | undefined
      if (matched) {
        if (typeof matched.name === 'string' && matched.name.trim()) patch.name = matched.name.trim()
        if (typeof matched.apiKey === 'string') patch.apiKey = matched.apiKey
        if (typeof matched.model === 'string' && matched.model.trim()) patch.model = matched.model.trim()
        if (typeof matched.timeout === 'number' && Number.isFinite(matched.timeout)) patch.timeout = matched.timeout
        if (isOpenAI) {
          if (matched.apiMode === 'images' || matched.apiMode === 'responses') patch.apiMode = matched.apiMode
        }
      }
    }
  }

  // 查询参数覆盖（优先级高于 settings JSON）
  const apiKeyParam = searchParams.get('apiKey')
  const modelParam = searchParams.get('model')
  const profileNameParam = searchParams.get('profileName')
  if (profileNameParam?.trim()) patch.name = profileNameParam.trim()
  if (apiKeyParam !== null) patch.apiKey = apiKeyParam.trim()
  if (modelParam !== null && modelParam.trim()) patch.model = modelParam.trim()
  if (isOpenAI) {
    const apiModeParam = searchParams.get('apiMode')
    if (apiModeParam === 'images' || apiModeParam === 'responses') patch.apiMode = apiModeParam
  }

  if (Object.keys(patch).length === 0) return {}

  return normalizeSettings({
    ...settings,
    profiles: settings.profiles.map((profile) =>
      profile.id === activeProfile.id ? { ...profile, ...patch, provider: profile.provider } : profile,
    ),
  })
}

export function hasUrlSettingParams(searchParams: URLSearchParams) {
  return URL_SETTING_KEYS.some((key) => searchParams.has(key))
}

export function clearUrlSettingParams(searchParams: URLSearchParams) {
  for (const key of URL_SETTING_KEYS) searchParams.delete(key)
}

export function buildSettingsFromUrlParams(currentSettings: Partial<AppSettings> | unknown, searchParams: URLSearchParams): Partial<AppSettings> {
  if (isDefaultConfigOnlyEnabled()) return buildDefaultConfigOnlySettingsFromUrlParams(currentSettings, searchParams)

  const importedSettings = getUrlSettingsPayload(searchParams)
  const apiKeyParam = searchParams.get('apiKey')
  const apiModeParam = searchParams.get('apiMode')
  const modelParam = searchParams.get('model')
  const profileNameParam = searchParams.get('profileName')
  const profileName = profileNameParam?.trim() ?? ''
  const apiMode: ApiMode | undefined = apiModeParam === 'images' || apiModeParam === 'responses' ? apiModeParam : undefined

  const hasOpenAIParams = apiKeyParam !== null || apiMode !== undefined || modelParam !== null || profileNameParam !== null
  const settings = importedSettings == null
    ? normalizeSettings(currentSettings)
    : activateFirstImportedProfile(mergeImportedSettings(currentSettings, importedSettings), importedSettings)

  if (hasOpenAIParams) {
    const profileApiMode = apiMode ?? 'images'
    const profile = createDefaultOpenAIProfile({
      id: createUrlProfileId(new Set(settings.profiles.map((item) => item.id))),
      name: 'URL 参数配置',
      apiMode: profileApiMode,
      model: profileApiMode === 'responses' ? DEFAULT_RESPONSES_MODEL : DEFAULT_IMAGES_MODEL,
    })
    if (apiKeyParam !== null) profile.apiKey = apiKeyParam.trim()
    if (modelParam !== null && modelParam.trim()) profile.model = modelParam.trim()
    if (profileName) profile.name = profileName

    const existingProfile = settings.profiles.find((item) =>
      getProfileDedupKey(item) === getProfileDedupKey(profile) &&
      (!profileName || item.name.trim() === profileName)
    )
    if (existingProfile) {
      return normalizeSettings({ ...settings, activeProfileId: existingProfile.id })
    }

    return normalizeSettings({
      ...settings,
      profiles: [...settings.profiles, profile],
      activeProfileId: profile.id,
    })
  }

  return importedSettings == null ? {} : settings
}
