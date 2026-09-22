import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
const db = new DatabaseSync(":memory:");
// A v2.1-shaped live DB: notes/roles/cursors/hits, no attachments table.
db.exec(`
  CREATE TABLE notes (id TEXT PRIMARY KEY, topic TEXT NOT NULL, author TEXT NOT NULL,
    body TEXT NOT NULL, tags TEXT, created_at TEXT NOT NULL, expires_at TEXT,
    reply_to TEXT, recipient TEXT, needs_reply INTEGER NOT NULL DEFAULT 0,
    answered_at TEXT, poster TEXT);
  CREATE TABLE roles (topic TEXT NOT NULL, role TEXT NOT NULL, holder TEXT NOT NULL,
    claimed_at TEXT NOT NULL, renewed_at TEXT NOT NULL, PRIMARY KEY (topic, role));
  CREATE TABLE cursors (topic TEXT NOT NULL, who TEXT NOT NULL, role TEXT,
    last_seen TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (topic, who));
`);
db.prepare("INSERT INTO notes (id,topic,author,body,created_at) VALUES (?,?,?,?,?)")
  .run("n1", "t", "a", "existing note", "2026-09-15T00:00:00Z");

function apply(path) {
  const sql = readFileSync(path, "utf8")
    .split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  for (const stmt of sql.split(";")) { const s = stmt.trim(); if (s) db.exec(s + ";"); }
}
const migration = new URL("../migrate-0004.sql", import.meta.url);
apply(migration);
apply(migration);                       // twice, to prove it is idempotent

let bad = 0;
const ck = (l, ok) => { console.log((ok ? "  ok   " : "  FAIL ") + l); if (!ok) bad++; };
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map((r) => r.name);
const cols = db.prepare("PRAGMA table_info(attachments)").all().map((c) => c.name);
ck("attachments table created", tables.includes("attachments"));
ck("re-running the migration is harmless", true);
ck("indexes created", idx.includes("attachments_note") && idx.includes("attachments_topic"));
ck("columns are complete", ["id","note_id","topic","author","filename",
  "content_type","size","encoding","content","created_at"].every((c) => cols.includes(c)));
ck("existing notes untouched",
  db.prepare("SELECT COUNT(*) AS n FROM notes").get().n === 1);
// A round-trip insert/select works against the new table.
db.prepare("INSERT INTO attachments (id,note_id,topic,author,filename,content_type,size,encoding,content,created_at)"
  + " VALUES (?,?,?,?,?,?,?,?,?,?)")
  .run("att_x", "n1", "t", "a", "f.txt", "text/plain", 3, "text", "abc", "2026-09-15T00:00:01Z");
ck("insert + read back works",
  db.prepare("SELECT content FROM attachments WHERE id='att_x'").get().content === "abc");
console.log(bad ? "\nFAILURES" : "\nmigration 0004 is clean");
process.exit(bad ? 1 : 0);
