import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/domain/defaults";
import { BrowserPreviewBridge } from "../src/fixtures/preview";

describe("browser preview queue contract", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("pauses without starting work, reorders by the complete requested ID list, and persists both", async () => {
    const bridge = new BrowserPreviewBridge();
    const updates: string[][] = [];
    const unsubscribe = await bridge.subscribe(() => undefined, (queue) => {
      updates.push(queue.jobs.map((job) => job.id));
    });

    const paused = await bridge.setQueuePaused(true);
    expect(paused.paused).toBe(true);

    const reordered = await bridge.reorderQueue(["preview-queued", "preview-ready"]);
    expect(reordered.jobs.map((job) => job.id)).toEqual(["preview-queued", "preview-ready"]);
    expect(updates[updates.length - 1]).toEqual(["preview-queued", "preview-ready"]);

    const reloaded = new BrowserPreviewBridge();
    const bootstrapPromise = reloaded.bootstrap();
    await expect(bootstrapPromise).resolves.toMatchObject({
      queuePaused: true,
      jobs: [{ id: "preview-queued" }, { id: "preview-ready" }],
    });
    unsubscribe();
  });

  it("retries a failed item by clearing its error and returning it to the queue", async () => {
    const bridge = new BrowserPreviewBridge();
    await bridge.setQueuePaused(true);
    await bridge.updateQueuedJob("preview-queued", {
      status: "failed",
      error: "Fixture encoder failure",
      errorCode: "processFailed",
      progress: { percent: 42, message: "Failed" },
    });

    const retried = await bridge.retryJob("preview-queued");
    expect(retried).toMatchObject({
      id: "preview-queued",
      status: "queued",
      progress: { percent: 0, message: "Queued for retry" },
    });
    expect(retried.error).toBeUndefined();
    expect(retried.errorCode).toBeUndefined();
  });

  it("emits a terminal cancellation and does not mutate unrelated items", async () => {
    const bridge = new BrowserPreviewBridge();
    await bridge.setQueuePaused(true);
    const jobListener = vi.fn();
    const unsubscribe = await bridge.subscribe(jobListener, () => undefined);

    await expect(bridge.cancelJob("preview-queued")).resolves.toBe(true);
    expect(await bridge.getJob("preview-queued")).toMatchObject({
      status: "cancelled",
      progress: { message: "Cancelled" },
    });
    expect(await bridge.getJob("preview-ready")).toMatchObject({ status: "review" });
    expect(jobListener).toHaveBeenCalledWith(expect.objectContaining({ status: "cancelled" }));
    unsubscribe();
  });

  it("does not resume an authoritative paused queue when unrelated settings are saved", async () => {
    const bridge = new BrowserPreviewBridge();
    await bridge.setQueuePaused(true);

    const saved = await bridge.updateSettings({
      ...DEFAULT_SETTINGS,
      queuePaused: false,
      historyEnabled: false,
    });

    expect(saved).toMatchObject({ queuePaused: true, historyEnabled: false });
    await expect(bridge.bootstrap()).resolves.toMatchObject({
      queuePaused: true,
      settings: { queuePaused: true, historyEnabled: false },
    });
  });

  it("exercises the local-file picker, inspection, filename preview, and waveform boundary", async () => {
    const bridge = new BrowserPreviewBridge();
    const [path] = await bridge.chooseLocalFiles();
    const inspection = await bridge.inspectSource({ kind: "localFile", path });

    expect(inspection).toMatchObject({
      kind: "localFile",
      source: { kind: "localFile", path },
      sourcePath: path,
      sourceLabel: "Local file",
    });
    expect(inspection.audio.durationMs).toBeGreaterThan(0);

    const fullName = await bridge.previewFilename({
      source: inspection,
      metadata: { bpm: "128", key: "C minor", detuneCents: "" },
      template: "{title}_{bpm}_{key}",
      presetId: "flac",
    });
    expect(fullName).toMatch(/_128_C minor\.flac$/);

    const preview = await bridge.preparePreview({
      id: "library-local",
      title: inspection.title,
      source: inspection.source,
      sourceLabel: inspection.sourceLabel,
      outputPath: path,
      format: "wav",
      durationSeconds: inspection.durationSeconds,
      exportedAt: "2026-07-18T12:00:00.000Z",
      exists: true,
    });
    expect(preview?.waveform).toHaveLength(240);
    expect(preview?.waveform.every((sample) => sample >= 0 && sample <= 1)).toBe(true);
  });
});
