import { describe, expect, it } from 'vitest'
import {
  DEFAULT_IMAGE_API_BASE_URL,
  DEFAULT_IMAGES_MODEL,
  DEFAULT_RESPONSES_MODEL,
  DEFAULT_SETTINGS,
  getRuntimeApiProfile,
  mergeImportedSettings,
  normalizeSettings,
  validateSettings,
} from './apiProfiles'

describe('settings normalization', () => {
  it('keeps only user settings fields', () => {
    const settings = normalizeSettings({
      ...DEFAULT_SETTINGS,
      apiKey: 'sk-test',
      apiMode: 'responses',
      codexCli: true,
      clearInputAfterSubmit: true,
      losslessUpscale: true,
      embeddedApiKeyId: 12,
      baseUrl: 'https://legacy.example/v1',
      model: 'legacy-model',
      upscale: { enabled: true },
    })

    expect(settings).toEqual({
      apiKey: 'sk-test',
      apiMode: 'responses',
      codexCli: true,
      clearInputAfterSubmit: true,
      losslessUpscale: true,
      embeddedApiKeyId: 12,
    })
  })

  it('defaults lossless upscaling to off', () => {
    expect(normalizeSettings({ apiKey: 'sk-test' }).losslessUpscale).toBe(false)
  })

  it('can read an OpenAI key from legacy profile exports', () => {
    const settings = normalizeSettings({
      profiles: [
        { id: 'fal', provider: 'fal', apiKey: 'fal-key', apiMode: 'images', codexCli: false },
        { id: 'openai', provider: 'openai', apiKey: 'openai-key', apiMode: 'responses', codexCli: true },
      ],
      activeProfileId: 'openai',
    })

    expect(settings.apiKey).toBe('openai-key')
    expect(settings.apiMode).toBe('responses')
    expect(settings.codexCli).toBe(true)
  })

  it('builds runtime profile from user settings and environment defaults', () => {
    const imagesProfile = getRuntimeApiProfile({ apiKey: 'sk-test', apiMode: 'images' })
    const responsesProfile = getRuntimeApiProfile({ apiKey: 'sk-test', apiMode: 'responses' })

    expect(imagesProfile).toMatchObject({
      provider: 'openai',
      apiKey: 'sk-test',
      baseUrl: DEFAULT_IMAGE_API_BASE_URL,
      imageApiBaseUrl: DEFAULT_IMAGE_API_BASE_URL,
      model: DEFAULT_IMAGES_MODEL,
    })
    expect(responsesProfile.model).toBe(DEFAULT_RESPONSES_MODEL)
  })

  it('keeps current key when imported settings have no key', () => {
    expect(mergeImportedSettings({ apiKey: 'current-key' }, { apiMode: 'responses' })).toMatchObject({
      apiKey: 'current-key',
      apiMode: 'responses',
    })
  })

  it('validates required API key', () => {
    expect(validateSettings({ apiKey: '' })).toBe('缺少 API Key')
    expect(validateSettings({ apiKey: 'sk-test' })).toBeNull()
  })
})
