-- Adds the attachments table, so a session can hand a whole file to another
-- (source, config, SVG or PNG mockup) without pasting it into a note. The
-- bytes live here; the note carries only a marker, and get_attachment pulls
-- the content on demand. This is the v2.2 change. Run once, before or after
-- deploying the v2.2 worker (a create is safe either way):
--
--   wrangler d1 execute claude-noticeboard --remote --file migrate-0004.sql
--
-- If the --file path hits the import API's auth error, run the statements
-- with --command instead, one at a time:
--
--   wrangler d1 execute claude-noticeboard --remote --command "CREATE TABLE IF NOT EXISTS attachments (id TEXT PRIMARY KEY, note_id TEXT, topic TEXT NOT NULL, author TEXT, filename TEXT NOT NULL, content_type TEXT, size INTEGER NOT NULL, encoding TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL);"
--   wrangler d1 execute claude-noticeboard --remote --command "CREATE INDEX IF NOT EXISTS attachments_note ON attachments (note_id);"
--   wrangler d1 execute claude-noticeboard --remote --command "CREATE INDEX IF NOT EXISTS attachments_topic ON attachments (topic, created_at);"
CREATE TABLE IF NOT EXISTS attachments (
  id           TEXT PRIMARY KEY,
  note_id      TEXT,
  topic        TEXT NOT NULL,
  author       TEXT,
  filename     TEXT NOT NULL,
  content_type TEXT,
  size         INTEGER NOT NULL,
  encoding     TEXT NOT NULL,
  content      TEXT NOT NULL,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS attachments_note  ON attachments (note_id);
CREATE INDEX IF NOT EXISTS attachments_topic ON attachments (topic, created_at);
