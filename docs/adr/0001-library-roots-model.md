# ADR 0001: Library Roots Model

**Date:** 2026-01-01  
**Status:** Proposed  
**Context:** Sonic v0.3.0 — Library Foundation

## Problem Statement

The current Library implementation stores absolute paths for `audio_path` and `sidecar_path`. When a user:
- Moves a folder to a different location
- Changes drive letters (e.g., `D:\Beats` → `E:\Beats`)
- Reorganizes storage structure
- Migrates to a new computer

Sonic detects files as "missing" but provides no relinking workflow. Users must manually remove and re-import items, losing metadata, tags, and organization.

## Decision

Adopt a **root-based relative path model** where all library item paths are stored relative to configurable library roots.

### Schema Changes

```sql
-- New table for library roots
CREATE TABLE library_roots (
  id TEXT PRIMARY KEY,           -- UUID
  name TEXT NOT NULL,            -- User-friendly name: "Main Beat Drive"
  root_path TEXT NOT NULL UNIQUE, -- Absolute path: "D:\Beats"
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

-- Modify library_items table
ALTER TABLE library_items ADD COLUMN root_id TEXT REFERENCES library_roots(id);
ALTER TABLE library_items ADD COLUMN relative_audio_path TEXT;
ALTER TABLE library_items ADD COLUMN relative_sidecar_path TEXT;

-- Keep original columns for backward compatibility during migration
-- audio_path, sidecar_path remain but are deprecated
```

### Path Resolution

```rust
fn resolve_absolute_path(root: &LibraryRoot, relative: &str) -> PathBuf {
    root.root_path.join(relative)
}

fn compute_relative_path(root: &LibraryRoot, absolute: &Path) -> Option<String> {
    absolute.strip_prefix(&root.root_path)
        .ok()?
        .to_str()
        .map(String::from)
}
```

### Example Data

```json
{
  "root": {
    "id": "root-uuid-123",
    "name": "Main Beat Drive",
    "root_path": "D:\\Beats"
  },
  "item": {
    "root_id": "root-uuid-123",
    "relative_audio_path": "2026\\Producer\\Beat.wav",
    "relative_sidecar_path": "2026\\Producer\\Beat.sonic.json"
  }
}
```

When the drive letter changes from `D:` to `E:`, only the root needs updating:
```sql
UPDATE library_roots SET root_path = 'E:\\Beats' WHERE id = 'root-uuid-123';
```

All items under that root automatically resolve to the new location.

## Alternatives Considered

### Alternative 1: Store Only Absolute Paths (Current)
**Rejected.** No recovery mechanism for moved files. Users lose all metadata when reorganizing.

### Alternative 2: Full-Text Search for Missing Files
**Insufficient.** Searching by filename alone cannot reliably relocate files without structural context. Expensive at scale.

### Alternative 3: Watch Folders Without Root Model
**Insufficient.** Watch folders detect changes but don't solve the path resolution problem for existing items.

### Alternative 4: Sidecar-Only Storage
**Deferred.** While sidecars are portable (see ADR 0004), SQLite remains the primary query index for performance. This can evolve later.

## Consequences

### Positive
- Drive letter changes require single UPDATE query
- Folder moves within same root require no database changes
- Clear mental model for users
- Enables "relink root" UI workflow
- Supports removable drives that temporarily go offline

### Negative
- Migration complexity: must scan existing absolute paths and infer roots
- Multiple roots increase query complexity (JOIN required)
- Edge case: files outside any root cannot be added (by design)

### Risks
- Migration must correctly identify common prefixes
- Users may create overlapping roots accidentally
- Network paths and UNC paths need special handling

## Implementation Notes

1. **Migration Strategy (v1 → v2):**
   - Scan all existing `audio_path` values
   - Identify common prefix directories
   - Create default root(s) based on detected patterns
   - Compute relative paths for each item
   - Preserve original absolute paths in deprecated columns

2. **UI Requirements:**
   - Settings page showing configured roots
   - "Relink Root" dialog for changed paths
   - Health indicator per root (online/offline/missing)
   - Warning when adding files outside any root

3. **Edge Cases:**
   - UNC paths (`\\server\share\folder`)
   - Network drives mapped to different letters per machine
   - Symlinks and junctions
   - Case sensitivity differences (Windows vs. Linux subsystems)

## References

- Issue: `feat(library): add roots, relative paths, and root relinking`
- Related: ADR 0004 (Sidecar as Source of Truth)
