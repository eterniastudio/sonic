import type {
  BootstrapPayload,
  BridgeMode,
  Diagnostics,
  ExportPreset,
  ExportRequest,
  FilenamePreviewRequest,
  JobUpdate,
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

export type Unsubscribe = () => void;

export interface SonicBridge {
  readonly mode: BridgeMode;
  bootstrap(): Promise<BootstrapPayload>;
  inspectSource(source: SourceInput): Promise<SourceInspection>;
  listExportPresets(): Promise<ExportPreset[]>;
  previewFilename(request: FilenamePreviewRequest): Promise<string>;
  enqueueExports(requests: ExportRequest[]): Promise<QueueItem[]>;
  listJobs(): Promise<QueueItem[]>;
  getJob(jobId: string): Promise<QueueItem>;
  updateQueuedJob(jobId: string, patch: Partial<QueueItem>): Promise<QueueItem>;
  cancelJob(jobId: string): Promise<boolean>;
  retryJob(jobId: string): Promise<QueueItem>;
  removeJob(jobId: string): Promise<boolean>;
  reorderQueue(jobIds: string[]): Promise<QueueSnapshot>;
  setQueuePaused(paused: boolean): Promise<QueueSnapshot>;
  listLibrary(query?: string, filters?: LibraryFilters, sort?: LibrarySort): Promise<LibraryItem[]>;
  getLibraryItem(itemId: string): Promise<LibraryItem>;
  reexportLibraryItem(itemId: string): Promise<QueueItem>;
  removeLibraryItem(itemId: string, deleteFile: boolean): Promise<boolean>;
  getSettings(): Promise<SonicSettings>;
  updateSettings(settings: SonicSettings): Promise<SonicSettings>;
  getDiagnostics(): Promise<Diagnostics>;
  exportDiagnostics(): Promise<string>;
  chooseLocalFiles(): Promise<string[]>;
  chooseDirectory(current?: string): Promise<string | null>;
  registerFileDrop(handler: (event: { type: "enter" | "over" | "drop" | "leave"; paths: string[] }) => void): Promise<Unsubscribe>;
  subscribe(onJob: (job: JobUpdate) => void, onQueue: (queue: QueueSnapshot) => void): Promise<Unsubscribe>;
  preparePreview(item: QueueItem | LibraryItem): Promise<PreviewAsset | null>;
  releasePreview(previewId: string): Promise<void>;
  revealPath(path: string): Promise<void>;
  openSource(source: SourceInput): Promise<void>;
  prepareEngine(): Promise<void>;
  refreshDependencies(): Promise<Diagnostics>;
}
