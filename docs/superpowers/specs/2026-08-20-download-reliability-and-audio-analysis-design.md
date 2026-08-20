# Download reliability and audio analysis design

**Date:** 2026-08-20  
**Status:** Approved  
**Scope:** Source inspection, acquisition, export validation, sidecar publication, and BPM analysis

## Goals

Sonic should complete ordinary authorized YouTube and local-file exports without requiring repeated manual retries, make every advertised export preset work through the bundled media engine, keep JSON sidecars out of the audio folder, and derive a useful tempo estimate from the audio signal when source text and tags do not provide a trustworthy BPM.

The implementation remains local-first, bounded, cancellable, and no-clobber. A failed export must never be reported as completed, and automatic recovery must never overwrite a producer's manual metadata edit.

## Decisions

### Stage-aware retries

Sonic will use one shared retry policy for YouTube inspection and acquisition. Each operation receives a small number of outer attempts with exponential backoff. The retry classifier will retry transport timeouts, connection resets, temporary HTTP/server failures, throttling, incomplete reads, and malformed or empty transient tool output. It will not retry permanent failures such as an invalid URL, private or removed media, an unsupported live source, authentication requirements, configured size or duration limits, or cancellation.

yt-dlp's internal fragment and file retries remain enabled. Outer acquisition retries reuse only the exact isolated job workspace so resumable `.part` data stays bounded to the current job. Before retrying, Sonic validates that every workspace entry remains a normal file owned by that workspace. A final error includes the failed stage, the attempt count, a bounded media-tool diagnostic, and a practical next action.

### Export preset correctness

All fixed presets will be treated as output contracts:

| Preset | Required output |
| --- | --- |
| MP3 V0 | MP3 container, `mp3` codec |
| MP3 320 | MP3 container, `mp3` codec |
| M4A AAC 256 | M4A/MP4 container, `aac` codec |
| WAV 44.1/24 | WAV container, `pcm_s24le`, 44,100 Hz, 24-bit |
| WAV 48/24 | WAV container, `pcm_s24le`, 48,000 Hz, 24-bit |
| FLAC | FLAC container and codec |
| Opus 192 | Ogg/Opus container, `opus` codec |

After FFmpeg exits successfully, ffprobe must confirm the selected contract before hashing, sidecar creation, or publication. Errors will identify the preset and the observed mismatch. The media-engine E2E test will generate a bounded synthetic input and run every preset through the actual pinned FFmpeg and ffprobe executables. A separate authorized live-source test will cover inspection and acquisition. Platform detection in the existing PowerShell test will use runtime APIs instead of relying on the optional `OS` environment variable.

### Sidecar directory

For output directory `D:\Exports`, Sonic will publish:

```text
D:\Exports\Track.wav
D:\Exports\.json\Track.wav.sonic.json
```

The `.json` directory is created automatically as a normal child directory of the selected canonical output directory. Publication still uses a journal and no-replace moves. Filename collision selection checks both the audio destination and the nested sidecar destination as one pair.

Recovery validates that audio remains directly under the selected output directory and that the sidecar remains directly under its canonical `.json` child. Sidecar scanning and import accept both the new nested layout and the legacy adjacent layout. For nested sidecars, the audio filename is reconstructed in the parent of `.json`; for legacy sidecars it is reconstructed beside the JSON file. Existing database paths and old sidecars require no migration.

### Audio-derived BPM

Sonic will add a local, bounded tempo analyzer rather than sending audio to an external service. FFmpeg will decode a capped analysis window to mono floating-point PCM at a low analysis sample rate. Rust will calculate a novelty/onset envelope, correlate plausible beat periods, compare half-time and double-time candidates, and return:

- primary BPM;
- alternate half/double-time BPM values;
- confidence from peak separation, periodic consistency, and analyzed duration;
- analyzed duration and analyzer version;
- warnings when rhythm is weak, changing, or ambiguous.

The analyzer must be deterministic for the same decoded samples and analyzer version. Tests will cover synthetic click tracks at representative tempos, half-time ambiguity, silence, too-short audio, non-finite samples, and bounded resource use. Low-confidence or failed analysis is non-fatal and leaves BPM blank unless declared or embedded metadata exists.

Automatic metadata precedence is:

1. an explicit producer edit;
2. a trustworthy embedded tag;
3. a trustworthy declared title, description, or filename match;
4. a high-confidence audio-derived estimate;
5. blank.

This deliberately updates the older proposed ADR rule that analysis can never populate final metadata. The producer's explicit request is to auto-accept recommendations. Sonic will therefore auto-fill only when no stronger value exists and confidence meets the fixed acceptance threshold. Once the producer edits BPM, later inspections, retries, queue hydration, or analysis cannot replace it.

Source inspection will expose audio analysis as a distinct evidence layer so the UI can label an automatically applied value as detected rather than declared. For remote sources, analysis runs after acquisition, before export naming and tagging. The job request's final metadata is updated atomically only if BPM is still blank and has not been revised by the producer. Local files can be analyzed during inspection without copying the source.

### Other metadata and technical checks

Declared and embedded BPM, key, Camelot, detune, and tuning parsing remain deterministic and retain their evidence. This change does not claim waveform-derived musical key or tuning accuracy; those require separate validated analyzers. Technical audio properties, tag readback, output hashing, duration bounds, disk-space checks, cancellation, recovery, and safe deletion remain required stages and gain regression tests where the new sidecar layout touches them.

## Data and interface changes

`SourceInspection` gains an optional audio-analysis record. Queue jobs retain the existing final metadata fields and gain enough origin/revision information to distinguish manual values from automatic ones. Completed library items persist the analysis result in the existing `audio_analysis` table keyed by output item and source hash. Sidecar schema advances compatibly to include the analysis record and final-field origins; the reader continues to accept schema version 1.

The UI shows retry progress during inspection and acquisition, distinguishes detected BPM from declared or tagged BPM, and presents stage-specific terminal errors. No new user setting is required for the requested automatic behavior.

## Error handling and safety

- Retry waits are cancellable and bounded.
- Diagnostics are length-limited and never include cookies, credentials, full inherited environments, or temporary signed media URLs.
- Permanent errors fail fast.
- Tempo-analysis failure never destroys an otherwise valid download.
- Output publication remains no-clobber and recoverable across interruption.
- `.json` creation rejects symlinks/reparse points and any path that escapes the chosen output folder.
- Older adjacent sidecars remain readable, importable, revealable, and deletable.

## Verification

The change is complete only when:

1. retry-classification tests prove transient/permanent/cancelled behavior;
2. deterministic process fixtures prove success after transient inspection and acquisition failures;
3. all seven transcoding presets pass real pinned FFmpeg/ffprobe contract checks;
4. publication, collision, recovery, import, and deletion tests pass for nested and legacy sidecars;
5. synthetic tempo fixtures meet defined tolerance and confidence bounds;
6. manual BPM edits survive late analysis, retry, and hydration;
7. TypeScript checks, frontend tests, Rust tests, formatting, clippy, production build, and the corrected media E2E pass.

## Out of scope

This change does not bypass protected/private media, add cookies or account authentication, download playlists, analyze musical key or tuning from the waveform, or introduce cloud analysis. Those require separate product and security decisions.
