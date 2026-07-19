# Changelog

All notable Sonic changes are recorded here. Sonic follows semantic versioning
while it is pre-1.0; minor releases may still introduce database or workflow
changes that require migration notes.

## [Unreleased]

- No unreleased changes yet.

## [0.2.0] - 2026-07-18

### Added

- Multi-source producer Session with batched URL intake and local file import.
- Drag-and-drop support for WAV, MP3, M4A, FLAC, Opus, OGG, and WebM audio.
- Persistent SQLite queue with pause/resume, reordering, one-to-three worker
  concurrency, revision-guarded edits, cancellation, retry, and crash recovery.
- Eight fixed export recipes: Original, MP3 V0, MP3 320, AAC 256, two 24-bit
  WAV targets, FLAC, and Opus 192.
- Declared/embedded/suggested/final metadata comparison, evidence display,
  alternate tempo selection, and half-time/double-time correction.
- Producer-style BPM, key, and master-pitch parsing, including bracketed
  descriptions and cent-detuned beats.
- Embedded tag writing, readback status, output hashing, and versioned private
  `.sonic.json` metadata sidecars.
- Rust-authoritative filename templates with producer tokens, previews,
  Windows sanitization, and no-clobber collision handling.
- Optional local Beat Library with search, filters, missing-file detection,
  reveal, re-export, preview, history removal, and verified disk deletion.
- Bounded local preview cache, waveform transport, looping, seeking, and tap
  tempo.
- Settings and redacted diagnostics for engine, database, limits, recovery,
  and local workspace defaults.
- Pinned yt-dlp, CPython, Deno, FFmpeg, and ffprobe artifact manifest with a
  verified first-run media-engine installer.
- License notices, generated dependency reports, SBOMs, release checksums,
  provenance attestations, and clean-runner installer smoke testing.
- Browser-preview bridge for deterministic design and interaction QA without
  native filesystem or process access.
- Frontend reducer, filename, formatter, IPC-contract, queue interaction,
  semantic smoke, axe accessibility, and coverage tests.

### Changed

- Rebuilt the interface as a matte graphite/red producer workstation with
  Session, Library, and Settings navigation plus a persistent transport.
- Split the original frontend and Rust monoliths into domain-focused modules.
- Replaced single-job transient execution with isolated, persistent native job
  workers and paired publication.
- Adopted `studio.eternia.sonic` and Eternia Studios release branding.
- Corrected MP3 320 kbps behavior and hardened sidecar execution.
- Updated all application, package, installer, and release sources to 0.2.0.

### Security and reliability

- Revalidates local source fingerprints immediately before export.
- Keeps user-controlled values out of shell parsing and arbitrary FFmpeg
  arguments.
- Rejects unsafe local files, reparse points, raw device paths, unknown
  filename tokens, and changed Library files during destructive actions.
- Uses same-volume per-job staging and no-replace audio/sidecar publication.
- Redacts source URLs and personal paths from exported diagnostics.
- Bounds preview duration, cache count, cache bytes, and waveform output.
- Enforces reviewed raw and gzip frontend bundle ceilings in CI and release
  builds.
- Adds a hash-verified, bounded live media-engine E2E check using an authorized
  NASA SVS source and ffprobe tag readback.
- Refuses installer smoke testing before mutation when any Sonic install,
  process, startup entry, shortcut, application data, or stale smoke root is
  already present, then verifies owned-resource cleanup after the run.

[Unreleased]: https://github.com/eterniastudio/sonic/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/eterniastudio/sonic/compare/v0.1.3...v0.2.0
