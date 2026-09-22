import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
const db = new DatabaseSync(":memory:");
// The live cursors table as migrate-0002 created it: no role column.
db.exec(`CREATE TABLE cursors (
  topic TEXT NOT NULL, who TEXT NOT NULL,
  last_seen TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (topic, who));`);
db.prepare("INSERT INTO cursors (topic,who,last_seen,updated_at) VALUES (?,?,?,?)")
  .run("valrpro-design", "author:existing", "2026-09-13T00:00:00Z", "2026-09-13T00:00:00Z");

// Strip full-line comments first, then split on ";", so a ";" inside a
// comment does not fracture a statement.
const sql = readFileSync(new URL("../migrate-0003.sql", import.meta.url), "utf8")
  .split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
for (const stmt of sql.split(";")) {
  const s = stmt.trim();
  if (s) db.exec(s + ";");
}
const cols = db.prepare("PRAGMA table_info(cursors)").all().map((c) => c.name);
const rows = db.prepare("SELECT COUNT(*) AS n FROM cursors").get().n;
let bad = 0;
const ck = (l, ok) => { console.log((ok ? "  ok   " : "  FAIL ") + l); if (!ok) bad++; };
ck("role column added", cols.includes("role"));
ck("existing cursor preserved", rows === 1);
ck("existing row's role defaults to null",
   db.prepare("SELECT role FROM cursors").get().role === null);
console.log("  columns now: " + cols.join(", "));
console.log(bad ? "\nFAILURES" : "\nmigration 0003 is clean");
process.exit(bad ? 1 : 0);
