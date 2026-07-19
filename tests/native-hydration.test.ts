import { describe, expect, it } from "vitest";
import detailFixture from "./fixtures/contracts/job-detail-v0.2.json";
import { hydrateBootstrapQueueJobs } from "../src/services/native";
import { normalizeQueueItem } from "../src/services/normalizers";
import type { QueueItem } from "../src/domain/types";

function compactSummary() {
  const { request: _request, workingDirectory: _workingDirectory, ...summary } = detailFixture;
  return normalizeQueueItem(summary);
}

describe("persisted native queue hydration", () => {
  it("restores the persisted inspection, final metadata, export recipe, output directory, and filename template", async () => {
    const summary = compactSummary();
    const [hydrated] = await hydrateBootstrapQueueJobs([summary], async (jobId) => {
      expect(jobId).toBe("persisted-job-1");
      return detailFixture;
    });

    expect(hydrated).toMatchObject({
      id: "client-persisted-1",
      nativeJobId: "persisted-job-1",
      source: { kind: "localFile", path: "C:\\Music\\Persisted Night Shift.wav" },
      inspection: {
        id: "local:persisted-night-shift",
        sourceFingerprint: "sha256:persisted-night-shift",
        title: "Persisted Night Shift",
      },
      metadata: {
        title: "Persisted Night Shift (Final)",
        artist: "Eternia Studios",
        bpm: "146",
        alternateBpms: [73],
        key: "D minor",
        camelot: "7A",
        detuneCents: "12.5",
        tuningHz: 442,
      },
      presetId: "wav48000S24",
      channelMode: "mono",
      normalizeLufs: -14,
      writeEmbeddedTags: false,
      outputDirectory: "C:\\Exports\\Recovered Session",
      customTemplate: "{producer} - {title} - {bpm} BPM - {key}{detune}",
      status: "queued",
    });
  });

  it("leaves a compact summary intact when its detail can no longer be fetched", async () => {
    const summary = compactSummary();
    const result = await hydrateBootstrapQueueJobs([summary], async () => {
      throw new Error("fixture detail disappeared");
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toBe(summary);
    expect(result[0]).toMatchObject({
      id: "client-persisted-1",
      nativeJobId: "persisted-job-1",
      status: "queued",
      filenamePreview: "",
    });
  });

  it("bounds restart hydration to four concurrent native detail requests", async () => {
    const base = compactSummary();
    const jobs = Array.from({ length: 11 }, (_, index): QueueItem => ({
      ...base,
      id: `client-${index}`,
      nativeJobId: `native-${index}`,
      queuePosition: index,
    }));
    let active = 0;
    let maximumActive = 0;
    let calls = 0;

    const result = await hydrateBootstrapQueueJobs(jobs, async (jobId) => {
      calls += 1;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => window.setTimeout(resolve, 5));
      active -= 1;
      const index = Number(jobId.replace("native-", ""));
      return {
        ...detailFixture,
        id: jobId,
        clientItemId: `client-${index}`,
        queuePosition: index,
      };
    }, { concurrency: 99 });

    expect(result).toHaveLength(11);
    expect(calls).toBe(11);
    expect(maximumActive).toBe(4);
  });
});
