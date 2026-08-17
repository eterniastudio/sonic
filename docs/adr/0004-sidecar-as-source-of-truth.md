# ADR 0004: Sidecar as Source of Truth

**Date:** 2026-01-01  
**Status:** Proposed  
**Context:** Sonic v0.3.0 — Library Foundation

## Problem Statement

Sonic documents the `.sonic.json` sidecar as "the portable producer record" and treats SQLite as "an optional local index." However, the current implementation:

- Reads sidecars primarily for integrity-sensitive deletion
- Has no folder scan or Library reconstruction workflow
- Cannot rebuild SQLite from sidecars after database loss
- Provides no import mechanism for existing sidecar collections

This creates a critical vulnerability: if the SQLite database corrupts or is deleted, all Library organization (tags, collections, notes, ratings) is lost even though sidecars still exist on disk.

## Decision

Establish the **sidecar as the authoritative source of truth** for portable records, with SQLite as a query-optimized index that can be fully reconstructed from sidecars.

### Hierarchy of Authority

```
┌─────────────────────────────────────────┐
│  Sidecar (.sonic.json)                  │
│  - Portable, human-readable             │
│  - Contains all user metadata           │
│  - Survives database loss               │
│  - Authoritative for: title, artist,    │
│    bpm, key, tags, notes, ratings       │
└─────────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────┐
│  SQLite Database                        │
│  - Query-optimized index                │
│  - Contains derived/computed fields     │
│  - Fast search, filter, sort            │
│  - Rebuildable from sidecars            │
└─────────────────────────────────────────┘
```

### Sidecar Schema Evolution

Current sidecar format (v1):
```json
{
  "$schema": "https://sonic.example.com/sidecar-v1.schema.json",
  "id": "uuid",
  "sourceFingerprint": "...",
  "audioHash": {
    "algorithm": "sha256",
    "value": "..."
  },
  "metadata": { ... },
  "exportHistory": [ ... ],
  "createdAtMs": 0,
  "updatedAtMs": 0
}
```

Proposed v2 additions:
```json
{
  "$schema": "https://sonic.example.com/sidecar-v2.schema.json",
  "id": "uuid",
  "sidecarVersion": 2,
  "sourceFingerprint": "...",
  "audioHash": {
    "algorithm": "sha256",
    "value": "..."
  },
  "metadata": { ... },
  "organization": {
    "tags": ["dark", "ambient"],
    "collections": ["favorites", "rage-beats"],
    "rating": 4,
    "status": "licensed",
    "colorLabel": "purple",
    "notes": "Used in track XYZ"
  },
  "analysis": { ... },
  "exportHistory": [ ... ],
  "variantGroupId": "optional-uuid",
  "createdAtMs": 0,
  "updatedAtMs": 0,
  "migratedFrom": null
}
```

### Import Workflow

```
User selects folder
       │
       ▼
Scan for *.sonic.json files
       │
       ▼
Validate each sidecar:
├── Schema version check
├── ID uniqueness
├── Audio hash verification
├── File safety (no path traversal)
       │
       ▼
Classify results:
├── ✓ Valid, not in DB → "Add to Library"
├── ✓ Valid, in DB → "Update record"
├── ⚠ Orphaned (no audio) → "Report"
├── ⚠ Duplicate ID → "Conflict resolution"
├── ✗ Corrupt JSON → "Skip"
├── ✗ Unsupported version → "Upgrade or skip"
       │
       ▼
Generate audit report:
├── Items added: N
├── Items updated: M
├── Orphans found: K
├── Errors: J
       │
       ▼
User reviews and confirms
       │
       ▼
Bulk import with progress tracking
```

### Reconstruction Algorithm

