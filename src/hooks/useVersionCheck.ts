import { useState } from 'react'

export interface LatestRelease {
  tag: string
  url: string
}

export function useVersionCheck() {
  const [dismissed, setDismissed] = useState(() =>
    sessionStorage.getItem('version-dismissed') === 'true',
  )

  const dismiss = () => {
    setDismissed(true)
    sessionStorage.setItem('version-dismissed', 'true')
  }

  return { hasUpdate: false, latestRelease: null as LatestRelease | null, dismiss, dismissed }
}
