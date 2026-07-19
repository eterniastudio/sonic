import { describe, expect, it } from "vitest";
import { BUILTIN_PRESETS, DEFAULT_SETTINGS } from "../src/domain/defaults";
import type { BootstrapPayload, LibraryItem, QueueItem, SourceInspection } from "../src/domain/types";
import {
  initialState,
  moveQueueItem,
  retryQueueItemTransition,
  selectJobs,
  selectSelectedJob,
  selectSelectedLibraryItem,
  setQueuePausedTransition,
  sonicReducer,
  type SonicState,
} from "../src/app/state";

const musicMetadata = {
  bpm: 144,
  alternateBpms: [72],
  key: "F# minor",
  camelot: "11A",
  detuneCents: -31.8,
  tuningHz: 432,
  confidence: 0.98,
  matches: [],
  warnings: [],
};

const inspection: SourceInspection = {
  id: "inspection-1",
  source: { kind: "localFile", path: "C:\\Music\\Night Shift.wav" },
  sourceFingerprint: "sha256:night-shift",
  kind: "localFile",
  title: "Night Shift",
  creator: "Eternia",
  durationSeconds: 173,
  sourcePath: "C:\\Music\\Night Shift.wav",
  sourceLabel: "Local file",
  isLive: false,
  audio: { codec: "pcm_s24le", durationMs: 173_000, fileSizeBytes: 49_824_000 },
  declaredMetadata: musicMetadata,
  embeddedMetadata: musicMetadata,
  suggestedMetadata: musicMetadata,
  warnings: [],
  metadata: musicMetadata,
};

function queueItem(id: string, overrides: Partial<QueueItem> = {}): QueueItem {
  return {
    id,
    source: inspection.source,
    inspection,
    metadata: { bpm: "144", key: "F# minor", detuneCents: "-31.8" },
    presetId: "wav44100S24",
    channelMode: "preserve",
    writeEmbeddedTags: true,
    templateId: "title-metadata",
    outputDirectory: "C:\\Exports\\Sonic",
    filenamePreview: "Night Shift - 144 BPM - F# minor.wav",
    status: "review",
    progress: {},
    createdAt: "2026-07-18T12:00:00.000Z",
    updatedAt: "2026-07-18T12:00:00.000Z",
    ...overrides,
  };
}

function libraryItem(id: string): LibraryItem {
  return {
    id,
    title: id,
    source: inspection.source,
    sourceLabel: "Local file",
    outputPath: `C:\\Exports\\${id}.wav`,
    format: "wav",
    exportedAt: "2026-07-18T12:00:00.000Z",
    exists: true,
  };
}

function stateWith(items: QueueItem[], selectedJobId: string | null = items[0]?.id ?? null): SonicState {
  return {
    ...initialState,
    loading: false,
    jobsById: Object.fromEntries(items.map((item) => [item.id, item])),
    jobOrder: items.map((item) => item.id),
    selectedJobId,
    settings: { ...DEFAULT_SETTINGS },
    diagnostics: { ...initialState.diagnostics, engine: { ready: false, dependencies: [] } },
    player: { ...initialState.player },
  };
}

describe("queue movement and transitions", () => {
  it("moves only one slot and preserves identity for missing or out-of-bounds moves", () => {
    const order = ["a", "b", "c"];
    expect(moveQueueItem(order, "b", -1)).toEqual(["b", "a", "c"]);
    expect(moveQueueItem(order, "b", 1)).toEqual(["a", "c", "b"]);
    expect(moveQueueItem(order, "a", -1)).toBe(order);
    expect(moveQueueItem(order, "c", 1)).toBe(order);
    expect(moveQueueItem(order, "missing", 1)).toBe(order);
  });

  it("retries from zero and clears both public and structured errors", () => {
    const failed = queueItem("failed", {
      status: "failed",
      error: "Encoder failed",
      errorCode: "processFailed",
      progress: { percent: 63, message: "Failed" },
    });
    const retried = retryQueueItemTransition(failed);
    expect(retried).toMatchObject({
      status: "queued",
      progress: { percent: 0, message: "Queued for retry" },
    });
    expect(retried.error).toBeUndefined();
    expect(retried.errorCode).toBeUndefined();
  });

  it("pauses future work without rewriting an active job and keeps settings in sync", () => {
    const active = queueItem("active", { status: "transcoding" });
    const state = stateWith([active]);
    const paused = setQueuePausedTransition(state, true);
    expect(paused.queuePaused).toBe(true);
    expect(paused.settings.queuePaused).toBe(true);
    expect(paused.jobsById.active.status).toBe("transcoding");
    expect(paused.announcement).toMatch(/active export will finish/i);
    expect(setQueuePausedTransition(paused, false).announcement).toBe("Queue resumed.");
  });
});

