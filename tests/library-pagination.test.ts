import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...await importOriginal<typeof import("@tauri-apps/api/core")>(),
  invoke,
}));

import { initialState, sonicReducer } from "../src/app/state";
import type { LibraryItem } from "../src/domain/types";
import type { SonicBridge } from "../src/services/bridge-types";
import {
  normalizeLibraryPage,
  requestNextLibraryPage,
  withLibraryPagination,
} from "../src/services/library-pagination";

function nativeItem(id: string, createdAtMs: number, missing = false) {
  return {
    id,
    jobId: `job-${id}`,
    source: { kind: "localFile", path: `C:\\Beats\\${id}.wav` },
    title: `Track ${id}`,
    artist: "Eternia",
    audioPath: `C:\\Exports\\${id}.wav`,
    sidecarPath: `C:\\Exports\\${id}.sonic.json`,
    presetId: "wav44100S24",
    format: "wav",
    fileSizeBytes: 1024,
    sha256: id.repeat(64).slice(0, 64),
    missing,
    createdAtMs,
    updatedAtMs: createdAtMs,
  };
}

function libraryItem(id: string, exists = true): LibraryItem {
  return {
    id,
    title: `Track ${id}`,
    creator: "Eternia",
    source: { kind: "localFile", path: `C:\\Beats\\${id}.wav` },
    sourceLabel: "Local file",
    outputPath: `C:\\Exports\\${id}.wav`,
    format: "wav",
    key: "F# minor",
    exportedAt: "2026-08-20T12:00:00.000Z",
    exists,
  };
}

describe("library page normalization and pagination", () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it("normalizes native Rust field names into the frontend LibraryItem contract", () => {
    const page = normalizeLibraryPage({
      items: [nativeItem("a", 1_787_227_200_000, true)],
      totalCount: 1,
      facets: {
        formats: [{ value: "wav", count: 1 }],
        keys: [],
        missingCount: 1,
      },
    });

    expect(page.items[0]).toMatchObject({
      id: "a",
      creator: "Eternia",
      outputPath: "C:\\Exports\\a.wav",
      exists: false,
      exportedAt: "2026-08-20T12:00:00.000Z",
    });
    expect(page.facets.missingCount).toBe(1);
  });

  it("requests the opaque native cursor and returns one accumulated ordered page", async () => {
    invoke
      .mockResolvedValueOnce({
        items: [nativeItem("a", 1_787_227_200_000)],
        nextCursor: "opaque-cursor",
        totalCount: 2,
        facets: {
          formats: [{ value: "wav", count: 2 }],
          keys: [],
          missingCount: 0,
        },
      })
      .mockResolvedValueOnce({
        items: [nativeItem("b", 1_787_227_100_000)],
        nextCursor: null,
        totalCount: 2,
        facets: {
          formats: [{ value: "wav", count: 2 }],
          keys: [],
          missingCount: 0,
        },
      });

    const pagedBridge = withLibraryPagination(
      { mode: "native" } as unknown as SonicBridge,
      1,
    );

    const first = await pagedBridge.listLibrary("", undefined, "newest");
    expect(first.items.map((item) => item.id)).toEqual(["a"]);
    expect(first.nextCursor).toBe("opaque-cursor");
    expect(requestNextLibraryPage()).toBe(true);

    const second = await pagedBridge.listLibrary("", undefined, "newest");
    expect(second.items.map((item) => item.id)).toEqual(["a", "b"]);
    expect(second.totalCount).toBe(2);
    expect(second.nextCursor).toBeUndefined();
    expect(requestNextLibraryPage()).toBe(false);
    expect(invoke).toHaveBeenNthCalledWith(2, "list_library", {
      query: {
        search: null,
        key: null,
        bpmMin: null,
        bpmMax: null,
        format: null,
        missing: null,
        limit: 1,
        cursor: "opaque-cursor",
        sort: "newest",
      },
    });
  });
});

describe("library pagination reducer state", () => {
  it("stores counts, facets, and cursors and updates them after removal", () => {
    const first = libraryItem("a", false);
    const second = libraryItem("b");
    const loaded = sonicReducer(initialState, {
      type: "setLibrary",
      items: [first, second],
      totalCount: 5,
      nextCursor: "next-page",
      facets: {
        formats: [{ value: "wav", count: 5 }],
        keys: [{ value: "F# minor", count: 2 }],
        missingCount: 1,
      },
    });

    expect(loaded).toMatchObject({
      libraryTotalCount: 5,
      libraryNextCursor: "next-page",
      selectedLibraryId: "a",
      libraryFacets: {
        formats: [{ value: "wav", count: 5 }],
        keys: [{ value: "F# minor", count: 2 }],
        missingCount: 1,
      },
    });

    const removed = sonicReducer(loaded, { type: "removeLibraryItem", itemId: "a" });
    expect(removed).toMatchObject({
      libraryTotalCount: 4,
      selectedLibraryId: "b",
      libraryFacets: {
        formats: [{ value: "wav", count: 4 }],
        keys: [{ value: "F# minor", count: 1 }],
        missingCount: 0,
      },
    });
  });
});
