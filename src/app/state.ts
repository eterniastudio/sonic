import { BUILTIN_PRESETS, DEFAULT_SETTINGS } from "../domain/defaults";
import type {
  AppRoute,
  BootstrapPayload,
  Diagnostics,
  ExportPreset,
  LibraryItem,
  PreviewAsset,
  QueueItem,
  QueueSnapshot,
  SonicSettings,
} from "../domain/types";

export type PlayerState = {
  targetId: string | null;
  asset: PreviewAsset | null;
  loading: boolean;
  playing: boolean;
  currentTime: number;
  loop: boolean;
  error?: string;
};

export type SonicState = {
  loading: boolean;
  route: AppRoute;
  jobsById: Record<string, QueueItem>;
  jobOrder: string[];
  selectedJobId: string | null;
  library: LibraryItem[];
  selectedLibraryId: string | null;
  presets: ExportPreset[];
  settings: SonicSettings;
  diagnostics: Diagnostics;
  queuePaused: boolean;
  queueRevision: number;
  settingsRevision: number;
  dropActive: boolean;
  globalError: string | null;
  announcement: string;
  shortcutsOpen: boolean;
  player: PlayerState;
};

const EMPTY_DIAGNOSTICS: Diagnostics = {
  appVersion: "Checking…",
  operatingSystem: "Windows",
  engine: { ready: false, dependencies: [] },
  outputDirectory: "",
};

export const initialState: SonicState = {
  loading: true,
  route: "session",
  jobsById: {},
  jobOrder: [],
  selectedJobId: null,
  library: [],
  selectedLibraryId: null,
  presets: BUILTIN_PRESETS,
  settings: DEFAULT_SETTINGS,
  diagnostics: EMPTY_DIAGNOSTICS,
  queuePaused: false,
  queueRevision: 0,
  settingsRevision: 0,
  dropActive: false,
  globalError: null,
  announcement: "",
  shortcutsOpen: false,
  player: {
    targetId: null,
    asset: null,
    loading: false,
    playing: false,
    currentTime: 0,
    loop: false,
  },
};

export function moveQueueItem(order: string[], itemId: string, direction: -1 | 1) {
  const index = order.indexOf(itemId);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= order.length) return order;
  const next = [...order];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

export function retryQueueItemTransition(item: QueueItem): QueueItem {
  return {
    ...item,
    status: "queued",
    error: undefined,
    errorCode: undefined,
    progress: { percent: 0, message: "Queued for retry" },
    updatedAt: new Date().toISOString(),
  };
}

export function setQueuePausedTransition(state: SonicState, paused: boolean): SonicState {
  return {
    ...state,
    queuePaused: paused,
    settings: { ...state.settings, queuePaused: paused },
    announcement: paused ? "Queue paused. The active export will finish." : "Queue resumed.",
  };
}

function itemMatchId(state: SonicState, incoming: QueueItem) {
  if (state.jobsById[incoming.id]) return incoming.id;
  return state.jobOrder.find((id) => {
    const existing = state.jobsById[id];
    return incoming.nativeJobId && existing?.nativeJobId === incoming.nativeJobId;
  }) ?? incoming.id;
}

function mergeItem(existing: QueueItem | undefined, incoming: QueueItem): QueueItem {
  const metadataIsMeaningful = Boolean(
    incoming.metadata.bpm.trim()
    || incoming.metadata.key.trim()
    || incoming.metadata.detuneCents.trim()
    || incoming.metadata.alternateBpms?.length
    || incoming.metadata.camelot
    || incoming.metadata.tuningHz,
  );
  return {
    ...existing,
    ...incoming,
    inspection: incoming.inspection ?? existing?.inspection,
    metadata: metadataIsMeaningful ? { ...existing?.metadata, ...incoming.metadata } : existing?.metadata ?? incoming.metadata,
    filenamePreview: incoming.filenamePreview || existing?.filenamePreview || "",
    customTemplate: incoming.customTemplate ?? existing?.customTemplate,
    outputDirectory: incoming.outputDirectory || existing?.outputDirectory || "",
    progress: { ...existing?.progress, ...incoming.progress },
  };
}

