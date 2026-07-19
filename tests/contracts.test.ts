import { describe, expect, it } from "vitest";
import bootstrapFixture from "./fixtures/contracts/bootstrap-v0.2.json";
import queueFixture from "./fixtures/contracts/queue-snapshot-v0.2.json";
import inspectionFixture from "./fixtures/contracts/source-inspection-v0.2.json";
import {
  normalizeBootstrap,
  normalizeInspection,
  normalizeMetadata,
  normalizeQueueSnapshot,
  normalizeSource,
} from "../src/services/normalizers";

describe("Rust to TypeScript v0.2 contracts", () => {
  it("normalizes the exact tagged SourceSpec and SourceInspection wire shape", () => {
    const inspection = normalizeInspection(inspectionFixture);
    expect(inspection).toMatchObject({
      id: "local:night-shift",
      kind: "localFile",
      title: "Night Shift",
      creator: "Eternia",
      sourcePath: "C:\\Music\\Night Shift.wav",
      durationSeconds: 173.25,
      fileSizeBytes: 49_824_000,
      codec: "pcm_s24le",
      metadata: {
        bpm: 144,
        alternateBpms: [72],
        key: "F# minor",
        camelot: "11A",
        detuneCents: -31.8,
      },
    });
  });

  it("normalizes snake-like state spellings and orders queue jobs by the native queue position", () => {
    const snapshot = normalizeQueueSnapshot(queueFixture);
    expect(snapshot.paused).toBe(true);
    expect(snapshot.jobs.map((job) => [job.id, job.status])).toEqual([
      ["job-a", "failed"],
      ["job-b", "queued"],
    ]);
    expect(snapshot.order).toEqual(["job-a", "job-b"]);
    expect(snapshot.jobs[0].error).toBe("Fixture failure");
  });

  it("unwraps settings, queue, dependency, preset, and recent-library fields from BootstrapSnapshot", () => {
    const bootstrap = normalizeBootstrap(bootstrapFixture);
    expect(bootstrap.queuePaused).toBe(true);
    expect(bootstrap.settings).toMatchObject({
      defaultOutputDirectory: "C:\\Exports\\Sonic",
      defaultPresetId: "mp3Cbr320",
      historyEnabled: true,
    });
    expect(bootstrap.diagnostics.engine).toMatchObject({ ready: true });
    expect(bootstrap.library).toHaveLength(1);
    expect(bootstrap.library[0]).toMatchObject({
      id: "library-1",
      title: "Night Shift",
      outputPath: "C:\\Exports\\Sonic\\Night Shift.wav",
      exists: true,
      bpm: 144,
    });
    expect(bootstrap.presets[0]).toMatchObject({
      id: "mp3Cbr320",
      name: "MP3 320 kbps",
      extension: "mp3",
    });
  });

  it("fails closed to finite metadata values and an explicit source variant", () => {
    expect(normalizeMetadata({ bpm: Number.NaN, warnings: ["valid", null, 4] })).toMatchObject({
      bpm: undefined,
      warnings: ["valid"],
    });
    expect(normalizeSource({ kind: "localFile", path: "C:\\Beat.wav" })).toEqual({
      kind: "localFile",
      path: "C:\\Beat.wav",
    });
    expect(normalizeSource({ webpageUrl: "https://youtu.be/fixture" })).toEqual({
      kind: "youtube",
      url: "https://youtu.be/fixture",
    });
  });
});
