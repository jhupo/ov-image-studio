import { useCallback, useEffect, useRef, useState } from 'react'
import { isApiProxyAvailable, readClientDevProxyConfig } from '../lib/devProxy'
import { useStore } from '../store'
import {
  createDefaultOpenAIProfile,
  DEFAULT_FAL_BASE_URL,
  DEFAULT_FAL_MODEL,
  DEFAULT_IMAGES_MODEL,
  DEFAULT_IMAGE_API_BASE_URL,
  DEFAULT_OPENAI_PROFILE_ID,
  DEFAULT_RESPONSES_MODEL,
  DEFAULT_SETTINGS,
  getActiveApiProfile,
  normalizeSettings,
  switchApiProfileProvider,
} from '../lib/apiProfiles'
import type { ApiProfile, AppSettings } from '../types'
import { useCloseOnEscape } from '../hooks/useCloseOnEscape'
import Select from './Select'

function newId(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

function providerLabel(provider: string) {
  return provider === 'fal' ? 'fal.ai' : 'OpenAI'
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return <span className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400">{children}</span>
}

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean
  onChange: () => void
  label: string
}) {
  return (
    <button
      type="button"
      onClick={onChange}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${checked ? 'bg-blue-500' : 'bg-gray-300 dark:bg-gray-600'}`}
      role="switch"
      aria-checked={checked}
      aria-label={label}
    >
      <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-[18px]' : 'translate-x-0.5'}`} />
    </button>
  )
}

