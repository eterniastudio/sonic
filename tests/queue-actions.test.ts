import { describe, expect, it } from "vitest";
import type { LibraryItem, QueueItem } from "../src/domain/types";
import { libraryItemMatchesQueueItem, queueRemovalMode } from "../src/domain/queue";

function queueItem(status: QueueItem["status"], overrides: Partial<QueueItem> = {}): QueueItem {
  return {
    id: "client-job",
    nativeJobId: "native-job",
    source: { kind: "localFile", path: "C:\\Music\\Beat.wav" },
    metadata: { bpm: "128", key: "C minor", detuneCents: "" },
    presetId: "wav44100S24",
    channelMode: "preserve",
    writeEmbeddedTags: true,
    templateId: "title-metadata",
    outputDirectory: "C:\\Exports",
    filenamePreview: "Beat.wav",
    status,
    progress: {},
    outputPath: "C:\\Exports\\Beat.wav",
    createdAt: "2026-07-18T12:00:00.000Z",
    updatedAt: "2026-07-18T12:00:00.000Z",
    ...overrides,
  };
}

function libraryItem(overrides: Partial<LibraryItem> = {}): LibraryItem {
  return {
    id: "library-job",
    jobId: "native-job",
    title: "Beat",
    source: { kind: "localFile", path: "C:\\Music\\Beat.wav" },
    sourceLabel: "Local file",
    outputPath: "C:\\Exports\\Beat.wav",
    format: "wav",
    exportedAt: "2026-07-18T12:00:00.000Z",
    exists: true,
    ...overrides,
  };
}

describe("queue removal lifecycle contract", () => {
  it("maps native non-terminal jobs to cancellation and terminal jobs to removal", () => {
    expect(queueRemovalMode(queueItem("queued"), [])).toBe("cancel");
    expect(queueRemovalMode(queueItem("transcoding"), [])).toBe("cancel");
    expect(queueRemovalMode(queueItem("cancelled"), [])).toBe("remove");
    expect(queueRemovalMode(queueItem("failed"), [])).toBe("remove");
    expect(queueRemovalMode(queueItem("review", { nativeJobId: undefined }), [])).toBe("local");
  });

  it("retains completed jobs that back Library history", () => {
    const completed = queueItem("completed");
    const history = libraryItem();

    expect(libraryItemMatchesQueueItem(history, completed)).toBe(true);
    expect(queueRemovalMode(completed, [history])).toBe("retain-library");
    expect(queueRemovalMode(completed, [])).toBe("remove");
  });

  it("can correlate older history by output path when no job id is present", () => {
    const completed = queueItem("completed", { nativeJobId: "legacy-job" });
    const history = libraryItem({ jobId: undefined, outputPath: "c:/exports/beat.wav" });

    expect(libraryItemMatchesQueueItem(history, completed)).toBe(true);
    expect(queueRemovalMode(completed, [history])).toBe("retain-library");
  });
});
