import { describe, expect, it } from "vitest";
import { formatBytes, formatDuration, formatEta, formatSpeed, shortPath, statusLabel } from "../src/domain/format";

describe("producer-facing formatting", () => {
  it.each([
    [undefined, "--:--"],
    [0, "0:00"],
    [65.6, "1:06"],
    [3661, "1:01:01"],
    [-4, "0:00"],
  ])("formats duration %s", (value, expected) => {
    expect(formatDuration(value)).toBe(expected);
  });

  it("formats byte totals, transfer rates, and ETA without inventing unavailable values", () => {
    expect(formatBytes(undefined)).toBe("—");
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1_572_864)).toBe("1.5 MB");
    expect(formatSpeed(2_097_152)).toBe("2.0 MB/s");
    expect(formatEta(62)).toBe("1m 2s");
    expect(formatEta(Number.NaN)).toBe("—");
  });

  it("shortens paths in the middle and maps every queue state to user language", () => {
    const path = "C:\\Users\\Producer\\Documents\\Very Long Project\\Exports\\beat.wav";
    const shortened = shortPath(path, 30);
    expect(shortened).toHaveLength(30);
    expect(shortened).toContain("…");
    expect(shortened.endsWith("beat.wav")).toBe(true);
    expect(statusLabel("writingMetadata")).toBe("Writing metadata");
    expect(statusLabel("failed")).toBe("Needs attention");
    expect(statusLabel("futureState")).toBe("futureState");
  });
});