export default function SettingsModal() {
  const showSettings = useStore((s) => s.showSettings)
  const setShowSettings = useStore((s) => s.setShowSettings)
  const settings = useStore((s) => s.settings)
  const setSettings = useStore((s) => s.setSettings)
  const setConfirmDialog = useStore((s) => s.setConfirmDialog)
  const embeddedSub2Api = useStore((s) => s.embeddedSub2Api)

  const [draft, setDraft] = useState<AppSettings>(normalizeSettings(settings))
  const [timeoutInput, setTimeoutInput] = useState(String(getActiveApiProfile(settings).timeout))
  const [showApiKey, setShowApiKey] = useState(false)
  const [showProfileMenu, setShowProfileMenu] = useState(false)
  const wasSettingsOpenRef = useRef(false)

  const apiProxyAvailable = isApiProxyAvailable(readClientDevProxyConfig())
  const activeProfile = draft.profiles.find((profile) => profile.id === draft.activeProfileId) ?? draft.profiles[0] ?? getActiveApiProfile(draft)
  const apiProxyEnabled = apiProxyAvailable && activeProfile.provider === 'openai' && activeProfile.apiProxy

  const getDefaultModelForMode = (apiMode: AppSettings['apiMode']) =>
    apiMode === 'responses' ? DEFAULT_RESPONSES_MODEL : DEFAULT_IMAGES_MODEL

  useEffect(() => {
    if (!showSettings) {
      wasSettingsOpenRef.current = false
      return
    }
    if (wasSettingsOpenRef.current) return

    wasSettingsOpenRef.current = true
    const nextDraft = normalizeSettings(apiProxyAvailable ? settings : {
      ...settings,
      profiles: settings.profiles.map((profile) => ({ ...profile, apiProxy: false })),
    })
    setDraft(nextDraft)
    setTimeoutInput(String(getActiveApiProfile(nextDraft).timeout))
  }, [apiProxyAvailable, showSettings, settings])

  useEffect(() => {
    setTimeoutInput(String(activeProfile.timeout))
  }, [activeProfile.id, activeProfile.timeout])

  const commitSettings = (nextDraft: AppSettings) => {
    const normalizedProfiles = nextDraft.profiles.map((profile) => {
      const normalizedBaseUrl = profile.provider === 'fal'
        ? profile.baseUrl.trim().replace(/\/+$/, '') || DEFAULT_FAL_BASE_URL
        : DEFAULT_SETTINGS.baseUrl
      const defaultModel = profile.provider === 'fal' ? DEFAULT_FAL_MODEL : getDefaultModelForMode(profile.apiMode)
      return {
        ...profile,
        name: profile.name.trim() || (profile.id === DEFAULT_OPENAI_PROFILE_ID ? '默认' : '新配置'),
        baseUrl: normalizedBaseUrl,
        imageApiBaseUrl: profile.provider === 'openai' ? (profile.imageApiBaseUrl ?? '').trim() : '',
        model: profile.model.trim() || defaultModel,
        timeout: Number(profile.timeout) || DEFAULT_SETTINGS.timeout,
        apiProxy: profile.provider === 'openai' && apiProxyAvailable ? profile.apiProxy : false,
        codexCli: profile.provider === 'openai' ? profile.codexCli : false,
      }
    })
    const fallbackProfile = createDefaultOpenAIProfile({ id: newId('openai') })
    const normalizedDraft = normalizeSettings({
      ...nextDraft,
      profiles: normalizedProfiles.length ? normalizedProfiles : [fallbackProfile],
      activeProfileId: normalizedProfiles.some((profile) => profile.id === nextDraft.activeProfileId)
        ? nextDraft.activeProfileId
        : (normalizedProfiles[0]?.id ?? fallbackProfile.id),
    })
    setDraft(normalizedDraft)
    setSettings(normalizedDraft)
  }

  const getDraftWithActiveProfilePatch = (patch: Partial<ApiProfile>) => ({
    ...draft,
    profiles: draft.profiles.map((profile) => profile.id === activeProfile.id ? { ...profile, ...patch } : profile),
  })

  const updateActiveProfile = (patch: Partial<ApiProfile>, commit = false) => {
    const nextDraft = getDraftWithActiveProfilePatch(patch)
    setDraft(nextDraft)
    if (commit) commitSettings(nextDraft)
  }

  const commitActiveProfilePatch = (patch: Partial<ApiProfile>) => {
    const nextDraft = getDraftWithActiveProfilePatch(patch)
    commitSettings(nextDraft)
  }

  const commitSettingsPatch = (patch: Partial<AppSettings>) => {
    const nextDraft = normalizeSettings({ ...draft, ...patch })
    commitSettings(nextDraft)
  }

  const commitTimeout = useCallback(() => {
    if (activeProfile.provider !== 'openai') return
    const nextTimeout = Number(timeoutInput)
    const normalizedTimeout =
      timeoutInput.trim() === '' ? DEFAULT_SETTINGS.timeout : Number.isNaN(nextTimeout) ? activeProfile.timeout : nextTimeout
    setTimeoutInput(String(normalizedTimeout))
    updateActiveProfile({ timeout: normalizedTimeout }, true)
  }, [draft, activeProfile.id, activeProfile.provider, activeProfile.timeout, timeoutInput])

  const handleEmbeddedApiKeyChange = (value: string) => {
    const selectedId = Number(value)
    const selectedApiKey = embeddedSub2Api.apiKeys.find((item) => item.id === selectedId)
    if (!selectedApiKey) return

    const nextDraft = normalizeSettings({
      ...draft,
      embeddedApiKeyId: selectedApiKey.id,
      profiles: draft.profiles.map((profile) =>
        profile.id === activeProfile.id
          ? {
              ...profile,
              provider: 'openai',
              baseUrl: embeddedSub2Api.origin || profile.baseUrl,
              apiKey: selectedApiKey.key,
            }
          : profile,
      ),
    })
    commitSettings(nextDraft)
  }

  const handleClose = () => {
    const nextTimeout = Number(timeoutInput)
    const normalizedTimeout =
      timeoutInput.trim() === '' || Number.isNaN(nextTimeout)
        ? DEFAULT_SETTINGS.timeout
        : nextTimeout
    const nextDraft = {
      ...draft,
      profiles: activeProfile.provider === 'openai'
        ? draft.profiles.map((profile) =>
            profile.id === activeProfile.id ? { ...profile, timeout: normalizedTimeout } : profile,
          )
        : draft.profiles,
    }
    commitSettings(nextDraft)
    setShowSettings(false)
  }

  useCloseOnEscape(showSettings, handleClose)

  if (!showSettings) return null

  const createNewProfile = () => {
    const profile = createDefaultOpenAIProfile({ id: newId('openai'), name: '新配置' })
    const nextDraft = normalizeSettings({
      ...draft,
      profiles: [...draft.profiles, profile],
      activeProfileId: profile.id,
    })
    commitSettings(nextDraft)
    setShowProfileMenu(false)
  }

  const switchProfile = (id: string) => {
    const nextDraft = normalizeSettings({ ...draft, activeProfileId: id })
    setDraft(nextDraft)
    setShowProfileMenu(false)
  }

  const deleteProfile = (id: string) => {
    if (draft.profiles.length <= 1) return
    const nextProfiles = draft.profiles.filter((item) => item.id !== id)
    const nextDraft = normalizeSettings({
      ...draft,
      profiles: nextProfiles,
      activeProfileId: draft.activeProfileId === id ? nextProfiles[0].id : draft.activeProfileId,
    })
    commitSettings(nextDraft)
  }

  const switchProvider = (provider: ApiProfile['provider']) => {
    updateActiveProfile(switchApiProfileProvider(activeProfile, provider), true)
  }

  return (
    <div data-no-drag-select className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm animate-overlay-in" onClick={handleClose} />
      <div className="relative z-10 w-full max-w-3xl max-h-[88vh] overflow-y-auto rounded-2xl border border-white/50 bg-white/95 p-6 shadow-2xl ring-1 ring-black/5 animate-modal-in dark:border-white/[0.08] dark:bg-gray-900/95 dark:ring-white/10 custom-scrollbar">
        <div className="mb-5 flex items-center justify-between gap-4">
          <h3 className="flex items-center gap-2 text-base font-semibold text-gray-800 dark:text-gray-100">
            <svg className="h-5 w-5 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            设置
          </h3>
          <div className="flex items-center gap-3">
            <span className="select-none font-mono text-xs text-gray-400 dark:text-gray-500">v{__APP_VERSION__}</span>
            <button
              onClick={handleClose}
              className="rounded-full p-1 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-white/[0.06] dark:hover:text-gray-200"
              aria-label="关闭"
            >
              <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        <div className="space-y-5">
          <section className="rounded-xl border border-gray-200/70 bg-white/45 p-4 dark:border-white/[0.08] dark:bg-white/[0.03]">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <h4 className="text-sm font-semibold text-gray-800 dark:text-gray-100">账号与密钥</h4>
                <p className="mt-0.5 text-xs text-gray-400 dark:text-gray-500">选择配置、服务商和本次使用的 API Key。</p>
              </div>
              <div className="relative w-56 max-w-[55%]">
                <button
                  type="button"
                  onClick={() => setShowProfileMenu(!showProfileMenu)}
                  className="flex w-full min-w-0 items-center justify-between gap-2 rounded-lg border border-gray-200/70 bg-white/70 px-3 py-2 text-sm text-gray-700 outline-none transition hover:bg-gray-50 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-200 dark:hover:bg-white/[0.06]"
                  title={activeProfile.name}
                >
                  <span className="min-w-0 truncate">{activeProfile.name}</span>
                  <span className="shrink-0 rounded bg-blue-50 px-1.5 py-0.5 text-[10px] font-medium text-blue-600 dark:bg-blue-500/10 dark:text-blue-400">
                    {providerLabel(activeProfile.provider)}
                  </span>
                </button>
                {showProfileMenu && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setShowProfileMenu(false)} />
                    <div className="absolute right-0 top-full z-50 mt-1.5 max-h-64 w-full overflow-y-auto rounded-xl border border-gray-200/60 bg-white/95 py-1 shadow-xl ring-1 ring-black/5 backdrop-blur-xl animate-dropdown-down dark:border-white/[0.08] dark:bg-gray-900/95 dark:ring-white/10 custom-scrollbar">
                      <button
                        type="button"
                        onClick={createNewProfile}
                        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-xs font-medium text-blue-600 transition hover:bg-blue-50 dark:text-blue-400 dark:hover:bg-blue-500/10"
                      >
                        <span>创建新配置</span>
                        <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                        </svg>
                      </button>
                      {draft.profiles.map((profile) => (
                        <div
                          key={profile.id}
                          className={`group flex items-center justify-between px-3 py-2 text-xs ${profile.id === activeProfile.id ? 'bg-blue-50 text-blue-600 dark:bg-blue-500/10 dark:text-blue-400' : 'text-gray-700 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-white/[0.06]'}`}
                        >
                          <button type="button" onClick={() => switchProfile(profile.id)} className="flex min-w-0 flex-1 items-center gap-2 pr-2 text-left">
                            <span className="min-w-0 truncate">{profile.name}</span>
                            <span className="shrink-0 rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-500 dark:bg-white/[0.08] dark:text-gray-400">
                              {providerLabel(profile.provider)}
                            </span>
                          </button>
                          {draft.profiles.length > 1 && (
                            <button
                              type="button"
                              onClick={(event) => {
                                event.stopPropagation()
                                setConfirmDialog({
                                  title: '删除配置',
                                  message: `确定要删除配置「${profile.name}」吗？`,
                                  action: () => deleteProfile(profile.id),
                                })
                              }}
                              className="rounded p-1 text-gray-400 transition hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-500/10"
                              aria-label="删除配置"
                            >
                              <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                              </svg>
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </div>
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              <label>
                <FieldLabel>配置名称</FieldLabel>
                <input
                  value={activeProfile.name}
                  onChange={(event) => updateActiveProfile({ name: event.target.value })}
                  onBlur={(event) => commitActiveProfilePatch({ name: event.target.value })}
                  className="w-full rounded-lg border border-gray-200/70 bg-white/70 px-3 py-2 text-sm text-gray-700 outline-none transition focus:border-blue-300 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-200 dark:focus:border-blue-500/50"
                />
              </label>
              <label>
                <FieldLabel>服务商</FieldLabel>
                <Select
                  value={activeProfile.provider}
                  onChange={(value) => switchProvider(value as ApiProfile['provider'])}
                  options={[
                    { label: 'OpenAI 兼容接口', value: 'openai' },
                    { label: 'fal.ai', value: 'fal' },
                  ]}
                  className="rounded-lg border border-gray-200/70 bg-white/70 px-3 py-2 text-sm text-gray-700 outline-none transition dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-200"
                />
              </label>
            </div>

            <div className="mt-3">
              {embeddedSub2Api.active && activeProfile.provider === 'openai' && embeddedSub2Api.apiKeys.length > 0 ? (
                <label>
                  <FieldLabel>API Key</FieldLabel>
                  <Select
                    value={settings.embeddedApiKeyId != null ? String(settings.embeddedApiKeyId) : ''}
                    onChange={handleEmbeddedApiKeyChange}
                    options={embeddedSub2Api.apiKeys.map((item) => ({
                      label: item.status === 'active' ? item.name : `${item.name} (${item.status})`,
                      value: String(item.id),
                    }))}
                    className="rounded-lg border border-gray-200/70 bg-white/70 px-3 py-3 text-base text-gray-700 outline-none transition dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-200"
                  />
                </label>
              ) : (
                <label>
                  <FieldLabel>API Key</FieldLabel>
                  <div className="relative">
                    <input
                      value={activeProfile.apiKey}
                      onChange={(event) => updateActiveProfile({ apiKey: event.target.value })}
                      onBlur={(event) => commitActiveProfilePatch({ apiKey: event.target.value })}
                      type={showApiKey ? 'text' : 'password'}
                      placeholder={activeProfile.provider === 'fal' ? 'FAL_KEY' : 'sk-...'}
                      className="w-full rounded-lg border border-gray-200/70 bg-white/70 px-3 py-3 pr-10 text-base text-gray-700 outline-none transition focus:border-blue-300 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-200 dark:focus:border-blue-500/50"
                    />
                    <button
                      type="button"
                      onClick={() => setShowApiKey((value) => !value)}
                      className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-gray-400 transition hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-white/[0.06] dark:hover:text-gray-200"
                      tabIndex={-1}
                      aria-label={showApiKey ? '隐藏 API Key' : '显示 API Key'}
                    >
                      <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        {showApiKey ? (
                          <>
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.25 12s3.75-6.75 9.75-6.75S21.75 12 21.75 12 18 18.75 12 18.75 2.25 12 2.25 12z" />
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15a3 3 0 100-6 3 3 0 000 6z" />
                          </>
                        ) : (
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 3l18 18M10.58 10.58A2 2 0 0012 14a2 2 0 001.42-3.42M9.88 5.18A9.1 9.1 0 0112 5.25c6 0 9.75 6.75 9.75 6.75a15.8 15.8 0 01-3.1 3.8M6.6 6.62A15.9 15.9 0 002.25 12S6 18.75 12 18.75c1.14 0 2.19-.24 3.15-.64" />
                        )}
                      </svg>
                    </button>
                  </div>
                </label>
              )}
              {embeddedSub2Api.active && embeddedSub2Api.error && (
                <div data-selectable-text className="mt-1 text-xs text-red-500 dark:text-red-400">{embeddedSub2Api.error}</div>
              )}
            </div>
          </section>

          <section className="rounded-xl border border-gray-200/70 bg-white/45 p-4 dark:border-white/[0.08] dark:bg-white/[0.03]">
            <div className="mb-3">
              <h4 className="text-sm font-semibold text-gray-800 dark:text-gray-100">API 接口与模型</h4>
              <p className="mt-0.5 text-xs text-gray-400 dark:text-gray-500">选择生成接口、模型和请求目标。</p>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              {activeProfile.provider === 'openai' && (
                <label>
                  <FieldLabel>API 接口</FieldLabel>
                  <Select
                    value={activeProfile.apiMode ?? DEFAULT_SETTINGS.apiMode}
                    onChange={(value) => {
                      const apiMode = value as AppSettings['apiMode']
                      const nextModel =
                        activeProfile.model === DEFAULT_IMAGES_MODEL || activeProfile.model === DEFAULT_RESPONSES_MODEL
                          ? getDefaultModelForMode(apiMode)
                          : activeProfile.model
                      updateActiveProfile({ apiMode, model: nextModel }, true)
                    }}
                    options={[
                      { label: 'Images API (/v1/images)', value: 'images' },
                      { label: 'Responses API (/v1/responses)', value: 'responses' },
                    ]}
                    className="rounded-lg border border-gray-200/70 bg-white/70 px-3 py-2 text-sm text-gray-700 outline-none transition dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-200"
                  />
                </label>
              )}
              <label>
                <FieldLabel>模型 ID</FieldLabel>
                <input
                  value={activeProfile.model}
                  onChange={(event) => updateActiveProfile({ model: event.target.value })}
                  onBlur={(event) => commitActiveProfilePatch({ model: event.target.value })}
                  placeholder={activeProfile.provider === 'fal' ? DEFAULT_FAL_MODEL : getDefaultModelForMode(activeProfile.apiMode ?? DEFAULT_SETTINGS.apiMode)}
                  className="w-full rounded-lg border border-gray-200/70 bg-white/70 px-3 py-2 text-sm text-gray-700 outline-none transition focus:border-blue-300 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-200 dark:focus:border-blue-500/50"
                />
              </label>
              {activeProfile.provider === 'openai' ? (
                <label className="md:col-span-2">
                  <FieldLabel>图片 API 地址</FieldLabel>
                  <input
                    value={activeProfile.imageApiBaseUrl ?? ''}
                    onChange={(event) => updateActiveProfile({ imageApiBaseUrl: event.target.value })}
                    onBlur={(event) => commitActiveProfilePatch({ imageApiBaseUrl: event.target.value })}
                    disabled={apiProxyEnabled}
                    placeholder={DEFAULT_IMAGE_API_BASE_URL}
                    className={`w-full rounded-lg border border-gray-200/70 bg-white/70 px-3 py-2 text-sm text-gray-700 outline-none transition focus:border-blue-300 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-200 dark:focus:border-blue-500/50 ${apiProxyEnabled ? 'cursor-not-allowed opacity-50' : ''}`}
                  />
                </label>
              ) : (
                <label className="md:col-span-2">
                  <FieldLabel>fal.ai Base URL</FieldLabel>
                  <input
                    value={activeProfile.baseUrl}
                    onChange={(event) => updateActiveProfile({ baseUrl: event.target.value })}
                    onBlur={(event) => commitActiveProfilePatch({ baseUrl: event.target.value })}
                    placeholder={DEFAULT_FAL_BASE_URL}
                    className="w-full rounded-lg border border-gray-200/70 bg-white/70 px-3 py-2 text-sm text-gray-700 outline-none transition focus:border-blue-300 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-200 dark:focus:border-blue-500/50"
                  />
                </label>
              )}
              {activeProfile.provider === 'openai' && (
                <label>
                  <FieldLabel>请求超时（秒）</FieldLabel>
                  <input
                    value={timeoutInput}
                    onChange={(event) => setTimeoutInput(event.target.value)}
                    onBlur={commitTimeout}
                    type="number"
                    min={10}
                    max={1200}
                    className="w-full rounded-lg border border-gray-200/70 bg-white/70 px-3 py-2 text-sm text-gray-700 outline-none transition focus:border-blue-300 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-200 dark:focus:border-blue-500/50"
                  />
                </label>
              )}
            </div>

            {activeProfile.provider === 'openai' && (
              <div className="mt-3 divide-y divide-gray-200/70 overflow-hidden rounded-lg border border-gray-200/70 bg-white/45 dark:divide-white/[0.08] dark:border-white/[0.08] dark:bg-white/[0.02]">
                {apiProxyAvailable && (
                  <div className="flex min-h-[44px] items-center justify-between gap-4 px-3">
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-gray-700 dark:text-gray-200">使用同源 API 代理</div>
                      <div className="text-xs text-gray-400 dark:text-gray-500">开启后请求目标由部署端决定。</div>
                    </div>
                    <Toggle checked={activeProfile.apiProxy} onChange={() => updateActiveProfile({ apiProxy: !activeProfile.apiProxy }, true)} label="使用同源 API 代理" />
                  </div>
                )}
                <div className="flex min-h-[44px] items-center justify-between gap-4 px-3">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-gray-700 dark:text-gray-200">Codex CLI 兼容模式</div>
                    <div className="text-xs text-gray-400 dark:text-gray-500">修正无效参数并降低提示词被改写的概率。</div>
                  </div>
                  <Toggle checked={activeProfile.codexCli} onChange={() => updateActiveProfile({ codexCli: !activeProfile.codexCli }, true)} label="Codex CLI 兼容模式" />
                </div>
              </div>
            )}
          </section>

          <section className="rounded-xl border border-gray-200/70 bg-white/45 p-4 dark:border-white/[0.08] dark:bg-white/[0.03]">
            <div className="mb-3">
              <h4 className="text-sm font-semibold text-gray-800 dark:text-gray-100">使用习惯</h4>
              <p className="mt-0.5 text-xs text-gray-400 dark:text-gray-500">调整日常生成时的输入行为。</p>
            </div>
            <div className="flex min-h-[44px] items-center justify-between gap-4 rounded-lg border border-gray-200/70 bg-white/45 px-3 dark:border-white/[0.08] dark:bg-white/[0.02]">
              <div className="min-w-0 text-sm font-medium text-gray-700 dark:text-gray-200">提交后清空输入框</div>
              <Toggle
                checked={draft.clearInputAfterSubmit}
                onChange={() => commitSettingsPatch({ clearInputAfterSubmit: !draft.clearInputAfterSubmit })}
                label="提交后清空输入框"
              />
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
