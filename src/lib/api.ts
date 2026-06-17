import { DEFAULT_IMAGES_MODEL, DEFAULT_RESPONSES_MODEL, getActiveApiProfile } from './apiProfiles'
import type { CallApiOptions, CallApiResult } from './imageApiShared'
import { callImageJobApi } from './imageJobsApi'

export type { CallApiOptions, CallApiResult } from './imageApiShared'
export { normalizeBaseUrl } from './devProxy'

function isImageModel(model: string): boolean {
  const normalized = model.trim().toLowerCase()
  return normalized.includes('image') || normalized.includes('dall-e') || normalized.includes('imagen')
}

export function normalizeImageRequestModel(apiMode: string, model: string): string {
  const trimmed = model.trim()
  if (apiMode === 'images') return isImageModel(trimmed) ? trimmed : DEFAULT_IMAGES_MODEL
  if (apiMode === 'responses' && isImageModel(trimmed)) return DEFAULT_RESPONSES_MODEL
  return trimmed || (apiMode === 'responses' ? DEFAULT_RESPONSES_MODEL : DEFAULT_IMAGES_MODEL)
}

export async function callImageApi(opts: CallApiOptions): Promise<CallApiResult> {
  const activeProfile = getActiveApiProfile(opts.settings)
  const apiMode = opts.inputImageDataUrls.length > 0 || opts.maskDataUrl ? 'images' : activeProfile.apiMode
  const profile = {
    ...activeProfile,
    apiMode,
    model: normalizeImageRequestModel(apiMode, activeProfile.model),
  }
  return callImageJobApi({
    profile,
    prompt: opts.prompt,
    params: opts.params,
    inputImageDataUrls: opts.inputImageDataUrls,
    maskDataUrl: opts.maskDataUrl,
    signal: opts.signal,
    onJobCreated: opts.onImageJobCreated ? (jobId) => opts.onImageJobCreated?.({ jobId }) : undefined,
  })
}
