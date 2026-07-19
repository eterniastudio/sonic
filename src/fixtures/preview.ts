import { BUILTIN_PRESETS, DEFAULT_SETTINGS } from "../domain/defaults";
import { renderFilename } from "../domain/filename";
import type {
  BootstrapPayload,
  Diagnostics,
  ExportRequest,
  FilenamePreviewRequest,
  LibraryFilters,
  LibraryItem,
  LibrarySort,
  PreviewAsset,
  QueueItem,
  QueueSnapshot,
  SonicSettings,
  SourceInput,
  SourceInspection,
} from "../domain/types";
import type { SonicBridge, Unsubscribe } from "../services/bridge-types";

const STORAGE_KEY = "sonic-v02-browser-preview";

type PreviewStore = {
  jobs: QueueItem[];
  library: LibraryItem[];
  settings: SonicSettings;
  paused: boolean;
};

function makeId(prefix: string) {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
}

function metadata(bpm: number, key: string, camelot: string, detuneCents = 0) {
  return {
    bpm,
    alternateBpms: bpm >= 100 ? [bpm / 2] : [bpm * 2],
    key,
    camelot,
    detuneCents,
    tuningHz: detuneCents ? 432 : 440,
    confidence: 0.94,
    matches: [
      { kind: "bpm", displayValue: `${bpm} BPM`, rawText: `BPM: ${bpm}`, source: "description", confidence: 0.98 },
      { kind: "key", displayValue: key, rawText: `KEY: ${key}`, source: "description", confidence: 0.97 },
      ...(detuneCents ? [{
        kind: "tuning",
        displayValue: `${detuneCents > 0 ? "+" : ""}${detuneCents} cents`,
        rawText: "Tuning: A=432Hz",
        source: "description",
        confidence: 0.96,
      }] : []),
    ],
    warnings: bpm >= 100 ? [`Both ${bpm} and ${bpm / 2} BPM are plausible; choose the feel you use in your DAW.`] : [],
  };
}

const NIGHT_SHIFT_METADATA = metadata(144, "F# minor", "11A", -31.8);

const NIGHT_SHIFT: SourceInspection = {
  id: "preview-night-shift",
  source: { kind: "youtube", url: "https://www.youtube.com/watch?v=jNQXAC9IVRw" },
  sourceFingerprint: "preview:youtube:night-shift",
  kind: "youtube",
  title: "Night Shift — Industrial Type Beat",
  creator: "Late Night Audio",
  durationSeconds: 173,
  thumbnailUrl: "/demo-beat-cover.svg",
  sourceUrl: "https://www.youtube.com/watch?v=jNQXAC9IVRw",
  sourceLabel: "YouTube",
  isLive: false,
  audio: { codec: "Opus", durationMs: 173_000, fileSizeBytes: 7_800_000 },
  declaredMetadata: NIGHT_SHIFT_METADATA,
  embeddedMetadata: { alternateBpms: [], confidence: 0, matches: [], warnings: [] },
  suggestedMetadata: NIGHT_SHIFT_METADATA,
  warnings: [],
  metadata: NIGHT_SHIFT_METADATA,
};

