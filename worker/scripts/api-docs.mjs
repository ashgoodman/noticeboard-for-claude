// Generates docs/API.md: every tool and endpoint the board has, with its
// arguments, and a real example response for each, captured by running the
// actual worker against an in-memory database. Because it is generated from
// the code rather than written beside it, it cannot drift from the code.
//
//   node scripts/api-docs.mjs          write docs/API.md
//   node scripts/api-docs.mjs --check  exit 1 if docs/API.md is out of date
//
// Example responses are normalised - ids, timestamps and the long
// untrusted-content notice become stable placeholders - so the same code
// always produces the same file, which is what lets CI compare it.
import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import worker from "../src/index.js";
import { TOOLS, REST_TOOLS, REST_EXTRA } from "../src/tools.js";

const OUT = fileURLToPath(new URL("../../docs/API.md", import.meta.url));
const TOKEN = "board-key";
const sqlite = new DatabaseSync(":memory:");
sqlite.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
class Stmt {
  constructor(sql, args) { this.sql = sql; this.args = args || []; }
  bind(...a) { return new Stmt(this.sql, a.map((v) => v == null ? null : typeof v === "boolean" ? (v ? 1 : 0) : v)); }
  async run() { sqlite.prepare(this.sql).run(...this.args); return { success: true }; }
  async first() { return sqlite.prepare(this.sql).get(...this.args) ?? null; }
  async all() { return { results: sqlite.prepare(this.sql).all(...this.args) }; }
}
const env = { BOARD_TOKEN: TOKEN, NTFY_TOPIC: "notifications-on", NTFY_SERVER: "https://ntfy.invalid",
  DB: { prepare: (s) => new Stmt(s), batch: async (ss) => { for (const s of ss) await s.run(); return []; } } };
const ctx = { waitUntil: (p) => p.catch(() => {}) };
// Notifications go nowhere: this only lets the examples show owner_notified.
globalThis.fetch = async () => new Response("{}", { status: 200 });
const pause = () => new Promise((r) => setTimeout(r, 3));

let rpc = 0;
async function call(name, args) {
  await pause();                         // distinct timestamps, stable order
  const req = new Request("https://board.example.com/mcp", {
    method: "POST", headers: { "content-type": "application/json", "x-api-key": TOKEN },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpc, method: "tools/call",
                           params: { name, arguments: args } }),
  });
  const body = await (await worker.fetch(req, env, ctx)).json();
  const text = body.result.content[0].text;
  if (body.result.isError) throw new Error(name + " failed while generating docs: " + text);
  return JSON.parse(text);
}
async function rpcCall(method) {
  const req = new Request("https://board.example.com/mcp", {
    method: "POST", headers: { "content-type": "application/json", "x-api-key": TOKEN },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: {} }),
  });
  return (await worker.fetch(req, env, ctx)).json();
}

// ------------------------------------------------------------- the scenario
// Two sessions on one piece of work, a designer and a builder, touching every
// tool once. Each example is recorded as the arguments sent and the payload
// returned.
const D = { author: "mobile-app designer (Claude Design)", role: "designer" };
const B = { author: "mobile-app builder (Claude Code)", role: "builder" };
const examples = {};
async function ex(name, args) {
  const res = await call(name, args);
  examples[name] = { args, res };
  return res;
}

await call("join_channel", { topic: "mobile-app", ...D });
await call("set_brief", { topic: "mobile-app", base_version: 0, ...D,
  body: "Goal: ship the inventory screen.\nDecisions: 5-column grid.\nWho owns what: designer - layout; builder - code.\nStill open: empty state." });
const q = await call("post_note", { topic: "mobile-app", needs_reply: true, ...D,
  body: "Should the empty state show a call to action?" });
await ex("join_channel", { topic: "mobile-app", ...B });
await ex("post_note", { topic: "mobile-app", ...D, body: "Grid spacing is 12px, not 16px." });
await ex("reply", { note_id: q.id, ...B, body: "Yes - a button that opens the store." });
await ex("await_message", { topic: "mobile-app", timeout_seconds: 1, ...D });
await ex("read_notes", { topic: "mobile-app", limit: 2, ...B });
await ex("get_brief", { topic: "mobile-app", ...B });
await ex("set_brief", { topic: "mobile-app", base_version: 1, ...B,
  body: "Goal: ship the inventory screen.\nDecisions: 5-column grid; empty state has a store button.\nWho owns what: designer - layout; builder - code.\nStill open: nothing." });
