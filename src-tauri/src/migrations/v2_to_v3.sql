-- v3 adds duplicate detection support and track variants

-- Track variants for grouping related exports (WAV/MP3/FLAC of same beat)
CREATE TABLE IF NOT EXISTS track_variants (
  id TEXT PRIMARY KEY,
  source_fingerprint TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS track_variants_fingerprint_idx ON track_variants(source_fingerprint);

-- Link library items to their variant group
ALTER TABLE library_items ADD COLUMN variant_group_id TEXT REFERENCES track_variants(id);
CREATE INDEX IF NOT EXISTS library_variant_idx ON library_items(variant_group_id);

-- Duplicate detection cache
CREATE TABLE IF NOT EXISTS duplicate_cache (
  sha256 TEXT PRIMARY KEY,
  item_ids_json TEXT NOT NULL CHECK (json_valid(item_ids_json)),
  detected_at_ms INTEGER NOT NULL
);
