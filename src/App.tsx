import { useEffect } from 'react'
import { ensureLocalBackendTaskPoll, initStore } from './store'
import { useStore } from './store'
import { normalizeBaseUrl } from './lib/api'
import { normalizeSettings, switchApiProfileProvider } from './lib/apiProfiles'
import type { ApiMode, ApiProvider, AppSettings } from './types'
import { detectEmbeddedSub2ApiContext, fetchEmbeddedSub2ApiKeys, getEmbeddedSub2ApiToken } from './lib/sub2apiEmbedded'
import Header from './components/Header'
import SearchBar from './components/SearchBar'
import TaskGrid from './components/TaskGrid'
import InputBar from './components/InputBar'
import DetailModal from './components/DetailModal'
import Lightbox from './components/Lightbox'
import SettingsModal from './components/SettingsModal'
import ConfirmDialog from './components/ConfirmDialog'
import Toast from './components/Toast'
import MaskEditorModal from './components/MaskEditorModal'
import ImageContextMenu from './components/ImageContextMenu'

export default function App() {
  const setSettings = useStore((s) => s.setSettings)
  const setEmbeddedSub2Api = useStore((s) => s.setEmbeddedSub2Api)
  const showToast = useStore((s) => s.showToast)
  const tasks = useStore((s) => s.tasks)

  useEffect(() => {
    let cancelled = false

    void (async () => {
      await initStore()
      if (cancelled) return

      const searchParams = new URLSearchParams(window.location.search)
      const nextSettings: Partial<AppSettings> = {}

      const apiUrlParam = searchParams.get('apiUrl')
      const imageApiUrlParam = searchParams.get('imageApiUrl')
      const adminApiUrlParam = searchParams.get('adminApiUrl')
      const normalizedApiUrl = normalizeBaseUrl(adminApiUrlParam ?? apiUrlParam ?? '')
      if (normalizedApiUrl) {
        nextSettings.baseUrl = normalizedApiUrl
        nextSettings.embeddedAdminBaseUrl = normalizedApiUrl
      }
      if (imageApiUrlParam !== null) {
        nextSettings.imageApiBaseUrl = normalizeBaseUrl(imageApiUrlParam.trim())
      }

      const apiKeyParam = searchParams.get('apiKey')
      if (apiKeyParam !== null) {
        nextSettings.apiKey = apiKeyParam.trim()
      }

      const adminApiKeyParam = searchParams.get('adminApiKey')
      if (adminApiKeyParam !== null) {
        nextSettings.embeddedAdminApiKey = adminApiKeyParam.trim()
      }

      const codexCliParam = searchParams.get('codexCli')
      if (codexCliParam !== null) {
        nextSettings.codexCli = codexCliParam.trim().toLowerCase() === 'true'
      }

      const apiModeParam = searchParams.get('apiMode')
      if (apiModeParam === 'images' || apiModeParam === 'responses') {
        nextSettings.apiMode = apiModeParam
      }

      const providerParam = searchParams.get('provider')?.trim().toLowerCase()
      if (providerParam) {
        const provider: ApiProvider | null = providerParam === 'fal'
          ? 'fal'
          : ['openai', 'openai-compatible'].includes(providerParam)
            ? 'openai'
            : null
        if (provider) {
          const state = useStore.getState()
          const settings = normalizeSettings(state.settings)
          const current = settings.profiles.find((profile) => profile.id === settings.activeProfileId) ?? settings.profiles[0]
          if (current) {
            nextSettings.profiles = settings.profiles.map((profile) =>
              profile.id === current.id
                ? {
                    ...switchApiProfileProvider(profile, provider),
                    ...(nextSettings.apiKey !== undefined ? { apiKey: nextSettings.apiKey } : {}),
                    ...(provider === 'openai' && nextSettings.apiMode !== undefined ? { apiMode: nextSettings.apiMode } : {}),
                    ...(provider === 'openai' && nextSettings.codexCli !== undefined ? { codexCli: nextSettings.codexCli } : {}),
                  }
                : profile,
            )
            nextSettings.activeProfileId = current.id
          }
        }
      }

      if (Object.keys(nextSettings).length > 0) setSettings(nextSettings)

      if (searchParams.has('apiUrl') || searchParams.has('imageApiUrl') || searchParams.has('adminApiUrl') || searchParams.has('apiKey') || searchParams.has('adminApiKey') || searchParams.has('codexCli') || searchParams.has('apiMode') || searchParams.has('provider')) {
        searchParams.delete('apiUrl')
        searchParams.delete('imageApiUrl')
        searchParams.delete('adminApiUrl')
        searchParams.delete('apiKey')
        searchParams.delete('adminApiKey')
        searchParams.delete('codexCli')
        searchParams.delete('apiMode')
        searchParams.delete('provider')

        const nextSearch = searchParams.toString()
        const nextUrl = `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ''}${window.location.hash}`
        window.history.replaceState(null, '', nextUrl)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [setSettings])

  useEffect(() => {
    const context = detectEmbeddedSub2ApiContext()
    if (!context.active) {
      setEmbeddedSub2Api({
        active: false,
        origin: '',
        userId: null,
        loading: false,
        error: null,
        apiKeys: [],
      })
      return
    }

    let cancelled = false
    const token = getEmbeddedSub2ApiToken()
    const clearEmbeddedProfileKey = () => {
      const currentSettings = normalizeSettings(useStore.getState().settings)
      const activeProfile = currentSettings.profiles.find((profile) => profile.id === currentSettings.activeProfileId) ?? currentSettings.profiles[0]
      if (!activeProfile) return
      setSettings({
        embeddedApiKeyId: null,
        profiles: currentSettings.profiles.map((profile) =>
          profile.id === activeProfile.id
            ? {
                ...profile,
                provider: 'openai',
                apiKey: '',
              }
            : profile,
        ),
        activeProfileId: activeProfile.id,
      })
    }

    setEmbeddedSub2Api({
      active: true,
      origin: context.origin,
      userId: context.userId,
      loading: true,
      error: null,
      apiKeys: [],
    })
    clearEmbeddedProfileKey()

    void (async () => {
      try {
        const apiKeys = await fetchEmbeddedSub2ApiKeys(token, context.userId ?? 0)
        if (cancelled) return

        setEmbeddedSub2Api({
          active: true,
          origin: context.origin,
          userId: context.userId,
          loading: false,
          error: null,
          apiKeys,
        })

        const refreshedSettings = normalizeSettings(useStore.getState().settings)
        const activeProfile = refreshedSettings.profiles.find((profile) => profile.id === refreshedSettings.activeProfileId) ?? refreshedSettings.profiles[0]
        const selectedApiKeyId = refreshedSettings.embeddedApiKeyId
        const selectedApiKey = apiKeys.find((item) => item.id === selectedApiKeyId)
          ?? apiKeys.find((item) => item.status === 'active')
          ?? apiKeys[0]

        if (!selectedApiKey || !activeProfile) return

        setSettings({
          embeddedApiKeyId: selectedApiKey.id,
          profiles: refreshedSettings.profiles.map((profile) =>
            profile.id === activeProfile.id
              ? {
                  ...profile,
                  provider: 'openai',
                  apiKey: selectedApiKey.key,
                }
              : profile,
          ),
          activeProfileId: activeProfile.id,
        })
      } catch (error) {
        if (cancelled) return
        const message = error instanceof Error ? error.message : String(error)
        clearEmbeddedProfileKey()
        setEmbeddedSub2Api({
          active: true,
          origin: context.origin,
          userId: context.userId,
          loading: false,
          error: message,
          apiKeys: [],
        })
        showToast(message, 'error')
      }
    })()

    return () => {
      cancelled = true
    }
  }, [setEmbeddedSub2Api, setSettings, showToast])

  useEffect(() => {
    const preventPageImageDrag = (e: DragEvent) => {
      if ((e.target as HTMLElement | null)?.closest('img')) {
        e.preventDefault()
      }
    }

    document.addEventListener('dragstart', preventPageImageDrag)
    return () => document.removeEventListener('dragstart', preventPageImageDrag)
  }, [])

  useEffect(() => {
    const ensureRunningPolls = () => {
      for (const task of useStore.getState().tasks) {
        if (task.status === 'running' && task.backendTaskId) {
          ensureLocalBackendTaskPoll(task.id)
        }
      }
    }

    ensureRunningPolls()
    const timer = window.setInterval(ensureRunningPolls, 3000)
    return () => window.clearInterval(timer)
  }, [tasks])

  return (
    <>
      <Header />
      <main data-home-main data-drag-select-surface className="pb-48">
        <div className="safe-area-x max-w-7xl mx-auto">
          <SearchBar />
          <TaskGrid />
        </div>
      </main>
      <InputBar />
      <DetailModal />
      <Lightbox />
      <SettingsModal />
      <ConfirmDialog />
      <Toast />
      <MaskEditorModal />
      <ImageContextMenu />
    </>
  )
}
