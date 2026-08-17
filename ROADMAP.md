# Sonic v0.3 Roadmap — Library Intelligence and Portability

This document outlines the development roadmap for Sonic v0.3.x through v0.5.0, focusing on transforming Sonic from a basic downloader into a comprehensive producer archive management tool.

## Vision

Make Sonic capable of managing a producer's entire long-term beat archive with intelligent organization, portable records, and reliable recovery capabilities.

---

## v0.3.0 — Library Foundation

**Target:** Q1 2026

### Core Deliverables

1. **Schema Migration Framework**
   - Explicit `migrate_v1_to_v2()`, `migrate_v2_to_v3()` functions
   - Transactional migrations with rollback support
   - Automatic database backup before every schema upgrade
   - Startup integrity checks after migration
   - Migration tests using actual prior-version fixture databases
   - Restore command in Settings UI

2. **SQL-Backed Library Search & Sorting**
   - Move filtering and sorting from in-memory to SQLite
   - Full-text search index (FTS5) for title, artist, filename, key, Camelot, notes, tags
   - Keyset pagination using `created_at_ms + id` instead of offset-based
   - Native `LibrarySort` enum with proper SQL ordering
   - `total_count` and facet counts in `LibraryPage` response
   - Background reconciliation for missing-file state

3. **Library Roots & Relative Paths**
   - Root-based path model:
     ```
     root_id: "main-beat-drive"
     root_path: "D:\Beats"
     relative_audio_path: "2026\Producer\Beat.wav"
     relative_sidecar_path: "2026\Producer\Beat.sonic.json"
     ```
   - Relink Library root when drive letters change
   - Per-item relinking workflow
   - Folder search for missing files using sidecar IDs, SHA-256, filename, audio properties
   - Root health indicators in Settings
   - Safe handling for temporarily offline removable drives

4. **Sidecar Import & Library Reconstruction**
   - Import Sonic folder: scan user-selected directory for audio/sidecar pairs
   - Validate sidecar version, IDs, audio hash, file safety
   - Rebuild missing SQLite records from sidecars
   - Detect and report corrupt, orphaned, duplicate, unsupported sidecars
   - Export audit report without modifying files
   - Non-destructive upgrade of older sidecars
   - User actions: "Add to Library," "Ignore," "Repair record"

5. **Multi-Select & Bulk Actions**
   - Select multiple library items
   - Bulk metadata corrections
   - Bulk preset/output changes
   - Bulk re-export
   - Safe bulk removal

### Success Criteria

- [ ] Library queries return correct results with 100k+ items
- [ ] Search responds in <100ms for typical queries
- [ ] Database migration from v1 to v2 tested with fixture databases
- [ ] Sidecar import successfully reconstructs library from folder scan
- [ ] Drive letter change can be recovered via root relink

---

## v0.3.1 — Library Organization

**Target:** Q2 2026

### Core Deliverables

1. **Tags & Collections**
   - Tags: dark, guitar, ambient, rage, sample-ready
   - Crates/collections for grouping
   - Favorites and star ratings (1-5)
   - Producer notes (free text)
   - Color labels
   - Custom status: unreviewed, candidate, used, licensed, archived

2. **Saved Searches & Smart Collections**
   - Save frequently-used filter combinations
   - Smart collections with dynamic rules:
     - 140–155 BPM · Minor keys
     - Recently imported · Missing key
     - 11A-compatible · Within ±5 BPM
     - WAV · 48 kHz · Added this month
     - Missing files
     - Possible duplicates

3. **Duplicate Detection**
   - Exact file duplicate: same SHA-256
   - Same source duplicate: same provider ID or source fingerprint
   - Audio-equivalent variant detection (future: similar audio content)
   - Intake-time duplicate warning: "This source already exists as WAV 44.1/24 and MP3 320"
   - Variant relationships: group MP3, WAV, FLAC, alternate exports under one logical track

4. **Library Integrity Audit**
   - Comprehensive audit report
   - Orphaned sidecars
   - Missing audio files
   - Hash mismatches
   - Duplicate detection results

### Success Criteria

- [ ] Users can tag, rate, and organize library items
- [ ] Smart collections update automatically
- [ ] Duplicate detection identifies all three levels
- [ ] Library audit completes without blocking UI