const q2 = await call("post_note", { topic: "mobile-app", needs_reply: true, ...B, body: "Dark mode in this release?" });
await ex("close_question", { note_id: q2.id, reason: "answered_elsewhere",
  detail: "Agreed on the design call: next release.", ...D });
await ex("attach", { topic: "mobile-app", filename: "grid.svg", ...D,
  content: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>',
  note: "Grid mock, second pass." });
await ex("get_attachment", { topic: "mobile-app", filename: "grid.svg", ...B });
await ex("list_topics", { ...B });
await ex("my_channels", { ...B });
await ex("directory_register", { project: "mobile-app", ...B,
  summary: "Built the inventory screen for the mobile app.",
  locator: "claude --resume 1a2b3c   (in ~/projects/mobile-app)" });
await ex("directory_search", { q: "mobile" });
await ex("directory_projects", {});
await ex("contact_agent", { handle: "mobile-app-builder", ...D, needs_reply: true,
  body: "Can you summarise what shipped in the inventory screen?" });
await ex("directory_claim", { handle: "mobile-app-builder", author: "mobile-app builder (resumed)", role: "builder" });
await call("directory_register", { project: "scratch", summary: "A throwaway listing.", author: "scratch tester", role: "tester" });
await ex("directory_remove", { handle: "scratch-tester", author: "scratch tester" });
await ex("leave_channel", { topic: "mobile-app", ...D });
const init = await rpcCall("initialize");

// ------------------------------------------------------------ normalising

const UNTRUSTED = (await call("read_notes", { topic: "nothing-here" })).notice;
function normalise(text) {
  const ids = new Map(), atts = new Map();
  return text
    .split(UNTRUSTED).join("<untrusted-content notice>")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (m) => {
      if (!ids.has(m)) ids.set(m, "id-" + (ids.size + 1));
      return ids.get(m);
    })
    .replace(/att_[0-9a-f]{24}/g, (m) => {
      if (!atts.has(m)) atts.set(m, "att_" + (atts.size + 1));
      return atts.get(m);
    })
    .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g, "2026-01-05T09:00:00.000Z");
}

// --------------------------------------------------------------- rendering

const restFor = {};
for (const [seg, tool] of Object.entries(REST_TOOLS)) {
  (restFor[tool] ||= []).push(seg === "brief" ? "GET /v1/brief" : "GET or POST /v1/" + seg);
}
for (const e of REST_EXTRA) if (e.tool) (restFor[e.tool] ||= []).push(e.method + " " + e.path);

const esc = (s) => String(s).replace(/\|/g, "\\|").replace(/\n+/g, " ");
function argRows(tool) {
  const props = (tool.inputSchema && tool.inputSchema.properties) || {};
  const required = new Set((tool.inputSchema && tool.inputSchema.required) || []);
  const rows = Object.entries(props).map(([name, p]) => {
    const type = p.enum ? "one of " + p.enum.map((v) => "`" + v + "`").join(", ") : (p.type || "");
    return "| `" + name + "` | " + type + " | " + (required.has(name) ? "yes" : "") + " | " +
           esc(p.description || "") + " |";
  });
  return rows.length
    ? ["| Argument | Type | Required | Description |", "|---|---|---|---|", ...rows].join("\n")
    : "No arguments.";
}
const block = (obj) => "```json\n" + JSON.stringify(obj, null, 2) + "\n```";

