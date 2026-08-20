import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...await importOriginal<typeof import("@tauri-apps/api/core")>(),
  invoke,
}));

import { NativeBridge } from "../src/services/native";

describe("native library intelligence contract", () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it("wraps library-root writes in the request shape expected by Tauri", async () => {
    invoke.mockResolvedValueOnce("root-1");
    const bridge = new NativeBridge();

    await expect(bridge.createLibraryRoot("Main crate", "C:\\Beats")).resolves.toBe("root-1");
    expect(invoke).toHaveBeenCalledWith("create_library_root", {
      request: { label: "Main crate", rootPath: "C:\\Beats" },
    });
  });

  it("normalizes tag rows and their usage counts", async () => {
    invoke.mockResolvedValueOnce([[
      { id: "tag-1", name: "Dark", color: "#442244", createdAtMs: 10 },
      3,
    ]]);
    const bridge = new NativeBridge();

    await expect(bridge.listTags()).resolves.toEqual([{
      id: "tag-1",
      name: "Dark",
      color: "#442244",
      createdAtMs: 10,
      itemCount: 3,
    }]);
  });

  it("maps bulk deletion to the native audio and sidecar safety flags", async () => {
    invoke.mockResolvedValueOnce(2);
    const bridge = new NativeBridge();

    await bridge.bulkDeleteItems(["item-1", "item-2"], true);
    expect(invoke).toHaveBeenCalledWith("bulk_delete_items", {
      request: {
        itemIds: ["item-1", "item-2"],
        deleteAudio: true,
        deleteSidecar: true,
      },
    });
  });

  it("uses the registered source-fingerprint duplicate command", async () => {
    invoke.mockResolvedValueOnce([]);
    const bridge = new NativeBridge();

    await bridge.findDuplicatesBySource();
    expect(invoke).toHaveBeenCalledWith("find_duplicates_by_source_fingerprint");
  });
});
