import { useEffect, useRef, useState, useCallback } from 'react'
import { isApiProxyAvailable, readClientDevProxyConfig } from '../lib/devProxy'
import { useStore } from '../store'
import {
  createDefaultOpenAIProfile,
  DEFAULT_FAL_BASE_URL,
  DEFAULT_FAL_MODEL,
  DEFAULT_IMAGES_MODEL,
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
  
  const apiProxyAvailable = isApiProxyAvailable(readClientDevProxyConfig())
  const activeProfile = draft.profiles.find((profile) => profile.id === draft.activeProfileId) ?? draft.profiles[0] ?? getActiveApiProfile(draft)
  const apiProxyEnabled = apiProxyAvailable && activeProfile.provider === 'openai' && activeProfile.apiProxy

  const getDefaultModelForMode = (apiMode: AppSettings['apiMode']) =>
    apiMode === 'responses' ? DEFAULT_RESPONSES_MODEL : DEFAULT_IMAGES_MODEL

  const wasSettingsOpenRef = useRef(false)

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

  const commitTimeout = useCallback(() => {
    if (activeProfile.provider !== 'openai') return
    const nextTimeout = Number(timeoutInput)
    const normalizedTimeout =
      timeoutInput.trim() === '' ? DEFAULT_SETTINGS.timeout : Number.isNaN(nextTimeout) ? activeProfile.timeout : nextTimeout
    setTimeoutInput(String(normalizedTimeout))
    updateActiveProfile({ timeout: normalizedTimeout }, true)
  }, [draft, activeProfile.id, activeProfile.provider, activeProfile.timeout, timeoutInput])

  useCloseOnEscape(showSettings, handleClose)

  if (!showSettings) return null

  const createNewProfile = () => {
    const profile = createDefaultOpenAIProfile({ id: newId('openai'), name: '新配置' })
    const nextDraft = normalizeSettings({ 
        ...draft, 
        profiles: [...draft.profiles, profile],
        activeProfileId: profile.id
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

  return (
    <div data-no-drag-select className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/30 backdrop-blur-sm animate-overlay-in"
        onClick={handleClose}
      />
      <div
        className="relative z-10 w-full max-w-2xl rounded-3xl border border-white/50 bg-white/95 p-6 shadow-2xl ring-1 ring-black/5 animate-modal-in dark:border-white/[0.08] dark:bg-gray-900/95 dark:ring-white/10 overflow-y-auto max-h-[88vh] custom-scrollbar"
      >
        <div className="mb-5 flex items-center justify-between gap-4">
          <h3 className="text-base font-semibold text-gray-800 dark:text-gray-100 flex items-center gap-2">
            <svg className="w-5 h-5 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            设置
          </h3>
          <div className="flex items-center gap-3">
            <span className="text-xs text-gray-400 dark:text-gray-500 font-mono select-none">v{__APP_VERSION__}</span>
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
          <section className="space-y-4">
            <div className="hidden">
                <button
                  type="button"
                  onClick={() => setShowProfileMenu(!showProfileMenu)}
                  className="flex w-full min-w-0 items-center justify-between gap-2 rounded-xl border border-gray-200/70 bg-white/60 px-3 py-2 text-sm text-gray-700 outline-none transition hover:bg-gray-50 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-200 dark:hover:bg-white/[0.06]"
                  title={activeProfile.name}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="min-w-0 truncate">{activeProfile.name}</span>
                    <span className="shrink-0 rounded bg-blue-50 px-1.5 py-0.5 text-[10px] font-medium text-blue-600 dark:bg-blue-500/10 dark:text-blue-400">
                      {providerLabel(activeProfile.provider)}
                    </span>
                  </span>
                  <svg className={`w-3.5 h-3.5 flex-shrink-0 text-gray-400 dark:text-gray-500 transition-transform duration-200 ${showProfileMenu ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </button>
                
                {showProfileMenu && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setShowProfileMenu(false)} />
                    <div className="absolute right-0 top-full z-50 mt-1.5 max-h-60 w-full overflow-hidden overflow-y-auto rounded-xl border border-gray-200/60 bg-white/95 py-1 shadow-[0_8px_30px_rgb(0,0,0,0.12)] ring-1 ring-black/5 backdrop-blur-xl animate-dropdown-down dark:border-white/[0.08] dark:bg-gray-900/95 dark:shadow-[0_8px_30px_rgb(0,0,0,0.3)] dark:ring-white/10 custom-scrollbar">
                      <button
                        type="button"
                        onClick={createNewProfile}
                        className="flex w-full cursor-pointer items-center justify-between gap-2 px-3 py-2 text-left text-xs font-medium text-blue-600 transition-colors hover:bg-blue-50 dark:text-blue-400 dark:hover:bg-blue-500/10"
                      >
                        <span className="truncate">创建新配置</span>
                        <span className="flex h-5 w-5 shrink-0 items-center justify-center">
                          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                          </svg>
                        </span>
                      </button>
                      <div>
                        {draft.profiles.map(profile => (
                          <div
                            key={profile.id}
                            title={profile.name}
                            className={`group flex w-full cursor-pointer items-center justify-between px-3 py-2 text-left text-xs transition-colors ${profile.id === activeProfile.id ? 'bg-blue-50 font-medium text-blue-600 dark:bg-blue-500/10 dark:text-blue-400' : 'text-gray-700 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-white/[0.06]'}`}
                          >
                            <button
                              type="button"
                              onClick={() => switchProfile(profile.id)}
                              className="flex min-w-0 flex-1 items-center gap-2 pr-2"
                            >
                              <span className="min-w-0 truncate">{profile.name}</span>
                              <span className={`rounded px-1.5 py-0.5 text-[10px] shrink-0 ${profile.id === activeProfile.id ? 'bg-blue-100 text-blue-700 dark:bg-blue-500/20 dark:text-blue-300' : 'bg-gray-100 text-gray-500 dark:bg-white/[0.08] dark:text-gray-400'}`}>
                                {providerLabel(profile.provider)}
                              </span>
                            </button>
                            
                            {draft.profiles.length > 1 && (
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  setConfirmDialog({
                                    title: '删除配置',
                                    message: `确定要删除配置「${profile.name}」吗？`,
                                    action: () => deleteProfile(profile.id)
                                  })
                                }}
                                className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-gray-400 opacity-60 transition-all hover:bg-red-50 hover:text-red-500 hover:opacity-100 dark:hover:bg-red-500/10"
                                aria-label="删除配置"
                              >
                                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                                </svg>
                              </button>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  </>
                )}
              </div>

            <div className="space-y-4">
              <label className="hidden">
                <span className="mb-1 block text-xs text-gray-500 dark:text-gray-400">配置名称</span>
                <input
                  value={activeProfile.name}
                  onChange={(e) => updateActiveProfile({ name: e.target.value })}
                  onBlur={(e) => commitActiveProfilePatch({ name: e.target.value })}
                  type="text"
                  className="w-full rounded-xl border border-gray-200/70 bg-white/60 px-3 py-2 text-sm text-gray-700 outline-none transition focus:border-blue-300 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-200 dark:focus:border-blue-500/50"
                />
              </label>

              <label className="hidden">
                <span className="mb-1 block text-xs text-gray-500 dark:text-gray-400">服务商类型</span>
                <Select
                  value={activeProfile.provider}
                  onChange={(value) => updateActiveProfile(switchApiProfileProvider(activeProfile, value as ApiProfile['provider']), true)}
                  options={[{ label: 'OpenAI 兼容接口', value: 'openai' }, { label: 'fal.ai', value: 'fal' }]}
                  className="w-full rounded-xl border border-gray-200/70 bg-white/60 px-3 py-2 text-sm text-gray-700 outline-none transition focus:border-blue-300 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-200 dark:focus:border-blue-500/50"
                />
              </label>

              {activeProfile.provider === 'openai' && (
                <label className="hidden">
                  <div className="mb-1 flex items-center justify-between">
                    <span className="block text-xs text-gray-500 dark:text-gray-400">API URL</span>
                    <div
                      onClick={(e) => {
                        e.preventDefault()
                        updateActiveProfile({ codexCli: !activeProfile.codexCli }, true)
                      }}
                      className="flex cursor-pointer items-center gap-1.5"
                      role="switch"
                      aria-checked={activeProfile.codexCli}
                    >
                      <span className={`text-[10px] transition-colors ${activeProfile.codexCli ? 'text-blue-500 dark:text-blue-400' : 'text-gray-400 dark:text-gray-500'}`}>Codex CLI</span>
                      <span className={`relative inline-flex h-3.5 w-6 items-center rounded-full transition-colors ${activeProfile.codexCli ? 'bg-blue-500' : 'bg-gray-300 dark:bg-gray-600'}`}>
                        <span className={`inline-block h-2.5 w-2.5 transform rounded-full bg-white shadow transition-transform ${activeProfile.codexCli ? 'translate-x-[11px]' : 'translate-x-[2px]'}`} />
                      </span>
                    </div>
                  </div>
                  <input
                    value={activeProfile.baseUrl}
                    onChange={(e) => updateActiveProfile({ baseUrl: e.target.value })}
                    onBlur={(e) => commitActiveProfilePatch({ baseUrl: e.target.value })}
                    type="text"
                    disabled={apiProxyEnabled}
                    placeholder={DEFAULT_SETTINGS.baseUrl}
                    className={`w-full rounded-xl border border-gray-200/70 bg-white/60 px-3 py-2 text-sm text-gray-700 outline-none transition focus:border-blue-300 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-200 dark:focus:border-blue-500/50 ${apiProxyEnabled ? 'opacity-50 cursor-not-allowed' : ''}`}
                  />
                  <div data-selectable-text className="mt-1 min-h-[22px] flex items-center text-[10px] text-gray-400 dark:text-gray-500">
                    {apiProxyEnabled ? (
                      <span className="text-yellow-600 dark:text-yellow-500">已开启代理，实际请求目标由部署端决定，此处设置被忽略。</span>
                    ) : (
                      <span>支持通过查询参数覆盖：<code className="bg-gray-100 dark:bg-white/[0.06] px-1 py-0.5 rounded">?apiUrl=</code>，<code className="bg-gray-100 dark:bg-white/[0.06] px-1 py-0.5 rounded">codexCli=true</code></span>
                    )}
                  </div>
                </label>
              )}

              {apiProxyAvailable && activeProfile.provider === 'openai' && (
                <div className="hidden">
                  <div className="mb-1 flex items-center justify-between">
                    <span className="block text-xs text-gray-500 dark:text-gray-400">API 代理</span>
                    <button
                      type="button"
                      onClick={() => updateActiveProfile({ apiProxy: !activeProfile.apiProxy }, true)}
                      className={`relative inline-flex h-3.5 w-6 items-center rounded-full transition-colors ${activeProfile.apiProxy ? 'bg-blue-500' : 'bg-gray-300 dark:bg-gray-600'}`}
                      role="switch"
                      aria-checked={activeProfile.apiProxy}
                      aria-label="API 代理"
                    >
                      <span className={`inline-block h-2.5 w-2.5 transform rounded-full bg-white shadow transition-transform ${activeProfile.apiProxy ? 'translate-x-[11px]' : 'translate-x-[2px]'}`} />
                    </button>
                  </div>
                  <div data-selectable-text className="text-[10px] text-gray-400 dark:text-gray-500">
                    由当前部署提供同源代理，用于解决浏览器跨域限制；开启后 API URL 设置会被忽略。
                  </div>
                </div>
              )}

              {embeddedSub2Api.active && activeProfile.provider === 'openai' && embeddedSub2Api.apiKeys.length > 0 ? (
                <label className="block">
                  <span className="block text-xs text-gray-500 dark:text-gray-400 mb-1">API Key</span>
                  <Select
                    value={settings.embeddedApiKeyId != null ? String(settings.embeddedApiKeyId) : ''}
                    onChange={handleEmbeddedApiKeyChange}
                    options={embeddedSub2Api.apiKeys.map((item) => ({
                      label: item.status === 'active' ? `${item.name}` : `${item.name} (${item.status})`,
                      value: String(item.id),
                    }))}
                    className="w-full rounded-xl border border-gray-200/70 bg-white/60 px-3 py-3 text-base text-gray-700 outline-none transition focus:border-blue-300 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-200 dark:focus:border-blue-500/50"
                  />
                </label>
              ) : (
                <div className="block">
                  <span className="block text-xs text-gray-500 dark:text-gray-400 mb-1">API Key</span>
                  <div className="relative">
                    <input
                      value={activeProfile.apiKey}
                      onChange={(e) => updateActiveProfile({ apiKey: e.target.value })}
                      onBlur={(e) => commitActiveProfilePatch({ apiKey: e.target.value })}
                      type={showApiKey ? 'text' : 'password'}
                      placeholder={activeProfile.provider === 'fal' ? 'FAL_KEY' : 'sk-...'}
                      className="w-full rounded-xl border border-gray-200/70 bg-white/60 px-3 py-3 pr-10 text-base text-gray-700 outline-none transition focus:border-blue-300 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-200 dark:focus:border-blue-500/50"
                    />
                    <button
                      type="button"
                      onClick={() => setShowApiKey((v) => !v)}
                      className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-gray-400 hover:text-gray-600 transition-colors"
                      tabIndex={-1}
                    >
                      {showApiKey ? (
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                          <circle cx="12" cy="12" r="3" />
                        </svg>
                      ) : (
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                          <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
                          <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
                          <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" />
                          <line x1="1" y1="1" x2="23" y2="23" />
                        </svg>
                      )}
                    </button>
                  </div>
                  {embeddedSub2Api.active && embeddedSub2Api.error && (
                    <div data-selectable-text className="mt-1 min-h-[22px] flex items-center text-[10px] text-red-500 dark:text-red-400">
                      <span>{embeddedSub2Api.error}</span>
                    </div>
                  )}
                </div>
              )}

              {activeProfile.provider === 'openai' && (
                <label className="block">
                  <span className="block text-xs text-gray-500 dark:text-gray-400 mb-1">API 接口</span>
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
                    className="w-full rounded-xl border border-gray-200/70 bg-white/60 px-3 py-2 text-sm text-gray-700 outline-none transition focus:border-blue-300 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-200 dark:focus:border-blue-500/50"
                  />
                </label>
              )}

              <label className="hidden">
                <span className="block text-xs text-gray-500 dark:text-gray-400 mb-1">
                  模型 ID
                </span>
                <input
                  value={activeProfile.model}
                  onChange={(e) => updateActiveProfile({ model: e.target.value })}
                  onBlur={(e) => commitActiveProfilePatch({ model: e.target.value })}
                  type="text"
                  placeholder={activeProfile.provider === 'fal' ? DEFAULT_FAL_MODEL : getDefaultModelForMode(activeProfile.apiMode ?? DEFAULT_SETTINGS.apiMode)}
                  className="w-full rounded-xl border border-gray-200/70 bg-white/60 px-3 py-2 text-sm text-gray-700 outline-none transition focus:border-blue-300 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-200 dark:focus:border-blue-500/50"
                />
                <div data-selectable-text className="mt-1 text-[10px] text-gray-400 dark:text-gray-500">
                  {activeProfile.provider === 'fal' ? (
                    <>当前适配 <code className="rounded bg-gray-100 px-1 py-0.5 dark:bg-white/[0.06]">{DEFAULT_FAL_MODEL}</code>。</>
                  ) : (activeProfile.apiMode ?? DEFAULT_SETTINGS.apiMode) === 'responses' ? (
                    <>Responses API 需要使用支持 <code className="rounded bg-gray-100 px-1 py-0.5 dark:bg-white/[0.06]">image_generation</code> 工具的文本模型，例如 <code className="rounded bg-gray-100 px-1 py-0.5 dark:bg-white/[0.06]">{DEFAULT_RESPONSES_MODEL}</code>。</>
                  ) : (
                    <>Images API 需要使用 GPT Image 模型，例如 <code className="rounded bg-gray-100 px-1 py-0.5 dark:bg-white/[0.06]">{DEFAULT_IMAGES_MODEL}</code>。</>
                  )}
                </div>
              </label>

              {activeProfile.provider === 'openai' && (
                <label className="hidden">
                  <span className="block text-xs text-gray-500 dark:text-gray-400 mb-1">请求超时 (秒)</span>
                  <input
                    value={timeoutInput}
                    onChange={(e) => setTimeoutInput(e.target.value)}
                    onBlur={commitTimeout}
                    type="number"
                    min={10}
                    max={600}
                    className="w-full rounded-xl border border-gray-200/70 bg-white/60 px-3 py-2 text-sm text-gray-700 outline-none transition focus:border-blue-300 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-200 dark:focus:border-blue-500/50"
                  />
                </label>
              )}
            </div>
          </section>

        </div>
      </div>
    </div>
  )
}
