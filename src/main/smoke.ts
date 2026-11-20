import { app, type BrowserWindow } from 'electron'
import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { BeatMetadata, Job } from '@shared/domain'
import { parseDeclared } from '@shared/metadata'
import { renderTemplate } from '@shared/template'
import { analysisService } from './analysis/service'
import { probeUrl } from './services/probe'
import { libraryService } from './services/library'
import { probeMediaFile } from './services/ffprobe'
import { queueService } from './services/queue'
import { settingsService } from './services/settings'

/** One assertion group's result. `ok` drives the run's exit code. */
type GroupResult = { ok: boolean; [key: string]: unknown }

/**
 * Deterministic assertions for the declared-metadata parser.
 *
 * These are the app's most intricate rules and need no network, so they run on
 * every smoke pass and pin down the exact producer-title conventions Sonic
 * claims to understand.
 */
function metadataChecks(): { name: string; ok: boolean; expected: unknown; actual: unknown }[] {
  const cases: {
    name: string
    title: string
    expect: Record<string, unknown>
  }[] = [
    {
      name: 'quoted beat name, bracketed tempo and key, prod. by',
      title: '[FREE] "Midnight Drive" Type Beat 2026 - prod. by KBeats [144 BPM] [F# minor]',
      expect: {
        title: 'Midnight Drive',
        producer: 'KBeats',
        bpm: 144,
        key: 'F# minor',
        camelot: '11A'
      }
    },
    {
      name: 'half/double-time pairing written as 72 / 144',
      title: 'Trap Beat 2024 | prod. LXST | 72 / 144 BPM | Key: 11A',
      expect: { producer: 'LXST', bpm: 144, altBpm: 72, camelot: '11A', key: 'F# minor' }
    },
    {
      name: 'compact minor key, lowercase bpm and detune in cents',
      title: 'Dark Drill Type Beat - Am - 140bpm - detuned -18 cents',
      expect: { bpm: 140, key: 'A minor', camelot: '8A', detune: -18, genre: 'Drill' }
    },
    {
      name: 'absolute tuning converted to a cents offset',
      title: 'Soul Sample Beat (prod. by J Dilla Tribute) Tuning: A=432Hz',
      expect: { producer: 'J Dilla Tribute', tuning: 'A=432Hz', detune: -31.8, genre: 'Soul' }
    },
    {
      name: 'compact sharp key at the start of the title',
      title: 'F#m 150 BPM Jersey Club',
      expect: { bpm: 150, key: 'F# minor', camelot: '11A', genre: 'Jersey Club' }
    }
  ]

  return cases.map((testCase) => {
    const { values } = parseDeclared({ title: testCase.title })
    const mismatches: Record<string, { expected: unknown; actual: unknown }> = {}

    for (const [field, expected] of Object.entries(testCase.expect)) {
      const actual = (values as Record<string, unknown>)[field]
      const bothNumbers = typeof expected === 'number' && typeof actual === 'number'
      const matches = bothNumbers
        ? Math.abs((expected as number) - (actual as number)) < 0.05
        : actual === expected
      if (!matches) mismatches[field] = { expected, actual: actual ?? null }
    }

    return {
      name: testCase.name,
      ok: Object.keys(mismatches).length === 0,
      expected: testCase.expect,
      actual: { ...values, mismatches: Object.keys(mismatches).length > 0 ? mismatches : undefined }
    }
  })
}

/**
 * Assertions for the naming template, including the empty-token case that used
 * to leak a literal `[BPM]` into published file names.
 */
function templateChecks(): { name: string; ok: boolean; expected: string; actual: string }[] {
  const template = '{producer} - {title} [{bpm} BPM] [{key}]'
  const base: BeatMetadata = {
    title: 'Midnight Drive',
    producer: 'KBeats',
    bpm: null,
    altBpm: null,
    key: null,
    camelot: null,
    detune: null,
    tuning: null,
    genre: null
  }

  const cases: { name: string; metadata: BeatMetadata; expected: string }[] = [
    {
      name: 'every token resolves',
      metadata: { ...base, bpm: 144, key: 'F# minor', camelot: '11A' },
      expected: 'KBeats - Midnight Drive [144 BPM] [F# minor]'
    },
    {
      name: 'empty tempo and key leave no orphaned units',
      metadata: base,
      expected: 'KBeats - Midnight Drive'
    },
    {
      name: 'missing producer collapses the separator',
      metadata: { ...base, producer: null, bpm: 140 },
      expected: 'Midnight Drive [140 BPM]'
    }
  ]

  return cases.map((testCase) => {
    const result = renderTemplate(template, {
      metadata: testCase.metadata,
      presetId: 'mp3-320',
      sourceKind: 'youtube',
      index: 1,
      durationSec: 214
    })
    return {
      name: testCase.name,
      ok: result.rendered === testCase.expected,
      expected: testCase.expected,
      actual: result.rendered
    }
  })
}

