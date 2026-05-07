import { describe, expect, it } from 'vitest'
import { DEFAULT_PARAMS } from '../types'
import { DEFAULT_SETTINGS, normalizeSettings } from './apiProfiles'
import { getOutputImageLimitForSettings, normalizeParamsForSettings } from './paramCompatibility'

describe('parameter compatibility', () => {
  it('limits OpenAI output count to 10', () => {
    const settings = normalizeSettings(DEFAULT_SETTINGS)

    expect(getOutputImageLimitForSettings(settings)).toBe(10)
    expect(normalizeParamsForSettings({ ...DEFAULT_PARAMS, n: 12 }, settings).n).toBe(10)
  })

  it('normalizes Codex CLI quality to auto', () => {
    const settings = normalizeSettings({ ...DEFAULT_SETTINGS, codexCli: true })

    expect(normalizeParamsForSettings({ ...DEFAULT_PARAMS, quality: 'high' }, settings).quality).toBe('auto')
  })
})
