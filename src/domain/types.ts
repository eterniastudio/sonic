export type AppRoute = "session" | "library" | "settings";

export type SourceInput =
  | { kind: "youtube"; url: string }
  | { kind: "localFile"; path: string };

export type SourceKind = SourceInput["kind"];

export type AudioProperties = {
  container?: string;
  codec?: string;
  sampleRateHz?: number;
  channels?: number;
  bitDepth?: number;
  durationMs?: number;
  fileSizeBytes?: number;
};

export type MetadataMatch = {
  kind: string;
  displayValue: string;
  rawText: string;
  source: string;
  confidence: number;
};

export type MusicMetadata = {
  bpm?: number;
  alternateBpms: number[];
  key?: string;
  camelot?: string;
  detuneCents?: number;
  tuningHz?: number;
  /** Confidence in text/tag pattern matches. This is not audio-analysis confidence. */
  confidence: number;
  matches: MetadataMatch[];
  warnings: string[];
};

export type SourceInspection = {
  id: string;
  source: SourceInput;
  sourceFingerprint: string;
  kind: SourceKind;
  title: string;
  creator?: string;
  description?: string;
  durationSeconds?: number;
  thumbnailUrl?: string;
  sourceUrl?: string;
  sourcePath?: string;
  sourceLabel: string;
  isLive: boolean;
  fileSizeBytes?: number;
  codec?: string;
  audio: AudioProperties;
  declaredMetadata: MusicMetadata;
  embeddedMetadata: MusicMetadata;
  /** Derived only from declared text and embedded tags; never from the audio signal. */
  suggestedMetadata: MusicMetadata;
  warnings: string[];
  /** Convenience alias for suggestedMetadata used by presentation selectors. */
  metadata: MusicMetadata;
};

export type MetadataDraft = {
  title?: string;
  artist?: string;
  bpm: string;
  key: string;
  detuneCents: string;
  alternateBpms?: number[];
  camelot?: string;
  tuningHz?: number;
};

export type ExportPresetId =
  | "original"
  | "mp3V0"
  | "mp3Cbr320"
  | "m4aAac256"
  | "wav44100S24"
  | "wav48000S24"
  | "flac"
  | "opus192";

export type ExportPreset = {
  id: ExportPresetId;
  name: string;
  shortName: string;
  description: string;
  format: "original" | "wav" | "mp3" | "m4a" | "flac" | "opus";
  extension: string;
  badge: string;
  isBuiltIn: boolean;
  lossy: boolean;
  supportsEmbeddedTags: boolean;
  sampleRateHz?: number;
  bitDepth?: number;
  bitrateKbps?: number;
};

export type FilenameTemplate = {
  id: string;
  name: string;
  template: string;
  isBuiltIn: boolean;
};

export type QueueStatus =
  | "draft"
  | "inspecting"
  | "review"
  | "queued"
  | "preparing"
  | "acquiring"
  | "copying"
  | "transcoding"
  | "tagging"
  | "validating"
  | "publishing"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export type QueueProgress = {
  percent?: number;
  downloadedBytes?: number;
  totalBytes?: number;
  speedBytesPerSecond?: number;
  etaSeconds?: number;
  message?: string;
};

export type QueueItem = {
  id: string;
  nativeJobId?: string;
  source: SourceInput;
  inspection?: SourceInspection;
  metadata: MetadataDraft;
  presetId: ExportPresetId;
  channelMode: "preserve" | "stereo" | "mono";
  normalizeLufs?: number;
  writeEmbeddedTags: boolean;
  templateId: string;
  customTemplate?: string;
  outputDirectory: string;
  filenamePreview: string;
  status: QueueStatus;
  progress: QueueProgress;
  outputPath?: string;
  error?: string;
  errorCode?: string;
  queuePosition?: number;
  revision?: number;
  attempt?: number;
  createdAt: string;
  updatedAt: string;
};

export type LibraryItem = {
  id: string;
  jobId?: string;
  clientItemId?: string;
  title: string;
  creator?: string;
  source: SourceInput;
  sourceLabel: string;
  thumbnailUrl?: string;
  outputPath: string;
  format: string;
  fileSizeBytes?: number;
  durationSeconds?: number;
  bpm?: number;
  key?: string;
  camelot?: string;
  detuneCents?: number;
  exportedAt: string;
  exists: boolean;
  presetId?: ExportPresetId;
  sidecarPath?: string;
  sha256?: string;
};

export type DependencyInfo = {
  name: string;
  available: boolean;
  version?: string;
  error?: string;
};

export type DependencyStatus = {
  ready: boolean;
  dependencies: DependencyInfo[];
};

export type SonicSettings = {
  defaultOutputDirectory: string;
  filenameTemplate: string;
  defaultPresetId: ExportPresetId;
  defaultTemplateId: string;
  maxConcurrentJobs: number;
  historyEnabled: boolean;
  writeEmbeddedTags: boolean;
  includeSourcePathInSidecar: boolean;
  maxDurationMinutes: number;
  maxInputBytes: number;
  queuePaused: boolean;
  previewSeconds: number;
  confirmBeforeRemoving: boolean;
  templates: FilenameTemplate[];
};

export type Diagnostics = {
  appVersion: string;
  dbSchemaVersion?: number;
  operatingSystem: string;
  architecture?: string;
  webviewVersion?: string;
  engine: DependencyStatus;
  outputDirectory: string;
  outputWritable?: boolean;
  availableDiskBytes?: number;
  updateStatus?: string;
  logDirectory?: string;
  databaseHealthy?: boolean;
  databaseFile?: string;
  dataDirectoryWritable?: boolean;
  mediaEngineDirectory?: string;
  libraryCount?: number;
  generatedAtMs?: number;
  recoveryWarnings?: string[];
};

export type BootstrapPayload = {
  settings: SonicSettings;
  jobs: QueueItem[];
  library: LibraryItem[];
  presets: ExportPreset[];
  diagnostics: Diagnostics;
  queuePaused: boolean;
  queueRevision: number;
  settingsRevision: number;
};

export type JobUpdate = QueueItem;

export type QueueSnapshot = {
  paused: boolean;
  jobs: QueueItem[];
  order?: string[];
  revision?: number;
  activeCount?: number;
  queuedCount?: number;
};

export type FilenamePreviewRequest = {
  source: SourceInspection;
  metadata: MetadataDraft;
  template: string;
  presetId: ExportPresetId;
};

export type ExportRequest = {
  itemId: string;
  source: SourceInput;
  inspection: SourceInspection;
  metadata: MetadataDraft;
  presetId: ExportPresetId;
  channelMode: "preserve" | "stereo" | "mono";
  normalizeLufs?: number;
  writeEmbeddedTags: boolean;
  outputDirectory: string;
  filenameTemplate: string;
};

export type PreviewAsset = {
  id: string;
  mediaUrl?: string;
  durationSeconds: number;
  waveform: number[];
  title: string;
};

export type BridgeMode = "native" | "preview";

export type UpdaterPhase =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "installing"
  | "upToDate"
  | "unavailable"
  | "error";

export type UpdaterState = {
  phase: UpdaterPhase;
  availableVersion?: string;
  releaseDate?: string;
  releaseNotes?: string;
  downloadedBytes: number;
  totalBytes?: number;
  lastCheckedAt?: string;
  error?: string;
};

export type LibraryFilters = {
  format: string;
  key: string;
  bpmMin: string;
  bpmMax: string;
  missingOnly: boolean;
};

export type LibrarySort = "newest" | "oldest" | "title" | "bpm";
