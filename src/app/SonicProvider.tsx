import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import { EMPTY_METADATA } from "../domain/defaults";
import { templateForItem } from "../domain/filename";
import { queueRemovalMode } from "../domain/queue";
import type {
  AppRoute,
  LibraryFilters,
  LibraryItem,
  LibrarySort,
  MetadataDraft,
  QueueItem,
  SonicSettings,
  SourceInput,
  UpdaterState,
} from "../domain/types";
import { getBridge } from "../services/bridge";
import type { SonicBridge } from "../services/bridge-types";
import {
  checkForSonicUpdate,
  installSonicUpdate,
  type SonicUpdate,
} from "../services/updater";
import {
  initialState,
  moveQueueItem,
  selectJobs,
  selectSelectedJob,
  selectSelectedLibraryItem,
  sonicReducer,
  type SonicState,
} from "./state";

function makeId(prefix: string) {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
}

function errorMessage(error: unknown) {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") return error.message;
  return "Something went wrong. Try again.";
}

function sourceKey(source: SourceInput) {
  return source.kind === "youtube" ? `youtube:${source.url.trim()}` : `file:${source.path.toLocaleLowerCase()}`;
}

export type SonicContextValue = {
  state: SonicState;
  jobs: QueueItem[];
  selectedJob: QueueItem | null;
  selectedLibraryItem: LibraryItem | null;
  bridgeMode: SonicBridge["mode"];
  updater: UpdaterState;
  setRoute(route: AppRoute): void;
  selectJob(itemId: string | null): void;
  selectLibraryItem(itemId: string | null): void;
  addUrls(value: string): Promise<void>;
  importFiles(): Promise<void>;
  addLocalPaths(paths: string[]): Promise<void>;
  updateItem(itemId: string, patch: Partial<QueueItem>): void;
  updateMetadata(itemId: string, patch: Partial<MetadataDraft>): void;
  refreshFilename(itemId: string): Promise<void>;
  enqueueItem(itemId: string): Promise<void>;
  enqueueAllReady(): Promise<void>;
  cancelItem(itemId: string): Promise<void>;
  retryItem(itemId: string): Promise<void>;
  removeItem(itemId: string): Promise<void>;
  clearCompleted(): Promise<void>;
  moveItem(itemId: string, direction: -1 | 1): Promise<void>;
  setQueuePaused(paused: boolean): Promise<void>;
  saveQueuedItem(itemId: string): Promise<void>;
  refreshLibrary(query?: string, filters?: LibraryFilters, sort?: LibrarySort): Promise<void>;
  reexportLibraryItem(itemId: string): Promise<void>;
  removeLibraryItem(itemId: string, deleteFile: boolean): Promise<void>;
  revealPath(path: string): Promise<void>;
  openSource(source: SourceInput): Promise<void>;
  chooseOutputDirectory(itemId?: string): Promise<void>;
  saveSettings(settings: SonicSettings): Promise<void>;
  refreshDiagnostics(): Promise<void>;
  exportDiagnostics(): Promise<void>;
  prepareEngine(): Promise<void>;
  checkForUpdates(): Promise<void>;
  installUpdate(): Promise<void>;
  loadPreview(item: QueueItem | LibraryItem): Promise<void>;
  releasePreview(): Promise<void>;
  setPlaying(playing: boolean): void;
  setPlayerTime(time: number): void;
  setPlayerLoop(loop: boolean): void;
  setDropActive(active: boolean): void;
  dismissError(): void;
  setShortcutsOpen(open: boolean): void;
};

const SonicContext = createContext<SonicContextValue | null>(null);