describe("sonicReducer hydration and correlation", () => {
  it("hydrates every persisted surface and selects the first review item", () => {
    const queued = queueItem("queued", { status: "queued" });
    const review = queueItem("review", { status: "review" });
    const library = [libraryItem("library-1")];
    const payload: BootstrapPayload = {
      jobs: [queued, review],
      library,
      presets: BUILTIN_PRESETS,
      settings: { ...DEFAULT_SETTINGS, queuePaused: true },
      diagnostics: { ...initialState.diagnostics, appVersion: "0.2.0" },
      queuePaused: true,
      queueRevision: 11,
      settingsRevision: 4,
    };

    const hydrated = sonicReducer(initialState, { type: "hydrate", payload });
    expect(hydrated.loading).toBe(false);
    expect(hydrated.jobOrder).toEqual(["queued", "review"]);
    expect(hydrated.selectedJobId).toBe("review");
    expect(hydrated.selectedLibraryId).toBe("library-1");
    expect(hydrated.queuePaused).toBe(true);
    expect(hydrated.queueRevision).toBe(11);
    expect(hydrated.settingsRevision).toBe(4);
  });

  it("correlates a native summary event to its client item without creating a duplicate", () => {
    const client = queueItem("client-1", { nativeJobId: "native-9", status: "queued" });
    const incoming = queueItem("native-9", {
      nativeJobId: "native-9",
      status: "transcoding",
      progress: { percent: 81, message: "Rendering output preset" },
    });
    const next = sonicReducer(stateWith([client]), { type: "upsertItem", item: incoming });

    expect(next.jobOrder).toEqual(["client-1"]);
    expect(next.jobsById["native-9"]).toBeUndefined();
    expect(next.jobsById["client-1"]).toMatchObject({
      id: "client-1",
      nativeJobId: "native-9",
      status: "transcoding",
      progress: { percent: 81 },
    });
  });

  it("does not erase user-edited metadata when a backend summary carries a synthetic inspection and empty draft", () => {
    const edited = queueItem("client-edited", {
      nativeJobId: "native-edited",
      metadata: { bpm: "146", key: "D minor", detuneCents: "+12" },
    });
    const summary = queueItem("native-edited", {
      nativeJobId: "native-edited",
      inspection: { ...inspection, id: "synthetic-summary", title: "Night Shift" },
      metadata: { bpm: "", key: "", detuneCents: "" },
      status: "tagging",
      progress: { percent: 94, message: "Writing metadata" },
    });

    const next = sonicReducer(stateWith([edited]), { type: "upsertItem", item: summary });
    expect(next.jobsById["client-edited"].metadata).toEqual({
      bpm: "146",
      key: "D minor",
      detuneCents: "+12",
    });
  });
});

describe("authoritative queue sync and selection fallbacks", () => {
  it("keeps local drafts, applies native order/revision, and evicts stale native jobs", () => {
    const local = queueItem("local-draft", { nativeJobId: undefined, status: "review" });
    const stale = queueItem("client-stale", { nativeJobId: "native-stale", status: "queued" });
    const current = queueItem("native-current", {
      nativeJobId: "native-current",
      status: "acquiring",
      queuePosition: 0,
    });
    const synced = sonicReducer(stateWith([local, stale], "client-stale"), {
      type: "syncQueue",
      queue: { paused: true, revision: 17, jobs: [current], order: ["native-current"] },
    });

    expect(synced.jobOrder).toEqual(["local-draft", "native-current"]);
    expect(synced.jobsById["client-stale"]).toBeUndefined();
    expect(synced.queuePaused).toBe(true);
    expect(synced.queueRevision).toBe(17);
    expect(synced.selectedJobId).toBe("local-draft");
    expect(selectJobs(synced).map((item) => item.id)).toEqual(["local-draft", "native-current"]);
  });

  it("reconciles a native snapshot onto its client item without discarding its edited draft", () => {
    const edited = queueItem("client-edited", {
      nativeJobId: "native-edited",
      metadata: { bpm: "146", key: "D minor", detuneCents: "+12" },
    });
    const summary = queueItem("native-edited", {
      nativeJobId: "native-edited",
      metadata: { bpm: "", key: "", detuneCents: "" },
      status: "tagging",
      progress: { percent: 94, message: "Writing metadata" },
    });

    const synced = sonicReducer(stateWith([edited]), {
      type: "syncQueue",
      queue: { paused: false, revision: 18, jobs: [summary], order: ["native-edited"] },
    });

    expect(synced.jobOrder).toEqual(["client-edited"]);
    expect(synced.jobsById["client-edited"]).toMatchObject({
      status: "tagging",
      metadata: { bpm: "146", key: "D minor", detuneCents: "+12" },
    });
  });

  it("treats removal of an unknown item as a no-op", () => {
    const state = stateWith([queueItem("a")]);
    expect(sonicReducer(state, { type: "removeItem", itemId: "missing" })).toBe(state);
  });

  it("selects the next queue or library item when the selected item disappears", () => {
    const state = stateWith([queueItem("a"), queueItem("b")], "a");
    const removed = sonicReducer(state, { type: "removeItem", itemId: "a" });
    expect(removed.selectedJobId).toBe("b");
    expect(selectSelectedJob(removed)?.id).toBe("b");

    const libraryState = {
      ...removed,
      library: [libraryItem("old")],
      selectedLibraryId: "old",
    };
    const replaced = sonicReducer(libraryState, {
      type: "setLibrary",
      items: [libraryItem("new")],
    });
    expect(replaced.selectedLibraryId).toBe("new");
    expect(selectSelectedLibraryItem(replaced)?.id).toBe("new");
  });
});

