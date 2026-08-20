# Download Reliability and Audio Analysis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Sonic resilient to transient YouTube failures, enforce every advertised export preset, publish sidecars under `.json`, and automatically apply reliable audio-derived BPM estimates without overwriting manual metadata.

**Architecture:** Add focused native modules for retry classification and bounded tempo analysis, then integrate them at the existing acquisition and job boundaries. Keep publication atomic through the current journal, extend its path validation for the nested sidecar directory, and verify output contracts with ffprobe before publication. Preserve schema-v1 sidecar compatibility while emitting schema v2 with analysis provenance.

**Tech Stack:** Rust, Tauri 2, serde, rusqlite, bundled yt-dlp/Python/Deno, bundled FFmpeg/ffprobe, TypeScript 7, React 19, Vitest, PowerShell media E2E.

**Spec:** `docs/superpowers/specs/2026-08-20-download-reliability-and-audio-analysis-design.md`

## Global Constraints

- All analysis is local and deterministic for the same decoded samples and analyzer version.
- Retry waits and analysis are bounded and cancellation-aware.
- Permanent source errors and user cancellation fail immediately.
- Manual BPM edits outrank embedded, declared, and audio-derived values.
- Audio-derived BPM is auto-applied only when BPM is blank and confidence meets the fixed threshold.
- Audio remains directly in the chosen output directory; new sidecars live directly under its canonical `.json` child.
- Publication remains journaled, no-clobber, and recoverable.
- Existing adjacent schema-v1 sidecars remain readable and importable.
- No cookies, authentication bypass, playlist support, cloud analysis, waveform-derived key, or waveform-derived tuning.

---

### Task 1: Stage-aware media retry policy

**Files:**
- Create: `src-tauri/src/media_retry.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/acquisition.rs`
- Modify: `src-tauri/src/jobs.rs`
- Test: inline Rust tests in `src-tauri/src/media_retry.rs`, `src-tauri/src/acquisition.rs`, and `src-tauri/src/jobs.rs`

**Interfaces:**
- Produces: `RetryDecision`, `RetryPolicy`, `classify_media_failure(&str) -> RetryDecision`, `retry_delay(attempt: u32) -> Duration`, and `format_exhausted_error(stage: &str, attempts: u32, message: &str) -> String`.
- Consumes: existing `AppError`, `limited_text`, yt-dlp command construction, and cancellation checks.

- [ ] **Step 1: Write retry-classifier tests**

Add table-driven tests proving that timeouts, connection resets, HTTP 429, HTTP 5xx, incomplete reads, and empty/malformed metadata are transient; private, removed, unavailable, login-required, age-restricted, live, unsupported URL, size-limit, duration-limit, and cancellation messages are permanent. Assert delays of 500 ms, 1 s, and 2 s and a maximum of four outer attempts.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `cargo test --manifest-path src-tauri/Cargo.toml media_retry -- --nocapture`

Expected: compilation fails because `media_retry` and its public interfaces do not exist.

- [ ] **Step 3: Implement the pure retry policy**

Create `media_retry.rs` with case-insensitive bounded message matching, `RetryDecision::{Retryable, Permanent}`, `RetryPolicy { max_attempts: 4 }`, capped exponential delays, and credential/signed-URL redaction before final error formatting. Do not retry unknown validation errors by default.

- [ ] **Step 4: Add deterministic inspection-attempt tests**

Extract YouTube JSON parsing into `parse_youtube_inspection(bytes, settings)` and add a small attempt-runner abstraction whose test closure returns two transient errors followed by valid JSON. Assert one logical inspection succeeds on attempt three, while a private-video error invokes the closure once.

- [ ] **Step 5: Integrate inspection retries**

Wrap `inspect_youtube` command execution and JSON parsing with the policy. Preserve validation before process execution. Sleep only after a retryable failure, use bounded diagnostics, and report `Inspecting source (attempt N of 4)` through the existing UI inspection state where available.

- [ ] **Step 6: Add acquisition retry tests**

Extract the per-attempt yt-dlp invocation from `acquire_youtube`. Test that retryable process errors retain the isolated workspace, permanent failures stop immediately, and cancellation before or during backoff returns `AppError::Cancelled` without another process spawn.

- [ ] **Step 7: Integrate acquisition retries**

Run up to four outer yt-dlp attempts around the current internally retried download. Before each retry validate workspace entries as non-reparse regular files or known yt-dlp partial files and update job progress with the attempt number. Reuse the same workspace to allow safe `.part` continuation.

