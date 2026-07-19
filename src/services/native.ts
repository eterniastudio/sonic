import { getVersion } from "@tauri-apps/api/app";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { BUILTIN_PRESETS, DEFAULT_SETTINGS } from "../domain/defaults";
import { renderFilename } from "../domain/filename";
import type {
  BootstrapPayload,
  Diagnostics,
  ExportPreset,
  ExportRequest,
  FilenamePreviewRequest,
  LibraryFilters,
  LibraryItem,
  LibrarySort,
  MetadataDraft,
  PreviewAsset,
  QueueItem,
  QueueSnapshot,
  SonicSettings,
  SourceInput,
} from "../domain/types";
import type { SonicBridge, Unsubscribe } from "./bridge-types";
import {
  asArray,
  asNumber,
  asRecord,
  asString,
  normalizeBootstrap,
  normalizeDependencies,
  normalizeDiagnostics,
  normalizeInspection,
  normalizeLibraryItem,
  normalizePreset,
  normalizeQueueItem,
  normalizeQueueSnapshot,
  normalizeSettings,
} from "./normalizers";

function messageFromError(error: unknown) {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  const record = asRecord(error);
  if (typeof record.message === "string") return record.message;
  return "Sonic could not complete that native operation.";
}

function commandUnavailable(error: unknown) {
  const message = messageFromError(error).toLocaleLowerCase();
  return message.includes("command") && (
    message.includes("not found")
    || message.includes("unknown")
    || message.includes("missing")
    || message.includes("does not exist")
  );
}

