import { StringDecoder } from 'node:string_decoder'
import { spawn } from 'node:child_process'

export interface RunOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
  /** Called for each complete line written to stdout. */
  onStdoutLine?: (line: string) => void
  /** Called for each complete line written to stderr. */
  onStderrLine?: (line: string) => void
  timeoutMs?: number
  /** Cap on retained stdout/stderr; long ffmpeg runs are line-streamed instead. */
  maxCaptureBytes?: number
}

export interface RunResult {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  aborted: boolean
  timedOut: boolean
  /**
   * True when captured output reached the cap and the rest was discarded.
   *
   * Callers that parse the output MUST check this. Silently truncating structured
   * data turns a too-large payload into an unhelpful parse error — which is
   * exactly how a 1.28 MB yt-dlp metadata dump was reported as "could not read
   * the metadata".
   */
  truncated: boolean
  stdoutTruncated: boolean
  stderrTruncated: boolean
}

/** Default cap. Generous enough for logs; structured payloads raise it. */
export const DEFAULT_MAX_CAPTURE = 512 * 1024
const owned = new Set<Promise<RunResult>>()
export async function settleChildren(): Promise<void> {
  while (owned.size) await Promise.allSettled([...owned])
}

/**
 * Spawns a process with an argv array — never a shell string — and streams its
 * output line by line so long-running tools can report progress.
 */
export function run(command: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  const task = perform(command, args, options)
  owned.add(task)
  void task.then(() => owned.delete(task), () => owned.delete(task))
  return task
}

function perform(command: string, args: string[], options: RunOptions): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const maxCapture = options.maxCaptureBytes ?? DEFAULT_MAX_CAPTURE

    let child: ReturnType<typeof spawn>
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env ?? process.env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch (error) {
      reject(error)
      return
    }

    const out = { bytes: 0, text: '', decoder: new StringDecoder('utf8'), truncated: false }
    const err = { bytes: 0, text: '', decoder: new StringDecoder('utf8'), truncated: false }
    let aborted = false
    let timedOut = false
    let settled = false

    // Buffer bytes, never UTF-16 code units. An incomplete terminal code point
    // stays in StringDecoder and is discarded only when the stream was capped.
    const capture = (target: typeof out, chunk: Buffer): void => {
      const room = Math.max(0, maxCapture - target.bytes)
      const kept = chunk.subarray(0, room)
      target.bytes += kept.length
      target.text += target.decoder.write(kept)
      if (kept.length < chunk.length) target.truncated = true
    }
    const lineOut = new StringDecoder('utf8'), lineErr = new StringDecoder('utf8')
    const bufferOut = createLineBuffer((line) => options.onStdoutLine?.(line))
    const bufferErr = createLineBuffer((line) => options.onStderrLine?.(line))

    const timer =
      options.timeoutMs != null
        ? setTimeout(() => {
            timedOut = true
            void terminate(child)
          }, options.timeoutMs)
        : null

    const onAbort = (): void => {
      aborted = true
      void terminate(child)
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })

    const cleanup = (): void => {
      if (timer) clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      capture(out, chunk)
      if (options.onStdoutLine) bufferOut(lineOut.write(chunk))
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      capture(err, chunk)
      if (options.onStderrLine) bufferErr(lineErr.write(chunk))
    })
    if (options.signal?.aborted) onAbort()

    child.on('error', (error) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    })

    child.on('close', (code, signal) => {
      if (settled) return
      settled = true
      cleanup()
      if (!out.truncated) out.text += out.decoder.end()
      if (!err.truncated) err.text += err.decoder.end()
      bufferOut(lineOut.end()); bufferErr(lineErr.end())
      bufferOut.flush()
      bufferErr.flush()
      resolve({ code, signal, stdout: out.text, stderr: err.text, aborted, timedOut, truncated: out.truncated || err.truncated, stdoutTruncated: out.truncated, stderrTruncated: err.truncated })
    })
  })
}

function createLineBuffer(onLine: (line: string) => void): ((chunk: string) => void) & {
  flush: () => void
} {
  let pending = ''
  const handle = (chunk: string): void => {
    pending += chunk
    let index = pending.indexOf('\n')
    while (index !== -1) {
      const line = pending.slice(0, index).replace(/\r$/, '')
      pending = pending.slice(index + 1)
      if (line.length > 0) onLine(line)
      index = pending.indexOf('\n')
    }
    // Guard against a tool that never emits a newline.
    if (pending.length > 64 * 1024) {
      onLine(pending)
      pending = ''
    }
  }
  handle.flush = (): void => {
    if (pending.length > 0) {
      onLine(pending.replace(/\r$/, ''))
      pending = ''
    }
  }
  return handle
}

/**
 * Kills a process and its descendants. On Windows a plain `kill()` leaves
 * ffmpeg children orphaned, so the tree is taken down explicitly.
 */
export async function terminate(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const pid = child.pid
  if (pid == null) return

  if (process.platform === 'win32') {
    try {
      await run('taskkill', ['/pid', String(pid), '/T', '/F'], { timeoutMs: 8_000 })
    } catch {
      // Fall through to the generic kill below.
    }
  }

  try {
    child.kill('SIGKILL')
  } catch {
    // Already gone.
  }
}
