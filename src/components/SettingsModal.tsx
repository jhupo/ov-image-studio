import { useCallback, useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import {
  DEFAULT_IMAGES_MODEL,
  DEFAULT_RESPONSES_MODEL,
  DEFAULT_SETTINGS,
  getActiveApiProfile,
  normalizeSettings,
} from '../lib/apiProfiles'
import type { ApiProfile, AppSettings } from '../types'
import { useCloseOnEscape } from '../hooks/useCloseOnEscape'
import { putSettings } from '../lib/db'
import Select from './Select'

function getDefaultModelForMode(apiMode: AppSettings['apiMode']) {
  return apiMode === 'responses' ? DEFAULT_RESPONSES_MODEL : DEFAULT_IMAGES_MODEL
}

function SectionTitle({
  icon,
  title,
}: {
  icon: React.ReactNode
  title: string
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="flex h-5 w-5 items-center justify-center text-blue-500 dark:text-blue-400">{icon}</span>
      <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">{title}</h3>
    </div>
  )
}

function FieldLabel({
  title,
}: {
  title: string
}) {
  return (
    <div className="mb-2">
      <div className="text-xs font-medium text-gray-700 dark:text-gray-200">{title}</div>
    </div>
  )
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
      className={`relative inline-flex h-[22px] w-10 shrink-0 items-center rounded-full transition-colors ${
        checked ? 'bg-blue-500' : 'bg-gray-300 dark:bg-gray-600'
      }`}
      role="switch"
      aria-checked={checked}
      aria-label={label}
    >
      <span
        className={`inline-block h-[18px] w-[18px] transform rounded-full bg-white shadow transition-transform ${
          checked ? 'translate-x-5' : 'translate-x-0.5'
        }`}
      />
    </button>
  )
}

function KeyIcon() {
  return (
    <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.75 7.5a4.5 4.5 0 11-8.24 2.5L3 14.5V18h3.5l1-1H10v-2.5h2.5l1.25-1.25A4.48 4.48 0 0115.75 7.5z" />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 6.5h.01" />
    </svg>
  )
}

function SlidersIcon() {
  return (
    <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 7h10M18 7h2M4 17h3M11 17h9" />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5v4M8 15v4" />
    </svg>
  )
}

function TerminalIcon() {
  return (
    <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 6h14v12H5z" />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 10l2 2-2 2M12 15h4" />
    </svg>
  )
}

function UploadIcon() {
  return (
    <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 16V4m0 0L7 9m5-5l5 5M5 14v4h14v-4" />
    </svg>
  )
}

