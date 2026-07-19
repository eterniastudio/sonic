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
| `state.test.ts` | Reducer hydration, client/native ID correlation, draft preservation, authoritative synchronization, stale-item eviction, selection fallback, pause/retry/reorder transitions, player lifecycle, and presentation actions |
| `app-smoke.test.tsx` | Semantic application shell, keyboard/user source intake, review transition, and an axe-core accessibility scan (except color contrast, which jsdom cannot compute) |

`npm run test:coverage` enforces aggregate V8 coverage thresholds of 80% for
lines, functions, and statements, and 70% for branches across the reducer,
normalizers, filename policy, and formatting helpers. CI retains the HTML/LCOV
coverage artifact for 14 days.

## Required local checks

```powershell
npm ci
npm run test:coverage
npm run check
npm run build
```

The Windows CI and tagged-release workflows run the frontend suite before the
production build. They then keep the existing Rust formatting, Clippy, unit
tests, dependency audits, SBOM/license generation, sidecar verification, NSIS
installer build, and install/start/uninstall smoke checks. Native WebView drag
and file-dialog behavior still requires the Windows installer smoke/manual QA;
the jsdom suite deliberately does not claim to emulate Windows or WebView2.
