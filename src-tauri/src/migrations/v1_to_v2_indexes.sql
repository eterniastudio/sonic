-- Create indexes for new columns in library_items table
CREATE INDEX IF NOT EXISTS library_status_idx ON library_items(status);
CREATE INDEX IF NOT EXISTS library_favorite_idx ON library_items(is_favorite);
CREATE INDEX IF NOT EXISTS library_rating_idx ON library_items(rating);
CREATE INDEX IF NOT EXISTS library_root_idx ON library_items(root_id);
