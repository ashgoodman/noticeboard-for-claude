// Deploy-before-migrate window: the v2.4 worker running against a v2.3
// database, before migrate-0006. Every existing tool must keep working;
// briefs and closing must fail cleanly and write nothing; notifications must
// still go out, just unthrottled.
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import worker from "../src/index.js";
const TOKEN = "test-token";
const full = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
const sqlite = new DatabaseSync(":memory:");
sqlite.exec(full.slice(0, full.indexOf("-- A channel's current state on one page.")));
class Stmt {
  constructor(sql, args) { this.sql = sql; this.args = args || []; }
  bind(...a) { return new Stmt(this.sql, a.map((v) => v == null ? null : typeof v === "boolean" ? (v ? 1 : 0) : v)); }
  async run() { sqlite.prepare(this.sql).run(...this.args); return { success: true }; }
  async first() { return sqlite.prepare(this.sql).get(...this.args) ?? null; }
  async all() { return { results: sqlite.prepare(this.sql).all(...this.args) }; }
}
const env = { BOARD_TOKEN: TOKEN, NTFY_TOPIC: "some-test-words", NTFY_SERVER: "https://ntfy.test",
  DB: { prepare: (s) => new Stmt(s), batch: async (ss) => { for (const s of ss) await s.run(); return []; } } };
const ctx = { waitUntil: (p) => p.catch(() => {}) };
const pushes = [];
globalThis.fetch = async (url, init) => { pushes.push(JSON.parse(init.body)); return new Response("{}", { status: 200 }); };
let id = 0;
async function tool(name, args) {
  const req = new Request("https://board.test/mcp", { method: "POST",
    headers: { "content-type": "application/json", "x-api-key": TOKEN },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }) });
  const body = await (await worker.fetch(req, env, ctx)).json();
  const text = body.result.content[0].text;
  return body.result.isError ? { isError: true, message: text } : JSON.parse(text);
}
let failures = 0;
const check = (l, c, d) => { console.log((c ? "  ok   " : "  FAIL ") + l + (c || d === undefined ? "" : "\n       " + JSON.stringify(d))); if (!c) failures++; };
const A = { author: "a (Claude)", role: "a" };

console.log("\nthe v2.4 worker on a database still waiting for migrate-0006");
const p = await tool("post_note", { topic: "work", body: "Still posting.", ...A });
check("posting works", p.posted === true, p);
const j = await tool("join_channel", { topic: "work", ...A });
check("join_channel works, with no brief to show", j.joined === true && j.brief === undefined, j);
check("read_notes works", (await tool("read_notes", { topic: "work", author: "b" })).count === 1);
check("list_topics works", (await tool("list_topics", { author: "b" })).topics.length === 1);
check("my_channels works", Array.isArray((await tool("my_channels", A)).channels));
const at1 = await tool("attach", { topic: "work", filename: "f.md", content: "one", ...A });
const at2 = await tool("attach", { topic: "work", filename: "f.md", content: "two", ...A });
check("attach works, versions included (they need no new table)", at1.version === 1 && at2.version === 2, [at1, at2]);
check("get_attachment by name works",
  (await tool("get_attachment", { topic: "work", filename: "f.md" })).content === "two");
const gb = await tool("get_brief", { topic: "work", ...A });
check("get_brief fails cleanly, naming the migration", gb.isError && gb.message.includes("migrate-0006"), gb);
const sb = await tool("set_brief", { topic: "work", body: "x", ...A });
check("set_brief fails cleanly, naming the migration", sb.isError && sb.message.includes("migrate-0006"), sb);
const q = await tool("post_note", { topic: "work", body: "A question?", needs_reply: true, ...A });
const cq = await tool("close_question", { note_id: q.id, reason: "no_longer_needed", ...A });
check("close_question fails cleanly", cq.isError && cq.message.includes("migrate-0006"), cq);
check("and leaves the question open",
  sqlite.prepare("SELECT answered_at FROM notes WHERE id = ?").get(q.id).answered_at === null);
const count = sqlite.prepare("SELECT COUNT(*) AS n FROM notes").get().n;
const rp = await tool("post_note", { topic: "work", body: "Replacement?", needs_reply: true, replaces: q.id, ...A });
check("replacing fails cleanly", rp.isError && rp.message.includes("migrate-0006"), rp);
check("without writing the new question", sqlite.prepare("SELECT COUNT(*) AS n FROM notes").get().n === count);
pushes.length = 0;
const n1 = await tool("post_note", { topic: "alerts", body: "x", needs_owner: true, ...A });
const n2 = await tool("post_note", { topic: "alerts", body: "y", needs_owner: true, ...A });
check("notifications still go out, unthrottled until the table exists",
  n1.owner_notified === "sent" && n2.owner_notified === "sent" && pushes.length === 2, [n1, n2, pushes]);
const waits = [];
await worker.scheduled({ scheduledTime: Date.now() }, env, { waitUntil: (w) => waits.push(w) });
await Promise.all(waits);
check("the scheduled run does nothing, rather than failing", true);
console.log(failures ? "\n" + failures + " FAILED" : "\nthe board survives the deploy-before-migrate window");
process.exit(failures ? 1 : 0);