const DEFAULT_JOBS: QueueItem[] = [
  {
    id: "preview-ready",
    source: { kind: "youtube", url: NIGHT_SHIFT.sourceUrl ?? "" },
    inspection: NIGHT_SHIFT,
    metadata: { title: NIGHT_SHIFT.title, artist: NIGHT_SHIFT.creator, bpm: "144", key: "F# minor", detuneCents: "-31.8" },
    presetId: "wav44100S24",
    channelMode: "preserve",
    writeEmbeddedTags: true,
    templateId: "title-metadata",
    outputDirectory: "C:\\Users\\Producer\\Downloads\\Sonic",
    filenamePreview: "Night Shift — Industrial Type Beat — 144 BPM — F# minor -31.8c.wav",
    status: "review",
    progress: {},
    createdAt: "2026-07-18T13:30:00.000Z",
    updatedAt: "2026-07-18T13:30:04.000Z",
  },
  {
    id: "preview-queued",
    nativeJobId: "preview-job-queued",
    source: { kind: "localFile", path: "C:\\Samples\\Velvet Static 92 BPM Am.wav" },
    inspection: {
      id: "preview-velvet",
      source: { kind: "localFile", path: "C:\\Samples\\Velvet Static 92 BPM Am.wav" },
      sourceFingerprint: "preview:local:velvet-static",
      kind: "localFile",
      title: "Velvet Static",
      creator: "Eternia Sessions",
      durationSeconds: 201,
      sourcePath: "C:\\Samples\\Velvet Static 92 BPM Am.wav",
      sourceLabel: "Local file",
      isLive: false,
      codec: "PCM 24-bit",
      fileSizeBytes: 64_200_000,
      audio: { codec: "PCM 24-bit", durationMs: 201_000, fileSizeBytes: 64_200_000, sampleRateHz: 44_100, bitDepth: 24, channels: 2 },
      declaredMetadata: metadata(92, "A minor", "8A"),
      embeddedMetadata: metadata(92, "A minor", "8A"),
      suggestedMetadata: metadata(92, "A minor", "8A"),
      warnings: [],
      metadata: metadata(92, "A minor", "8A"),
    },
    metadata: { title: "Velvet Static", artist: "Eternia Sessions", bpm: "92", key: "A minor", detuneCents: "" },
    presetId: "mp3Cbr320",
    channelMode: "preserve",
    writeEmbeddedTags: true,
    templateId: "producer-title",
    outputDirectory: "C:\\Users\\Producer\\Downloads\\Sonic",
    filenamePreview: "Eternia Sessions - Velvet Static [8A].mp3",
    status: "queued",
    progress: { percent: 0, message: "Waiting for the active export" },
    createdAt: "2026-07-18T13:31:00.000Z",
    updatedAt: "2026-07-18T13:31:00.000Z",
  },
];

const DEFAULT_LIBRARY: LibraryItem[] = [
  {
    id: "library-crimson",
    title: "Crimson Sky",
    creator: "Northroom",
    source: { kind: "youtube", url: "https://www.youtube.com/watch?v=jNQXAC9IVRw" },
    sourceLabel: "YouTube",
    outputPath: "C:\\Users\\Producer\\Downloads\\Sonic\\Crimson Sky — 124 BPM — B minor.wav",
    format: "wav",
    fileSizeBytes: 47_800_000,
    durationSeconds: 189,
    bpm: 124,
    key: "B minor",
    camelot: "10A",
    detuneCents: 0,
    exportedAt: "2026-07-17T22:18:00.000Z",
    exists: true,
    presetId: "wav44100S24",
  },
  {
    id: "library-aurora",
    title: "Aurora",
    creator: "Nocturne Club",
    source: { kind: "localFile", path: "C:\\Sessions\\Aurora master.m4a" },
    sourceLabel: "Local file",
    outputPath: "C:\\Users\\Producer\\Downloads\\Sonic\\Aurora_123_Aminor.m4a",
    format: "m4a",
    fileSizeBytes: 8_900_000,
    durationSeconds: 162,
    bpm: 123,
    key: "A minor",
    camelot: "8A",
    exportedAt: "2026-07-16T18:42:00.000Z",
    exists: true,
    presetId: "m4aAac256",
  },
  {
    id: "library-paper-planes",
    title: "Paper Planes",
    creator: "Collab Archive",
    source: { kind: "youtube", url: "https://www.youtube.com/watch?v=jNQXAC9IVRw" },
    sourceLabel: "YouTube",
    outputPath: "D:\\Old exports\\Paper Planes — 122 BPM — F# minor.mp3",
    format: "mp3",
    fileSizeBytes: 7_100_000,
    durationSeconds: 198,
    bpm: 122,
    key: "F# minor",
    camelot: "11A",
    exportedAt: "2026-07-11T09:15:00.000Z",
    exists: false,
    presetId: "mp3Cbr320",
  },
];

function readStore(): PreviewStore {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    if (value) return JSON.parse(value) as PreviewStore;
  } catch {
    // Browser preview remains usable when storage is unavailable.
  }
  return {
    jobs: DEFAULT_JOBS,
    library: DEFAULT_LIBRARY,
    settings: {
      ...DEFAULT_SETTINGS,
      defaultOutputDirectory: "C:\\Users\\Producer\\Downloads\\Sonic",
    },
    paused: false,
  };
}

