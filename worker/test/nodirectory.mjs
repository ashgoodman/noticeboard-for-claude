// Deploy-before-migrate window: the v2.3 worker running against a database
// that has no directory table yet. Every pre-existing tool must keep working
// - list_topics especially, since it now consults the directory to decide
// what to hide - and only the directory tools themselves may fail, cleanly.
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
  CREATE TABLE attachments (id TEXT PRIMARY KEY, note_id TEXT, topic TEXT NOT NULL,
    author TEXT, filename TEXT NOT NULL, content_type TEXT, size INTEGER NOT NULL,
    encoding TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL);
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
  const req = new Request("https://board.test/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": TOKEN },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call",
      params: { name, arguments: args } }),
  });
  const body = await (await worker.fetch(req, env, ctx)).json();
  const text = body.result.content[0].text;
  if (body.result.isError) return { isError: true, message: text };
  return JSON.parse(text);
}
let failures = 0;
function check(label, cond, detail) {
  if (cond) { console.log("  ok   " + label); return; }
  failures++;
  console.log("  FAIL " + label + (detail ? "\n       " + JSON.stringify(detail) : ""));
}

console.log("\nthe v2.3 worker on a database still waiting for migrate-0005");
const p = await tool("post_note", { topic: "work", body: "Still posting.", author: "a" });
check("posting works without the directory table", p.posted === true, p);
const r = await tool("read_notes", { topic: "work", author: "b" });
check("read_notes works and returns the note", r.count === 1, r);
const t = await tool("list_topics", { author: "b" });
check("list_topics works and does not hide everything",
  t.topics.some((x) => x.topic === "work"), t);
check("its default kind is still reported", t.kind === "work", t);
const ta = await tool("list_topics", { kind: "agents", author: "b" });
check("kind=agents is empty rather than broken",
  Array.isArray(ta.topics) && ta.topics.length === 0, ta);
const ch = await tool("my_channels", { author: "a" });
check("my_channels works", Array.isArray(ch.channels), ch);

const reg = await tool("directory_register", {
  project: "tacos", summary: "Would be a listing.", author: "a",
});
check("directory_register fails cleanly, naming the migration",
  reg.isError === true && reg.message.includes("migrate-0005"), reg);
const s = await tool("directory_search", { q: "tacos" });
check("directory_search fails cleanly",
  s.isError === true && s.message.includes("migrate-0005"), s);
const pr = await tool("directory_projects", { author: "a" });
check("directory_projects fails cleanly",
  pr.isError === true && pr.message.includes("migrate-0005"), pr);
const c = await tool("contact_agent", { handle: "nobody", body: "hi", author: "a" });
check("contact_agent fails cleanly", c.isError === true, c);
const cl = await tool("directory_claim", { handle: "nobody", author: "a" });
check("directory_claim fails cleanly", cl.isError === true, cl);

console.log(failures ? "\n" + failures + " FAILED"
  : "\nthe board survives the deploy-before-migrate window");
process.exit(failures ? 1 : 0);
