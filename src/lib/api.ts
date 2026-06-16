import { getActiveApiProfile } from './apiProfiles'
import type { CallApiOptions, CallApiResult } from './imageApiShared'
import { callImageJobApi } from './imageJobsApi'

export type { CallApiOptions, CallApiResult } from './imageApiShared'
export { normalizeBaseUrl } from './devProxy'

export async function callImageApi(opts: CallApiOptions): Promise<CallApiResult> {
  const profile = getActiveApiProfile(opts.settings)
  return callImageJobApi({
    profile,
    prompt: opts.prompt,
    params: opts.params,
    inputImageDataUrls: opts.inputImageDataUrls,
    maskDataUrl: opts.maskDataUrl,
  })
}
