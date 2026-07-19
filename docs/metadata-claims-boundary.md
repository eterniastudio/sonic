# Metadata claims boundary

This document defines what Sonic v0.2 does today and the product rules that
apply if audio-derived estimates are added later. It is a claims boundary, not
a promise that waveform analysis exists in the current release.

## Sonic v0.2

Sonic v0.2 uses four distinct metadata concepts:

| Concept | Meaning |
| --- | --- |
| Declared | BPM, key, or tuning written in a YouTube title or description, or in a local filename. |
| Embedded | Values stored in supported audio-container tags and read through ffprobe. |
| Suggested | Sonic's rule-based parsing, ranking, and merge of declared text and embedded tags. |
| Final | The producer-editable values used for naming, tagging, sidecars, and export. |

`MusicMetadata.confidence` is the strength of a deterministic text or tag
pattern match. It is not model confidence, acoustic confidence, or evidence
that the value agrees with the waveform.

Sonic reads technical audio properties such as codec, sample rate, channel
count, bit depth, duration, and file size. The preview transport also renders
bounded amplitude peaks for its waveform display. Neither operation derives
BPM, musical key, or tuning from the audio signal.

Before a Session item enters the export queue, the inspector shows the source
evidence and editable final fields. The producer confirms or corrects those
fields. Sidecar schema version 1 stores the final values and the available
source-text or tag evidence; that evidence is not proof of a manually edited
final value.

## Future audio-derived estimates

If Sonic later analyzes the audio signal, the results must remain a separate
`Detected` or `Audio analysis` layer. They must not be merged silently into
`Suggested`, copied into `Final` when analysis completes, or presented as
ground truth.

Any future implementation must:

- label tempo, key, and tuning as estimates;
- report confidence separately for each estimate;
- show the analyzed duration, engine version, warnings, and failure state;
- keep declared text, embedded tags, and audio-derived evidence distinguishable;
- require an explicit producer action to apply each estimate to a final field;
- preserve manual edits when late or repeated analysis completes; and
- record the origin of every applied final field in any new sidecar schema.

The invariant is:

```text
declared text ─┐
               ├─ parsed suggestion ─┐
embedded tags ─┘                     │
                                     ├─ explicit producer choice ── final metadata
audio estimate ──────────────────────┘
```

Marketing, release notes, screenshots, and interface copy must reserve terms
such as "audio-derived," "detected," and "audio analysis" for this future
boundary until a shipped build performs the work described.