- [ ] **Step 8: Run retry and native regression tests**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml media_retry -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml acquisition -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml jobs -- --nocapture
```

Expected: all focused tests pass.

- [ ] **Step 9: Commit the retry unit**

Run:

```powershell
git add src-tauri/src/media_retry.rs src-tauri/src/lib.rs src-tauri/src/acquisition.rs src-tauri/src/jobs.rs
git commit -m "fix: retry transient media failures automatically"
```

---

### Task 2: Enforce every export preset and expand the real media test

**Files:**
- Modify: `src-tauri/src/presets.rs`
- Modify: `src-tauri/src/jobs.rs`
- Modify: `scripts/test-media-engine-e2e.ps1`
- Test: inline Rust tests in `src-tauri/src/presets.rs`
- Test: `scripts/test-media-engine-e2e.ps1`

**Interfaces:**
- Produces: `validate_output_contract(preset: ExportPresetId, audio: &AudioProperties) -> AppResult<()>`.
- Consumes: existing `ffmpeg_transcode_args`, `probe_audio`, `AudioProperties`, and pinned media executables.

- [ ] **Step 1: Write output-contract tests**

Add one passing and one failing `AudioProperties` fixture for MP3 V0, MP3 320, M4A AAC, WAV 44.1/24, WAV 48/24, FLAC, and Opus. Include container aliases returned by ffprobe (`mov,mp4,m4a,3gp,3g2,mj2` and `ogg`) and require exact WAV codec/sample-rate/bit-depth values.

- [ ] **Step 2: Run the preset tests and verify RED**

Run: `cargo test --manifest-path src-tauri/Cargo.toml presets::tests -- --nocapture`

Expected: compilation fails because `validate_output_contract` does not exist.

- [ ] **Step 3: Implement preset contract validation**

Implement the pure validator in `presets.rs`. Error text must name the selected preset, expected properties, and bounded observed properties. `Original` validates only that a readable audio stream exists because its container is source-dependent.

- [ ] **Step 4: Wire validation before publication**

In `jobs.rs`, call `validate_output_contract` immediately after probing `staged_audio` and before hashing, tag verification, sidecar creation, or publication.

- [ ] **Step 5: Correct Windows platform detection in media E2E**

Replace `$env:OS -cne 'Windows_NT'` with `[Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT`. Keep exact temp-parent and reparse-point safety checks.

- [ ] **Step 6: Add a synthetic all-preset E2E matrix**

Within the random E2E workspace, generate an eight-second source using FFmpeg lavfi, run the production codec/tag arguments for all seven transcoding presets, probe every result, and assert container, codec, sample rate, bit depth, positive bounded duration, nonzero bounded size, and final `progress=end`. Keep the authorized NASA acquisition as a separate section so a network failure is distinguishable from a codec regression.

- [ ] **Step 7: Run focused and real media verification**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml presets::tests -- --nocapture
npm run media:e2e
```

Expected: every preset passes the synthetic contract matrix and the authorized source completes inspection/acquisition.

- [ ] **Step 8: Commit the export-contract unit**

Run:

```powershell
git add src-tauri/src/presets.rs src-tauri/src/jobs.rs scripts/test-media-engine-e2e.ps1
git commit -m "fix: verify every audio export preset"
```

---

### Task 3: Publish sidecars in the `.json` child directory

**Files:**
- Modify: `src-tauri/src/filesystem.rs`
- Modify: `src-tauri/src/jobs.rs`
- Modify: `src-tauri/src/storage.rs`
- Modify: `src-tauri/src/commands.rs`
- Modify: `docs/sidecar-schema.md`
- Modify: `README.md`
- Test: inline Rust tests in `src-tauri/src/filesystem.rs`, `src-tauri/src/jobs.rs`, and `src-tauri/src/storage.rs`

**Interfaces:**
- Produces: `canonical_sidecar_directory(output: &Path) -> AppResult<PathBuf>` and `audio_path_for_sidecar(sidecar: &Path) -> AppResult<PathBuf>`.
- Consumes: `publish_pair`, publication journals, recovery, sidecar import, deletion, and canonical path/reparse checks.

- [ ] **Step 1: Write nested publication tests**

Update `paired_publication_never_clobbers` to assert audio at `<output>/Beat (2).mp3` and sidecar at `<output>/.json/Beat (2).mp3.sonic.json`. Add tests for automatic `.json` creation, collisions in either destination, a hostile pre-existing `.json` file, and a `.json` reparse point on Windows.

- [ ] **Step 2: Run filesystem tests and verify RED**

Run: `cargo test --manifest-path src-tauri/Cargo.toml filesystem::tests -- --nocapture`

Expected: nested-path assertions fail because publication still writes adjacent sidecars.

- [ ] **Step 3: Implement canonical `.json` directory handling**

Create the child with `create_dir` only when absent, canonicalize it, require its parent to equal the selected canonical output directory, require a normal non-reparse directory, and return a conflict if a non-directory occupies `.json`.

- [ ] **Step 4: Move paired publication to nested sidecars**

Name sidecars `<audio filename>.sonic.json`, including the audio extension. Check collision of audio and sidecar together, journal both final paths before moving, roll audio back on sidecar failure, and validate each published file against its expected canonical parent.

- [ ] **Step 5: Write recovery tests for both layouts**

Add interrupted-publication fixtures for new nested sidecars and legacy adjacent sidecars. Assert complete pairs recover, verified partial pairs roll back safely, and paths outside the exact output/`.json` parents are ignored.

- [ ] **Step 6: Update recovery path validation**

Teach `recover_interrupted_jobs` to accept audio directly under output and sidecars either under output (legacy journal) or under canonical output `.json` (new journal). Preserve exact hashes and job IDs as recovery requirements.

- [ ] **Step 7: Write sidecar import tests for both layouts**

Keep the adjacent import fixture and add `.json/import.wav.sonic.json` pointing to `../import.wav`. Assert recursive and direct `.json` scans find the nested sidecar, reconstruct the audio path, verify its SHA-256, and insert one library record.

- [ ] **Step 8: Implement layout-aware audio reconstruction**

Add `audio_path_for_sidecar`: if the immediate parent is named `.json`, resolve audio in its parent; otherwise resolve beside the sidecar. Strip only the terminal `.sonic.json`, preserve the audio extension, and reject malformed names and escaped paths.

- [ ] **Step 9: Verify deletion and update docs**

Add command-level deletion coverage using a nested stored sidecar path. Update README and sidecar documentation with the new tree and legacy compatibility.

- [ ] **Step 10: Run sidecar regression tests**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml filesystem -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml storage -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml jobs -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml commands -- --nocapture
```

Expected: nested and legacy layouts pass publication, recovery, scan, import, and deletion tests.

- [ ] **Step 11: Commit the sidecar-layout unit**

Run:

```powershell
git add src-tauri/src/filesystem.rs src-tauri/src/jobs.rs src-tauri/src/storage.rs src-tauri/src/commands.rs docs/sidecar-schema.md README.md
git commit -m "feat: organize metadata sidecars under json folder"
```

---

### Task 4: Build deterministic bounded tempo analysis

**Files:**
- Create: `src-tauri/src/audio_analysis.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/models.rs`
- Modify: `src/domain/types.ts`
- Modify: `src/services/normalizers.ts`
- Test: inline Rust tests in `src-tauri/src/audio_analysis.rs`
- Test: `tests/contracts.test.ts`

**Interfaces:**
- Produces: `AudioAnalysis`, `TempoEstimate`, `analyze_tempo_samples(samples: &[f32], sample_rate: u32) -> Option<TempoEstimate>`, and `analyze_audio(app: &AppHandle, path: &Path) -> AppResult<AudioAnalysis>`.
- Consumes: bundled FFmpeg path/configuration, `AudioProperties`, normalizer conventions, and finite-number validation.

- [ ] **Step 1: Define wire types and failing contract tests**

Add Rust/TypeScript types containing `sourceSha256`, `analyzerVersion`, `analyzedDurationMs`, `bpm { primary, alternates, confidence }`, and warnings. Add fixture normalization assertions that reject non-finite/out-of-range values and preserve a valid analysis record.

- [ ] **Step 2: Write pure analyzer tests**

Generate in-memory click envelopes at 72, 90, 120, 128, 144, and 180 BPM with deterministic low-amplitude noise. Assert primary BPM within 1.0 BPM or a documented half/double candidate, confidence at or above the auto-accept threshold for stable clicks, alternate candidates in 20–400 BPM, and no result for silence, non-finite-only input, or less than eight seconds.

- [ ] **Step 3: Run analyzer and contract tests and verify RED**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml audio_analysis -- --nocapture
npx vitest run tests/contracts.test.ts
```

Expected: missing module/types cause compilation or assertion failures.

- [ ] **Step 4: Implement the pure tempo estimator**

Sanitize finite samples, create 10 ms RMS frames, log-compress energy, retain positive spectral-energy changes as the onset envelope, normalize it, and score autocorrelation lags corresponding to 60–200 BPM. Compare primary, half-time, and double-time candidates; derive confidence from normalized periodic strength, winning-peak separation, and analyzed duration. Cap input at three minutes and 4 kHz decoded mono PCM.

- [ ] **Step 5: Implement bounded FFmpeg decoding**

Run bundled FFmpeg with `-nostdin -hide_banner -v error -t 180 -map 0:a:0 -vn -ac 1 -ar 4000 -f f32le pipe:1`. Cap stdout at 3.2 MiB and stderr at the existing diagnostic limit, reject nonzero exits and malformed byte counts, and never treat analysis failure as an export failure.

- [ ] **Step 6: Complete normalizers and run focused tests**

Normalize only finite BPM 20–400, confidence 0–1, bounded alternates/warnings, a positive analyzed duration, and a supported analyzer version. Run the two focused commands from Step 3 and expect all tests to pass.

- [ ] **Step 7: Commit the analyzer unit**

Run:

```powershell
git add src-tauri/src/audio_analysis.rs src-tauri/src/lib.rs src-tauri/src/models.rs src/domain/types.ts src/services/normalizers.ts tests/contracts.test.ts
git commit -m "feat: add local audio tempo analysis"
```

---

### Task 5: Auto-apply reliable BPM without overwriting producers

**Files:**
- Modify: `src-tauri/src/acquisition.rs`
- Modify: `src-tauri/src/jobs.rs`
- Modify: `src-tauri/src/storage.rs`
- Modify: `src-tauri/src/models.rs`
- Modify: `src-tauri/src/sidecar.rs`
- Modify: `src/app/SonicProvider.tsx`
- Modify: `src/features/inspector/SourceInspector.tsx`
- Modify: `src/domain/types.ts`
- Modify: `src/services/normalizers.ts`
- Modify: `docs/metadata-claims-boundary.md`
- Modify: `docs/adr/0003-audio-analysis-boundary.md`
- Modify: `docs/sidecar-schema.md`
- Test: inline Rust tests in the modified native modules
- Test: `tests/state.test.ts`
- Test: `tests/app-smoke.test.tsx`

**Interfaces:**
- Produces: `MetadataOrigin::{Manual, Embedded, Declared, AudioAnalysis}`, `apply_detected_bpm(job_id, expected_revision, analysis) -> AppResult<JobDetail>`, and schema-v2 sidecar analysis/origin fields.
- Consumes: Task 4 `analyze_audio`, existing inspection merge rules, job revisions, sidecar reader/writer, and UI metadata draft lifecycle.

- [ ] **Step 1: Write precedence and revision tests**

Test these cases: manual BPM survives all inputs; embedded BPM beats declared and detected; declared BPM beats detected; high-confidence detected BPM fills blank; low-confidence detected BPM leaves blank; a stale expected revision cannot apply analysis; retry/hydration preserves manual BPM.

- [ ] **Step 2: Run precedence tests and verify RED**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml metadata_origin -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml apply_detected_bpm -- --nocapture
```

Expected: missing origin and atomic apply interfaces fail to compile.

- [ ] **Step 3: Add origin-aware metadata selection**

Store BPM origin alongside the final value. Existing user-submitted nonblank queue drafts enter as `Manual`; embedded and declared inspection matches retain their respective origins; audio analysis can fill only `None` at confidence `>= 0.70`. Never replace a nonblank value.

- [ ] **Step 4: Analyze local files during inspection**

After ffprobe and source hashing, run bounded analysis. Attach the distinct analysis record to `SourceInspection`, apply it only when embedded/declared BPM is absent and confidence qualifies, and add a warning rather than failing inspection when decoding or estimation fails.

- [ ] **Step 5: Analyze acquired remote audio before naming/tagging**

After yt-dlp acquisition and input validation, run analysis. If qualified and BPM remains blank, atomically update persisted request metadata using job ID and revision, then use the returned detail as the effective metadata for FFmpeg tags, filename rendering, sidecar creation, and library insertion. If analysis fails or confidence is low, continue export normally.

- [ ] **Step 6: Write schema compatibility tests**

Assert the sidecar writer emits schema v2 with analysis and field origin, the reader accepts v1 without analysis, the reader accepts v2, and unknown future versions fail. Ensure local source privacy rules still hold.

- [ ] **Step 7: Persist completed analysis**

Insert the result into existing `audio_analysis` after the library item is created, within the same logical completion path. Store source hash, analyzer version, analyzed time, primary/alternate BPM, and confidence. Make repeated completion idempotent by item ID.

- [ ] **Step 8: Add UI origin and auto-fill tests**

In state and smoke tests, assert detected BPM is visibly labeled `Detected from audio`, declared/tagged values keep their labels, confidence is shown, a producer edit changes origin to manual, and later native updates cannot replace it.

- [ ] **Step 9: Implement UI presentation and update claims**

Render a compact detected-BPM evidence row in `SourceInspector`. Update the claims boundary and ADR status to record the user-approved auto-fill exception while keeping manual values authoritative. Update sidecar docs for schema v2.

- [ ] **Step 10: Run native and frontend analysis tests**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml acquisition -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml storage -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml sidecar -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml jobs -- --nocapture
npx vitest run tests/state.test.ts tests/app-smoke.test.tsx tests/contracts.test.ts
```

Expected: all precedence, persistence, compatibility, and UI tests pass.

- [ ] **Step 11: Commit the integration unit**

Run:

```powershell
git add src-tauri/src/acquisition.rs src-tauri/src/jobs.rs src-tauri/src/storage.rs src-tauri/src/models.rs src-tauri/src/sidecar.rs src/app/SonicProvider.tsx src/features/inspector/SourceInspector.tsx src/domain/types.ts src/services/normalizers.ts docs/metadata-claims-boundary.md docs/adr/0003-audio-analysis-boundary.md docs/sidecar-schema.md tests/state.test.ts tests/app-smoke.test.tsx
git commit -m "feat: auto-apply reliable detected tempo"
```

---

### Task 6: Improve stage-specific download errors and complete regression verification

**Files:**
- Modify: `src-tauri/src/error.rs`
- Modify: `src-tauri/src/jobs.rs`
- Modify: `src/app/SonicProvider.tsx`
- Modify: `src/features/queue/QueueList.tsx`
- Modify: `README.md`
- Modify: `tests/VERIFICATION.md`
- Test: inline Rust tests in `src-tauri/src/error.rs` and `src-tauri/src/jobs.rs`
- Test: `tests/app-smoke.test.tsx`

**Interfaces:**
- Produces: stable stage codes `inspect`, `acquire`, `analyze`, `transcode`, `validate`, and `publish` with retry attempt details.
- Consumes: Tasks 1–5 diagnostics and existing `errorCode`/`error` frontend fields.

- [ ] **Step 1: Write stage-error tests**

Assert that an exhausted inspection failure says Sonic tried four times, a permanent source failure omits retry advice, a conversion mismatch names the selected preset, and a publication conflict points to the output/`.json` destinations without exposing workspace paths or signed media URLs.

- [ ] **Step 2: Run focused error tests and verify RED**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml error -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml jobs::tests -- --nocapture
```

Expected: assertions fail against generic process errors.

- [ ] **Step 3: Add stable stage context and sanitized messages**

Wrap errors at each job boundary with the stage code, bounded user-facing message, attempt count where relevant, and one actionable sentence. Preserve internal error categories for retry classification and UI behavior.

- [ ] **Step 4: Update UI error rendering**

Show concise stage labels and the sanitized message, keep one-click retry only for retryable or interrupted jobs, and retain the existing producer metadata draft when retrying.

- [ ] **Step 5: Run the complete verification suite**

Run:

```powershell
npm run check
npm test
npm run test:coverage
npm run build
npm run bundle:budget
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml --all-features
npm run media:e2e
```

Expected: all commands exit 0; coverage remains above repository thresholds; every preset and the authorized acquisition test pass.

- [ ] **Step 6: Inspect the final diff and generated-file hygiene**

Run:

```powershell
git status --short
git diff --check
git diff --stat HEAD
git ls-files --others --exclude-standard
```

Expected: no generated binaries, build outputs, caches, temporary media, SQLite files, or diagnostics are tracked; only intentional source, test, and documentation changes remain.

- [ ] **Step 7: Update verification documentation and commit**

Record exact passing counts and the all-preset/live-media checks in `tests/VERIFICATION.md`, update README behavior, then run:

```powershell
git add src-tauri/src/error.rs src-tauri/src/jobs.rs src/app/SonicProvider.tsx src/features/queue/QueueList.tsx README.md tests/VERIFICATION.md tests/app-smoke.test.tsx
git commit -m "fix: surface actionable media pipeline errors"
```