---

## v0.4.0 — Audio Intelligence

**Target:** Q3 2026

### Core Deliverables

1. **Audio QC Analysis** (Phase 1)
   - Integrated LUFS loudness
   - True peak dBTP
   - Clipping detection
   - Silence detection
   - Duration validation
   - Channel count verification
   - Sample rate and bit depth confirmation

2. **Musical Analysis** (Phase 2)
   - BPM estimation with confidence scores
   - Musical key detection (with Camelot conversion)
   - Tuning/detune analysis (cents deviation, reference Hz)
   - Alternate BPM/key candidates
   - Versioned analyzer with stale-result recomputation

3. **Evidence Model**
   ```json
   {
     "audioAnalysis": {
       "sourceSha256": "...",
       "analyzerVersion": "1",
       "analyzedAtMs": 0,
       "bpm": {
         "primary": 144,
         "alternates": [72],
         "confidence": 0.91
       },
       "key": {
         "primary": "F# minor",
         "camelot": "11A",
         "alternates": ["A major"],
         "confidence": 0.74
       },
       "tuning": {
         "detuneCents": -18.2,
         "confidence": 0.86
       },
       "loudness": {
         "integratedLufs": -10.8,
         "truePeakDbtp": -0.4
       }
     }
   }
   ```

4. **Behavioral Rules**
   - Declared, embedded, analyzed, suggested, and final remain separate categories
   - Analysis never silently overwrites producer's final values
   - Results cached by source SHA-256
   - Analyzer version stored for recomputation
   - Batch analysis runs as cancellable background job
   - Low-confidence results clearly labeled

5. **Compatibility Search**
   - Find beats within ±5 BPM
   - Camelot-compatible keys (e.g., 11A → 10A, 11A, 12A, 11B)
   - Similar audio characteristics

### Success Criteria

- [ ] Audio analysis runs as background job
- [ ] Confidence scores displayed for all derived values
- [ ] Analysis results do not overwrite manual metadata
- [ ] Compatibility search returns relevant results

---

## v0.5.0 — Producer Handoff

**Target:** Q4 2026

### Core Deliverables

1. **Export Packs**
   - User-defined packs composed of approved presets
   - Example Producer Pack:
     ```
     ├── WAV 44.1 kHz / 24-bit
     ├── MP3 320 kbps
     └── FLAC archive
     ```
   - Shared acquisition and inspection between outputs
   - Shared decoded intermediate where safe
   - Independent publication state per output
   - Destination profiles:
     - DAW Imports
     - Phone Preview
     - Client Delivery
     - Lossless Archive
   - Batch "apply pack to selected items"
   - Preset-specific filename templates
   - Output-space estimation before dispatch

2. **Quick Destinations**
   - Configurable quick-destination folders
   - "Copy to current project folder"
   - Drag-to-DAW integration
   - Windows shell integration: "Open with Sonic," "Send to Sonic"

3. **Advanced Audition**
   - Zoomable waveform display
   - Loop-in and loop-out markers
   - Persistent cue points
   - Preview gain and mute
   - Mono compatibility toggle
   - Continuous audition queue with next/previous
   - A/B comparison between two tracks
   - Copy path and copy metadata actions
   - Keyboard shortcuts: play, seek, loop, tap tempo, favorite, next track

4. **Release Trust Enhancements**
   - Authenticode signing for installer and executable
   - Signature verification in installer smoke test
   - Stable and beta release channels
   - Automatic rollback/recovery for failed updates
   - Local structured logs with bounded rotation
   - User-triggered support bundle:
     - Redacted logs
     - App/database/schema versions
     - Recent error codes
     - Dependency health
     - Queue recovery state
     - No source URLs or personal paths by default
   - Crash recovery prompt on next launch (no background analytics)

### Success Criteria

- [ ] Export packs produce multiple outputs from single source
- [ ] Drag-to-DAW works with compatible DAWs
- [ ] Installer passes SmartScreen without warnings
- [ ] Support bundle generates without exposing sensitive paths

---

## Implementation Order

The following sequence is critical to prevent building differentiated features on an underscaled foundation:

```
v0.3.0 Foundation (MUST complete first)
├── Schema migrations + backups
├── SQL-backed search + FTS + keyset pagination
├── Library roots + relative paths
├── Sidecar import + reconstruction
└── Multi-select + bulk actions

v0.3.1 Organization
├── Tags + crates + favorites + notes + ratings
├── Saved searches + smart collections
├── Duplicate detection + variants
└── Library integrity audit

v0.4.0 Intelligence
├── Audio QC (LUFS, peak, clipping, silence)
├── BPM/key/tuning analysis
├── Evidence model + confidence scores
└── Compatibility search

v0.5.0 Handoff
├── Export packs
├── Quick destinations + shell integration
├── Advanced audition + A/B comparison
└── Authenticode signing + diagnostics
```

**Critical Constraint:** The first five v0.3.0 backlog items must be completed before audio analysis begins.

---

## GitHub Project Setup

### Milestones

- `v0.3.0 — Library Foundation`
- `v0.3.1 — Library Organization`
- `v0.4.0 — Audio Intelligence`
- `v0.5.0 — Producer Handoff`

### Initial Issues (v0.3.0)

1. `feat(storage): add schema v2 migrations and automatic database backups`
2. `perf(library): move filtering and sorting into SQLite`
3. `feat(library): add keyset pagination and total result counts`
4. `feat(library): add roots, relative paths, and root relinking`
5. `feat(library): rebuild records from validated Sonic sidecars`
6. `feat(library): add multi-select and bulk actions`
7. `feat(library): add tags, crates, favorites, notes, and saved searches`
8. `feat(library): expose exact-source and SHA-256 duplicate detection`
9. `test(storage): add released-schema migration fixtures`
10. `test(library): add 10k and 100k item performance fixtures`

### Labels

- `feature` — New functionality
- `database-migration` — Schema changes requiring migration
- `security` — Security-related changes
- `performance` — Performance improvements
- `breaking-change` — Breaking changes requiring user action
- `bug` — Bug fixes
- `triage` — Needs review
- `dependencies` — Dependency updates
- `npm` — JavaScript dependencies
- `rust` — Rust dependencies
- `ci` — CI/CD changes

### Architecture Decision Records

Create `/docs/adr/` directory with:

- `0001-library-roots-model.md` — Relative path model decision
- `0002-fts5-search-index.md` — Full-text search implementation
- `0003-audio-analysis-boundary.md` — Separation of declared vs. analyzed metadata
- `0004-sidecar-as-source-of-truth.md` — Sidecar primacy over SQLite

---

## Testing Strategy

### Coverage Gaps to Address

1. **Browser-Fixture E2E Tests**
   - Adding several sources
   - Inspection success/failure flows
   - Metadata editing
   - Queue enqueueing and reordering
   - Retry and cancellation
   - Library searching/filtering
   - Preview loading
   - Missing-file behavior
   - Deletion confirmation

2. **Database Migration Fixtures**
   - Fixture for every published schema version
   - Upgrade path tests (v1→v2, v2→v3, etc.)
   - Downgrade/rollback tests

3. **Sidecar Import & Corruption Fixtures**
   - Valid sidecars
   - Corrupt sidecars
   - Orphaned sidecars (no audio)
   - Duplicate sidecars
   - Unsupported versions

4. **Property Tests**
   - Metadata parsing edge cases
   - Filename sanitization
   - Path normalization

5. **Large-Library Performance Tests**
   - 10k items
   - 100k items
   - Query response time benchmarks

6. **Interrupted-Publication Recovery Tests**
   - Mid-export interruption
   - Mid-tagging interruption
   - System crash simulation

7. **Export-Pack Partial-Failure Tests**
   - One output fails, others succeed
   - Rollback behavior

8. **Accessibility Coverage**
   - Every primary page
   - Keyboard navigation
   - Screen reader compatibility

---

## Related Documents

- [CONTRIBUTING.md](./CONTRIBUTING.md) — Contribution guidelines
- [SECURITY.md](./SECURITY.md) — Security policy
- [docs/sidecar-schema.md](./docs/sidecar-schema.md) — Sidecar format specification
- [docs/metadata-claims-boundary.md](./docs/metadata-claims-boundary.md) — Metadata evidence model

---

*Last updated: 2026-01-01*
*Document status: Draft*