export default function SettingsModal() {
  const showSettings = useStore((s) => s.showSettings)
  const setShowSettings = useStore((s) => s.setShowSettings)
  const settings = useStore((s) => s.settings)
  const setSettings = useStore((s) => s.setSettings)
  const embeddedSub2Api = useStore((s) => s.embeddedSub2Api)
  const showToast = useStore((s) => s.showToast)

  const [draft, setDraft] = useState<AppSettings>(normalizeSettings(settings))
  const [showApiKey, setShowApiKey] = useState(false)
  const [apiKeyError, setApiKeyError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const wasSettingsOpenRef = useRef(false)

  const activeProfile = draft.profiles.find((profile) => profile.id === draft.activeProfileId) ?? getActiveApiProfile(draft)

  useEffect(() => {
    if (!showSettings) {
      wasSettingsOpenRef.current = false
      return
    }
    if (wasSettingsOpenRef.current) return

    wasSettingsOpenRef.current = true
    setApiKeyError(null)
    setDraft(normalizeSettings(settings))
  }, [showSettings, settings])

  const patchActiveProfile = useCallback((patch: Partial<ApiProfile>) => {
    setDraft((current) => normalizeSettings({
      ...current,
      profiles: current.profiles.map((profile) => {
        if (profile.id !== current.activeProfileId) return profile
        return { ...profile, ...patch }
      }),
    }))
  }, [])

  const patchSettings = useCallback((patch: Partial<AppSettings>) => {
    setDraft((current) => normalizeSettings({ ...current, ...patch }))
  }, [])

  const saveSettings = useCallback(async () => {
    if (saving) return
    const profile = draft.profiles.find((item) => item.id === draft.activeProfileId) ?? activeProfile
    const apiKey = profile.apiKey.trim()
    if (!apiKey) {
      setApiKeyError('请先填写 API 凭证')
      showToast('请先填写 API 凭证', 'error')
      return
    }

    const model = profile.model.trim() || getDefaultModelForMode(profile.apiMode ?? DEFAULT_SETTINGS.apiMode)
    const nextSettings = normalizeSettings({
      ...draft,
      profiles: draft.profiles.map((item) =>
        item.id === profile.id
          ? {
              ...item,
              apiKey,
              model,
              codexCli: item.provider === 'openai' ? item.codexCli : false,
            }
          : item,
      ),
    })
    try {
      setSaving(true)
      await putSettings(nextSettings)
      setSettings(nextSettings)
      setApiKeyError(null)
      showToast('设置已保存', 'success')
      setShowSettings(false)
    } catch (error) {
      showToast(`设置保存失败：${error instanceof Error ? error.message : String(error)}`, 'error')
    } finally {
      setSaving(false)
    }
  }, [activeProfile, draft, saving, setSettings, setShowSettings, showToast])

  const handleCancel = useCallback(() => {
    setDraft(normalizeSettings(settings))
    setApiKeyError(null)
    setSaving(false)
    setShowSettings(false)
  }, [settings, setShowSettings])

  useCloseOnEscape(showSettings, handleCancel)

  if (!showSettings) return null

  const apiMode = activeProfile.apiMode ?? DEFAULT_SETTINGS.apiMode

  return (
    <div data-no-drag-select className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm animate-overlay-in" onClick={handleCancel} />
      <div className="relative z-10 w-full max-w-[780px] rounded-3xl border border-white/50 bg-white/95 p-5 shadow-2xl ring-1 ring-black/5 animate-modal-in dark:border-white/[0.08] dark:bg-gray-900/95 dark:ring-white/10">
        <div className="mb-4 flex items-center justify-between gap-4">
          <SectionTitle icon={<KeyIcon />} title="API 设置" />
          <button
            type="button"
            onClick={handleCancel}
            className="rounded-full p-1.5 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-white/[0.06] dark:hover:text-gray-200"
            aria-label="关闭"
          >
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <section className="rounded-2xl border border-gray-200/70 bg-white/45 p-4 dark:border-white/[0.08] dark:bg-white/[0.03]">
          <FieldLabel title="API 凭证" />
          {embeddedSub2Api.active && activeProfile.provider === 'openai' && embeddedSub2Api.apiKeys.length > 0 ? (
            <Select
              value={draft.embeddedApiKeyId != null ? String(draft.embeddedApiKeyId) : ''}
              onChange={(value) => {
                const selectedId = Number(value)
                const selectedApiKey = embeddedSub2Api.apiKeys.find((item) => item.id === selectedId)
                if (!selectedApiKey) return
                setApiKeyError(null)
                patchSettings({ embeddedApiKeyId: selectedApiKey.id })
                patchActiveProfile({
                  provider: 'openai',
                  baseUrl: embeddedSub2Api.origin || activeProfile.baseUrl,
                  apiKey: selectedApiKey.key,
                })
              }}
              options={embeddedSub2Api.apiKeys.map((item) => ({
                label: item.status === 'active' ? item.name : `${item.name} (${item.status})`,
                value: String(item.id),
              }))}
              className="h-9 rounded-xl border border-gray-200/70 bg-white/60 px-3 text-xs text-gray-700 outline-none transition focus:border-blue-300 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-200 dark:focus:border-blue-500/50"
            />
          ) : (
            <div className="relative">
              <input
                value={activeProfile.apiKey}
                onChange={(event) => {
                  if (apiKeyError) setApiKeyError(null)
                  patchActiveProfile({ apiKey: event.target.value })
                }}
                type={showApiKey ? 'text' : 'password'}
                placeholder={activeProfile.provider === 'fal' ? 'FAL_KEY' : 'sk-...'}
                className={`h-9 w-full rounded-xl border bg-white/60 px-3 pr-11 text-xs text-gray-700 outline-none transition dark:bg-white/[0.03] dark:text-gray-200 ${
                  apiKeyError
                    ? 'border-red-300 focus:border-red-400 dark:border-red-500/40'
                    : 'border-gray-200/70 focus:border-blue-300 dark:border-white/[0.08] dark:focus:border-blue-500/50'
                }`}
              />
              <button
                type="button"
                onClick={() => setShowApiKey((value) => !value)}
                className="absolute right-1.5 top-1/2 flex h-7 w-9 -translate-y-1/2 items-center justify-center rounded-lg border border-gray-200/70 text-gray-400 transition hover:bg-gray-50 hover:text-gray-600 dark:border-white/[0.08] dark:hover:bg-white/[0.06] dark:hover:text-gray-200"
                aria-label={showApiKey ? '隐藏 API Key' : '显示 API Key'}
              >
                {showApiKey ? (
                  <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15a3 3 0 100-6 3 3 0 000 6z" />
                  </svg>
                ) : (
                  <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 3l18 18M10.58 10.58A2 2 0 0012 14a2 2 0 001.42-3.42M9.88 5.18A9.1 9.1 0 0112 5.25c6 0 9.75 6.75 9.75 6.75a15.8 15.8 0 01-3.1 3.8M6.6 6.62A15.9 15.9 0 002.25 12S6 18.75 12 18.75c1.14 0 2.19-.24 3.15-.64" />
                  </svg>
                )}
              </button>
            </div>
          )}
          {embeddedSub2Api.active && embeddedSub2Api.error && (
            <div data-selectable-text className="mt-2 text-xs text-red-500 dark:text-red-400">{embeddedSub2Api.error}</div>
          )}
          {apiKeyError && (
            <div data-selectable-text className="mt-2 text-xs text-red-500 dark:text-red-400">{apiKeyError}</div>
          )}

          <div className="mt-4">
            <FieldLabel title="API 接口" />
            <Select
              value={apiMode}
              onChange={(value) => {
                const nextApiMode = value as AppSettings['apiMode']
                const nextModel =
                  activeProfile.model === DEFAULT_IMAGES_MODEL || activeProfile.model === DEFAULT_RESPONSES_MODEL
                    ? getDefaultModelForMode(nextApiMode)
                    : activeProfile.model
                patchActiveProfile({ apiMode: nextApiMode, model: nextModel })
              }}
              options={[
                { label: 'Images API (v1/images)', value: 'images' },
                { label: 'Responses API (v1/responses)', value: 'responses' },
              ]}
              disabled={activeProfile.provider !== 'openai'}
              className="h-9 rounded-xl border border-gray-200/70 bg-white/60 px-3 text-xs text-gray-800 outline-none transition focus:border-blue-300 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-100 dark:focus:border-blue-500/50"
            />
          </div>
        </section>

        <div className="my-5 border-t border-gray-200/70 dark:border-white/[0.08]" />

        <div className="mb-3">
          <SectionTitle icon={<SlidersIcon />} title="通用设置" />
        </div>
        <section className="overflow-hidden rounded-2xl border border-gray-200/70 bg-white/45 dark:border-white/[0.08] dark:bg-white/[0.03]">
          <div className="flex min-h-[52px] items-center justify-between gap-4 px-4">
            <div className="flex min-w-0 items-center gap-4">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-blue-500/40 text-blue-500 dark:text-blue-400">
                <TerminalIcon />
              </span>
              <div className="min-w-0">
                <div className="text-xs font-semibold text-gray-800 dark:text-gray-100">Codex CLI 兼容模式</div>
                <div className="mt-0.5 text-[11px] text-gray-500 dark:text-gray-400">启用后，将以 Codex CLI 兼容模式运行</div>
              </div>
            </div>
            <Toggle
              checked={activeProfile.codexCli}
              onChange={() => patchActiveProfile({ codexCli: !activeProfile.codexCli })}
              label="Codex CLI 兼容模式"
            />
          </div>
          <div className="border-t border-gray-200/70 dark:border-white/[0.08]" />
          <div className="flex min-h-[52px] items-center justify-between gap-4 px-4">
            <div className="flex min-w-0 items-center gap-4">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-blue-500 dark:text-blue-400">
                <UploadIcon />
              </span>
              <div className="min-w-0">
                <div className="text-xs font-semibold text-gray-800 dark:text-gray-100">提交后清空输入框</div>
                <div className="mt-0.5 text-[11px] text-gray-500 dark:text-gray-400">提交后自动清空输入框内容</div>
              </div>
            </div>
            <Toggle
              checked={draft.clearInputAfterSubmit}
              onChange={() => patchSettings({ clearInputAfterSubmit: !draft.clearInputAfterSubmit })}
              label="提交后清空输入框"
            />
          </div>
        </section>

        <div className="mt-4 flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={handleCancel}
            className="h-9 min-w-20 rounded-xl border border-gray-200/70 bg-white/50 px-4 text-xs font-medium text-gray-700 transition hover:bg-gray-50 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-gray-200 dark:hover:bg-white/[0.08]"
          >
            取消
          </button>
          <button
            type="button"
            onClick={saveSettings}
            disabled={saving}
            className="h-9 min-w-20 rounded-xl bg-blue-500 px-4 text-xs font-medium text-white shadow transition hover:bg-blue-600 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {saving ? '保存中' : '保存'}
          </button>
        </div>
      </div>
    </div>
  )
}