export type SonicAction =
  | { type: "hydrate"; payload: BootstrapPayload }
  | { type: "setRoute"; route: AppRoute }
  | { type: "addItem"; item: QueueItem }
  | { type: "updateItem"; itemId: string; patch: Partial<QueueItem> }
  | { type: "upsertItem"; item: QueueItem }
  | { type: "syncQueue"; queue: QueueSnapshot }
  | { type: "removeItem"; itemId: string }
  | { type: "moveItem"; itemId: string; direction: -1 | 1 }
  | { type: "selectItem"; itemId: string | null }
  | { type: "setQueuePaused"; paused: boolean }
  | { type: "setLibrary"; items: LibraryItem[] }
  | { type: "removeLibraryItem"; itemId: string }
  | { type: "selectLibraryItem"; itemId: string | null }
  | { type: "setSettings"; settings: SonicSettings }
  | { type: "setDiagnostics"; diagnostics: Diagnostics }
  | { type: "setDropActive"; active: boolean }
  | { type: "setError"; error: string | null }
  | { type: "announce"; message: string }
  | { type: "setShortcutsOpen"; open: boolean }
  | { type: "playerLoading"; targetId: string }
  | { type: "playerReady"; targetId: string; asset: PreviewAsset }
  | { type: "playerUnavailable"; targetId: string; error: string }
  | { type: "playerPlaying"; playing: boolean }
  | { type: "playerTime"; time: number }
  | { type: "playerLoop"; loop: boolean }
  | { type: "playerRelease" };