function waveform(seed: string, count = 240) {
  let state = [...seed].reduce((value, character) => value + character.charCodeAt(0), 17);
  return Array.from({ length: count }, (_, index) => {
    state = (state * 9301 + 49297) % 233280;
    const noise = state / 233280;
    const envelope = 0.28 + Math.sin((index / count) * Math.PI) * 0.72;
    const pulse = 0.55 + Math.abs(Math.sin(index * 0.39)) * 0.45;
    return Math.max(0.08, Math.min(1, (0.2 + noise * 0.8) * envelope * pulse));
  });
}

export class BrowserPreviewBridge implements SonicBridge {
  readonly mode = "preview" as const;
  private store = readStore();
  private jobListeners = new Set<(job: QueueItem) => void>();
  private queueListeners = new Set<(queue: QueueSnapshot) => void>();
  private timers = new Map<string, number>();

  private persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.store));
    } catch {
      // Persistence is an enhancement for preview mode, never a runtime requirement.
    }
  }

  private emitJob(job: QueueItem) {
    this.jobListeners.forEach((listener) => listener(structuredClone(job)));
  }

  private emitQueue() {
    const snapshot = { paused: this.store.paused, jobs: structuredClone(this.store.jobs) };
    this.queueListeners.forEach((listener) => listener(snapshot));
  }

  async bootstrap(): Promise<BootstrapPayload> {
    await new Promise((resolve) => window.setTimeout(resolve, 180));
    return {
      settings: structuredClone(this.store.settings),
      jobs: structuredClone(this.store.jobs),
      library: structuredClone(this.store.library),
      presets: BUILTIN_PRESETS,
      diagnostics: await this.getDiagnostics(),
      queuePaused: this.store.paused,
      queueRevision: 1,
      settingsRevision: 1,
    };
  }

  async inspectSource(source: SourceInput): Promise<SourceInspection> {
    await new Promise((resolve) => window.setTimeout(resolve, 650));
    if (source.kind === "youtube") {
      const suffix = source.url.includes("jNQXAC9IVRw") ? "" : ` ${source.url.slice(-4).toUpperCase()}`;
      return {
        ...structuredClone(NIGHT_SHIFT),
        id: makeId("source"),
        source,
        sourceFingerprint: `preview:youtube:${source.url}`,
        title: `${NIGHT_SHIFT.title}${suffix}`,
        sourceUrl: source.url,
      };
    }
    const rawName = source.path.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, "") ?? "Imported audio";
    const title = rawName.replace(/[-_]+/g, " ").replace(/\s+(?:\d+(?:\.\d+)?\s*BPM|[A-G](?:#|b)?\s*(?:maj(?:or)?|min(?:or)?|m)?).*$/i, "").trim() || rawName;
    const localMetadata = metadata(128, "C minor", "5A");
    return {
      id: makeId("source"),
      source,
      sourceFingerprint: `preview:local:${source.path.toLocaleLowerCase()}`,
      kind: "localFile",
      title,
      creator: "Local session",
      durationSeconds: 196,
      sourcePath: source.path,
      sourceLabel: "Local file",
      isLive: false,
      codec: "PCM / stereo",
      fileSizeBytes: 58_400_000,
      audio: { codec: "PCM / stereo", durationMs: 196_000, fileSizeBytes: 58_400_000, sampleRateHz: 48_000, channels: 2, bitDepth: 24 },
      declaredMetadata: localMetadata,
      embeddedMetadata: localMetadata,
      suggestedMetadata: localMetadata,
      warnings: [],
      metadata: localMetadata,
    };
  }

  async listExportPresets() {
    return BUILTIN_PRESETS;
  }

  async previewFilename(request: FilenamePreviewRequest) {
    const preset = BUILTIN_PRESETS.find((item) => item.id === request.presetId) ?? BUILTIN_PRESETS[0];
    return renderFilename(request, preset.extension);
  }

  async enqueueExports(requests: ExportRequest[]) {
    const jobs = requests.map((request) => {
      const existing = this.store.jobs.find((item) => item.id === request.itemId);
      const now = new Date().toISOString();
      return {
        ...(existing ?? {
          id: request.itemId,
          source: request.source,
          inspection: request.inspection,
          metadata: request.metadata,
          presetId: request.presetId,
          channelMode: request.channelMode,
          normalizeLufs: request.normalizeLufs,
          writeEmbeddedTags: request.writeEmbeddedTags,
          templateId: "title-metadata",
          outputDirectory: request.outputDirectory,
          filenamePreview: "",
          progress: {},
          createdAt: now,
        }),
        nativeJobId: existing?.nativeJobId ?? makeId("job"),
        status: "queued" as const,
        updatedAt: now,
        progress: { percent: 0, message: "Queued" },
      };
    });
    for (const job of jobs) {
      const index = this.store.jobs.findIndex((item) => item.id === job.id);
      if (index >= 0) this.store.jobs[index] = job;
      else this.store.jobs.push(job);
      this.emitJob(job);
    }
    this.persist();
    this.emitQueue();
    this.startNext();
    return structuredClone(jobs);
  }

  private startNext() {
    if (this.store.paused || this.store.jobs.some((item) => ["preparing", "acquiring", "copying", "transcoding", "tagging", "validating", "publishing"].includes(item.status))) return;
    const job = this.store.jobs.find((item) => item.status === "queued");
    if (!job) return;
    let percent = 0;
    job.status = "acquiring";
    job.progress = { percent: 0, message: "Acquiring source audio" };
    this.emitJob(job);
    const timer = window.setInterval(() => {
      percent += 4 + Math.round(Math.random() * 4);
      if (percent >= 100) {
        window.clearInterval(timer);
        this.timers.delete(job.id);
        job.status = "completed";
        job.progress = { percent: 100, message: "Export complete" };
        job.outputPath = `${job.outputDirectory}\\${job.filenamePreview}`;
        job.updatedAt = new Date().toISOString();
        if (job.inspection && this.store.settings.historyEnabled) {
          this.store.library.unshift({
            id: makeId("library"),
            title: job.inspection.title,
            creator: job.inspection.creator,
            source: job.source,
            sourceLabel: job.inspection.sourceLabel,
            thumbnailUrl: job.inspection.thumbnailUrl,
            outputPath: job.outputPath,
            format: BUILTIN_PRESETS.find((preset) => preset.id === job.presetId)?.extension ?? "audio",
            durationSeconds: job.inspection.durationSeconds,
            bpm: Number(job.metadata.bpm) || undefined,
            key: job.metadata.key || undefined,
            camelot: job.inspection.metadata.camelot,
            detuneCents: Number(job.metadata.detuneCents) || undefined,
            exportedAt: job.updatedAt,
            exists: true,
            presetId: job.presetId,
          });
        }
        this.persist();
        this.emitJob(job);
        this.emitQueue();
        this.startNext();
        return;
      }
      job.status = percent >= 96 ? "publishing" : percent >= 90 ? "tagging" : percent >= 78 ? "transcoding" : "acquiring";
      job.progress = {
        percent: Math.min(percent, 99),
        downloadedBytes: Math.round(42_000_000 * Math.min(percent, 78) / 78),
        totalBytes: 42_000_000,
        speedBytesPerSecond: job.status === "acquiring" ? 5_200_000 : undefined,
        etaSeconds: Math.max(0, Math.round((100 - percent) / 8)),
        message: job.status === "transcoding" ? "Rendering output preset" : job.status === "tagging" ? "Writing metadata" : job.status === "publishing" ? "Publishing safely" : "Acquiring source audio",
      };
      this.emitJob(job);
    }, 420);
    this.timers.set(job.id, timer);
  }

  async listJobs() {
    return structuredClone(this.store.jobs);
  }

  async getJob(jobId: string) {
    const job = this.store.jobs.find((item) => item.nativeJobId === jobId || item.id === jobId);
    if (!job) throw new Error("That queue item no longer exists.");
    return structuredClone(job);
  }

  async updateQueuedJob(jobId: string, patch: Partial<QueueItem>) {
    const job = this.store.jobs.find((item) => item.nativeJobId === jobId || item.id === jobId);
    if (!job) throw new Error("That queue item no longer exists.");
    Object.assign(job, patch, { updatedAt: new Date().toISOString() });
    this.persist();
    this.emitJob(job);
    return structuredClone(job);
  }

  async cancelJob(jobId: string) {
    const job = this.store.jobs.find((item) => item.nativeJobId === jobId || item.id === jobId);
    if (!job) return false;
    const timer = this.timers.get(job.id);
    if (timer !== undefined) window.clearInterval(timer);
    this.timers.delete(job.id);
    job.status = "cancelled";
    job.progress = { message: "Cancelled" };
    this.persist();
    this.emitJob(job);
    this.startNext();
    return true;
  }

  async retryJob(jobId: string) {
    const job = await this.getJob(jobId);
    const stored = this.store.jobs.find((item) => item.id === job.id);
    if (!stored) throw new Error("That queue item no longer exists.");
    stored.status = "queued";
    stored.error = undefined;
    stored.errorCode = undefined;
    stored.progress = { percent: 0, message: "Queued for retry" };
    this.persist();
    this.emitJob(stored);
    this.startNext();
    return structuredClone(stored);
  }

  async removeJob(jobId: string) {
    const index = this.store.jobs.findIndex((item) => item.nativeJobId === jobId || item.id === jobId);
    if (index < 0) return false;
    const [removed] = this.store.jobs.splice(index, 1);
    const timer = this.timers.get(removed.id);
    if (timer !== undefined) window.clearInterval(timer);
    this.timers.delete(removed.id);
    this.persist();
    this.emitQueue();
    return true;
  }

  async reorderQueue(jobIds: string[]) {
    const positions = new Map(jobIds.map((id, index) => [id, index]));
    const positionFor = (item: QueueItem) => positions.get(item.id)
      ?? positions.get(item.nativeJobId ?? "")
      ?? Number.MAX_SAFE_INTEGER;
    this.store.jobs.sort((a, b) => positionFor(a) - positionFor(b));
    this.persist();
    this.emitQueue();
    return { paused: this.store.paused, jobs: structuredClone(this.store.jobs) };
  }

  async setQueuePaused(paused: boolean) {
    this.store.paused = paused;
    this.store.settings.queuePaused = paused;
    this.persist();
    this.emitQueue();
    if (!paused) this.startNext();
    return { paused, jobs: structuredClone(this.store.jobs) };
  }

  async listLibrary(query = "", filters?: LibraryFilters, sort: LibrarySort = "newest") {
    const normalized = query.trim().toLocaleLowerCase();
    const minimum = Number(filters?.bpmMin);
    const maximum = Number(filters?.bpmMax);
    const result = this.store.library.filter((item) => {
      const searchable = `${item.title} ${item.creator ?? ""} ${item.key ?? ""} ${item.bpm ?? ""} ${item.outputPath}`.toLocaleLowerCase();
      return (!normalized || searchable.includes(normalized))
        && (!filters?.format || item.format === filters.format)
        && (!filters?.key || item.key?.toLocaleLowerCase().includes(filters.key.toLocaleLowerCase()))
        && (!filters?.bpmMin || (item.bpm ?? 0) >= minimum)
        && (!filters?.bpmMax || (item.bpm ?? Number.MAX_SAFE_INTEGER) <= maximum)
        && (!filters?.missingOnly || !item.exists);
    });
    result.sort((a, b) => {
      if (sort === "oldest") return a.exportedAt.localeCompare(b.exportedAt);
      if (sort === "title") return a.title.localeCompare(b.title);
      if (sort === "bpm") return (a.bpm ?? Number.MAX_SAFE_INTEGER) - (b.bpm ?? Number.MAX_SAFE_INTEGER);
      return b.exportedAt.localeCompare(a.exportedAt);
    });
    return structuredClone(result);
  }

  async getLibraryItem(itemId: string) {
    const item = this.store.library.find((candidate) => candidate.id === itemId);
    if (!item) throw new Error("That library item no longer exists.");
    return structuredClone(item);
  }

  async reexportLibraryItem(itemId: string) {
    const libraryItem = await this.getLibraryItem(itemId);
    const inspection = await this.inspectSource(libraryItem.source);
    const now = new Date().toISOString();
    const job: QueueItem = {
      id: makeId("item"),
      source: libraryItem.source,
      inspection,
      metadata: {
        bpm: libraryItem.bpm?.toString() ?? "",
        key: libraryItem.key ?? "",
        detuneCents: libraryItem.detuneCents?.toString() ?? "",
      },
      presetId: libraryItem.presetId ?? this.store.settings.defaultPresetId,
      channelMode: "preserve",
      writeEmbeddedTags: this.store.settings.writeEmbeddedTags,
      templateId: this.store.settings.defaultTemplateId,
      outputDirectory: this.store.settings.defaultOutputDirectory,
      filenamePreview: libraryItem.outputPath.split(/[\\/]/).pop() ?? libraryItem.title,
      status: "review",
      progress: {},
      createdAt: now,
      updatedAt: now,
    };
    this.store.jobs.push(job);
    this.persist();
    this.emitQueue();
    return structuredClone(job);
  }

  async removeLibraryItem(itemId: string, _deleteFile: boolean) {
    const index = this.store.library.findIndex((item) => item.id === itemId);
    if (index < 0) return false;
    this.store.library.splice(index, 1);
    this.persist();
    return true;
  }

  async getSettings() {
    return structuredClone(this.store.settings);
  }

  async updateSettings(settings: SonicSettings) {
    this.store.settings = structuredClone({ ...settings, queuePaused: this.store.paused });
    this.persist();
    return structuredClone(this.store.settings);
  }

  async getDiagnostics(): Promise<Diagnostics> {
    return {
      appVersion: "0.2.0 browser preview",
      operatingSystem: navigator.platform || "Browser preview",
      webviewVersion: "Preview adapter",
      engine: {
        ready: true,
        dependencies: ["yt-dlp", "Python", "Deno", "FFmpeg", "ffprobe"].map((name) => ({
          name,
          available: true,
          version: "preview",
        })),
      },
      outputDirectory: this.store.settings.defaultOutputDirectory,
      outputWritable: true,
      availableDiskBytes: 128_400_000_000,
      updateStatus: "Browser preview — native checks are not running",
      logDirectory: "Local diagnostics are available in the installed app",
    };
  }

  async exportDiagnostics() {
    await new Promise((resolve) => window.setTimeout(resolve, 260));
    return "Browser preview copied a redacted diagnostic fixture.";
  }

  async chooseLocalFiles() {
    await new Promise((resolve) => window.setTimeout(resolve, 180));
    return ["C:\\Samples\\Midnight Frequency 126 BPM Gm.wav", "C:\\Samples\\Solar Drift 138 BPM Fm.flac"];
  }

  async chooseDirectory(current?: string) {
    return current || "C:\\Users\\Producer\\Downloads\\Sonic";
  }

  async registerFileDrop(_handler: (event: { type: "enter" | "over" | "drop" | "leave"; paths: string[] }) => void): Promise<Unsubscribe> {
    return () => undefined;
  }

  async subscribe(onJob: (job: QueueItem) => void, onQueue: (queue: QueueSnapshot) => void): Promise<Unsubscribe> {
    this.jobListeners.add(onJob);
    this.queueListeners.add(onQueue);
    return () => {
      this.jobListeners.delete(onJob);
      this.queueListeners.delete(onQueue);
    };
  }

  async preparePreview(item: QueueItem | LibraryItem): Promise<PreviewAsset | null> {
    const isQueueItem = "status" in item;
    const title = isQueueItem ? item.inspection?.title ?? "Audio preview" : item.title;
    const id = isQueueItem ? item.inspection?.id ?? item.id : item.id;
    const durationSeconds = isQueueItem ? item.inspection?.durationSeconds ?? 180 : item.durationSeconds ?? 180;
    return { id: makeId("preview"), durationSeconds, waveform: waveform(id), title };
  }

  async releasePreview(_previewId: string) {}

  async revealPath(path: string) {
    window.alert(`Browser preview would reveal:\n${path}`);
  }

  async openSource(source: SourceInput) {
    if (source.kind === "youtube") window.open(source.url, "_blank", "noopener,noreferrer");
    else window.alert(`Browser preview would open:\n${source.path}`);
  }

  async prepareEngine() {
    await new Promise((resolve) => window.setTimeout(resolve, 600));
  }

  async refreshDependencies() {
    return this.getDiagnostics();
  }
}
