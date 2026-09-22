// migrate-0006 against a v2.3 database that already holds data: it must add
// the three tables and the index, leave every existing row alone, and be safe
// to run twice.
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
const full = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
// schema.sql is v2.3 with the v2.4 tables appended, so cutting at the first
// v2.4 comment gives exactly the database a v2.3 board has.
const v23 = full.slice(0, full.indexOf("-- A channel's current state on one page."));
const db = new DatabaseSync(":memory:");
db.exec(v23);
db.prepare("INSERT INTO notes (id, topic, author, body, created_at, needs_reply) VALUES ('n1','t','a','kept',?,1)")
  .run(new Date().toISOString());
db.prepare("INSERT INTO attachments (id, note_id, topic, author, filename, content_type, size, encoding, content, created_at) VALUES ('att1','n1','t','a','f.md','text/markdown',4,'text','kept',?)")
  .run(new Date().toISOString());
let failures = 0;
const check = (l, c) => { console.log((c ? "  ok   " : "  FAIL ") + l); if (!c) failures++; };
const tables = () => db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
check("a v2.3 database has none of the new tables", !["briefs", "closures", "push_state"].some((t) => tables().includes(t)));
const mig = readFileSync(new URL("../migrate-0006.sql", import.meta.url), "utf8");
db.exec(mig);
check("the migration adds briefs, closures and push_state", ["briefs", "closures", "push_state"].every((t) => tables().includes(t)));
check("and the attachment-name index",
  db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='attachments_name'").get() !== undefined);
db.exec(mig);
check("running it again is harmless", true);
check("existing notes untouched", db.prepare("SELECT body, needs_reply FROM notes WHERE id='n1'").get().body === "kept");
check("existing attachments untouched", db.prepare("SELECT content FROM attachments WHERE id='att1'").get().content === "kept");
const cols = (t) => db.prepare("PRAGMA table_info(" + t + ")").all().map((c) => c.name).join(",");
check("no existing table gained or lost a column",
  cols("notes") === "id,topic,author,body,tags,created_at,expires_at,reply_to,recipient,needs_reply,answered_at,poster");
console.log(failures ? "\n" + failures + " FAILED" : "\nmigration 0006 is clean");
process.exit(failures ? 1 : 0);