describe("presentation state actions", () => {
  it("adds, reorders, selects, and pauses queue items through reducer actions", () => {
    let state = stateWith([queueItem("a")]);
    state = sonicReducer(state, { type: "addItem", item: queueItem("b") });
    expect(state).toMatchObject({ jobOrder: ["a", "b"], selectedJobId: "b", route: "session" });

    state = sonicReducer(state, { type: "moveItem", itemId: "b", direction: -1 });
    state = sonicReducer(state, { type: "selectItem", itemId: "a" });
    state = sonicReducer(state, { type: "setQueuePaused", paused: true });
    expect(state).toMatchObject({ jobOrder: ["b", "a"], selectedJobId: "a", queuePaused: true });
  });

  it("merges editable patches and treats an update for a missing item as a no-op", () => {
    const state = stateWith([queueItem("a")]);
    const updated = sonicReducer(state, {
      type: "updateItem",
      itemId: "a",
      patch: {
        metadata: { bpm: "150", key: "", detuneCents: "" },
        progress: { percent: 25 },
      },
    });
    expect(updated.jobsById.a.metadata).toMatchObject({ bpm: "150", key: "", detuneCents: "" });
    expect(updated.jobsById.a.progress).toEqual({ percent: 25 });
    expect(sonicReducer(state, { type: "updateItem", itemId: "missing", patch: { status: "queued" } })).toBe(state);
  });

  it("updates route, settings, diagnostics, drop, alert, and shortcut state without touching the queue", () => {
    const state = { ...stateWith([queueItem("a")]), queuePaused: true };
    const routed = sonicReducer({ ...state, globalError: "old" }, { type: "setRoute", route: "settings" });
    expect(routed).toMatchObject({ route: "settings", globalError: null });

    const settings = { ...DEFAULT_SETTINGS, queuePaused: false, historyEnabled: false };
    const withSettings = sonicReducer(routed, { type: "setSettings", settings });
    const diagnostics = { ...initialState.diagnostics, appVersion: "0.2.0" };
    const withDiagnostics = sonicReducer(withSettings, { type: "setDiagnostics", diagnostics });
    const withDrop = sonicReducer(withDiagnostics, { type: "setDropActive", active: true });
    const withError = sonicReducer(withDrop, { type: "setError", error: "Fixture warning" });
    const announced = sonicReducer(withError, { type: "announce", message: "Saved" });
    const shortcuts = sonicReducer(announced, { type: "setShortcutsOpen", open: true });

    expect(shortcuts).toMatchObject({
      queuePaused: true,
      settings: { historyEnabled: false, queuePaused: true },
      diagnostics: { appVersion: "0.2.0" },
      dropActive: true,
      globalError: "Fixture warning",
      announcement: "Saved",
      shortcutsOpen: true,
      jobOrder: ["a"],
    });
  });

  it("selects and removes library records without disturbing queue state", () => {
    const state = {
      ...stateWith([queueItem("a")]),
      library: [libraryItem("one"), libraryItem("two")],
      selectedLibraryId: "one",
    };
    const selected = sonicReducer(state, { type: "selectLibraryItem", itemId: "two" });
    const removed = sonicReducer(selected, { type: "removeLibraryItem", itemId: "two" });

    expect(removed.library.map((item) => item.id)).toEqual(["one"]);
    expect(removed.selectedLibraryId).toBe("one");
    expect(removed.jobOrder).toEqual(["a"]);
  });

  it("runs the complete preview-player lifecycle", () => {
    let state = stateWith([]);
    state = sonicReducer(state, { type: "playerLoading", targetId: "track-1" });
    expect(state.player).toMatchObject({ targetId: "track-1", loading: true });

    const asset = { id: "preview-1", durationSeconds: 30, waveform: [0.2, 0.8], title: "Night Shift" };
    state = sonicReducer(state, { type: "playerReady", targetId: "track-1", asset });
    state = sonicReducer(state, { type: "playerPlaying", playing: true });
    state = sonicReducer(state, { type: "playerTime", time: 12.5 });
    state = sonicReducer(state, { type: "playerLoop", loop: true });
    expect(state.player).toMatchObject({ asset, playing: true, currentTime: 12.5, loop: true });

    state = sonicReducer(state, { type: "playerUnavailable", targetId: "track-2", error: "No preview" });
    expect(state.player).toMatchObject({ targetId: "track-2", error: "No preview", asset: null });
    expect(sonicReducer(state, { type: "playerRelease" }).player).toEqual(initialState.player);
  });
});
