# ADR 0002: FTS5 Full-Text Search Index

**Date:** 2026-01-01  
**Status:** Proposed  
**Context:** Sonic v0.3.0 — Library Foundation

## Problem Statement

The current Library search implementation:
1. Fetches up to 1,000 rows from SQLite
2. Filters them in-memory in Rust
3. The React frontend sorts the filtered subset again

This approach fails at scale:
- Incomplete results when library exceeds 1,000 items
- Slow response times as dataset grows
- Sort mode selection is ignored by the native bridge
- No support for multi-field search (title + artist + filename + key + tags)
- No relevance ranking

## Decision

Implement **SQLite FTS5 full-text search index** with SQL-side filtering and sorting.

### Prerequisites

Verify FTS5 is available in bundled SQLite:
```rust
fn verify_fts5_available(conn: &Connection) -> AppResult<()> {
    conn.execute("CREATE VIRTUAL TABLE IF NOT EXISTS fts5_test USING fts5(test)", [])?;
    conn.execute("DROP TABLE fts5_test", [])?;
    Ok(())
}
```

If FTS5 is unavailable, fall back to LIKE-based search with warning.

### Schema Design

```sql
-- FTS5 virtual table for library search
CREATE VIRTUAL TABLE library_fts USING fts5(
  title,
  artist,
  filename,
  musical_key,
  camelot,
  notes,
  tags,
  content='library_items',
  content_rowid='rowid'
);

-- Triggers to keep FTS index in sync
CREATE TRIGGER library_items_ai AFTER INSERT ON library_items BEGIN
  INSERT INTO library_fts(rowid, title, artist, filename, musical_key, camelot, notes, tags)
  VALUES (new.rowid, new.title, COALESCE(new.artist,''), 
          COALESCE(new.filename,''), COALESCE(new.musical_key,''), 
          COALESCE(new.camelot,''), COALESCE(new.notes,''), 
          COALESCE(new.tags,''));
END;

CREATE TRIGGER library_items_ad AFTER DELETE ON library_items BEGIN
  INSERT INTO library_fts(library_fts, rowid, title, artist, filename, musical_key, camelot, notes, tags)
  VALUES('delete', old.rowid, old.title, COALESCE(old.artist,''), 
         COALESCE(old.filename,''), COALESCE(old.musical_key,''), 
         COALESCE(old.camelot,''), COALESCE(old.notes,''), 
         COALESCE(old.tags,''));
END;

CREATE TRIGGER library_items_au AFTER UPDATE ON library_items BEGIN
  INSERT INTO library_fts(library_fts, rowid, title, artist, filename, musical_key, camelot, notes, tags)
  VALUES('delete', old.rowid, old.title, COALESCE(old.artist,''), 
         COALESCE(old.filename,''), COALESCE(old.musical_key,''), 
         COALESCE(old.camelot,''), COALESCE(old.notes,''), 
         COALESCE(old.tags,''));
  INSERT INTO library_fts(rowid, title, artist, filename, musical_key, camelot, notes, tags)
  VALUES (new.rowid, new.title, COALESCE(new.artist,''), 
          COALESCE(new.filename,''), COALESCE(new.musical_key,''), 
          COALESCE(new.camelot,''), COALESCE(new.notes,''), 
          COALESCE(new.tags,''));
END;
```

### Query Pattern

```sql
-- Search with relevance ranking
SELECT li.*, bm.*
FROM library_items li
JOIN library_fts ft ON li.rowid = ft.rowid
JOIN library_fts_bm25(library_fts) AS bm
WHERE library_fts MATCH ?
ORDER BY bm.score, li.created_at_ms DESC, li.id
LIMIT ? OFFSET ?;
```

### Search Fields Configuration

| Field | Weight | Notes |
|-------|--------|-------|
| title | 10 | Primary search target |
| filename | 8 | Exact filename matches |
| artist | 5 | Secondary importance |
| camelot | 3 | Exact match only (e.g., "11A") |
| musical_key | 3 | Case-insensitive |
| tags | 7 | User-defined organization |
| notes | 2 | Lowest priority |

### Alternatives Considered

### Alternative 1: Continue In-Memory Filtering
**Rejected.** Does not scale beyond ~1,000 items. Ignores sort mode.

### Alternative 2: SQLite LIKE Queries
**Insufficient.** `WHERE title LIKE '%query%'` cannot search multiple fields efficiently. No relevance ranking. Still requires scanning entire table.

### Alternative 3: External Search Engine (Lucene, Tantivy)
**Over-engineering.** Adds significant complexity and external dependencies. FTS5 provides sufficient functionality for producer-scale libraries (< 1M items).

### Alternative 4: Hybrid Approach (FTS + Numeric Filters)
**Selected with modification.** Use FTS5 for text search, combine with standard WHERE clauses for numeric filters (BPM range, format, missing status).

## Consequences

### Positive
- Sub-100ms search response for typical queries
- Relevance-ranked results
- Scales to 100k+ items
- Single query handles filtering + sorting + pagination
- Supports complex queries: `"minor key" AND bpm:140..150`

### Negative
- FTS5 increases database size (~10-20% overhead)
- Triggers add slight write latency
- Must handle FTS5 unavailability gracefully
- Migration must populate initial index

### Risks
- FTS5 may not be enabled in all SQLite builds
- Trigger failures could desynchronize index
- Complex queries may need query planner tuning

## Implementation Notes

1. **Migration (v1 → v2):**
   ```sql
   -- After creating FTS5 table and triggers
   INSERT INTO library_fts(rowid, title, artist, filename, musical_key, camelot, notes, tags)
   SELECT rowid, title, COALESCE(artist,''), 
          json_extract(source_json, '$.filename'), 
          COALESCE(musical_key,''), 
          COALESCE(camelot,''), 
          '',  -- notes column added in v2
          '';  -- tags column added in v2
   FROM library_items;
   ```

2. **Query Builder:**
   ```rust
   pub fn build_search_query(query: &LibraryQuery) -> (String, Vec<Param>) {
       let mut sql = String::from("SELECT li.* FROM library_items li");
       let mut params = Vec::new();
       
       if let Some(search) = &query.search {
           sql.push_str(" JOIN library_fts ft ON li.rowid = ft.rowid");
           sql.push_str(" JOIN library_fts_bm25(library_fts) AS bm");
           sql.push_str(" WHERE library_fts MATCH ?");
           params.push(search.to_string());
           
           // Add numeric filters
           if let Some(bpm_min) = query.bpm_min {
               sql.push_str(" AND li.bpm >= ?");
               params.push(bpm_min);
           }
           // ... additional filters
           
           sql.push_str(" ORDER BY bm.score");
       } else {
           // No search term: use standard filters
           sql.push_str(" WHERE 1=1");
           // ... filters
           sql.push_str(" ORDER BY li.created_at_ms DESC");
       }
       
       sql.push_str(" LIMIT ? OFFSET ?");
       params.push(query.limit.unwrap_or(50));
       params.push(query.offset.unwrap_or(0));
       
       (sql, params)
   }
   ```

3. **Testing Requirements:**
   - Verify FTS5 availability on clean Windows install
   - Test with 10k and 100k item fixtures
   - Benchmark query response times
   - Test trigger synchronization under concurrent writes

## References

- [SQLite FTS5 Documentation](https://www.sqlite.org/fts5.html)
- Issue: `perf(library): move filtering and sorting into SQLite`
- Related: ADR 0004 (Sidecar as Source of Truth)
