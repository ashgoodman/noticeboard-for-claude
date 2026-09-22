-- Noticeboard for Claude: schema.
--
-- This file is the whole truth. Running it against an empty D1 produces a
-- database the worker can serve, which was not true of the version before it:
-- four columns the code depends on had been added by hand to the live
-- database and survived here only as a comment.

-- A note is one durable message on a topic, written by one session for
-- whoever reads the topic later. Nothing is addressed to a session: session
-- names die with the session, topics do not.
--
-- reply_to    set on a reply, pointing at the note being answered
-- recipient   free-text hint at who a note is for; nothing depends on it
-- needs_reply 1 marks an open question, which stays open until answered
-- answered_at stamped on the question the moment a reply lands
-- poster      the identity key of the writer, so a reader is never shown
--             their own note back as unread
CREATE TABLE IF NOT EXISTS notes (
  id          TEXT PRIMARY KEY,
  topic       TEXT NOT NULL,
  author      TEXT NOT NULL,
  body        TEXT NOT NULL,
  tags        TEXT,
  created_at  TEXT NOT NULL,
  expires_at  TEXT,
  reply_to    TEXT,
  recipient   TEXT,
  needs_reply INTEGER NOT NULL DEFAULT 0,
  answered_at TEXT,
  poster      TEXT
);
CREATE INDEX IF NOT EXISTS notes_topic_time ON notes (topic, created_at);
CREATE INDEX IF NOT EXISTS notes_time       ON notes (created_at);
CREATE INDEX IF NOT EXISTS notes_reply_to   ON notes (reply_to);
CREATE INDEX IF NOT EXISTS notes_open       ON notes (needs_reply, answered_at);

-- A session claiming a stable address on a channel. Claiming is optional:
-- posting and reading work without it exactly as before. What a claim buys
-- is an address that outlives the session id, and a way for the other side
-- to see whether you are still running.
CREATE TABLE IF NOT EXISTS roles (
  topic      TEXT NOT NULL,
  role       TEXT NOT NULL,
  holder     TEXT NOT NULL,
  claimed_at TEXT NOT NULL,
  renewed_at TEXT NOT NULL,
  PRIMARY KEY (topic, role)
);

-- What a reader has already been shown, so "what is new for me" needs no
-- timestamp from the caller. `who` is the author string ("author:<name>"),
-- because that is unique per chat; the role is not, since "designer" repeats
-- across projects. A cursor row is also the membership: you get an inbox for
-- a topic because you have a cursor on it, my_channels lists these rows, and
-- leave_channel deletes one. `role` is the label this chat holds on the
-- topic, carried here so my_channels can report it.
CREATE TABLE IF NOT EXISTS cursors (
  topic      TEXT NOT NULL,
  who        TEXT NOT NULL,
  role       TEXT,
  last_seen  TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (topic, who)
);
CREATE INDEX IF NOT EXISTS cursors_who ON cursors (who);

-- Every inbound request, authorised or not. Without it there is no way to
-- tell "nobody called" from "we turned them away".
CREATE TABLE IF NOT EXISTS hits (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  ts     TEXT NOT NULL,
  path   TEXT, method TEXT, status INTEGER,
  authed INTEGER, rpc TEXT, origin TEXT, ua TEXT
);

-- A file handed from one session to another. The bytes live here, not in the
-- note, so a note's inbox marker stays tiny and the content is pulled only on
-- an explicit get_attachment. Text is stored as-is; binary is base64 in the
-- same column, with `encoding` saying which and `size` the real byte count.
-- note_id ties it to the announcing note so a reader finds it in the thread.
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
