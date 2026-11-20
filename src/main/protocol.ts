import { net, protocol } from 'electron'
import { pathToFileURL } from 'node:url'
import { libraryService } from './services/library'

export const MEDIA_SCHEME = 'sonic-media'

/**
 * Registers the privileged scheme used to stream local audio into the renderer.
 *
 * The renderer never receives a filesystem path it can act on: it asks for
 * `sonic-media://beat/<library-id>` and the main process resolves that id
 * against the library. A path outside the library simply has no id.
 *
 * Must be called before the app is ready.
 */
export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: MEDIA_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        corsEnabled: true
      }
    }
  ])
}

/** Installs the handler. Must be called after the app is ready. */
export function installMediaProtocol(): void {
  protocol.handle(MEDIA_SCHEME, async (request) => {
    try {
      const url = new URL(request.url)
      const id = decodeURIComponent(url.pathname.replace(/^\//, '')) || url.hostname
      const beat = libraryService.get(id)

      if (!beat) {
        return new Response('Unknown beat', { status: 404 })
      }

      // Forward the Range header so the audio element can seek without pulling
      // the whole file into memory.
      return await net.fetch(pathToFileURL(beat.filePath).toString(), {
        headers: request.headers,
        bypassCustomProtocolHandlers: true
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Media unavailable'
      return new Response(message, { status: 500 })
    }
  })
}

export function mediaUrlFor(beatId: string): string {
  return `${MEDIA_SCHEME}://beat/${encodeURIComponent(beatId)}`
}
