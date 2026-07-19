# Sonic v0.2 verification

The frontend suite is deterministic and does not contact YouTube. Browser-preview
tests use the same typed bridge consumed by the application, backed by local
fixtures and `localStorage`.

## Automated frontend coverage

| Test file | Contract protected |
| --- | --- |
| `filename.test.ts` | Template rendering, optional tokens, deterministic date substitution, Windows reserved names, traversal punctuation, control characters, trailing dots, and the filename length limit |
| `format.test.ts` | Duration, byte/speed, ETA, path, and queue-status presentation helpers |
| `contracts.test.ts` | Checked-in v0.2 JSON wire fixtures for source inspection, queue snapshots, bootstrap data, tagged source variants, finite metadata, native ordering, presets, diagnostics, and recent library entries |
| `native-hydration.test.ts` | Persisted `JobDetail` recovery across restart, including inspection/metadata/export requests, per-job failure isolation, and the four-request concurrency ceiling |
| `preview-queue.test.ts` | Browser adapter pause, complete reorder, persistence, retry error reset, cancellation isolation, local-file inspection, filename preview, and waveform boundaries |
| `queue-actions.test.ts` | Native job lifecycle mapping, queued-job cancellation, terminal removal, Library-backed history retention, and queue-to-Library identity correlation |
| `state.test.ts` | Reducer hydration, client/native ID correlation, draft preservation, authoritative synchronization, stale-item eviction, selection fallback, pause/retry/reorder transitions, player lifecycle, and presentation actions |
| `app-smoke.test.tsx` | Semantic application shell, keyboard/user source intake, review transition, and an axe-core accessibility scan (except color contrast, which jsdom cannot compute) |

`npm run test:coverage` enforces aggregate V8 coverage thresholds of 80% for
lines, functions, and statements, and 70% for branches across the reducer,
normalizers, filename policy, and formatting helpers. CI retains the HTML/LCOV
coverage artifact for 14 days.

## Required local checks

```powershell
npm ci
npm run installer:smoke:verify
npm run test:coverage
npm run check
npm run build
npm run bundle:budget
```

The Windows CI and tagged-release workflows run the frontend suite before the
production build and enforce the bundle budget immediately afterward. They then
keep the existing Rust formatting, Clippy, unit tests, dependency audits,
SBOM/license generation, sidecar verification, NSIS installer build, and
install/start/uninstall smoke checks. Native WebView drag and file-dialog
behavior still requires the Windows installer smoke/manual QA; the jsdom suite
deliberately does not claim to emulate Windows or WebView2.

`npm run installer:smoke:verify` statically proves the clean-state preflight
and no-mutation mode precede the harness's first write, exercises Windows
command-line quoting for an NSIS `/D=` path containing spaces, and requires
fatal cleanup assertions for every owned resource class. The tagged-release
job then runs the real installer harness on a clean Windows runner.

## Production bundle evidence

`scripts/check-bundle-budget.mjs` recursively reads `dist`, totals each file's
raw byte length, and computes gzip byte length with Node's built-in zlib. It has
no package dependency. The baseline below was reproduced with `npm run build`
followed by `npm run bundle:budget`:

| Payload | Files | Measured raw | Raw limit | Measured gzip | Gzip limit |
| --- | ---: | ---: | ---: | ---: | ---: |
| JavaScript | 1 | 415,100 B | 440,000 B | 116,301 B | 125,000 B |
| CSS | 1 | 39,489 B | 42,000 B | 7,841 B | 8,500 B |
| Complete static output | 9 | 539,764 B | 570,000 B | 207,944 B | 220,000 B |

The complete-output limit covers HTML, SVG, and local font assets in addition
to JavaScript and CSS. A missing/empty `dist`, missing JavaScript or CSS output,
or any limit overage returns a non-zero status.

## Authorized live media-engine audit

On 2026-07-18, the packaged Python/yt-dlp path and verified Deno, FFmpeg, and
ffprobe binaries completed a live acquire, transcode, tag, and readback check
against NASA SVS video `53AhGVjmO94`. The
[official visualization page](https://svs.gsfc.nasa.gov/4573/) links that exact
YouTube item, and the [SVS usage policy](https://svs.gsfc.nasa.gov/help/)
identifies SVS material as public domain unless an item says otherwise.

The audit used Sonic's production yt-dlp isolation, retry, progress-template,
output-template, format, filename, size-limit, JavaScript-runtime, and FFmpeg
location arguments. It acquired one Opus/WebM audio source, converted it to
MP3, and confirmed title, artist, `TBPM`, and `TKEY` through ffprobe readback.
Both `SONIC_PROGRESS` and `SONIC_OUTPUT` protocol records were observed. The
isolated temporary workspace was deleted after verification.

Reproduce the check from a prepared Windows checkout with:

```powershell
npm run tools:fetch
npm run media:e2e
```

This live check is kept out of ordinary pull-request and release CI so those
gates remain deterministic and do not make an unsolicited third-party network
request. `scripts/test-media-engine-e2e.ps1` validates all pinned hashes before
execution, enforces a global timeout and size limits, rejects non-YouTube URLs,
and only cleans its exact randomized child of Windows Temp without following
reparse points.
