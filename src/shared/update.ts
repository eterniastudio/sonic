/** Where the GitHub releases live. The updater, About links and README share it. */
export const RELEASE_REPO = { owner: 'eterniastudio', repo: 'sonic' } as const
export const RELEASES_URL = `https://github.com/${RELEASE_REPO.owner}/${RELEASE_REPO.repo}/releases`
export const ISSUES_URL = `https://github.com/${RELEASE_REPO.owner}/${RELEASE_REPO.repo}/issues/new`

/**
 * - `disabled`: this build cannot update itself (development, tests, non-Windows).
 * - `ready`: an update is downloaded and installs on restart or on the next close.
 */
export type UpdatePhase = 'disabled' | 'idle' | 'checking' | 'downloading' | 'ready' | 'up-to-date' | 'error'

export interface UpdateStatus {
  phase: UpdatePhase
  currentVersion: string
  /** The newer version being downloaded or ready to install. */
  availableVersion: string | null
  /** Download progress, 0–1, while `downloading`. */
  percent: number | null
  /** Epoch ms of the last finished check. */
  checkedAt: number | null
  /** A short reason for `disabled` or `error`. */
  message: string | null
}
