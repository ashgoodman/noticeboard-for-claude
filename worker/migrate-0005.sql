-- Adds the directory table: a register of agents, so a human who has
-- forgotten which session did a piece of work can find it again months later
-- and leave it a message. This is the v2.3 change. Run once, before or after
-- deploying the v2.3 worker (a create is safe either way):
--
--   wrangler d1 execute claude-noticeboard --remote --file migrate-0005.sql
--
-- If the --file path hits the import API's auth error, run the statements
-- with --command instead, one at a time:
--
--   wrangler d1 execute claude-noticeboard --remote --command "CREATE TABLE IF NOT EXISTS directory (handle TEXT PRIMARY KEY, owner TEXT NOT NULL, project TEXT NOT NULL, role TEXT, summary TEXT NOT NULL, auto_summary TEXT, locator TEXT, tags TEXT, surface TEXT, contact_channel TEXT NOT NULL, registered_at TEXT NOT NULL, last_seen TEXT, summary_updated_at TEXT, auto_summary_updated_at TEXT);"
--   wrangler d1 execute claude-noticeboard --remote --command "CREATE INDEX IF NOT EXISTS directory_project ON directory (project);"
--   wrangler d1 execute claude-noticeboard --remote --command "CREATE INDEX IF NOT EXISTS directory_owner ON directory (owner);"
--   wrangler d1 execute claude-noticeboard --remote --command "CREATE INDEX IF NOT EXISTS directory_channel ON directory (contact_channel);"

-- A listing is a name in a book, not a conversation. Registering writes this
-- row and nothing else: no topic, no channel, no note. The contact channel
-- named here is created lazily, by the first contact_agent call.
--
-- project      free text for an area of work. NOT a foreign key to a topic.
-- summary      the human's words, short, shown in every search result
-- auto_summary the session's own running account of what it has done, long
-- locator      how to reopen the conversation, e.g. a resume id and a folder
-- owner        identity key of whoever currently holds the handle
CREATE TABLE IF NOT EXISTS directory (
  handle                  TEXT PRIMARY KEY,
  owner                   TEXT NOT NULL,
  project                 TEXT NOT NULL,
  role                    TEXT,
  summary                 TEXT NOT NULL,
  auto_summary            TEXT,
  locator                 TEXT,
  tags                    TEXT,
  surface                 TEXT,
  contact_channel         TEXT NOT NULL,
  registered_at           TEXT NOT NULL,
  last_seen               TEXT,
  summary_updated_at      TEXT,
  auto_summary_updated_at TEXT
);
CREATE INDEX IF NOT EXISTS directory_project ON directory (project);
CREATE INDEX IF NOT EXISTS directory_owner   ON directory (owner);
CREATE INDEX IF NOT EXISTS directory_channel ON directory (contact_channel);
