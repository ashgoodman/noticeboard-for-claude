-- v2.4: briefs, closing questions without answering, and throttled push
-- notifications, plus an index for attachment versions. Run once, before or
-- after deploying the v2.4 worker; every statement is a CREATE ... IF NOT
-- EXISTS, so it is safe either way and safe to re-run:
--
--   wrangler d1 execute claude-noticeboard --remote --file migrate-0006.sql
--
-- If the --file path hits the import API's auth error, run the statements
-- with --command instead, one at a time:
--
--   wrangler d1 execute claude-noticeboard --remote --command "CREATE TABLE IF NOT EXISTS briefs (topic TEXT PRIMARY KEY, body TEXT NOT NULL, version INTEGER NOT NULL, updated_by TEXT, updated_at TEXT NOT NULL);"
--   wrangler d1 execute claude-noticeboard --remote --command "CREATE TABLE IF NOT EXISTS closures (note_id TEXT PRIMARY KEY, reason TEXT NOT NULL, detail TEXT, closed_by TEXT, closed_at TEXT NOT NULL);"
--   wrangler d1 execute claude-noticeboard --remote --command "CREATE TABLE IF NOT EXISTS push_state (topic TEXT PRIMARY KEY, last_sent_at TEXT, held INTEGER NOT NULL DEFAULT 0, held_last TEXT);"
--   wrangler d1 execute claude-noticeboard --remote --command "CREATE INDEX IF NOT EXISTS attachments_name ON attachments (topic, filename, created_at);"

-- A channel's current state on one page. Only the latest version is kept:
-- the notes are the history, the brief is the summary. version rises on every
-- write, so a session can say which one it edited and be refused if another
-- got there first.
CREATE TABLE IF NOT EXISTS briefs (
  topic      TEXT PRIMARY KEY,
  body       TEXT NOT NULL,
  version    INTEGER NOT NULL,
  updated_by TEXT,
  updated_at TEXT NOT NULL
);

-- Why a question was closed without being answered, and by whom. Closing
-- also stamps notes.answered_at, so every existing open-question count stops
-- counting it with no change to those queries; this row keeps the reason.
CREATE TABLE IF NOT EXISTS closures (
  note_id   TEXT PRIMARY KEY,
  reason    TEXT NOT NULL,
  detail    TEXT,
  closed_by TEXT,
  closed_at TEXT NOT NULL
);

-- One row per channel that has had a push: when the last one went, and how
-- many more have been held back inside the throttle window since. The
-- weekly digest records itself under the key '#digest', which no topic can
-- be, because topic names cannot contain '#'.
CREATE TABLE IF NOT EXISTS push_state (
  topic        TEXT PRIMARY KEY,
  last_sent_at TEXT,
  held         INTEGER NOT NULL DEFAULT 0,
  held_last    TEXT
);

-- Versions of an attachment are derived, not stored: the Nth file with a
-- given topic and filename, by creation time, is version N. This makes that
-- lookup cheap.
CREATE INDEX IF NOT EXISTS attachments_name ON attachments (topic, filename, created_at);
