import { describe, expect, it, vi } from "vitest";
import { renderFilename, safeFileStem, templateForItem } from "../src/domain/filename";
import type { FilenamePreviewRequest, QueueItem, SourceInspection } from "../src/domain/types";

const musicalMetadata = {
  bpm: 144,
  alternateBpms: [72],
  key: "F# minor",
  camelot: "11A",
  detuneCents: -31.8,
  tuningHz: 432,
  confidence: 0.9,
  matches: [],
  warnings: [],
};

const source: SourceInspection = {
  id: "fixture-source",
  source: { kind: "localFile", path: "C:\\Music\\Night Shift.wav" },
  sourceFingerprint: "sha256:fixture-source",
  kind: "localFile",
  title: "Night Shift: Industrial / Beat?",
  creator: "Eternia",
  durationSeconds: 173.25,
  sourcePath: "C:\\Music\\Night Shift.wav",
  sourceLabel: "Local file",
  isLive: false,
  audio: { codec: "pcm_s24le", durationMs: 173_250, fileSizeBytes: 49_824_000 },
  declaredMetadata: musicalMetadata,
  embeddedMetadata: musicalMetadata,
  suggestedMetadata: musicalMetadata,
  warnings: [],
  metadata: musicalMetadata,
};

function request(template: string): FilenamePreviewRequest {
  return {
    source,
    metadata: { bpm: "144", key: "F# minor", detuneCents: "-31.8" },
    template,
    presetId: "wav44100S24",
  };
}

describe("safeFileStem", () => {
  it("removes traversal punctuation, invalid Windows characters, repeated spaces, and trailing dots", () => {
    expect(safeFileStem('  ..\\ Beat: C#m / 140 BPM?.  ')).toBe(".. Beat C#m 140 BPM");
  });

  it("caps names to a filesystem-safe preview length", () => {
    expect(safeFileStem("x".repeat(300))).toHaveLength(150);
  });

  it.each(["CON", "prn", "COM1", "lpt9"])("protects the reserved Windows device name %s", (name) => {
    expect(safeFileStem(name)).toBe(`_${name}`);
  });

  it("removes ASCII control characters before presenting the preview", () => {
    expect(safeFileStem("Night\u0000\u0007 Shift")).toBe("Night Shift");
  });
});

describe("renderFilename", () => {
  it("renders producer metadata and a signed detune without leaking invalid title characters", () => {
    expect(renderFilename(request("{producer} - {title} [{camelot}] {detune}"), "wav"))
      .toBe("Eternia - Night Shift Industrial Beat [11A] -31.8c.wav");
  });

  it("exposes the selected export preset as a filename token", () => {
    expect(renderFilename(request("{title}_{preset}"), "wav"))
      .toBe("Night Shift Industrial Beat_wav44100S24.wav");
  });

  it("removes empty decorations and unknown tokens", () => {
    const sparse = request("{producer} - {title} [{unknown}] - {detune}");
    sparse.source = { ...source, creator: undefined };
    sparse.metadata = { bpm: "", key: "", detuneCents: "0" };
    expect(renderFilename(sparse, "source")).toBe("Night Shift Industrial Beat.source");
  });

  it("renders the date token deterministically", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-18T12:00:00Z"));
    expect(renderFilename(request("{date}_{title}"), "mp3")).toBe("2026-07-18_Night Shift Industrial Beat.mp3");
    vi.useRealTimers();
  });
});

describe("templateForItem", () => {
  const item = {
    templateId: "selected",
  } as QueueItem;

  it("prefers a custom item template", () => {
    expect(templateForItem({ ...item, customTemplate: "{title}_{bpm}" }, [
      { id: "selected", name: "Selected", template: "{title}", isBuiltIn: true },
    ])).toBe("{title}_{bpm}");
  });

  it("uses the selected template, then the first available template", () => {
    const templates = [
      { id: "first", name: "First", template: "{producer}", isBuiltIn: true },
      { id: "selected", name: "Selected", template: "{title}", isBuiltIn: true },
    ];
    expect(templateForItem(item, templates)).toBe("{title}");
    expect(templateForItem({ ...item, templateId: "missing" }, templates)).toBe("{producer}");
  });
});