export function sonicReducer(state: SonicState, action: SonicAction): SonicState {
  switch (action.type) {
    case "hydrate": {
      const jobsById = Object.fromEntries(action.payload.jobs.map((item) => [item.id, item]));
      const selected = action.payload.jobs.find((item) => item.status === "review")?.id
        ?? action.payload.jobs[0]?.id
        ?? null;
      return {
        ...state,
        loading: false,
        jobsById,
        jobOrder: action.payload.jobs.map((item) => item.id),
        selectedJobId: selected,
        library: action.payload.library,
        selectedLibraryId: action.payload.library[0]?.id ?? null,
        presets: action.payload.presets,
        settings: { ...action.payload.settings, queuePaused: action.payload.queuePaused },
        diagnostics: action.payload.diagnostics,
        queuePaused: action.payload.queuePaused,
        queueRevision: action.payload.queueRevision,
        settingsRevision: action.payload.settingsRevision,
      };
    }
    case "setRoute":
      return { ...state, route: action.route, globalError: null };
    case "addItem":
      return {
        ...state,
        jobsById: { ...state.jobsById, [action.item.id]: action.item },
        jobOrder: [...state.jobOrder, action.item.id],
        selectedJobId: action.item.id,
        route: "session",
      };
    case "updateItem": {
      const existing = state.jobsById[action.itemId];
      if (!existing) return state;
      return {
        ...state,
        jobsById: {
          ...state.jobsById,
          [action.itemId]: {
            ...existing,
            ...action.patch,
            metadata: action.patch.metadata ? { ...existing.metadata, ...action.patch.metadata } : existing.metadata,
            progress: action.patch.progress ? { ...existing.progress, ...action.patch.progress } : existing.progress,
            updatedAt: new Date().toISOString(),
          },
        },
      };
    }
    case "upsertItem": {
      const id = itemMatchId(state, action.item);
      const isNew = !state.jobsById[id];
      const merged = mergeItem(state.jobsById[id], { ...action.item, id });
      return {
        ...state,
        jobsById: { ...state.jobsById, [id]: merged },
        jobOrder: isNew ? [...state.jobOrder, id] : state.jobOrder,
        announcement: `${merged.inspection?.title ?? "Queue item"}: ${merged.progress.message ?? merged.status}`,
      };
    }
    case "syncQueue": {
      const jobsById = Object.fromEntries(
        state.jobOrder
          .filter((id) => !state.jobsById[id]?.nativeJobId)
          .map((id) => [id, state.jobsById[id]]),
      );
      const nativeOrder: string[] = [];
      for (const incoming of action.queue.jobs) {
        const id = itemMatchId(state, incoming);
        jobsById[id] = mergeItem(state.jobsById[id], { ...incoming, id });
        nativeOrder.push(id);
      }
      const localOnly = state.jobOrder.filter((id) => jobsById[id] && !jobsById[id].nativeJobId && !nativeOrder.includes(id));
      const order = [...localOnly, ...nativeOrder];
      return {
        ...state,
        jobsById,
        jobOrder: order,
        selectedJobId: state.selectedJobId && jobsById[state.selectedJobId]
          ? state.selectedJobId
          : order[0] ?? null,
        settings: { ...state.settings, queuePaused: action.queue.paused },
        queuePaused: action.queue.paused,
        queueRevision: action.queue.revision ?? state.queueRevision,
      };
    }
    case "removeItem": {
      if (!state.jobsById[action.itemId]) return state;
      const jobsById = { ...state.jobsById };
      delete jobsById[action.itemId];
      const order = state.jobOrder.filter((id) => id !== action.itemId);
      return {
        ...state,
        jobsById,
        jobOrder: order,
        selectedJobId: state.selectedJobId === action.itemId ? order[0] ?? null : state.selectedJobId,
      };
    }
    case "moveItem":
      return { ...state, jobOrder: moveQueueItem(state.jobOrder, action.itemId, action.direction) };
    case "selectItem":
      return { ...state, selectedJobId: action.itemId };
    case "setQueuePaused":
      return setQueuePausedTransition(state, action.paused);
    case "setLibrary":
      return {
        ...state,
        library: action.items,
        selectedLibraryId: action.items.some((item) => item.id === state.selectedLibraryId)
          ? state.selectedLibraryId
          : action.items[0]?.id ?? null,
      };
    case "removeLibraryItem": {
      const items = state.library.filter((item) => item.id !== action.itemId);
      return {
        ...state,
        library: items,
        selectedLibraryId: state.selectedLibraryId === action.itemId ? items[0]?.id ?? null : state.selectedLibraryId,
      };
    }
    case "selectLibraryItem":
      return { ...state, selectedLibraryId: action.itemId };
    case "setSettings":
      return {
        ...state,
        settings: { ...action.settings, queuePaused: state.queuePaused },
      };
    case "setDiagnostics":
      return { ...state, diagnostics: action.diagnostics };
    case "setDropActive":
      return { ...state, dropActive: action.active };
    case "setError":
      return { ...state, globalError: action.error };
    case "announce":
      return { ...state, announcement: action.message };
    case "setShortcutsOpen":
      return { ...state, shortcutsOpen: action.open };
    case "playerLoading":
      return { ...state, player: { ...initialState.player, targetId: action.targetId, loading: true } };
    case "playerReady":
      return { ...state, player: { ...initialState.player, targetId: action.targetId, asset: action.asset } };
    case "playerUnavailable":
      return { ...state, player: { ...initialState.player, targetId: action.targetId, error: action.error } };
    case "playerPlaying":
      return { ...state, player: { ...state.player, playing: action.playing } };
    case "playerTime":
      return { ...state, player: { ...state.player, currentTime: action.time } };
    case "playerLoop":
      return { ...state, player: { ...state.player, loop: action.loop } };
    case "playerRelease":
      return { ...state, player: initialState.player };
    default:
      return state;
  }
}

export function selectJobs(state: SonicState) {
  return state.jobOrder.map((id) => state.jobsById[id]).filter((item): item is QueueItem => Boolean(item));
}

export function selectSelectedJob(state: SonicState) {
  return state.selectedJobId ? state.jobsById[state.selectedJobId] ?? null : null;
}

export function selectSelectedLibraryItem(state: SonicState) {
  return state.library.find((item) => item.id === state.selectedLibraryId) ?? null;
}