/**
 * Headless self-check.
 *
 * Enabled by `--smoke` (or an explicit `SONIC_SMOKE_REPORT` path) in unpackaged builds only. It boots the
 * real application — window, preload bridge, IPC, services — probes the
 * rendered DOM, then quits, so a build can be verified without a human watching
 * the screen.
 *
 * Setting `SONIC_SMOKE_URL` additionally drives one real download through the
 * whole pipeline (acquire → convert → tag → publish → library) into a throwaway
 * folder, which makes this a genuine end-to-end test rather than a boot check.
 */
export function installSmokeTest(window: BrowserWindow): void {
  // A development harness: it drives IPC, downloads and file writes on its own.
  // A shipped build never honours `--smoke` or the report variable.
  if (app.isPackaged) return
  const reportPath =
    process.env['SONIC_SMOKE_REPORT'] ??
    (process.argv.includes('--smoke') ? join(app.getPath('userData'), 'smoke-report.json') : null)
  if (!reportPath) return

  const smokeUrl = process.env['SONIC_SMOKE_URL'] ?? null
  console.log(`[smoke] report will be written to ${reportPath}`)

  const consoleMessages: { level: string; message: string }[] = []
  const loadFailures: string[] = []
  const rendererGone: string[] = []
  let finished = false

  window.webContents.on('console-message', (event) => {
    if (event.level === 'error' || event.level === 'warning') {
      consoleMessages.push({ level: event.level, message: event.message.slice(0, 400) })
    }
  })

  window.webContents.on('did-fail-load', (_event, code, description, url) => {
    loadFailures.push(`${code} ${description} ${url}`)
  })

  window.webContents.on('render-process-gone', (_event, details) => {
    rendererGone.push(details.reason)
  })

  const probe = `(() => {
    const html = document.documentElement
    const bodyStyles = getComputedStyle(document.body)
    const rootStyles = getComputedStyle(html)
    const root = document.getElementById('root')
    return {
      hasBridge: typeof window.sonic === 'object' && window.sonic !== null,
      rootChildren: root ? root.children.length : 0,
      visibleTextLength: (document.body.innerText || '').trim().length,
      headingTexts: [...document.querySelectorAll('h1, h2, h3')].map((node) => node.innerText).slice(0, 10),
      navButtons: document.querySelectorAll('nav button').length,
      totalButtons: document.querySelectorAll('button').length,
      svgCount: document.querySelectorAll('svg').length,
      images: document.querySelectorAll('img').length,
      theme: html.dataset.theme || null,
      accent: html.dataset.accent || null,
      reduceMotion: html.dataset.reduceMotion || null,
      bodyBackground: bodyStyles.backgroundColor,
      bodyColor: bodyStyles.color,
      fontFamily: bodyStyles.fontFamily,
      tokens: {
        accent: rootStyles.getPropertyValue('--sonic-accent').trim(),
        surface: rootStyles.getPropertyValue('--sonic-surface').trim(),
        durationFast: rootStyles.getPropertyValue('--duration-fast').trim(),
        easeSmoothOut: rootStyles.getPropertyValue('--ease-smooth-out').trim(),
        tabsBarBg: rootStyles.getPropertyValue('--tabs-bar-bg').trim(),
        tooltipBg: rootStyles.getPropertyValue('--tt-bg').trim(),
        toggleTravel: rootStyles.getPropertyValue('--toggle-travel').trim()
      }
    }
  })()`

  const finish = (extra: Record<string, unknown>, ok: boolean): void => {
    if (finished) return
    finished = true

    const report = {
      ok,
      generatedAt: new Date().toISOString(),
      app: {
        name: app.getName(),
        version: app.getVersion(),
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        node: process.versions.node
      },
      loadFailures,
      rendererGone,
      consoleMessages,
      ...extra
    }

    try {
      writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8')
      console.log(`[smoke] ${ok ? 'PASS' : 'FAIL'} → ${reportPath}`)
    } catch {
      // Nothing more we can do; the process still needs to exit.
    }

    app.exit(ok ? 0 : 1)
  }

  /** Runs one real job to completion and reports everything observable. */
  const runPipeline = async (url: string): Promise<{ ok: boolean; detail: Record<string, unknown> }> => {
    const outputDir = join(app.getPath('userData'), 'exports')
    // Redirect exports to a throwaway folder, but restore the producer's real
    // settings afterwards — a test must not repoint their library.
    // `skipExisting` is disabled so the run always exercises the full pipeline
    // rather than short-circuiting on a beat a previous run already exported.
    const original = settingsService.get()
    settingsService.patch({
      autoStart: true,
      downloadDir: outputDir,
      embedThumbnail: true,
      skipExisting: false
    })

    try {
      return await driveJob(url, outputDir)
    } finally {
      settingsService.patch({
        downloadDir: original.downloadDir,
        autoStart: original.autoStart,
        skipExisting: original.skipExisting
      })
    }
  }

  const driveJob = async (
    url: string,
    outputDir: string
  ): Promise<{ ok: boolean; detail: Record<string, unknown> }> => {
    const before = new Set(libraryService.list().map((beat) => beat.id))
    queueService.add([url])

    const deadline = Date.now() + 240_000
    let job: Job | undefined

    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 700))
      const snapshot = queueService.snapshot()
      job = snapshot.jobs.find((entry) => entry.url.includes(url.split('v=')[1] ?? url))
      if (job && ['complete', 'failed', 'cancelled'].includes(job.stage)) break
    }

    if (!job) return { ok: false, detail: { error: 'The job never appeared in the queue.' } }
    if (job.stage !== 'complete') {
      return { ok: false, detail: { stage: job.stage, error: job.error, message: job.message } }
    }

    const beat = libraryService.list().find((entry) => !before.has(entry.id))
    if (!beat) return { ok: false, detail: { error: 'Nothing was added to the library.' } }

    // Read the published file back to prove the tags actually landed.
    const media = await probeMediaFile(beat.filePath)

    return {
      ok: true,
      detail: {
        id: beat.id,
        outputDir,
        file: {
          name: beat.fileName,
          exists: existsSync(beat.filePath),
          sizeBytes: beat.sizeBytes,
          durationSec: Math.round(media.durationSec * 100) / 100,
          container: media.container,
          codec: media.audio?.codec ?? null,
          sampleRate: media.audio?.sampleRate ?? null,
          channels: media.audio?.channels ?? null,
          bitrateKbps: Math.round((media.audio?.bitrateKbps ?? media.bitrateKbps ?? 0) * 10) / 10
        },
        metadata: {
          title: beat.title,
          producer: beat.producer,
          bpm: beat.bpm,
          key: beat.key,
          camelot: beat.camelot,
          detune: beat.detune
        },
        tagReadback: media.tags,
        sidecarWritten: beat.sidecarPath ? existsSync(beat.sidecarPath) : false,
        fingerprintLength: beat.fingerprint.length,
        declaredEvidence: job.metadata.evidence.map((item) => ({
          field: item.field,
          value: item.value,
          source: item.source
        }))
      }
    }
  }

  // ------------------------------------------------------- renderer assertions

  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

  /** Evaluates an expression in the renderer, bounded by a timeout. */
  const evalInRenderer = async <T>(expression: string, timeoutMs = 20_000): Promise<T> => {
    let timer: NodeJS.Timeout | null = null
    try {
      return (await Promise.race([
        window.webContents.executeJavaScript(expression, true) as Promise<T>,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('Renderer evaluation timed out')), timeoutMs)
        })
      ])) as T
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  const THEME_PROBE = `(() => {
    const root = document.documentElement
    const styles = getComputedStyle(root)
    return {
      theme: root.dataset.theme || null,
      bodyBackground: getComputedStyle(document.body).backgroundColor,
      bodyColor: getComputedStyle(document.body).color,
      bg: styles.getPropertyValue('--sonic-bg').trim(),
      surface: styles.getPropertyValue('--sonic-surface').trim(),
      fg: styles.getPropertyValue('--sonic-fg').trim(),
      tabsBarBg: styles.getPropertyValue('--tabs-bar-bg').trim(),
      tooltipBg: styles.getPropertyValue('--tt-bg').trim(),
      rootDivBackground: (() => {
        const node = document.getElementById('root')
        const child = node && node.firstElementChild
        return child ? getComputedStyle(child).backgroundColor : null
      })()
    }
  })()`

  /**
   * Both themes must actually apply, and the switch is driven by a settings push
   * from the main process rather than a reload — so this also proves the
   * `settings:changed` channel works.
   */
  const checkThemes = async (): Promise<GroupResult> => {
    const dark = await evalInRenderer<Record<string, string | null>>(THEME_PROBE)

    settingsService.patch({ theme: 'light' })

    // `body` transitions its background and colour, so a single fixed sleep can
    // sample an interpolated value and report a switch that has not landed yet.
    // Poll until the change is actually visible.
    let light = dark
    const lightDeadline = Date.now() + 8_000
    while (Date.now() < lightDeadline) {
      await sleep(200)
      light = await evalInRenderer<Record<string, string | null>>(THEME_PROBE)
      if (light.theme === 'light' && light.bodyBackground !== dark.bodyBackground) break
    }

    settingsService.patch({ theme: 'dark' })

    let restored = light
    const restoreDeadline = Date.now() + 8_000
    while (Date.now() < restoreDeadline) {
      await sleep(200)
      restored = await evalInRenderer<Record<string, string | null>>(THEME_PROBE)
      if (restored.theme === 'dark' && restored.bodyBackground === dark.bodyBackground) break
    }

    const ok =
      dark.theme === 'dark' &&
      light.theme === 'light' &&
      restored.theme === 'dark' &&
      dark.bodyBackground !== light.bodyBackground &&
      dark.surface !== light.surface &&
      dark.fg !== light.fg &&
      // Vendored transitions.dev colour tokens must follow the theme as well.
      dark.tabsBarBg !== light.tabsBarBg &&
      dark.tooltipBg !== light.tooltipBg

    return { ok, dark, light, restored }
  }

  /** Streams the published file back through the privileged media scheme. */
  const checkMediaProtocol = async (
    beatId: string,
    expectedBytes: number
  ): Promise<GroupResult> => {
    const result = await evalInRenderer<{
      ok: boolean
      status?: number
      byteLength?: number
      error?: string
    }>(`(async () => {
      try {
        const response = await fetch('sonic-media://beat/${beatId}')
        const buffer = await response.arrayBuffer()
        return { ok: response.ok, status: response.status, byteLength: buffer.byteLength }
      } catch (error) {
        return { ok: false, error: String(error) }
      }
    })()`)

    return {
      ...result,
      expectedBytes,
      bytesMatch: result.byteLength === expectedBytes,
      ok: result.ok === true && result.byteLength === expectedBytes
    }
  }

  /** Drives an explicit Play action and waits for the one shell-owned decoder. */
  const checkPreviewTransport = async (beatId: string): Promise<GroupResult> => {
    const navigated = await evalInRenderer<boolean>(`(() => {
      const target = [...document.querySelectorAll('nav button')].find(
        (node) => (node.textContent || '').trim().startsWith('Library')
      )
      if (target) target.click()
      return Boolean(target)
    })()`)
    const cardClicked = await (async (): Promise<boolean> => {
      // The library list arrives over IPC, so wait for the card rather than
      // assuming a fixed delay is enough.
      const deadline = Date.now() + 12_000
      while (Date.now() < deadline) {
        const clicked = await evalInRenderer<boolean>(
          `(() => {
            const card = document.querySelector('[data-beat-id="${beatId}"]')
            if (card) card.click()
            return Boolean(card)
          })()`
        )
        if (clicked) return true
        await sleep(300)
      }
      return false
    })()

    const playClicked = await (async (): Promise<boolean> => {
      const deadline = Date.now() + 8_000
      while (Date.now() < deadline) {
        const clicked = await evalInRenderer<boolean>(`(() => {
          const button = document.querySelector('[data-beat-id="${beatId}"] button[aria-label^="Play "]')
          if (button) button.click()
          return Boolean(button)
        })()`)
        if (clicked) return true
        await sleep(200)
      }
      return false
    })()

    let state: string | null = null
    let waveformChildren = 0
    let waveformHtml: string | null = null
    let displayedDuration: string | null = null
    const deadline = Date.now() + 25_000

    while (Date.now() < deadline) {
      await sleep(600)
      const snapshot = await evalInRenderer<{
        state: string | null
        waveformChildren: number
        waveformHtml: string | null
        displayedDuration: string | null
      }>(
        `(() => {
          const transport = document.querySelector('[data-playback-dock]')
          if (!transport) {
            return { state: null, waveformChildren: 0, waveformHtml: null, displayedDuration: null }
          }
          const waveform = transport.querySelector('[data-waveform]')
          const match = (transport.innerText || '').match(/(\\d+:\\d{2})\\s*\\/\\s*(\\d+:\\d{2})/)
          return {
            state: transport.getAttribute('data-playback-state'),
            waveformChildren: waveform ? waveform.children.length : 0,
            waveformHtml: waveform ? waveform.innerHTML.replace(/\\s+/g, ' ').slice(0, 500) : null,
            displayedDuration: match ? match[2] : null
          }
        })()`
      )
      state = snapshot.state
      waveformChildren = snapshot.waveformChildren
      waveformHtml = snapshot.waveformHtml
      displayedDuration = snapshot.displayedDuration
      if (state === 'error' || (['ready', 'playing', 'paused', 'ended'].includes(state ?? '') &&
        displayedDuration != null && displayedDuration !== '0:00')) break
    }

    // Decoder readiness and waveform paint are separate conditions.
    let canvasCount = 0
    let shadowHosts = 0
    let canvasesPartChildren = 0
    let lightDomCanvases = 0
    if (state === 'ready' || state === 'playing' || state === 'paused' || state === 'ended') {
      const canvasDeadline = Date.now() + 6_000
      while (Date.now() < canvasDeadline) {
        const settled = await evalInRenderer<{
        canvasCount: number
        shadowHosts: number
        canvasesPartChildren: number
        lightDomCanvases: number
        }>(
        `(() => {
          const waveform = document.querySelector('[data-playback-dock] [data-waveform]')
          if (!waveform) {
            return { canvasCount: 0, shadowHosts: 0, canvasesPartChildren: 0, lightDomCanvases: 0 }
          }
          // wavesurfer builds a <div> with a shadow root holding .canvases, and
          // neither innerHTML nor querySelectorAll can see through it.
          let hosts = 0
          let canvases = 0
          let partChildren = 0
          for (const node of [waveform, ...waveform.querySelectorAll('*')]) {
            if (!node.shadowRoot) continue
            hosts += 1
            canvases += node.shadowRoot.querySelectorAll('canvas').length
            const part = node.shadowRoot.querySelector('.canvases')
            if (part) partChildren += part.children.length
          }
          return {
            canvasCount: canvases,
            shadowHosts: hosts,
            canvasesPartChildren: partChildren,
            lightDomCanvases: waveform.querySelectorAll('canvas').length
          }
        })()`
      )
        canvasCount = settled.canvasCount
        shadowHosts = settled.shadowHosts
        canvasesPartChildren = settled.canvasesPartChildren
        lightDomCanvases = settled.lightDomCanvases
        if (canvasCount > 0) break
        await sleep(150)
      }
    }

    return {
      ok:
        ['ready', 'playing', 'paused', 'ended'].includes(state ?? '') &&
        displayedDuration != null &&
        displayedDuration !== '0:00' &&
        canvasCount > 0 && playClicked,
      navigated,
      cardClicked,
      playClicked,
      decoderState: state,
      displayedDuration,
      waveformChildren,
      shadowHosts,
      waveformCanvasCount: canvasCount,
      canvasesPartChildren,
      lightDomCanvases,
      waveformHtml,
      // Diagnostics for a failed lookup: what the Library view actually rendered.
      diagnostics: cardClicked
        ? null
        : await evalInRenderer<Record<string, unknown>>(
            `(() => {
              const text = document.body.innerText || ''
              return {
                beatCards: document.querySelectorAll('[data-beat-id]').length,
                navLabels: [...document.querySelectorAll('nav button')].map((n) => (n.textContent || '').trim()),
                showsEmptyState: text.includes('Your library is'),
                showsNoMatch: text.includes('No beats match'),
                bodyTextSample: text.replace(/\\s+/g, ' ').slice(0, 300)
              }
            })()`
          )
    }
  }

  /**
   * Exercises the renderer's real IPC surface: editing final metadata, deriving
   * Camelot from a key edit, the naming preview, correcting a library record,
   * and the preload allow-list.
   */
  const checkRendererIpc = async (beatId: string): Promise<GroupResult> => {
    return evalInRenderer<GroupResult>(`(async () => {
      const invoke = window.sonic.invoke

      const before = await invoke('queue:snapshot')
      const job = before.jobs.find((entry) => entry.stage === 'complete')
      if (!job) return { ok: false, error: 'no completed job to edit' }

      await invoke('queue:updateJob', job.id, { metadataEdit: { field: 'bpm', value: 145 } })
      const afterBpm = (await invoke('queue:snapshot')).jobs.find((entry) => entry.id === job.id)

      await invoke('queue:updateJob', job.id, { metadataEdit: { field: 'key', value: 'F# minor' } })
      const afterKey = (await invoke('queue:snapshot')).jobs.find((entry) => entry.id === job.id)

      const preview = await invoke(
        'settings:previewTemplate',
        '{producer} - {title} [{bpm} BPM] [{key}]',
        'mp3-320'
      )

      await invoke('library:updateMetadata', '${beatId}', { bpm: 128, key: 'A minor', camelot: '8A' })
      const library = await invoke('library:list')
      const beat = library.find((entry) => entry.id === '${beatId}')

      // Editing one field must not freeze the others. The override set must be
      // exactly the fields that were edited — that is the regression test for the
      // old global dirty flag, which froze every field at once.
      await invoke('queue:updateJob', job.id, { metadataEdit: { field: 'title', value: 'Renamed' } })
      const afterTitle = (await invoke('queue:snapshot')).jobs.find((entry) => entry.id === job.id)
      const overrides = Array.isArray(afterTitle.metadata.overrides) ? afterTitle.metadata.overrides : []
      const editedFields = ['bpm', 'key', 'title']
      const overridesArePerField =
        overrides.length === editedFields.length &&
        editedFields.every((field) => overrides.includes(field)) &&
        afterTitle.metadata.final.title === 'Renamed'

      let unknownChannelRejected = false
      try {
        await invoke('library:notARealChannel')
      } catch {
        unknownChannelRejected = true
      }

      let invalidPayloadRejected = false
      try {
        await invoke('library:updateMetadata', '${beatId}', { bpm: 'corrupt' })
      } catch {
        invalidPayloadRejected = true
      }
      const beatAfterInvalidPayload = (await invoke('library:list')).find((entry) => entry.id === '${beatId}')

      let arbitraryPathRejected = false
      try {
        await invoke('app:openPath', 'not-an-actual-path')
      } catch {
        arbitraryPathRejected = true
      }

      return {
        ok:
          afterBpm.metadata.final.bpm === 145 &&
          afterBpm.revision > job.revision &&
          afterKey.metadata.final.camelot === '11A' &&
          Array.isArray(afterKey.metadata.overrides) &&
          afterKey.metadata.overrides.includes('key') &&
          overridesArePerField &&
          preview.rendered === 'KBeats - Midnight Drive [144 BPM] [F# minor]' &&
          beat.bpm === 128 &&
          beat.camelot === '8A' &&
          unknownChannelRejected && invalidPayloadRejected &&
          beatAfterInvalidPayload.bpm === 128 && arbitraryPathRejected,
        editedBpm: afterBpm.metadata.final.bpm,
        revisionBumped: afterBpm.revision > job.revision,
        derivedCamelotFromKey: afterKey.metadata.final.camelot,
        overridesAfterThreeEdits: overrides,
        overridesArePerField,
        templatePreview: preview.rendered,
        libraryBpmAfterUpdate: beat.bpm,
        libraryCamelotAfterUpdate: beat.camelot,
        unknownChannelRejected,
        invalidPayloadRejected,
        beatUnaffectedByInvalidPayload: beatAfterInvalidPayload.bpm === 128,
        arbitraryPathRejected
      }
    })()`)
  }

  /** Always runs, including the offline boot smoke without a download fixture. */
  const checkIpcBoundary = async (): Promise<GroupResult> =>
    evalInRenderer<GroupResult>(`(async () => {
      const invoke = window.sonic.invoke
      const before = await invoke('settings:get')
      let malformedRejected = false
      let arbitraryPathRejected = false
      let importPathRejected = false
      let unknownEventRejected = false
      try { await invoke('settings:patch', { theme: { invalid: true } }) }
      catch { malformedRejected = true }
      try { await invoke('app:openPath', 'not-an-actual-path') }
      catch { arbitraryPathRejected = true }
      try { await invoke('import:chooseFiles', 'arbitrary-selected-path') }
      catch { importPathRejected = true }
      try { window.sonic.on('not:a:real:event', () => {}) }
      catch { unknownEventRejected = true }
      const after = await invoke('settings:get')
      return {
        ok: malformedRejected && arbitraryPathRejected && importPathRejected && unknownEventRejected &&
          after.theme === before.theme,
        malformedRejected, arbitraryPathRejected, importPathRejected, unknownEventRejected,
        settingsUnchanged: after.theme === before.theme
      }
    })()`)

  /**
   * Deletion is advertised as conservative: a file that changed on disk since
   * export must be refused. Tampering with the published audio proves it.
   */
  const checkDeletionSafety = async (beatId: string): Promise<GroupResult> => {
    const beat = libraryService.get(beatId)
    if (!beat) return { ok: false, error: 'the beat vanished before the deletion check' }

    appendFileSync(beat.filePath, Buffer.from([0x00]))

    const tampered = await libraryService.remove(beatId, true)
    const fileSurvivedRefusal = existsSync(beat.filePath)

    const recordOnly = await libraryService.remove(beatId, false)
    const fileKeptAfterRecordRemoval = existsSync(beat.filePath)

    return {
      ok:
        tampered.ok === false &&
        fileSurvivedRefusal &&
        recordOnly.ok === true &&
        fileKeptAfterRecordRemoval,
      refusedOnFingerprintMismatch: tampered.ok === false,
      refusalReason: tampered.reason,
      fileSurvivedRefusal,
      recordRemovalSucceeded: recordOnly.ok,
      fileKeptAfterRecordRemoval
    }
  }

  /**
   * Runs the real analysis path — ffmpeg decode on a child process, DSP on a
   * worker thread — against a named file, through the *built* main bundle.
   *
   * This is the check that proves the worker boundary survives bundling, which
   * no amount of unit testing on the DSP can show. It is strictly read-only: the
   * audio file is never modified and no library record is touched.
   */
  const checkAnalysis = async (filePath: string): Promise<GroupResult> => {
    const outcome = await analysisService.analyze({
      requestId: 'smoke:file',
      inputPath: filePath,
      durationSec: 0,
      force: true
    })

    if (!outcome.ok || !outcome.analysis) {
      return {
        ok: false,
        error: outcome.error ?? 'Analysis returned no result.',
        cancelled: outcome.cancelled,
        elapsedMs: outcome.elapsedMs
      }
    }

    const { analysis } = outcome
    return {
      ok: true,
      file: basename(filePath),
      elapsedMs: outcome.elapsedMs,
      engine: analysis.engine,
      analyzedSeconds: analysis.analyzedSeconds,
      sampleRate: analysis.sampleRate,
      durationSec: analysis.durationSec,
      tempo: {
        status: analysis.tempo.status,
        bpm: analysis.tempo.bpm,
        confidence: analysis.tempo.confidence,
        alternatives: analysis.tempo.alternatives.map((entry) => `${entry.bpm} (${entry.relation})`),
        warning: analysis.tempo.warning
      },
      key: {
        status: analysis.key.status,
        key: analysis.key.key,
        camelot: analysis.key.camelot,
        confidence: analysis.key.confidence,
        tuningCents: analysis.key.tuningCents,
        alternatives: analysis.key.alternatives.map((entry) => `${entry.key} ${entry.correlation.toFixed(2)}`),
        warning: analysis.key.warning
      },
      warnings: analysis.warnings,
      inputIdPreview: analysis.inputId.slice(0, 12)
    }
  }

  /**
   * Probes a real URL through the app's own metadata path.
   *
   * This exists specifically to catch capture-truncation regressions: a real
   * video's `--dump-single-json` payload is over a megabyte, so any capture cap
   * below that silently produces an unparseable document.
   */
  const checkProbe = async (url: string): Promise<GroupResult> => {
    const result = await probeUrl(url)
    return {
      ok: result.error === null && result.title.trim().length > 0,
      url,
      title: result.title,
      uploader: result.uploader,
      durationSec: result.durationSec,
      hasThumbnail: result.thumbnail != null,
      error: result.error
    }
  }

  window.webContents.once('did-finish-load', async () => {
    let renderer: unknown = null
    let probeError: string | null = null
    try {
      // This is boot readiness only. Preview, media, theme and IPC groups below
      // independently await their selected record, decoder and settled state.
      const deadline = Date.now() + 10_000
      let bootReady = false
      while (Date.now() < deadline) {
        bootReady = await window.webContents.executeJavaScript(`document.querySelector('main') != null && [...document.querySelectorAll('nav button')].some(node => node.textContent.trim().startsWith('Library')) && typeof window.sonic === 'object'`)
        if (bootReady) break
        await sleep(50)
      }
      if (!bootReady) throw new Error('Renderer bootstrap did not finish within 10 seconds')
      renderer = await window.webContents.executeJavaScript(probe, true)
    } catch (error) {
      probeError = error instanceof Error ? error.message : String(error)
    }

    let pipeline: { ok: boolean; detail: Record<string, unknown> } | null = null
    if (smokeUrl) {
      try {
        pipeline = await runPipeline(smokeUrl)
      } catch (error) {
        pipeline = { ok: false, detail: { error: error instanceof Error ? error.message : String(error) } }
      }

    }

    const checks = metadataChecks()
    const checksOk = checks.every((check) => check.ok)
    const naming = templateChecks()
    const namingOk = naming.every((check) => check.ok)
    const domOk = probeError === null && renderer !== null
    const clean = loadFailures.length === 0 && rendererGone.length === 0 && consoleMessages.length === 0

    // Everything below needs a real exported beat to talk about.
    const beatId = pipeline?.ok ? ((pipeline.detail as { id?: string }).id ?? null) : null
    const exportedBytes = pipeline?.ok
      ? ((pipeline.detail as { file?: { sizeBytes?: number } }).file?.sizeBytes ?? 0)
      : 0

    let themes: GroupResult | null = null
    let media: GroupResult | null = null
    let preview: GroupResult | null = null
    let ipcChecks: GroupResult | null = null
    let deletion: GroupResult | null = null
    let analysis: GroupResult | null = null
    let probeCheck: GroupResult | null = null
    let ipcBoundary: GroupResult | null = null

    try {
      themes = await checkThemes()
      ipcBoundary = await checkIpcBoundary()

      if (beatId) {
        media = await checkMediaProtocol(beatId, exportedBytes)
        preview = await checkPreviewTransport(beatId)
        ipcChecks = await checkRendererIpc(beatId)
        deletion = await checkDeletionSafety(beatId)
      }

      // Read-only analysis of an arbitrary local file, to verify the decode →
      // worker-thread → result path inside the built application.
      const analysisFile = process.env['SONIC_ANALYSIS_FILE']
      if (analysisFile && existsSync(analysisFile)) {
        analysis = await checkAnalysis(analysisFile)
      }

      const probeTarget = process.env['SONIC_PROBE_URL']
      if (probeTarget) {
        probeCheck = await checkProbe(probeTarget)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      themes = themes ?? { ok: false, error: message }
      ipcBoundary = ipcBoundary ?? { ok: false, error: message }
      ipcChecks = ipcChecks ?? { ok: false, error: message }
      analysis = analysis ?? { ok: false, error: message }
    }

    const themedOk = themes?.ok === true

    // A group that needs a source URL is reported as `skipped` rather than
    // `failed`, so this stays usable as a fast offline gate.
    const status = (value: boolean | null | undefined): 'pass' | 'fail' | 'skipped' =>
      value == null ? 'skipped' : value ? 'pass' : 'fail'

    const summary = {
      boot: status(domOk && clean),
      metadataParser: status(checksOk),
      namingTemplates: status(namingOk),
      pipeline: status(smokeUrl ? (pipeline?.ok ?? false) : null),
      themes: status(themes ? themedOk : null),
      ipcBoundary: status(ipcBoundary?.ok),
      mediaProtocol: status(media?.ok),
      previewTransport: status(preview?.ok),
      rendererIpc: status(ipcChecks?.ok),
      deletionSafety: status(deletion?.ok),
      audioAnalysis: status(analysis?.ok),
      metadataProbe: status(probeCheck?.ok)
    }
    const skippedGroups = Object.entries(summary)
      .filter(([, value]) => value === 'skipped')
      .map(([name]) => name)
    const failedGroups = Object.entries(summary)
      .filter(([, value]) => value === 'fail')
      .map(([name]) => name)

    finish(
      {
        renderer,
        probeError,
        metadataChecks: checks,
        templateChecks: naming,
        pipeline,
        themes,
        ipcBoundary,
        mediaProtocol: media,
        previewTransport: preview,
        rendererIpc: ipcChecks,
        deletionSafety: deletion,
        audioAnalysis: analysis,
        metadataProbe: probeCheck,
        summary,
        skippedGroups,
        failedGroups
      },
      failedGroups.length === 0 && probeError === null && renderer !== null
    )
  })

  // Generous ceiling: a real download plus the UI assertions needs time.
  setTimeout(() => finish({ timedOut: true }, false), smokeUrl ? 300_000 : 20_000)
}