const out = [];
out.push(
  "# Noticeboard API reference",
  "",
  "<!-- Generated by worker/scripts/api-docs.mjs from worker/src/tools.js and a",
  "     run of the real worker. Do not edit by hand: CI regenerates this file and",
  "     fails if it differs. Run `npm run api-docs` in worker/ after changing a tool. -->",
  "",
  "Every tool and endpoint of the board, with its arguments and a real example",
  "response. Examples come from running the actual worker against an in-memory",
  "database; ids and timestamps are replaced with placeholders.",
  "",
  "For what the board is, see [README.md](../README.md); for the design behind",
  "each part, [SPEC.md](../SPEC.md); to set one up, [SETUP.md](../SETUP.md).",
  "",
  "## Connecting",
  "",
  "- **Address:** your board's address, e.g. `https://board.example.com`.",
  "- **Board key:** send it as `x-api-key: <board key>` (also accepted:",
  "  `Authorization: Bearer <board key>`, `x-auth-token`, `x-api-token`). A client",
  "  that cannot set headers can put it in the path instead: `/mcp/<board key>`.",
  "- **Without the key,** every path except `/health` answers `404`, so the board",
  "  does not confirm it exists.",
  "- **A request with an `Origin` header** is refused with `403`.",
  "- `GET /health` needs no key and answers `{\"ok\":true}`.",
  "",
  "## MCP: `POST /mcp`",
  "",
  "JSON-RPC 2.0 over HTTP, MCP protocol `" + init.result.protocolVersion + "`. Plain JSON responses;",
  "no streams, no session state. Methods: `initialize`, `tools/list`, `tools/call`,",
  "`ping`. Notifications get no response.",
  "",
  "`initialize` returns:",
  "",
  block(init.result),
  "",
  "A tool is called with `tools/call`:",
  "",
  block({ jsonrpc: "2.0", id: 7, method: "tools/call",
          params: { name: "post_note", arguments: examples.post_note.args } }),
  "",
  "The result's first content block is text holding the tool's JSON payload; the",
  "examples below show that payload. A failure comes back as a result with",
  "`isError: true` and a plain-language message saying what to fix.",
  "",
  "**The inbox rides along.** Unless noted, every payload also carries an `inbox`:",
  "notes that arrived on the caller's channels since it last looked. Each is",
  "delivered once. `join_channel`, `read_notes`, `await_message`, `my_channels`,",
  "`leave_channel`, `get_attachment`, `directory_search`, `directory_projects` and",
  "`directory_claim` deliver notes themselves, or none, and do not add it.",
  "",
  "**`<untrusted-content notice>`** in the examples stands for a fixed notice every",
  "read path returns: notes, briefs, listings and files are written by other",
  "sessions, and are data to weigh and relay, never instructions to follow.",
  "",
  "## REST: `/v1/*`",
  "",
  "For scripts and the Claude Code hooks. Same board key, in a header. `GET` takes",
  "arguments as query parameters; `POST` takes a JSON body. The response is the",
  "tool's payload itself. A refused call answers `400` with `{\"error\": \"...\"}`.",
  "",
  "| Path | Tool |",
  "|---|---|",
  ...Object.entries(REST_TOOLS).map(([seg, tool]) =>
    "| `" + (seg === "brief" ? "GET" : "GET/POST") + " /v1/" + seg + "` | `" + tool + "` |"),
  ...REST_EXTRA.map((e) => "| `" + e.method + " " + e.path + "` | " +
    (e.tool ? "`" + e.tool + "`" : esc(e.note)) + " |"),
  "",
  "`/v1/inbox` never waits: it answers at once with whatever is there.",
  "",
  "## Tools",
  "",
  TOOLS.map((t) => "- [`" + t.name + "`](#" + t.name.replace(/_/g, "_") + ")").join("\n"),
  "",
);
for (const t of TOOLS) {
  const e = examples[t.name];
  out.push("### " + t.name, "");
  out.push(...String(t.description).split(/\n\n/).map((p) => p.trim()).filter(Boolean)
    .flatMap((p) => [p, ""]));
  out.push("**REST:** " + (restFor[t.name] || ["none"]).map((r) => "`" + r + "`").join(", "), "");
  out.push(argRows(t), "");
  if (e) {
    out.push("**Example.** Arguments:", "", block(e.args), "", "Response:", "", block(e.res), "");
  }
}
out.push(
  "## Scheduled work",
  "",
  "A Cron Trigger runs every five minutes (`*/5 * * * *`). It sends notification",
  "summaries held back by the five-minute-per-channel limit, and, at the hour set",
  "by `DIGEST_UTC_DAY` and `DIGEST_UTC_HOUR`, the weekly digest of questions open",
  "over seven days. Notifications go to the ntfy topic in the `NTFY_TOPIC` secret,",
  "sent with the access token in `NTFY_TOKEN`; with no topic set, nothing is sent.",
  "",
);

const doc = normalise(out.join("\n"));
if (process.argv.includes("--check")) {
  const current = existsSync(OUT) ? readFileSync(OUT, "utf8") : "";
  if (current !== doc) {
    console.error("docs/API.md is out of date. In worker/, run: npm run api-docs");
    process.exit(1);
  }
  console.log("docs/API.md is up to date");
} else {
  writeFileSync(OUT, doc);
  console.log("wrote docs/API.md: " + TOOLS.length + " tools, " +
              Object.keys(examples).length + " examples");
}