export function SonicProvider({ children }: { children: ReactNode }) {
  const bridge = useMemo(() => getBridge(), []);
  const [state, dispatch] = useReducer(sonicReducer, initialState);
  const [updater, setUpdater] = useState<UpdaterState>({
    phase: bridge.mode === "native" ? "idle" : "unavailable",
    downloadedBytes: 0,
  });
  const stateRef = useRef(state);
  const pendingUpdateRef = useRef<SonicUpdate | null>(null);
  const updateCheckRef = useRef<Promise<void> | null>(null);
  stateRef.current = state;

  const setError = useCallback((error: unknown) => {
    dispatch({ type: "setError", error: errorMessage(error) });
  }, []);

  const inspectNewItem = useCallback(async (item: QueueItem) => {
    try {
      const inspection = await bridge.inspectSource(item.source);
      const metadata: MetadataDraft = {
        title: inspection.title,
        artist: inspection.creator,
        bpm: inspection.suggestedMetadata.bpm?.toString() ?? "",
        key: inspection.suggestedMetadata.key ?? "",
        detuneCents: inspection.suggestedMetadata.detuneCents?.toString() ?? "",
        alternateBpms: inspection.suggestedMetadata.alternateBpms,
        camelot: inspection.suggestedMetadata.camelot,
        tuningHz: inspection.suggestedMetadata.tuningHz,
      };
      const current = stateRef.current.jobsById[item.id] ?? item;
      const next: QueueItem = {
        ...current,
        inspection,
        metadata,
        status: "review",
        error: undefined,
        progress: {},
        updatedAt: new Date().toISOString(),
      };
      const template = templateForItem(next, stateRef.current.settings.templates);
      next.filenamePreview = await bridge.previewFilename({
        source: inspection,
        metadata,
        template,
        presetId: next.presetId,
      });
      dispatch({ type: "upsertItem", item: next });
      dispatch({ type: "announce", message: `${inspection.title} is ready for review.` });
    } catch (error) {
      dispatch({
        type: "updateItem",
        itemId: item.id,
        patch: { status: "failed", error: errorMessage(error), progress: { message: "Inspection failed" } },
      });
    }
  }, [bridge]);

  const addSources = useCallback(async (sources: SourceInput[]) => {
    const existing = new Set(selectJobs(stateRef.current).map((item) => sourceKey(item.source)));
    const unique = sources.filter((source, index) => {
      const key = sourceKey(source);
      return key.replace(/^(?:youtube:|file:)$/, "") && !existing.has(key)
        && sources.findIndex((candidate) => sourceKey(candidate) === key) === index;
    });
    if (!unique.length) {
      dispatch({ type: "announce", message: "Already added." });
      return;
    }
    const settings = stateRef.current.settings;
    const now = new Date().toISOString();
    const items = unique.map<QueueItem>((source) => ({
      id: makeId("item"),
      source,
      metadata: { ...EMPTY_METADATA },
      presetId: settings.defaultPresetId,
      channelMode: "preserve",
      writeEmbeddedTags: settings.writeEmbeddedTags,
      templateId: settings.defaultTemplateId,
      customTemplate: settings.filenameTemplate,
      outputDirectory: settings.defaultOutputDirectory,
      filenamePreview: "Inspecting source…",
      status: "inspecting",
      progress: { message: "Reading source metadata" },
      createdAt: now,
      updatedAt: now,
    }));
    items.forEach((item) => dispatch({ type: "addItem", item }));
    dispatch({ type: "announce", message: `Inspecting ${items.length} ${items.length === 1 ? "source" : "sources"}.` });
    const pending = [...items];
    const worker = async () => {
      let next = pending.shift();
      while (next) {
        await inspectNewItem(next);
        next = pending.shift();
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, items.length) }, worker));
  }, [inspectNewItem]);

  const addUrls = useCallback(async (value: string) => {
    const entries = value.split(/[\r\n]+/).map((item) => item.trim()).filter(Boolean);
    const invalid = entries.find((entry) => {
      try {
        const parsed = new URL(entry);
        return parsed.protocol !== "https:";
      } catch {
        return true;
      }
    });
    if (!entries.length) {
      setError("Paste at least one YouTube link.");
      return;
    }
    if (invalid) {
      setError(`“${invalid}” is not a valid HTTPS media link.`);
      return;
    }
    dispatch({ type: "setError", error: null });
    await addSources(entries.map((url) => ({ kind: "youtube", url })));
  }, [addSources, setError]);

  const addLocalPaths = useCallback(async (paths: string[]) => {
    const supported = paths.filter((path) => /\.(?:wav|mp3|m4a|flac|opus|ogg|webm)$/i.test(path));
    if (!supported.length) {
      setError("Drop WAV, MP3, M4A, FLAC, Opus, OGG, or WebM audio files.");
      return;
    }
    await addSources(supported.map((path) => ({ kind: "localFile", path })));
  }, [addSources, setError]);

  const importFiles = useCallback(async () => {
    try {
      await addLocalPaths(await bridge.chooseLocalFiles());
    } catch (error) {
      setError(error);
    }
  }, [addLocalPaths, bridge, setError]);

  useEffect(() => {
    let disposed = false;
    let unsubscribe: () => void = () => undefined;
    let unlistenDrop: () => void = () => undefined;
    void (async () => {
      try {
        unsubscribe = await bridge.subscribe(
            (job) => dispatch({ type: "upsertItem", item: job }),
            (queue) => dispatch({ type: "syncQueue", queue }),
          );
        if (disposed) {
          unsubscribe();
          return;
        }
        unlistenDrop = await bridge.registerFileDrop((event) => {
            if (event.type === "drop") {
              dispatch({ type: "setDropActive", active: false });
              void addLocalPaths(event.paths);
            } else {
              dispatch({ type: "setDropActive", active: event.type !== "leave" });
            }
          });
        if (disposed) {
          unsubscribe();
          unlistenDrop();
          return;
        }
        const bootstrap = await bridge.bootstrap();
        if (disposed) {
          unsubscribe();
          unlistenDrop();
          return;
        }
        dispatch({ type: "hydrate", payload: bootstrap });
      } catch (error) {
        unsubscribe();
        unlistenDrop();
        if (!disposed) {
          dispatch({ type: "setError", error: errorMessage(error) });
          dispatch({
            type: "hydrate",
            payload: {
              settings: initialState.settings,
              jobs: [],
              library: [],
              presets: initialState.presets,
              diagnostics: initialState.diagnostics,
              queuePaused: false,
              queueRevision: 0,
              settingsRevision: 0,
            },
          });
        }
      }
    })();
    return () => {
      disposed = true;
      unsubscribe();
      unlistenDrop();
    };
  }, [addLocalPaths, bridge]);

  useEffect(() => () => {
    const asset = stateRef.current.player.asset;
    if (asset) void bridge.releasePreview(asset.id);
  }, [bridge]);

  const checkForUpdates = useCallback(async () => {
    if (bridge.mode !== "native") {
      setUpdater({ phase: "unavailable", downloadedBytes: 0 });
      return;
    }
    if (updateCheckRef.current) {
      await updateCheckRef.current;
      return;
    }

    const task = (async () => {
      setUpdater((current) => ({
        ...current,
        phase: "checking",
        downloadedBytes: 0,
        totalBytes: undefined,
        error: undefined,
      }));
      try {
        const update = await checkForSonicUpdate();
        const previous = pendingUpdateRef.current;
        pendingUpdateRef.current = update;
        if (previous && previous !== update) void previous.close();
        const checkedAt = new Date().toISOString();
        if (update) {
          setUpdater({
            phase: "available",
            availableVersion: update.version,
            releaseDate: update.date,
            releaseNotes: update.body,
            downloadedBytes: 0,
            lastCheckedAt: checkedAt,
          });
        } else {
          setUpdater({ phase: "upToDate", downloadedBytes: 0, lastCheckedAt: checkedAt });
        }
      } catch (error) {
        setUpdater((current) => ({
          ...current,
          phase: "error",
          downloadedBytes: 0,
          totalBytes: undefined,
          lastCheckedAt: new Date().toISOString(),
          error: errorMessage(error),
        }));
      }
    })();
    updateCheckRef.current = task;
    try {
      await task;
    } finally {
      if (updateCheckRef.current === task) updateCheckRef.current = null;
    }
  }, [bridge.mode]);

  const installUpdate = useCallback(async () => {
    const update = pendingUpdateRef.current;
    if (!update) {
      await checkForUpdates();
      return;
    }

    let downloadedBytes = 0;
    let totalBytes: number | undefined;
    setUpdater((current) => ({ ...current, phase: "downloading", downloadedBytes: 0, error: undefined }));
    try {
      await installSonicUpdate(update, (event) => {
        if (event.event === "Started") {
          totalBytes = event.data.contentLength;
          setUpdater((current) => ({ ...current, phase: "downloading", downloadedBytes: 0, totalBytes }));
        } else if (event.event === "Progress") {
          downloadedBytes += event.data.chunkLength;
          setUpdater((current) => ({ ...current, phase: "downloading", downloadedBytes, totalBytes }));
        } else {
          setUpdater((current) => ({ ...current, phase: "installing", downloadedBytes, totalBytes }));
        }
      });
    } catch (error) {
      setUpdater((current) => ({
        ...current,
        phase: "error",
        downloadedBytes,
        totalBytes,
        error: errorMessage(error),
      }));
    }
  }, [checkForUpdates]);

  useEffect(() => {
    if (bridge.mode !== "native" || state.loading) return;
    const timeout = window.setTimeout(() => void checkForUpdates(), 2_500);
    return () => window.clearTimeout(timeout);
  }, [bridge.mode, checkForUpdates, state.loading]);

  useEffect(() => () => {
    const pending = pendingUpdateRef.current;
    pendingUpdateRef.current = null;
    if (pending) void pending.close();
  }, []);

  const updateItem = useCallback((itemId: string, patch: Partial<QueueItem>) => {
    dispatch({ type: "updateItem", itemId, patch });
  }, []);

  const updateMetadata = useCallback((itemId: string, patch: Partial<MetadataDraft>) => {
    const existing = stateRef.current.jobsById[itemId];
    if (!existing) return;
    dispatch({ type: "updateItem", itemId, patch: { metadata: { ...existing.metadata, ...patch } } });
  }, []);

  const refreshFilename = useCallback(async (itemId: string) => {
    const item = stateRef.current.jobsById[itemId];
    if (!item?.inspection) return;
    try {
      const template = templateForItem(item, stateRef.current.settings.templates);
      const filenamePreview = await bridge.previewFilename({
        source: item.inspection,
        metadata: item.metadata,
        template,
        presetId: item.presetId,
      });
      dispatch({ type: "updateItem", itemId, patch: { filenamePreview } });
    } catch (error) {
      setError(error);
    }
  }, [bridge, setError]);

  const enqueueItem = useCallback(async (itemId: string) => {
    const item = stateRef.current.jobsById[itemId];
    if (!item?.inspection) return;
    if (!stateRef.current.diagnostics.engine.ready) {
      setError("Set up the media tools before exporting.");
      return;
    }
    if (!item.outputDirectory) {
      setError("Choose where to save this file.");
      return;
    }
    if (item.inspection.isLive) {
      setError("Wait until this stream ends before exporting it.");
      return;
    }
    try {
      const template = templateForItem(item, stateRef.current.settings.templates);
      const jobs = await bridge.enqueueExports([{
        itemId: item.id,
        source: item.source,
        inspection: item.inspection,
        metadata: item.metadata,
        presetId: item.presetId,
        channelMode: item.presetId === "original" ? "preserve" : item.channelMode,
        normalizeLufs: item.presetId === "original" ? undefined : item.normalizeLufs,
        writeEmbeddedTags: item.presetId === "original" ? false : item.writeEmbeddedTags,
        outputDirectory: item.outputDirectory,
        filenameTemplate: template,
      }]);
      jobs.forEach((job) => dispatch({ type: "upsertItem", item: { ...job, id: item.id } }));
      dispatch({ type: "announce", message: `${item.inspection.title} was added to the export queue.` });
    } catch (error) {
      setError(error);
    }
  }, [bridge, setError]);

  const enqueueAllReady = useCallback(async () => {
    const ready = selectJobs(stateRef.current).filter((item) => item.status === "review");
    for (const item of ready) await enqueueItem(item.id);
  }, [enqueueItem]);

  const cancelItem = useCallback(async (itemId: string) => {
    const item = stateRef.current.jobsById[itemId];
    if (!item?.nativeJobId) return;
    try {
      if (await bridge.cancelJob(item.nativeJobId)) {
        dispatch({ type: "updateItem", itemId, patch: { status: "cancelled", progress: { message: "Cancelled" } } });
      }
    } catch (error) {
      setError(error);
    }
  }, [bridge, setError]);

  const retryItem = useCallback(async (itemId: string) => {
    const item = stateRef.current.jobsById[itemId];
    if (!item) return;
    if (!item.nativeJobId) {
      const retry = { ...item, status: "inspecting" as const, error: undefined, errorCode: undefined, progress: { message: "Reading source metadata" } };
      dispatch({ type: "upsertItem", item: retry });
      await inspectNewItem(retry);
      return;
    }
    try {
      dispatch({ type: "upsertItem", item: await bridge.retryJob(item.nativeJobId) });
    } catch (error) {
      setError(error);
    }
  }, [bridge, inspectNewItem, setError]);

  const removeItem = useCallback(async (itemId: string) => {
    const item = stateRef.current.jobsById[itemId];
    if (!item) return;
    try {
      let library = stateRef.current.library;
      if (item.status === "completed" && item.nativeJobId) {
        library = await bridge.listLibrary();
      }
      const mode = queueRemovalMode(item, library);
      if (mode === "retain-library") {
        dispatch({
          type: "announce",
          message: "Remove this track from the Library before clearing it here.",
        });
        return;
      }
      if (mode === "cancel") {
        if (item.nativeJobId && await bridge.cancelJob(item.nativeJobId)) {
          dispatch({ type: "updateItem", itemId, patch: { status: "cancelled", progress: { message: "Cancelled" } } });
        }
        return;
      }
      if (mode === "remove" && item.nativeJobId && !await bridge.removeJob(item.nativeJobId)) return;
      dispatch({ type: "removeItem", itemId });
    } catch (error) {
      setError(error);
    }
  }, [bridge, setError]);

  const clearCompleted = useCallback(async () => {
    const finished = selectJobs(stateRef.current).filter((item) => ["completed", "cancelled"].includes(item.status));
    if (!finished.length) return;
    let removed = 0;
    let retained = 0;
    const failures: string[] = [];
    let library = stateRef.current.library;
    try {
      if (finished.some((item) => item.status === "completed")) library = await bridge.listLibrary();
    } catch (error) {
      failures.push(errorMessage(error));
    }
    for (const item of finished) {
      const mode = queueRemovalMode(item, library);
      if (mode === "retain-library") {
        retained += 1;
        continue;
      }
      try {
        if (mode === "remove" && item.nativeJobId && !await bridge.removeJob(item.nativeJobId)) continue;
        dispatch({ type: "removeItem", itemId: item.id });
        removed += 1;
      } catch (error) {
        failures.push(errorMessage(error));
      }
    }
    if (failures.length) {
      setError(`Some finished items could not be cleared. ${failures[0]}`);
      return;
    }
    const retainedMessage = retained
      ? ` ${retained} finished ${retained === 1 ? "track is" : "tracks are"} still linked to the Library.`
      : "";
    dispatch({
      type: "announce",
      message: `${removed ? `Cleared ${removed} finished ${removed === 1 ? "item" : "items"}.` : "No finished items were removed."}${retainedMessage}`,
    });
  }, [bridge, setError]);

  const moveItem = useCallback(async (itemId: string, direction: -1 | 1) => {
    const nextOrder = moveQueueItem(stateRef.current.jobOrder, itemId, direction);
    dispatch({ type: "moveItem", itemId, direction });
    const nativeIds = nextOrder
      .map((id) => stateRef.current.jobsById[id])
      .filter((item) => item?.status === "queued")
      .map((item) => item.nativeJobId)
      .filter((id): id is string => Boolean(id));
    if (!nativeIds.length) return;
    try {
      dispatch({ type: "syncQueue", queue: await bridge.reorderQueue(nativeIds) });
    } catch (error) {
      setError(error);
    }
  }, [bridge, setError]);

  const setQueuePaused = useCallback(async (paused: boolean) => {
    const previous = stateRef.current.queuePaused;
    dispatch({ type: "setQueuePaused", paused });
    try {
      dispatch({ type: "syncQueue", queue: await bridge.setQueuePaused(paused) });
    } catch (error) {
      dispatch({ type: "setQueuePaused", paused: previous });
      setError(error);
    }
  }, [bridge, setError]);

  const saveQueuedItem = useCallback(async (itemId: string) => {
    const item = stateRef.current.jobsById[itemId];
    if (!item?.nativeJobId || item.status !== "queued") return;
    try {
      dispatch({ type: "upsertItem", item: await bridge.updateQueuedJob(item.nativeJobId, item) });
      dispatch({ type: "announce", message: "Queue changes saved." });
    } catch (error) {
      setError(error);
    }
  }, [bridge, setError]);

  const refreshLibrary = useCallback(async (query = "", filters?: LibraryFilters, sort?: LibrarySort) => {
    try {
      dispatch({ type: "setLibrary", items: await bridge.listLibrary(query, filters, sort) });
    } catch (error) {
      setError(error);
    }
  }, [bridge, setError]);

  const reexportLibraryItem = useCallback(async (itemId: string) => {
    try {
      const job = await bridge.reexportLibraryItem(itemId);
      dispatch({ type: "upsertItem", item: job });
      dispatch({ type: "selectItem", itemId: job.id });
      dispatch({ type: "setRoute", route: "session" });
    } catch (error) {
      setError(error);
    }
  }, [bridge, setError]);

  const removeLibraryItem = useCallback(async (itemId: string, deleteFile: boolean) => {
    try {
      if (await bridge.removeLibraryItem(itemId, deleteFile)) dispatch({ type: "removeLibraryItem", itemId });
    } catch (error) {
      setError(error);
    }
  }, [bridge, setError]);

  const revealPath = useCallback(async (path: string) => {
    try { await bridge.revealPath(path); } catch (error) { setError(error); }
  }, [bridge, setError]);

  const openSource = useCallback(async (source: SourceInput) => {
    try { await bridge.openSource(source); } catch (error) { setError(error); }
  }, [bridge, setError]);

  const chooseOutputDirectory = useCallback(async (itemId?: string) => {
    const current = itemId ? stateRef.current.jobsById[itemId]?.outputDirectory : stateRef.current.settings.defaultOutputDirectory;
    try {
      const selected = await bridge.chooseDirectory(current);
      if (!selected) return;
      if (itemId) dispatch({ type: "updateItem", itemId, patch: { outputDirectory: selected } });
      else dispatch({ type: "setSettings", settings: { ...stateRef.current.settings, defaultOutputDirectory: selected } });
    } catch (error) {
      setError(error);
    }
  }, [bridge, setError]);

  const saveSettings = useCallback(async (settings: SonicSettings) => {
    try {
      const queuePaused = stateRef.current.queuePaused;
      const saved = await bridge.updateSettings({ ...settings, queuePaused });
      dispatch({ type: "setSettings", settings: { ...saved, queuePaused } });
      dispatch({ type: "announce", message: "Settings saved." });
      dispatch({ type: "setDiagnostics", diagnostics: await bridge.getDiagnostics() });
    } catch (error) {
      setError(error);
    }
  }, [bridge, setError]);

  const refreshDiagnostics = useCallback(async () => {
    try { dispatch({ type: "setDiagnostics", diagnostics: await bridge.refreshDependencies() }); } catch (error) { setError(error); }
  }, [bridge, setError]);

  const exportDiagnostics = useCallback(async () => {
    try {
      const path = await bridge.exportDiagnostics();
      dispatch({ type: "announce", message: `Diagnostics ready: ${path}` });
      if (/^[A-Za-z]:\\/.test(path)) await bridge.revealPath(path);
    } catch (error) {
      setError(error);
    }
  }, [bridge, setError]);

  const prepareEngine = useCallback(async () => {
    try {
      await bridge.prepareEngine();
      dispatch({ type: "setDiagnostics", diagnostics: await bridge.refreshDependencies() });
    } catch (error) {
      setError(error);
    }
  }, [bridge, setError]);

  const loadPreview = useCallback(async (item: QueueItem | LibraryItem) => {
    const previousAsset = stateRef.current.player.asset;
    if (previousAsset) await bridge.releasePreview(previousAsset.id);
    dispatch({ type: "playerLoading", targetId: item.id });
    try {
      const asset = await bridge.preparePreview(item);
      if (asset) dispatch({ type: "playerReady", targetId: item.id, asset });
      else dispatch({ type: "playerUnavailable", targetId: item.id, error: "Export this track before previewing it." });
    } catch (error) {
      dispatch({ type: "playerUnavailable", targetId: item.id, error: errorMessage(error) });
    }
  }, [bridge]);

  const releasePreview = useCallback(async () => {
    const asset = stateRef.current.player.asset;
    dispatch({ type: "playerRelease" });
    if (asset) await bridge.releasePreview(asset.id);
  }, [bridge]);

  const value = useMemo<SonicContextValue>(() => ({
    state,
    jobs: selectJobs(state),
    selectedJob: selectSelectedJob(state),
    selectedLibraryItem: selectSelectedLibraryItem(state),
    bridgeMode: bridge.mode,
    updater,
    setRoute: (route) => dispatch({ type: "setRoute", route }),
    selectJob: (itemId) => dispatch({ type: "selectItem", itemId }),
    selectLibraryItem: (itemId) => dispatch({ type: "selectLibraryItem", itemId }),
    addUrls,
    importFiles,
    addLocalPaths,
    updateItem,
    updateMetadata,
    refreshFilename,
    enqueueItem,
    enqueueAllReady,
    cancelItem,
    retryItem,
    removeItem,
    clearCompleted,
    moveItem,
    setQueuePaused,
    saveQueuedItem,
    refreshLibrary,
    reexportLibraryItem,
    removeLibraryItem,
    revealPath,
    openSource,
    chooseOutputDirectory,
    saveSettings,
    refreshDiagnostics,
    exportDiagnostics,
    prepareEngine,
    checkForUpdates,
    installUpdate,
    loadPreview,
    releasePreview,
    setPlaying: (playing) => dispatch({ type: "playerPlaying", playing }),
    setPlayerTime: (time) => dispatch({ type: "playerTime", time }),
    setPlayerLoop: (loop) => dispatch({ type: "playerLoop", loop }),
    setDropActive: (active) => dispatch({ type: "setDropActive", active }),
    dismissError: () => dispatch({ type: "setError", error: null }),
    setShortcutsOpen: (open) => dispatch({ type: "setShortcutsOpen", open }),
  }), [
    addLocalPaths, addUrls, bridge, cancelItem, checkForUpdates, chooseOutputDirectory, clearCompleted, enqueueAllReady,
    enqueueItem, exportDiagnostics, importFiles, installUpdate, loadPreview, moveItem, openSource, prepareEngine,
    refreshDiagnostics, refreshFilename, refreshLibrary, releasePreview, removeItem, removeLibraryItem,
    reexportLibraryItem, retryItem, revealPath, saveQueuedItem, saveSettings, setQueuePaused, state,
    updateItem, updateMetadata, updater,
  ]);

  return <SonicContext.Provider value={value}>{children}</SonicContext.Provider>;
}

export function useSonic() {
  const value = useContext(SonicContext);
  if (!value) throw new Error("useSonic must be used inside SonicProvider");
  return value;
}
