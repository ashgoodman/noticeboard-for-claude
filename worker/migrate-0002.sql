-- Brings the live database up to schema.sql. Run once:
--   wrangler d1 execute claude-noticeboard --remote --file migrate-0002.sql
-- The ALTER fails harmlessly if the column is already there.
ALTER TABLE notes ADD COLUMN poster TEXT;

CREATE INDEX IF NOT EXISTS notes_reply_to ON notes (reply_to);
CREATE INDEX IF NOT EXISTS notes_open     ON notes (needs_reply, answered_at);

CREATE TABLE IF NOT EXISTS roles (
  topic      TEXT NOT NULL,
  role       TEXT NOT NULL,
  holder     TEXT NOT NULL,
  claimed_at TEXT NOT NULL,
  renewed_at TEXT NOT NULL,
  PRIMARY KEY (topic, role)
);

CREATE TABLE IF NOT EXISTS cursors (
  topic      TEXT NOT NULL,
  who        TEXT NOT NULL,
  last_seen  TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (topic, who)
);
CREATE INDEX IF NOT EXISTS cursors_who ON cursors (who);
