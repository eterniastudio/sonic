import type {
  BootstrapPayload,
  BridgeMode,
  Collection,
  Diagnostics,
  DuplicateGroup,
  ExportPreset,
  ExportRequest,
  FilenamePreviewRequest,
  JobUpdate,
  LibraryFilters,
  LibraryItem,
  LibraryPage,
  LibraryRoot,
  LibrarySort,
  PreviewAsset,
  QueueItem,
  QueueSnapshot,
  SidecarImportReport,
  SonicSettings,
  SourceInput,
  SourceInspection,
  Tag,
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
  listLibrary(query?: string, filters?: LibraryFilters, sort?: LibrarySort): Promise<LibraryPage>;
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
  
  // Library roots (v0.3)
  listLibraryRoots(): Promise<LibraryRoot[]>;
  createLibraryRoot(name: string, path: string): Promise<LibraryRoot>;
  updateLibraryRoot(id: number, patch: { name?: string; path?: string; enabled?: boolean }): Promise<LibraryRoot>;
  deleteLibraryRoot(id: number): Promise<void>;
  relinkLibraryRoot(oldRootId: number, newRootId: number): Promise<number>;
  
  // Tags (v0.3)
  listTags(): Promise<Tag[]>;
  createTag(name: string, color?: string): Promise<Tag>;
  updateTag(id: number, patch: { name?: string; color?: string }): Promise<Tag>;
  deleteTag(id: number): Promise<void>;
  assignTagToItem(itemId: string, tagId: number): Promise<void>;
  removeTagFromItem(itemId: string, tagId: number): Promise<void>;
  
  // Collections (v0.3)
  listCollections(): Promise<Collection[]>;
  createCollection(name: string, description?: string): Promise<Collection>;
  updateCollection(id: number, patch: { name?: string; description?: string }): Promise<Collection>;
  deleteCollection(id: number): Promise<void>;
  addItemsToCollection(collectionId: number, itemIds: string[]): Promise<void>;
  removeItemsFromCollection(collectionId: number, itemIds: string[]): Promise<void>;
  
  // Bulk actions (v0.3)
  bulkTagItems(itemIds: string[], tagId: number): Promise<void>;
  bulkUpdateItems(itemIds: string[], patch: Partial<LibraryItem>): Promise<void>;
  bulkDeleteItems(itemIds: string[], deleteFiles: boolean): Promise<void>;
  
  // Duplicate detection (v0.3)
  findDuplicatesBySha256(): Promise<DuplicateGroup[]>;
  findDuplicatesBySource(): Promise<DuplicateGroup[]>;
  
  // Sidecar import (v0.3)
  scanSidecarFolder(folderPath: string, recursive: boolean): Promise<SidecarImportReport>;
}
