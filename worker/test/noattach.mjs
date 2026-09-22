// Deploy-before-migrate window: the v2.2 worker running against a DB that has
// no attachments table yet. Reads and posts must still work; only attach fails.
import { DatabaseSync } from "node:sqlite";
import worker from "../src/index.js";
const TOKEN = "test-token";
const sqlite = new DatabaseSync(":memory:");
sqlite.exec(`
  CREATE TABLE notes (id TEXT PRIMARY KEY, topic TEXT NOT NULL, author TEXT NOT NULL,
    body TEXT NOT NULL, tags TEXT, created_at TEXT NOT NULL, expires_at TEXT,
    reply_to TEXT, recipient TEXT, needs_reply INTEGER NOT NULL DEFAULT 0,
    answered_at TEXT, poster TEXT);
  CREATE TABLE roles (topic TEXT NOT NULL, role TEXT NOT NULL, holder TEXT NOT NULL,
    claimed_at TEXT NOT NULL, renewed_at TEXT NOT NULL, PRIMARY KEY (topic, role));
  CREATE TABLE cursors (topic TEXT NOT NULL, who TEXT NOT NULL, role TEXT,
    last_seen TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (topic, who));
  CREATE TABLE hits (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL,
    path TEXT, method TEXT, status INTEGER, authed INTEGER, rpc TEXT, origin TEXT, ua TEXT);
`);
class Stmt {
  constructor(sql, args) { this.sql = sql; this.args = args || []; }
  bind(...a) { return new Stmt(this.sql, a.map((v) => v == null ? null : typeof v === "boolean" ? (v?1:0) : v)); }
  async run() { sqlite.prepare(this.sql).run(...this.args); return { success: true }; }
  async first() { return sqlite.prepare(this.sql).get(...this.args) ?? null; }
  async all() { return { results: sqlite.prepare(this.sql).all(...this.args) }; }
}
const env = { BOARD_TOKEN: TOKEN, DB: { prepare: (s) => new Stmt(s),
  batch: async (ss) => { for (const s of ss) await s.run(); return []; } } };
const ctx = { waitUntil: (p) => p.catch(() => {}) };
let id = 0;
async function tool(name, args) {
  const req = new Request("https://board.test/mcp", { method: "POST",
    headers: { "content-type": "application/json", "x-api-key": TOKEN },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }) });
  const b = await (await worker.fetch(req, env, ctx)).json();
  const t = b.result.content[0].text;
  return b.result.isError ? { isError: true, message: t } : JSON.parse(t);
}
let bad = 0;
const ck = (l, ok, d) => { console.log((ok?"  ok   ":"  FAIL ")+l+(ok?"":"\n       "+JSON.stringify(d))); if(!ok) bad++; };

const A = { author: "a (x)", role: "designer" };
const B = { author: "b (y)", role: "builder" };
await tool("join_channel", { topic: "t", ...A });
await tool("join_channel", { topic: "t", ...B });
const p = await tool("post_note", { topic: "t", body: "hello with no attachments table", ...A });
ck("posting works without the attachments table", p.posted === true, p);
const r = await tool("read_notes", { topic: "t", ...B });
ck("read_notes works and returns the note", r.count === 1 && r.notes[0].body.includes("hello"), r);
const inbox = await tool("list_topics", B);
ck("inbox annotation degrades gracefully (no throw)", !!inbox.topics, inbox);
const at = await tool("attach", { topic: "t", filename: "f.txt", content: "hi", ...A });
ck("attach fails cleanly (table missing) rather than crashing the server",
  at.isError === true, at);
console.log(bad ? "\nFAILURES" : "\nreads survive the deploy-before-migrate window");
process.exit(bad ? 1 : 0);
