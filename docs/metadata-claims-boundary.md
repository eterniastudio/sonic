# Metadata claims boundary

This document defines what Sonic derives today and which values remain
producer-authoritative.

## Evidence layers

| Concept | Meaning |
| --- | --- |
| Declared | BPM, key, or tuning written in remote-source text or a local filename. |
| Embedded | Values stored in supported audio-container tags and read through ffprobe. |
| Audio analysis | Local, bounded BPM and musical-key estimates with per-field confidence. |
| Suggested | The precedence merge presented to the producer. |
| Final | Producer-editable values used for naming, tagging, sidecars, and export. |

`MusicMetadata.confidence` describes evidence strength. `AudioAnalysis` keeps
its BPM and key confidence separate and records the analyzed duration, source
hash, analyzer version, and warnings.

Sonic decodes no more than 180 seconds to low-rate mono PCM. It estimates tempo
with an onset/autocorrelation model and musical key with chroma/profile matching.
It does not derive tuning, loudness, clipping, or production-quality judgments.

## Automatic fill rule

A reliable audio estimate may fill a blank final BPM or key. The merge order is:

```text
manual / queued value > embedded or declared value > qualified audio estimate > blank
```

Analysis never replaces a nonblank value. Job updates use optimistic revisions,
so a stale analysis result cannot overwrite newer queue state. A failed or
low-confidence analysis is non-fatal and the download/export continues.

The UI labels detected values and confidence. Schema-v2 sidecars store the
analysis record independently of final metadata; schema-v1 sidecars remain
readable without an analysis record.

## Claims Sonic must not make

- A detected BPM or key is not ground truth.
- Text/tag confidence is not acoustic confidence.
- Sonic does not currently analyze tuning or loudness from the waveform.
- Stem separation is optional local ML processing and can contain artifacts.
- Download support does not bypass private, paid, removed, or protected media.
