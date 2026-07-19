import { beforeEach, describe, expect, it, vi } from "vitest";
import { checkForSonicUpdate, installSonicUpdate } from "../src/services/updater";

const mocks = vi.hoisted(() => ({
  check: vi.fn(),
  relaunch: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-updater", () => ({ check: mocks.check }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: mocks.relaunch }));

describe("signed updater service", () => {
  beforeEach(() => {
    mocks.check.mockReset();
    mocks.relaunch.mockReset();
  });

  it("checks the configured endpoint with a bounded request timeout", async () => {
    const update = { version: "0.3.0" };
    mocks.check.mockResolvedValue(update);

    await expect(checkForSonicUpdate()).resolves.toBe(update);
    expect(mocks.check).toHaveBeenCalledWith({ timeout: 15_000 });
  });

  it("passes download progress through and relaunches only after installation", async () => {
    const events = [
      { event: "Started", data: { contentLength: 256 } },
      { event: "Progress", data: { chunkLength: 128 } },
      { event: "Finished" },
    ] as const;
    const downloadAndInstall = vi.fn(async (onEvent: (event: (typeof events)[number]) => void) => {
      for (const event of events) onEvent(event);
    });
    const onEvent = vi.fn();

    await installSonicUpdate({ downloadAndInstall } as never, onEvent);

    expect(downloadAndInstall).toHaveBeenCalledWith(onEvent, { timeout: 600_000 });
    expect(onEvent.mock.calls.map(([event]) => event)).toEqual(events);
    expect(mocks.relaunch).toHaveBeenCalledOnce();
    expect(downloadAndInstall.mock.invocationCallOrder[0]).toBeLessThan(mocks.relaunch.mock.invocationCallOrder[0]);
  });

  it("does not relaunch when the signed update installation fails", async () => {
    const failure = new Error("signature rejected");
    const downloadAndInstall = vi.fn().mockRejectedValue(failure);

    await expect(installSonicUpdate({ downloadAndInstall } as never, vi.fn())).rejects.toBe(failure);
    expect(mocks.relaunch).not.toHaveBeenCalled();
  });
});
