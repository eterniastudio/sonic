import { BUILTIN_PRESETS, DEFAULT_SETTINGS } from "../domain/defaults";
import type {
  AudioProperties,
  BootstrapPayload,
  DependencyInfo,
  DependencyStatus,
  Diagnostics,
  ExportPreset,
  ExportPresetId,
  LibraryItem,
  MetadataDraft,
  MetadataMatch,
  MusicMetadata,
  QueueItem,
  QueueProgress,
  QueueSnapshot,
  QueueStatus,
  SonicSettings,
  SourceInput,
  SourceInspection,
} from "../domain/types";

export function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function asString(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

export function asOptionalString(value: unknown) {
  const result = asString(value).trim();
  return result ? result : undefined;
}

export function asNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function asBoolean(value: unknown, fallback = false) {
  return typeof value === "boolean" ? value : fallback;
}

export function asArray(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function numericText(value: unknown, fallback = "") {
  const number = asNumber(value);
  return number !== undefined ? number.toString() : asString(value, fallback);
}

function isoFromMilliseconds(value: unknown, fallback: string) {
  const milliseconds = asNumber(value);
  return milliseconds === undefined ? fallback : new Date(milliseconds).toISOString();
}

function emptyMetadata(): MusicMetadata {
  return { alternateBpms: [], confidence: 0, matches: [], warnings: [] };
}

function normalizeMatch(value: unknown): MetadataMatch {
  const raw = asRecord(value);
  return {
    kind: asString(raw.kind, "metadata"),
    displayValue: asString(raw.displayValue ?? raw.value),
    rawText: asString(raw.rawText ?? raw.raw),
    source: asString(raw.source, "source"),
    confidence: asNumber(raw.confidence) ?? 0,
  };
}

export function normalizeMetadata(value: unknown): MusicMetadata {
  const raw = asRecord(value);
  return {
    bpm: asNumber(raw.bpm),
    alternateBpms: asArray(raw.alternateBpms).map(asNumber).filter((item): item is number => item !== undefined),
    key: asOptionalString(raw.key),
    camelot: asOptionalString(raw.camelot),
    detuneCents: asNumber(raw.detuneCents),
    tuningHz: asNumber(raw.tuningHz),
    confidence: asNumber(raw.confidence) ?? 0,
    matches: asArray(raw.matches ?? raw.evidence).map(normalizeMatch),
    warnings: asArray(raw.warnings).map((item) => asString(item)).filter(Boolean),
  };
}

export function normalizeSource(value: unknown): SourceInput {
  const raw = asRecord(value);
  const kind = asString(raw.kind);
  if (kind === "localFile" || raw.path !== undefined || raw.sourcePath !== undefined) {
    return { kind: "localFile", path: asString(raw.path ?? raw.sourcePath) };
  }
  return { kind: "youtube", url: asString(raw.url ?? raw.sourceUrl ?? raw.webpageUrl) };
}

function normalizeAudio(value: unknown): AudioProperties {
  const raw = asRecord(value);
  return {
    container: asOptionalString(raw.container),
    codec: asOptionalString(raw.codec),
    sampleRateHz: asNumber(raw.sampleRateHz),
    channels: asNumber(raw.channels),
    bitDepth: asNumber(raw.bitDepth),
    durationMs: asNumber(raw.durationMs),
    fileSizeBytes: asNumber(raw.fileSizeBytes),
  };
}

export function normalizeInspection(value: unknown, fallbackSource?: SourceInput): SourceInspection {
  const raw = asRecord(value);
  const source = raw.source ? normalizeSource(raw.source) : fallbackSource ?? normalizeSource(raw);
  const declaredMetadata = normalizeMetadata(raw.declaredMetadata ?? raw.metadata);
  const embeddedMetadata = raw.embeddedMetadata ? normalizeMetadata(raw.embeddedMetadata) : emptyMetadata();
  const suggestedMetadata = raw.suggestedMetadata
    ? normalizeMetadata(raw.suggestedMetadata)
    : declaredMetadata;
  const audio = normalizeAudio(raw.audio);
  const durationSeconds = asNumber(raw.durationSeconds ?? raw.duration)
    ?? (audio.durationMs !== undefined ? audio.durationMs / 1_000 : undefined);
  const sourceUrl = asOptionalString(raw.webpageUrl ?? raw.sourceUrl) ?? (source.kind === "youtube" ? source.url : undefined);
  const sourcePath = asOptionalString(raw.sourcePath ?? raw.path) ?? (source.kind === "localFile" ? source.path : undefined);
  const title = asString(
    raw.title ?? raw.displayTitle,
    source.kind === "localFile" ? source.path.split(/[\\/]/).pop() ?? "Local audio" : "Untitled source",
  );
  return {
    id: asString(raw.id ?? raw.sourceId, globalThis.crypto?.randomUUID?.() ?? String(Date.now())),
    source,
    sourceFingerprint: asString(raw.sourceFingerprint ?? raw.fingerprint),
    kind: source.kind,
    title,
    creator: asOptionalString(raw.artist ?? raw.creator ?? raw.uploader ?? raw.producer),
    description: asOptionalString(raw.description),
    durationSeconds,
    thumbnailUrl: asOptionalString(raw.thumbnailUrl ?? raw.artworkUrl),
    sourceUrl,
    sourcePath,
    sourceLabel: asString(raw.sourceLabel, source.kind === "youtube" ? "YouTube" : "Local file"),
    isLive: asBoolean(raw.isLive),
    fileSizeBytes: audio.fileSizeBytes ?? asNumber(raw.fileSizeBytes ?? raw.fileSize),
    codec: audio.codec ?? asOptionalString(raw.codec ?? raw.audioCodec),
    audio,
    declaredMetadata,
    embeddedMetadata,
    suggestedMetadata,
    warnings: asArray(raw.warnings).map((item) => asString(item)).filter(Boolean),
    metadata: suggestedMetadata,
  };
}

function normalizeDraft(value: unknown, inspection?: SourceInspection): MetadataDraft {
  const raw = asRecord(value);
  const metadata = inspection?.suggestedMetadata;
  return {
    title: asOptionalString(raw.title) ?? inspection?.title,
    artist: asOptionalString(raw.artist) ?? inspection?.creator,
    bpm: numericText(raw.bpm, metadata?.bpm?.toString() ?? ""),
    key: asString(raw.key, metadata?.key ?? ""),
    detuneCents: numericText(raw.detuneCents, metadata?.detuneCents?.toString() ?? ""),
    alternateBpms: asArray(raw.alternateBpms).map(asNumber).filter((item): item is number => item !== undefined),
    camelot: asOptionalString(raw.camelot) ?? metadata?.camelot,
    tuningHz: asNumber(raw.tuningHz) ?? metadata?.tuningHz,
  };
}

function normalizeStatus(value: unknown): QueueStatus {
  const normalized = asString(value).replace(/[_-](.)/g, (_, letter: string) => letter.toUpperCase());
  const supported: QueueStatus[] = [
    "draft", "inspecting", "review", "queued", "preparing", "acquiring", "copying",
    "transcoding", "tagging", "validating", "publishing", "completed", "failed",
    "cancelled", "interrupted",
  ];
  return supported.includes(normalized as QueueStatus) ? normalized as QueueStatus : "review";
}

function normalizeProgress(value: unknown): QueueProgress {
  const raw = asRecord(value);
  return {
    percent: asNumber(raw.percent),
    downloadedBytes: asNumber(raw.downloadedBytes),
    totalBytes: asNumber(raw.totalBytes),
    speedBytesPerSecond: asNumber(raw.speedBytesPerSecond),
    etaSeconds: asNumber(raw.etaSeconds),
    message: asOptionalString(raw.message),
  };
}

function normalizePresetId(value: unknown, fallback: ExportPresetId = "mp3Cbr320"): ExportPresetId {
  const id = asString(value) as ExportPresetId;
  return BUILTIN_PRESETS.some((preset) => preset.id === id) ? id : fallback;
}

export function normalizeQueueItem(value: unknown, fallback?: Partial<QueueItem>): QueueItem {
  const raw = asRecord(value);
  const request = asRecord(raw.request);
  const source = (request.source ?? raw.source) ? normalizeSource(request.source ?? raw.source) : fallback?.source ?? { kind: "youtube", url: "" };
  const inspectionValue = request.inspection ?? raw.inspection ?? raw.sourceInspection ?? raw.media;
  const inspection = inspectionValue ? normalizeInspection(inspectionValue, source) : fallback?.inspection;
  const metadata = normalizeDraft(request.metadata ?? raw.metadata ?? raw.metadataDraft, inspection);
  const exportSpec = asRecord(request.export ?? raw.export);
  const now = new Date().toISOString();
  const backendId = asOptionalString(raw.jobId ?? raw.nativeJobId ?? raw.id);
  return {
    id: asString(raw.itemId ?? raw.clientItemId, fallback?.id ?? backendId ?? globalThis.crypto?.randomUUID?.() ?? String(Date.now())),
    nativeJobId: backendId ?? fallback?.nativeJobId,
    source,
    inspection: inspection ?? (asOptionalString(raw.title) ? normalizeInspection({
      id: backendId,
      source,
      title: raw.title,
      artist: raw.artist,
      suggestedMetadata: request.metadata,
    }, source) : undefined),
    metadata,
    presetId: normalizePresetId(exportSpec.presetId ?? raw.presetId, fallback?.presetId),
    channelMode: asString(exportSpec.channelMode, fallback?.channelMode ?? "preserve") as QueueItem["channelMode"],
    normalizeLufs: asNumber(exportSpec.normalizeLufs) ?? fallback?.normalizeLufs,
    writeEmbeddedTags: asBoolean(exportSpec.writeEmbeddedTags, fallback?.writeEmbeddedTags ?? true),
    templateId: asString(raw.templateId, fallback?.templateId ?? "title-metadata"),
    customTemplate: asOptionalString(request.filenameTemplate ?? raw.customTemplate ?? raw.filenameTemplate) ?? fallback?.customTemplate,
    outputDirectory: asString(request.outputDirectory ?? raw.outputDirectory, fallback?.outputDirectory ?? ""),
    filenamePreview: asString(raw.filenamePreview ?? raw.fileName, fallback?.filenamePreview ?? ""),
    status: normalizeStatus(raw.state ?? raw.status ?? fallback?.status),
    progress: normalizeProgress(raw.progress ?? raw),
    outputPath: asOptionalString(raw.outputPath) ?? fallback?.outputPath,
    error: asOptionalString(raw.errorMessage ?? raw.error) ?? fallback?.error,
    errorCode: asOptionalString(raw.errorCode) ?? fallback?.errorCode,
    queuePosition: asNumber(raw.queuePosition) ?? fallback?.queuePosition,
    revision: asNumber(raw.revision) ?? fallback?.revision,
    attempt: asNumber(raw.attempt) ?? fallback?.attempt,
    createdAt: isoFromMilliseconds(raw.createdAtMs, asString(raw.createdAt, fallback?.createdAt ?? now)),
    updatedAt: isoFromMilliseconds(raw.finishedAtMs ?? raw.startedAtMs, asString(raw.updatedAt, fallback?.updatedAt ?? now)),
  };
}

export function normalizeLibraryItem(value: unknown): LibraryItem {
  const raw = asRecord(value);
  const source = normalizeSource(raw.source ?? raw);
  const createdAt = isoFromMilliseconds(raw.createdAtMs, asString(raw.exportedAt ?? raw.createdAt, new Date().toISOString()));
  return {
    id: asString(raw.itemId ?? raw.id, globalThis.crypto?.randomUUID?.() ?? String(Date.now())),
    jobId: asOptionalString(raw.jobId),
    clientItemId: asOptionalString(raw.clientItemId),
    title: asString(raw.title, "Untitled export"),
    creator: asOptionalString(raw.artist ?? raw.creator ?? raw.producer),
    source,
    sourceLabel: asString(raw.sourceLabel, source.kind === "youtube" ? "YouTube" : "Local file"),
    thumbnailUrl: asOptionalString(raw.thumbnailUrl ?? raw.artworkUrl),
    outputPath: asString(raw.audioPath ?? raw.outputPath ?? raw.path),
    format: asString(raw.format ?? raw.extension, "audio"),
    fileSizeBytes: asNumber(raw.fileSizeBytes ?? raw.fileSize),
    durationSeconds: asNumber(raw.durationSeconds ?? raw.duration)
      ?? (asNumber(raw.durationMs) !== undefined ? (asNumber(raw.durationMs) ?? 0) / 1_000 : undefined),
    bpm: asNumber(raw.bpm ?? asRecord(raw.metadata).bpm),
    key: asOptionalString(raw.key ?? asRecord(raw.metadata).key),
    camelot: asOptionalString(raw.camelot ?? asRecord(raw.metadata).camelot),
    detuneCents: asNumber(raw.detuneCents ?? asRecord(raw.metadata).detuneCents),
    exportedAt: createdAt,
    exists: !asBoolean(raw.missing),
    presetId: normalizePresetId(raw.presetId),
    sidecarPath: asOptionalString(raw.sidecarPath),
    sha256: asOptionalString(raw.sha256),
  };
}

function normalizeDependency(value: unknown): DependencyInfo {
  const raw = asRecord(value);
  return {
    name: asString(raw.name, "tool"),
    available: asBoolean(raw.available),
    version: asOptionalString(raw.version),
    error: asOptionalString(raw.error),
  };
}

export function normalizeDependencies(value: unknown): DependencyStatus {
  const raw = asRecord(value);
  const dependencies = asArray(raw.dependencies).map(normalizeDependency);
  return {
    ready: asBoolean(raw.ready, dependencies.length > 0 && dependencies.every((item) => item.available)),
    dependencies,
  };
}

export function normalizePreset(value: unknown): ExportPreset {
  const raw = asRecord(value);
  const id = normalizePresetId(raw.id ?? raw.presetId);
  const builtin = BUILTIN_PRESETS.find((item) => item.id === id);
  return {
    ...(builtin ?? BUILTIN_PRESETS[0]),
    id,
    name: asString(raw.label ?? raw.name, builtin?.name ?? id),
    shortName: asString(raw.shortName, builtin?.shortName ?? id),
    description: asString(raw.description, builtin?.description ?? ""),
    extension: asString(raw.extension, builtin?.extension ?? "audio"),
    lossy: asBoolean(raw.lossy, builtin?.lossy ?? false),
    supportsEmbeddedTags: asBoolean(raw.supportsEmbeddedTags, builtin?.supportsEmbeddedTags ?? false),
  };
}

export function normalizeSettings(value: unknown): SonicSettings {
  const snapshot = asRecord(value);
  const raw = snapshot.settings ? asRecord(snapshot.settings) : snapshot;
  const filenameTemplate = asString(raw.filenameTemplate, DEFAULT_SETTINGS.filenameTemplate);
  return {
    ...DEFAULT_SETTINGS,
    defaultOutputDirectory: asString(raw.defaultOutputDirectory, DEFAULT_SETTINGS.defaultOutputDirectory),
    filenameTemplate,
    defaultPresetId: normalizePresetId(raw.defaultPresetId, DEFAULT_SETTINGS.defaultPresetId),
    defaultTemplateId: DEFAULT_SETTINGS.templates.find((template) => template.template === filenameTemplate)?.id ?? "custom-default",
    maxConcurrentJobs: asNumber(raw.maxConcurrentJobs) ?? DEFAULT_SETTINGS.maxConcurrentJobs,
    historyEnabled: asBoolean(raw.historyEnabled, DEFAULT_SETTINGS.historyEnabled),
    writeEmbeddedTags: asBoolean(raw.writeEmbeddedTags, DEFAULT_SETTINGS.writeEmbeddedTags),
    includeSourcePathInSidecar: asBoolean(raw.includeSourcePathInSidecar, DEFAULT_SETTINGS.includeSourcePathInSidecar),
    maxDurationMinutes: asNumber(raw.maxDurationMinutes) ?? DEFAULT_SETTINGS.maxDurationMinutes,
    maxInputBytes: asNumber(raw.maxInputBytes) ?? DEFAULT_SETTINGS.maxInputBytes,
    queuePaused: asBoolean(raw.queuePaused, DEFAULT_SETTINGS.queuePaused),
    previewSeconds: asNumber(raw.previewSeconds) ?? DEFAULT_SETTINGS.previewSeconds,
    confirmBeforeRemoving: asBoolean(raw.confirmBeforeRemoving, DEFAULT_SETTINGS.confirmBeforeRemoving),
    templates: DEFAULT_SETTINGS.templates,
  };
}

export function normalizeDiagnostics(value: unknown, fallbackOutput = "", fallbackDependencies?: unknown): Diagnostics {
  const raw = asRecord(value);
  const recovery = asRecord(raw.recoveryReport);
  return {
    appVersion: asString(raw.appVersion ?? raw.version, "0.2 preview"),
    dbSchemaVersion: asNumber(raw.dbSchemaVersion),
    operatingSystem: asString(raw.operatingSystem ?? raw.os, "Windows"),
    architecture: asOptionalString(raw.architecture),
    webviewVersion: asOptionalString(raw.webviewVersion),
    engine: normalizeDependencies(raw.dependencies ?? raw.engine ?? fallbackDependencies),
    outputDirectory: asString(raw.outputDirectory, fallbackOutput),
    outputWritable: typeof raw.outputWritable === "boolean"
      ? raw.outputWritable
      : typeof raw.dataDirectoryWritable === "boolean" ? raw.dataDirectoryWritable : undefined,
    availableDiskBytes: asNumber(raw.availableDiskBytes ?? raw.freeDiskBytes),
    updateStatus: asOptionalString(raw.updateStatus),
    logDirectory: asOptionalString(raw.logDirectory),
    databaseHealthy: typeof raw.databaseHealthy === "boolean" ? raw.databaseHealthy : undefined,
    databaseFile: asOptionalString(raw.databaseFile),
    dataDirectoryWritable: typeof raw.dataDirectoryWritable === "boolean" ? raw.dataDirectoryWritable : undefined,
    mediaEngineDirectory: asOptionalString(raw.mediaEngineDirectory),
    libraryCount: asNumber(raw.libraryCount),
    generatedAtMs: asNumber(raw.generatedAtMs),
    recoveryWarnings: asArray(recovery.warnings).map((item) => asString(item)).filter(Boolean),
  };
}

export function normalizeBootstrap(value: unknown): BootstrapPayload {
  const raw = asRecord(value);
  const settingsSnapshot = asRecord(raw.settings);
  const settings = normalizeSettings(settingsSnapshot);
  const queue = normalizeQueueSnapshot(raw.queue);
  settings.queuePaused = queue.paused;
  const presets = asArray(raw.exportPresets ?? raw.presets).map(normalizePreset);
  const library = asArray(raw.recentLibrary ?? raw.library ?? raw.libraryItems).map(normalizeLibraryItem);
  const diagnostics = normalizeDiagnostics({
    appVersion: raw.appVersion,
    dbSchemaVersion: raw.dbSchemaVersion,
    dependencies: raw.dependencyStatus,
    outputDirectory: settings.defaultOutputDirectory,
    recoveryReport: raw.recoveryReport,
  }, settings.defaultOutputDirectory, raw.dependencyStatus);
  return {
    settings,
    diagnostics,
    jobs: queue.jobs,
    library,
    presets: presets.length ? presets : BUILTIN_PRESETS,
    queuePaused: queue.paused,
    queueRevision: queue.revision ?? 0,
    settingsRevision: asNumber(settingsSnapshot.revision) ?? 0,
  };
}

export function normalizeQueueSnapshot(value: unknown): QueueSnapshot {
  const raw = asRecord(value);
  const jobsValue = asRecord(raw.queue).jobs ?? raw.jobs ?? raw.items;
  const jobs = asArray(jobsValue)
    .map((item) => normalizeQueueItem(item))
    .sort((left, right) => (left.queuePosition ?? Number.MAX_SAFE_INTEGER) - (right.queuePosition ?? Number.MAX_SAFE_INTEGER));
  return {
    paused: asBoolean(asRecord(raw.queue).paused ?? raw.paused),
    jobs,
    order: jobs.map((job) => job.nativeJobId ?? job.id),
    revision: asNumber(asRecord(raw.queue).revision ?? raw.revision),
    activeCount: asNumber(asRecord(raw.queue).activeCount ?? raw.activeCount),
    queuedCount: asNumber(asRecord(raw.queue).queuedCount ?? raw.queuedCount),
  };
}
