export interface PlaylistTrack {
  url: string
  title: string
}

export interface PlaylistReview {
  title: string
  tracks: PlaylistTrack[]
  skipped: number
  limited: boolean
}

export const PLAYLIST_LIMIT = 500