function optionalNumber(value: string) {
  if (!value.trim()) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function finalMetadata(item: { metadata: MetadataDraft; inspection?: QueueItem["inspection"] }) {
  const inspection = item.inspection;
  return {
    title: item.metadata.title?.trim() || inspection?.title || "Untitled audio",
    artist: item.metadata.artist?.trim() || inspection?.creator || null,
    bpm: optionalNumber(item.metadata.bpm) ?? null,
    alternateBpms: item.metadata.alternateBpms ?? inspection?.suggestedMetadata.alternateBpms ?? [],
    key: item.metadata.key.trim() || null,
    camelot: item.metadata.camelot?.trim() || null,
    detuneCents: optionalNumber(item.metadata.detuneCents) ?? null,
    tuningHz: item.metadata.tuningHz ?? inspection?.suggestedMetadata.tuningHz ?? null,
    evidence: inspection?.suggestedMetadata.matches ?? [],
    warnings: [...(inspection?.suggestedMetadata.warnings ?? []), ...(inspection?.warnings ?? [])],
  };
}

function nativeExportRequest(request: ExportRequest) {
  return {
    clientItemId: request.itemId,
    source: request.source,
    expectedFingerprint: request.inspection.sourceFingerprint || null,
    inspection: {
      id: request.inspection.id,
      source: request.inspection.source,
      sourceFingerprint: request.inspection.sourceFingerprint,
      title: request.inspection.title,
      artist: request.inspection.creator ?? null,
      description: request.inspection.description ?? null,
      thumbnailUrl: request.inspection.thumbnailUrl ?? null,
      webpageUrl: request.inspection.sourceUrl ?? null,
      isLive: request.inspection.isLive,
      audio: {
        container: request.inspection.audio.container ?? null,
        codec: request.inspection.audio.codec ?? null,
        sampleRateHz: request.inspection.audio.sampleRateHz ?? null,
        channels: request.inspection.audio.channels ?? null,
        bitDepth: request.inspection.audio.bitDepth ?? null,
        durationMs: request.inspection.audio.durationMs ?? null,
        fileSizeBytes: request.inspection.audio.fileSizeBytes ?? null,
      },
      declaredMetadata: request.inspection.declaredMetadata,
      embeddedMetadata: request.inspection.embeddedMetadata,
      suggestedMetadata: request.inspection.suggestedMetadata,
      warnings: request.inspection.warnings,
    },
    metadata: finalMetadata({ metadata: request.metadata, inspection: request.inspection }),
    export: {
      presetId: request.presetId,
      channelMode: request.channelMode,
      normalizeLufs: request.normalizeLufs ?? null,
      writeEmbeddedTags: request.writeEmbeddedTags,
    },
    outputDirectory: request.outputDirectory,
    filenameTemplate: request.filenameTemplate,
  };
}

const BOOTSTRAP_DETAIL_LIMIT = 100;
const BOOTSTRAP_DETAIL_CONCURRENCY = 4;
const BOOTSTRAP_DETAIL_STATES = new Set<QueueItem["status"]>([
  "queued",
  "preparing",
  "acquiring",
  "copying",
  "transcoding",
  "tagging",
  "validating",
  "publishing",
  "failed",
  "cancelled",
  "interrupted",
]);

/**
 * Queue snapshots intentionally contain compact summaries. Hydrate the jobs
 * that can still be edited, monitored, cancelled, or retried so a restarted
 * renderer retains the persisted inspection and export request.
 */
export async function hydrateBootstrapQueueJobs(
  jobs: QueueItem[],
  fetchDetail: (jobId: string) => Promise<unknown>,
  options: { limit?: number; concurrency?: number } = {},
) {
  const limit = Math.min(
    BOOTSTRAP_DETAIL_LIMIT,
    Math.max(0, Math.trunc(options.limit ?? BOOTSTRAP_DETAIL_LIMIT)),
  );
  const candidates = jobs
    .map((job, index) => ({ job, index }))
    .filter(({ job }) => BOOTSTRAP_DETAIL_STATES.has(job.status))
    .slice(0, limit);
  if (!candidates.length) return jobs;

  const hydrated = [...jobs];
  const concurrency = Math.min(
    BOOTSTRAP_DETAIL_CONCURRENCY,
    Math.max(1, Math.trunc(options.concurrency ?? BOOTSTRAP_DETAIL_CONCURRENCY)),
    candidates.length,
  );
  let cursor = 0;

  const worker = async () => {
    while (cursor < candidates.length) {
      const candidate = candidates[cursor];
      cursor += 1;
      try {
        const detail = await fetchDetail(candidate.job.nativeJobId ?? candidate.job.id);
        hydrated[candidate.index] = normalizeQueueItem(detail, candidate.job);
      } catch {
        // A single stale/deleted job must not prevent the rest of Sonic from booting.
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return hydrated;
}

export class NativeBridge implements SonicBridge {
  readonly mode = "native" as const;
  private queueRevision = 0;
  private settingsRevision = 0;
  private settings = DEFAULT_SETTINGS;
  private legacyJobs = new Map<string, QueueItem>();

  async bootstrap(): Promise<BootstrapPayload> {
    try {
      const payload = normalizeBootstrap(await invoke<unknown>("bootstrap"));
      this.queueRevision = payload.queueRevision;
      this.settingsRevision = payload.settingsRevision;
      this.settings = payload.settings;
      const jobs = await hydrateBootstrapQueueJobs(
        payload.jobs,
        (jobId) => invoke<unknown>("get_job", { jobId }),
      );
      return { ...payload, jobs };
    } catch (error) {
      if (!commandUnavailable(error)) throw error;
      const [dependenciesRaw, outputDirectory, appVersion] = await Promise.all([
        invoke<unknown>("check_dependencies"),
        invoke<string>("get_default_output_dir"),
        getVersion(),
      ]);
      const settings = { ...DEFAULT_SETTINGS, defaultOutputDirectory: outputDirectory };
      this.settings = settings;
      return {
        settings,
        jobs: [],
        library: [],
        presets: BUILTIN_PRESETS.filter((preset) => ["original", "mp3Cbr320", "m4aAac256", "wav44100S24"].includes(preset.id)),
        diagnostics: {
          appVersion,
          operatingSystem: "Windows",
          engine: normalizeDependencies(dependenciesRaw),
          outputDirectory,
        },
        queuePaused: false,
        queueRevision: 0,
        settingsRevision: 0,
      };
    }
  }

  async inspectSource(source: SourceInput) {
    try {
      return normalizeInspection(await invoke<unknown>("inspect_source", { request: { source } }), source);
    } catch (error) {
      if (!commandUnavailable(error)) throw error;
      if (source.kind === "localFile") {
        throw new Error("This Sonic build does not yet include local-file inspection. Install the v0.2 native update to use imported audio.");
      }
      return normalizeInspection(await invoke<unknown>("inspect_video", { url: source.url }), source);
    }
  }

  async listExportPresets(): Promise<ExportPreset[]> {
    try {
      const value = await invoke<unknown>("list_export_presets");
      const presets = asArray(value).map(normalizePreset);
      return presets.length ? presets : BUILTIN_PRESETS;
    } catch (error) {
      if (!commandUnavailable(error)) throw error;
      return BUILTIN_PRESETS.filter((preset) => ["original", "mp3Cbr320", "m4aAac256", "wav44100S24"].includes(preset.id));
    }
  }

  async previewFilename(request: FilenamePreviewRequest) {
    try {
      const value = asRecord(await invoke<unknown>("preview_filename", {
        request: {
          template: request.template,
          metadata: finalMetadata({ metadata: request.metadata, inspection: request.source }),
          presetId: request.presetId,
          originalExtension: request.source.audio.container ?? null,
        },
      }));
      return asString(value.fullName ?? value.filename ?? value.stem);
    } catch (error) {
      if (!commandUnavailable(error)) throw error;
      const extension = BUILTIN_PRESETS.find((preset) => preset.id === request.presetId)?.extension ?? "audio";
      return renderFilename(request, extension);
    }
  }

  async enqueueExports(requests: ExportRequest[]) {
    try {
      const raw = await invoke<unknown>("enqueue_exports", {
        request: { items: requests.map(nativeExportRequest) },
      });
      const record = asRecord(raw);
      const snapshot = normalizeQueueSnapshot(raw);
      if (snapshot.revision !== undefined) this.queueRevision = snapshot.revision;
      const values = snapshot.jobs.length ? snapshot.jobs : asArray(record.items ?? raw).map((item) => normalizeQueueItem(item));
      return values.map((job, index) => normalizeQueueItem(job, {
        id: requests[index]?.itemId,
        source: requests[index]?.source,
        inspection: requests[index]?.inspection,
        metadata: requests[index]?.metadata,
        presetId: requests[index]?.presetId,
        channelMode: requests[index]?.channelMode,
        normalizeLufs: requests[index]?.normalizeLufs,
        writeEmbeddedTags: requests[index]?.writeEmbeddedTags,
        outputDirectory: requests[index]?.outputDirectory,
        customTemplate: requests[index]?.filenameTemplate,
      }));
    } catch (error) {
      if (!commandUnavailable(error)) throw error;
      if (requests.length !== 1) {
        throw new Error("This installed native engine supports one YouTube export at a time. Update Sonic to enable the v0.2 queue and local files.");
      }
      const request = requests[0];
      if (request.source.kind !== "youtube") {
        throw new Error("Local-file export requires the v0.2 native engine.");
      }
      const preset = BUILTIN_PRESETS.find((item) => item.id === request.presetId);
      const legacyFormat = preset?.format === "original" ? "original"
        : preset?.format === "wav" ? "wav"
          : preset?.format === "mp3" ? "mp3"
            : preset?.format === "m4a" ? "m4a" : null;
      if (!legacyFormat) throw new Error(`${preset?.name ?? "That preset"} requires the v0.2 native engine.`);
      const result = await invoke<{ jobId: string }>("start_download", {
        request: {
          url: request.source.url,
          outputDirectory: request.outputDirectory,
          format: legacyFormat,
          fileName: renderFilename({
            source: request.inspection,
            metadata: request.metadata,
            template: request.filenameTemplate,
            presetId: request.presetId,
          }, preset?.extension ?? legacyFormat).replace(/\.[^.]+$/, ""),
          bpm: optionalNumber(request.metadata.bpm),
          key: request.metadata.key.trim() || undefined,
          detuneCents: optionalNumber(request.metadata.detuneCents),
        },
      });
      const now = new Date().toISOString();
      const job: QueueItem = {
        id: request.itemId,
        nativeJobId: result.jobId,
        source: request.source,
        inspection: request.inspection,
        metadata: request.metadata,
        presetId: request.presetId,
        channelMode: request.channelMode,
        normalizeLufs: request.normalizeLufs,
        writeEmbeddedTags: request.writeEmbeddedTags,
        templateId: "title-metadata",
        customTemplate: request.filenameTemplate,
        outputDirectory: request.outputDirectory,
        filenamePreview: "",
        status: "queued",
        progress: { percent: 0, message: "Queued" },
        createdAt: now,
        updatedAt: now,
      };
      this.legacyJobs.set(result.jobId, job);
      return [job];
    }
  }

  async listJobs() {
    try {
      const value = asRecord(await invoke<unknown>("list_jobs", { query: { states: [], limit: 250, cursor: null } }));
      return asArray(value.items ?? value.jobs).map((item) => normalizeQueueItem(item));
    } catch (error) {
      if (!commandUnavailable(error)) throw error;
      return [...this.legacyJobs.values()];
    }
  }

  async getJob(jobId: string) {
    try {
      return normalizeQueueItem(await invoke<unknown>("get_job", { jobId }));
    } catch (error) {
      if (!commandUnavailable(error)) throw error;
      const job = this.legacyJobs.get(jobId);
      if (!job) throw new Error("That job is not available in this native build.");
      return job;
    }
  }

  async updateQueuedJob(jobId: string, patch: Partial<QueueItem>) {
    const current = { ...(await this.getJob(jobId)), ...patch };
    if (!current.inspection) throw new Error("Wait for Sonic to finish checking this source.");
    try {
      return normalizeQueueItem(await invoke<unknown>("update_queued_job", {
        request: {
          jobId,
          metadata: finalMetadata(current),
          export: {
            presetId: current.presetId,
            channelMode: current.channelMode,
            normalizeLufs: current.normalizeLufs ?? null,
            writeEmbeddedTags: current.writeEmbeddedTags,
          },
          outputDirectory: current.outputDirectory,
          filenameTemplate: current.customTemplate ?? this.settings.filenameTemplate,
          expectedRevision: current.revision ?? 0,
        },
      }), current);
    } catch (error) {
      if (!commandUnavailable(error)) throw error;
      throw new Error("Queued-job editing requires the v0.2 native engine.");
    }
  }

  async cancelJob(jobId: string) {
    try {
      const value = await invoke<unknown>("cancel_job", { jobId });
      return typeof value === "boolean" ? value : true;
    } catch (error) {
      if (!commandUnavailable(error)) throw error;
      return invoke<boolean>("cancel_download", { jobId });
    }
  }

  async retryJob(jobId: string) {
    return normalizeQueueItem(await invoke<unknown>("retry_job", { jobId }));
  }

  async removeJob(jobId: string) {
    const value = await invoke<unknown>("remove_job", { jobId });
    return typeof value === "boolean" ? value : true;
  }

  async reorderQueue(jobIds: string[]) {
    const snapshot = normalizeQueueSnapshot(await invoke<unknown>("reorder_queue", {
      request: { orderedJobIds: jobIds, expectedRevision: this.queueRevision },
    }));
    if (snapshot.revision !== undefined) this.queueRevision = snapshot.revision;
    return snapshot;
  }

  async setQueuePaused(paused: boolean) {
    const snapshot = normalizeQueueSnapshot(await invoke<unknown>("set_queue_paused", {
      request: { paused, expectedRevision: this.queueRevision },
    }));
    if (snapshot.revision !== undefined) this.queueRevision = snapshot.revision;
    this.settings = { ...this.settings, queuePaused: snapshot.paused };
    return snapshot;
  }

  async listLibrary(query = "", filters?: LibraryFilters, _sort?: LibrarySort) {
    const value = asRecord(await invoke<unknown>("list_library", {
      query: {
        search: query.trim() || null,
        key: filters?.key.trim() || null,
        bpmMin: optionalNumber(filters?.bpmMin ?? "") ?? null,
        bpmMax: optionalNumber(filters?.bpmMax ?? "") ?? null,
        format: filters?.format || null,
        missing: filters?.missingOnly ? true : null,
        limit: 500,
        cursor: null,
      },
    }));
    return asArray(value.items ?? value.library).map(normalizeLibraryItem);
  }

  async getLibraryItem(itemId: string) {
    return normalizeLibraryItem(await invoke<unknown>("get_library_item", { itemId }));
  }

  async reexportLibraryItem(itemId: string) {
    const item = await this.getLibraryItem(itemId);
    const raw = await invoke<unknown>("reexport_library_item", {
      request: {
        itemId,
        export: {
          presetId: item.presetId ?? this.settings.defaultPresetId,
          channelMode: "preserve",
          normalizeLufs: null,
          writeEmbeddedTags: this.settings.writeEmbeddedTags,
        },
        outputDirectory: this.settings.defaultOutputDirectory,
        filenameTemplate: this.settings.filenameTemplate,
      },
    });
    return normalizeQueueItem(raw);
  }

  async removeLibraryItem(itemId: string, deleteFile: boolean) {
    const value = await invoke<unknown>("remove_library_item", {
      request: { itemId, deleteAudio: deleteFile, deleteSidecar: deleteFile },
    });
    return typeof value === "boolean" ? value : true;
  }

  async getSettings() {
    const raw = asRecord(await invoke<unknown>("get_settings"));
    this.settingsRevision = asNumber(raw.revision) ?? this.settingsRevision;
    this.settings = { ...normalizeSettings(raw), queuePaused: this.settings.queuePaused };
    return this.settings;
  }

  async updateSettings(settings: SonicSettings) {
    const queuePaused = settings.queuePaused;
    const raw = asRecord(await invoke<unknown>("update_settings", {
      request: {
        patch: {
          defaultOutputDirectory: settings.defaultOutputDirectory || null,
          filenameTemplate: settings.filenameTemplate,
          defaultPresetId: settings.defaultPresetId,
          maxConcurrentJobs: settings.maxConcurrentJobs,
          historyEnabled: settings.historyEnabled,
          writeEmbeddedTags: settings.writeEmbeddedTags,
          includeSourcePathInSidecar: settings.includeSourcePathInSidecar,
          maxDurationMinutes: settings.maxDurationMinutes,
          maxInputBytes: settings.maxInputBytes,
        },
        expectedRevision: this.settingsRevision,
      },
    }));
    this.settingsRevision = asNumber(raw.revision) ?? this.settingsRevision;
    this.settings = { ...settings, ...normalizeSettings(raw), queuePaused };
    return this.settings;
  }

  async getDiagnostics() {
    return normalizeDiagnostics(await invoke<unknown>("get_diagnostics"), this.settings.defaultOutputDirectory);
  }

  async exportDiagnostics() {
    if (!this.settings.defaultOutputDirectory) {
      const selected = await this.chooseDirectory();
      if (!selected) throw new Error("Choose a folder for the diagnostic report.");
      this.settings = { ...this.settings, defaultOutputDirectory: selected };
    }
    const value = asRecord(await invoke<unknown>("export_diagnostics", {
      request: { outputDirectory: this.settings.defaultOutputDirectory },
    }));
    return asString(value.path ?? value.outputPath, "Diagnostics exported.");
  }

  async chooseLocalFiles() {
    const selected = await openDialog({
      multiple: true,
      directory: false,
      title: "Choose audio files",
      filters: [{
        name: "Audio",
        extensions: ["wav", "mp3", "m4a", "flac", "opus", "ogg", "webm"],
      }],
    });
    if (Array.isArray(selected)) return selected;
    return typeof selected === "string" ? [selected] : [];
  }

  async chooseDirectory(current?: string) {
    const selected = await openDialog({
      multiple: false,
      directory: true,
      title: "Choose Sonic output folder",
      defaultPath: current,
    });
    return typeof selected === "string" ? selected : null;
  }

  async subscribe(onJob: (job: QueueItem) => void, onQueue: (queue: QueueSnapshot) => void): Promise<Unsubscribe> {
    const unlisteners: UnlistenFn[] = [];
    unlisteners.push(await listen<unknown>("sonic://job-updated", ({ payload }) => onJob(normalizeQueueItem(payload))));
    unlisteners.push(await listen<unknown>("sonic://queue-updated", ({ payload }) => {
      const snapshot = normalizeQueueSnapshot(payload);
      if (snapshot.revision !== undefined) this.queueRevision = snapshot.revision;
      this.settings = { ...this.settings, queuePaused: snapshot.paused };
      onQueue(snapshot);
    }));
    unlisteners.push(await listen<unknown>("sonic://download-progress", ({ payload }) => {
      const raw = asRecord(payload);
      const jobId = asString(raw.jobId);
      const existing = this.legacyJobs.get(jobId);
      if (!existing) return;
      const legacyStatus = asString(raw.status);
      const status = legacyStatus === "downloading" ? "acquiring"
        : legacyStatus === "converting" ? "transcoding"
          : legacyStatus === "completed" ? "completed"
            : legacyStatus === "failed" ? "failed"
              : legacyStatus === "cancelled" ? "cancelled" : existing.status;
      const job = normalizeQueueItem({ ...raw, state: status }, existing);
      this.legacyJobs.set(jobId, job);
      onJob(job);
    }));
    return () => unlisteners.forEach((unlisten) => unlisten());
  }

  async registerFileDrop(handler: (event: { type: "enter" | "over" | "drop" | "leave"; paths: string[] }) => void): Promise<Unsubscribe> {
    return getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type === "enter" || event.payload.type === "over" || event.payload.type === "drop") {
        const paths = "paths" in event.payload ? event.payload.paths : [];
        handler({ type: event.payload.type, paths });
      } else {
        handler({ type: "leave", paths: [] });
      }
    });
  }

  async preparePreview(item: QueueItem | LibraryItem): Promise<PreviewAsset | null> {
    const isQueueItem = "status" in item;
    let source: { kind: "localFile"; path: string } | { kind: "libraryItem"; itemId: string };
    if (isQueueItem) {
      if (item.source.kind !== "localFile") return null;
      source = { kind: "localFile", path: item.source.path };
    } else {
      source = { kind: "libraryItem", itemId: item.id };
    }
    try {
      const raw = asRecord(await invoke<unknown>("prepare_preview", {
        request: { source, maxDurationSeconds: this.settings.previewSeconds },
      }));
      const mediaPath = asString(raw.path);
      const peaks = asArray(raw.waveform).map((value) => {
        const peak = asRecord(value);
        return Math.max(Math.abs(asNumber(peak.min) ?? 0), Math.abs(asNumber(peak.max) ?? 0));
      });
      return {
        id: asString(raw.id, mediaPath),
        mediaUrl: mediaPath ? convertFileSrc(mediaPath) : undefined,
        durationSeconds: (asNumber(raw.durationMs) ?? 0) / 1_000,
        waveform: peaks,
        title: isQueueItem ? item.inspection?.title ?? "Local audio preview" : item.title,
      };
    } catch (error) {
      if (!commandUnavailable(error)) throw error;
      return null;
    }
  }

  async releasePreview(previewId: string) {
    if (!previewId) return;
    try {
      await invoke("release_preview", { previewId });
    } catch (error) {
      if (!commandUnavailable(error)) throw error;
    }
  }

  async revealPath(path: string) {
    await revealItemInDir(path);
  }

  async openSource(source: SourceInput) {
    if (source.kind === "youtube") await openUrl(source.url);
    else await revealItemInDir(source.path);
  }

  async prepareEngine() {
    await invoke("prepare_media_engine");
  }

  async refreshDependencies(): Promise<Diagnostics> {
    try {
      return await this.getDiagnostics();
    } catch (error) {
      if (!commandUnavailable(error)) throw error;
      const dependencies = normalizeDependencies(await invoke<unknown>("check_dependencies"));
      return {
        appVersion: await getVersion(),
        operatingSystem: "Windows",
        engine: dependencies,
        outputDirectory: this.settings.defaultOutputDirectory,
      };
    }
  }
}
