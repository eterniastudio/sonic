-- Library roots for relative path management
CREATE TABLE IF NOT EXISTS library_roots (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  root_path TEXT NOT NULL UNIQUE,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS library_roots_path_idx ON library_roots(root_path);

-- Library item locations (relative paths)
CREATE TABLE IF NOT EXISTS library_item_locations (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
  root_id TEXT NOT NULL REFERENCES library_roots(id) ON DELETE RESTRICT,
  relative_audio_path TEXT NOT NULL,
  relative_sidecar_path TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS library_item_locations_item_idx ON library_item_locations(item_id);
CREATE INDEX IF NOT EXISTS library_item_locations_root_idx ON library_item_locations(root_id);

-- Tags system
CREATE TABLE IF NOT EXISTS tags (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  color TEXT,
  created_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS tags_name_idx ON tags(name COLLATE NOCASE);

-- Many-to-many relationship between library items and tags
CREATE TABLE IF NOT EXISTS library_item_tags (
  item_id TEXT NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (item_id, tag_id)
);
CREATE INDEX IF NOT EXISTS library_item_tags_item_idx ON library_item_tags(item_id);
CREATE INDEX IF NOT EXISTS library_item_tags_tag_idx ON library_item_tags(tag_id);

-- Collections (crates, smart collections)
CREATE TABLE IF NOT EXISTS collections (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  is_smart INTEGER NOT NULL DEFAULT 0 CHECK (is_smart IN (0,1)),
  query_json TEXT CHECK (query_json IS NULL OR json_valid(query_json)),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS collections_name_idx ON collections(name COLLATE NOCASE);

-- Collection items
CREATE TABLE IF NOT EXISTS collection_items (
  collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (collection_id, item_id)
);
CREATE INDEX IF NOT EXISTS collection_items_collection_idx ON collection_items(collection_id);
CREATE INDEX IF NOT EXISTS collection_items_item_idx ON collection_items(item_id);

-- Saved searches
CREATE TABLE IF NOT EXISTS saved_searches (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  query_json TEXT NOT NULL CHECK (json_valid(query_json)),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

-- Audio analysis results
CREATE TABLE IF NOT EXISTS audio_analysis (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL UNIQUE REFERENCES library_items(id) ON DELETE CASCADE,
  source_sha256 TEXT NOT NULL,
  analyzer_version TEXT NOT NULL,
  analyzed_at_ms INTEGER NOT NULL,
  bpm_primary REAL,
  bpm_alternates_json TEXT CHECK (bpm_alternates_json IS NULL OR json_valid(bpm_alternates_json)),
  bpm_confidence REAL,
  key_primary TEXT,
  key_camelot TEXT,
  key_alternates_json TEXT CHECK (key_alternates_json IS NULL OR json_valid(key_alternates_json)),
  key_confidence REAL,
  tuning_detune_cents REAL,
  tuning_confidence REAL,
  loudness_integrated_lufs REAL,
  loudness_true_peak_dbtp REAL,
  created_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS audio_analysis_item_idx ON audio_analysis(item_id);
CREATE INDEX IF NOT EXISTS audio_analysis_sha_idx ON audio_analysis(source_sha256);

-- Cue points
CREATE TABLE IF NOT EXISTS cue_points (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
  label TEXT,
  position_ms INTEGER NOT NULL,
  color TEXT,
  created_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS cue_points_item_idx ON cue_points(item_id);

-- Full-text search index using FTS5
CREATE VIRTUAL TABLE IF NOT EXISTS library_items_fts USING fts5(
  title, artist, filename, musical_key, camelot, notes, tags,
  content='library_items',
  content_rowid='rowid'
);

-- Triggers to keep FTS index in sync
CREATE TRIGGER IF NOT EXISTS library_items_ai AFTER INSERT ON library_items BEGIN
  INSERT INTO library_items_fts(rowid, title, artist, filename, musical_key, camelot, notes, tags)
  VALUES (NEW.rowid, NEW.title, COALESCE(NEW.artist,''), 
          COALESCE(NEW.audio_path,''), COALESCE(NEW.musical_key,''), 
          COALESCE(NEW.camelot,''), '', '');
END;

CREATE TRIGGER IF NOT EXISTS library_items_ad AFTER DELETE ON library_items BEGIN
  INSERT INTO library_items_fts(library_items_fts, rowid, title, artist, filename, musical_key, camelot, notes, tags)
  VALUES('delete', OLD.rowid, OLD.title, COALESCE(OLD.artist,''), 
         COALESCE(OLD.audio_path,''), COALESCE(OLD.musical_key,''), 
         COALESCE(OLD.camelot,''), '', '');
END;

CREATE TRIGGER IF NOT EXISTS library_items_au AFTER UPDATE ON library_items BEGIN
  INSERT INTO library_items_fts(library_items_fts, rowid, title, artist, filename, musical_key, camelot, notes, tags)
  VALUES('delete', OLD.rowid, OLD.title, COALESCE(OLD.artist,''), 
         COALESCE(OLD.audio_path,''), COALESCE(OLD.musical_key,''), 
         COALESCE(OLD.camelot,''), '', '');
  INSERT INTO library_items_fts(rowid, title, artist, filename, musical_key, camelot, notes, tags)
  VALUES (NEW.rowid, NEW.title, COALESCE(NEW.artist,''), 
          COALESCE(NEW.audio_path,''), COALESCE(NEW.musical_key,''), 
          COALESCE(NEW.camelot,''), '', '');
END;
