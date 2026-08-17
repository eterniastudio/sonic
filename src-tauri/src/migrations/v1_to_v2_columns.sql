-- Add new columns to existing library_items table for v0.3 Library Intelligence
ALTER TABLE library_items ADD COLUMN notes TEXT;
ALTER TABLE library_items ADD COLUMN rating INTEGER CHECK (rating IS NULL OR (rating >= 1 AND rating <= 5));
ALTER TABLE library_items ADD COLUMN status TEXT CHECK (status IS NULL OR status IN ('unreviewed','candidate','used','licensed','archived'));
ALTER TABLE library_items ADD COLUMN is_favorite INTEGER NOT NULL DEFAULT 0 CHECK (is_favorite IN (0,1));
ALTER TABLE library_items ADD COLUMN color_label TEXT;
ALTER TABLE library_items ADD COLUMN root_id TEXT REFERENCES library_roots(id);
ALTER TABLE library_items ADD COLUMN relative_audio_path TEXT;
ALTER TABLE library_items ADD COLUMN relative_sidecar_path TEXT;