```rust
pub fn reconstruct_library_from_sidecars(
    root_path: &Path,
    db: &Repository,
) -> AppResult<ImportReport> {
    let mut report = ImportReport::default();
    
    // Phase 1: Discover all sidecars
    let sidecars = discover_sidecars(root_path)?;
    
    // Phase 2: Validate and classify
    let mut valid_items = Vec::new();
    for sidecar_file in sidecars {
        match validate_sidecar(&sidecar_file) {
            Ok(validated) => valid_items.push(validated),
            Err(e) => report.errors.push(e),
        }
    }
    
    // Phase 3: Check for conflicts with existing DB
    let existing_ids = db.get_all_library_ids()?;
    let (new_items, existing_items): (Vec<_>, Vec<_>) = valid_items
        .into_iter()
        .partition(|item| !existing_ids.contains(&item.id));
    
    report.new_count = new_items.len();
    report.updated_count = existing_items.len();
    
    // Phase 4: Verify audio files exist
    for item in &new_items {
        let audio_path = resolve_audio_path(item)?;
        if !audio_path.exists() {
            report.orphans.push(item.clone());
        }
    }
    
    // Phase 5: Transactional insert
    let tx = db.begin_transaction()?;
    for item in new_items {
        tx.insert_library_item(&item)?;
    }
    tx.commit()?;
    
    Ok(report)
}
```

### Upgrade Strategy

For sidecars with older schema versions:

1. **Non-destructive upgrade:**
   - Read original sidecar
   - Add new fields with defaults
   - Set `migratedFrom` to previous version
   - Write to temporary file
   - Validate new file
   - Atomically replace original

2. **Backward compatibility:**
   - Newer Sonic versions read old sidecars gracefully
   - Missing fields use sensible defaults
   - Unknown fields are preserved (not stripped)

## Alternatives Considered

### Alternative 1: SQLite as Primary Storage
**Rejected.** Database corruption = total loss. Not portable across machines. Defeats Sonic's portability goal.

### Alternative 2: Sidecar-Only (No SQLite)
**Insufficient.** Querying hundreds of JSON files is slow. No full-text search. Scales poorly.

### Alternative 3: Hybrid with Periodic Sync
**Selected.** Sidecars are authoritative; SQLite is synced cache. Reconstruction possible at any time.

### Alternative 4: External Database Format
**Deferred.** Could explore IndexedDB, Realm, or other formats later. Current priority is sidecar↔SQLite relationship.

## Consequences

### Positive
- Database becomes disposable/rebuildable
- Users can manually edit sidecars (advanced)
- Cross-machine migration via folder copy
- Recovery from catastrophic database failure
- Clear upgrade path for sidecar schema

### Negative
- Write operations must update both sidecar and SQLite
- Synchronization complexity (what if they diverge?)
- Sidecar file I/O adds latency
- Must handle concurrent modification edge cases

### Risks
- Race condition: sidecar updated while SQLite write pending
- User manually edits sidecar with invalid data
- Disk full during dual-write could corrupt one
- Version skew: new Sonic reads old sidecars incorrectly

## Implementation Notes

### Dual-Write Pattern

```rust
pub fn add_library_item(&self, item: &LibraryItem) -> AppResult<()> {
    // Step 1: Write sidecar atomically
    let sidecar_path = compute_sidecar_path(&item.audio_path);
    let temp_path = sidecar_path.with_extension(".sonic.json.tmp");
    
    write_sidecar_atomic(&temp_path, &sidecar_file)?;
    fs::rename(&temp_path, &sidecar_path)?;
    
    // Step 2: Insert into SQLite
    self.insert_library_item(item)?;
    
    // Step 3: Verify consistency
    debug_assert!(sidecar_path.exists());
    debug_assert!(self.library_item_exists(&item.id)?);
    
    Ok(())
}
```

### Conflict Resolution

When sidecar and SQLite disagree:

| Scenario | Resolution |
|----------|------------|
| Sidecar newer (`updatedAtMs`) | Trust sidecar, update SQLite |
| SQLite newer | Trust SQLite, update sidecar |
| Same timestamp, different values | Log warning, prefer sidecar |
| Hash mismatch | Flag as corrupted, require user action |

### Testing Requirements

1. **Reconstruction Tests:**
   - Create 100-item library
   - Delete SQLite database
   - Run reconstruction
   - Verify all items restored
   - Verify all metadata preserved

2. **Corruption Tests:**
   - Truncate sidecar JSON
   - Remove audio file (orphan)
   - Duplicate sidecar IDs
   - Invalid schema version

3. **Upgrade Tests:**
   - Import v1 sidecars into v2 application
   - Verify automatic non-destructive upgrade
   - Confirm old application can still read upgraded sidecars

## References

- Issue: `feat(library): rebuild records from validated Sonic sidecars`
- Related: ADR 0001 (Library Roots Model)
- Document: `docs/sidecar-schema.md`
