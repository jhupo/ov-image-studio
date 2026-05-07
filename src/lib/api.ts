import { getRuntimeApiProfile } from './apiProfiles'
import { callOpenAICompatibleImageApi } from './openaiCompatibleImageApi'
import type { CallApiOptions, CallApiResult } from './imageApiShared'

export type { CallApiOptions, CallApiResult } from './imageApiShared'
export { normalizeBaseUrl } from './baseUrl'

export async function callImageApi(opts: CallApiOptions): Promise<CallApiResult> {
  return callOpenAICompatibleImageApi(opts, getRuntimeApiProfile(opts.settings))
}
