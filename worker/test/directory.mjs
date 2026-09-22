// The agent directory (v2.3): a register of agents rather than of
// conversations. Driven through the worker's own HTTP surface against a
// database rebuilt from schema.sql, so a from-empty rebuild is proven too.
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import worker from "../src/index.js";

const TOKEN = "test-token";
const sqlite = new DatabaseSync(":memory:");
sqlite.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));

class Stmt {
  constructor(sql, args) { this.sql = sql; this.args = args || []; }
  bind(...a) { return new Stmt(this.sql, a.map(norm)); }
  async run() { sqlite.prepare(this.sql).run(...this.args); return { success: true }; }
  async first() { return sqlite.prepare(this.sql).get(...this.args) ?? null; }
  async all() { return { results: sqlite.prepare(this.sql).all(...this.args) }; }
}
function norm(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  return v;
}
const env = { BOARD_TOKEN: TOKEN, DB: { prepare: (s) => new Stmt(s),
  batch: async (ss) => { for (const s of ss) await s.run(); return []; } } };
const ctx = { waitUntil: (p) => p.catch(() => {}) };

let rpcId = 0;
async function tool(name, args) {
  const req = new Request("https://board.test/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": TOKEN },
    body: JSON.stringify({
      jsonrpc: "2.0", id: ++rpcId, method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const body = await (await worker.fetch(req, env, ctx)).json();
  const text = body.result.content[0].text;
  if (body.result.isError) return { isError: true, message: text };
  return JSON.parse(text);
}
async function restGet(path) {
  const req = new Request("https://board.test" + path, { headers: { "x-api-key": TOKEN } });
  const res = await worker.fetch(req, env, ctx);
  return { status: res.status, body: await res.json() };
}
const topicRows = () => sqlite.prepare("SELECT topic FROM notes GROUP BY topic").all();

let failures = 0;
function check(label, cond, detail) {
  if (cond) { console.log("  ok   " + label); return; }
  failures++;
  console.log("  FAIL " + label + (detail ? "\n       " + JSON.stringify(detail) : ""));
}

const FIRST = { author: "tacos first pass (Claude Code, WSL)", role: "first-pass" };
const LATER = { author: "tacos second look (Cowork)", role: "reviewer" };

console.log("\n1. registering creates a listing and nothing else");
const before = topicRows().length;
const reg = await tool("directory_register", {
  project: "tacos", summary: "First pass on the taco pipeline.",
  locator: "claude --resume 7a3f in ~/projects/tacos",
  surface: "Claude Code (WSL)", ...FIRST,
});
check("registered", reg.registered === true, reg);
check("handle was derived from project and role",
  reg.handle === "tacos-first-pass" && reg.derived === true, reg);
check("the result tells the caller to report back to the user",
  typeof reg.next === "string" && reg.next.includes("correct"), reg.next);
check("no topic was created", topicRows().length === before, topicRows());

console.log("\n2. a second registration derives a free handle");
const dup = await tool("directory_register", {
  project: "tacos", summary: "Another first pass entirely.",
  author: "someone else (Claude Design)", role: "first-pass",
});
check("collision resolved with a suffix", dup.handle === "tacos-first-pass-2", dup);

console.log("\n3. the human's fields and the agent's do not overwrite each other");
await tool("directory_register", {
  handle: "tacos-first-pass", project: "tacos",
  auto_summary: "Evaluated three fillings; recommended carnitas.", ...FIRST,
});
let one = await tool("directory_search", { handle: "tacos-first-pass" });
check("auto_summary written", one.listings[0].auto_summary.includes("carnitas"), one.listings[0]);
check("the human's summary survived an agent write",
  one.listings[0].summary === "First pass on the taco pipeline.", one.listings[0]);
await tool("directory_register", {
  handle: "tacos-first-pass", project: "tacos",
  summary: "First pass; landed on carnitas.", ...FIRST,
});
one = await tool("directory_search", { handle: "tacos-first-pass" });
check("summary updated on request", one.listings[0].summary.includes("landed"), one.listings[0]);
check("the agent's account survived a human write",
  one.listings[0].auto_summary.includes("carnitas"), one.listings[0]);

console.log("\n4. a handle may be renamed until it has been contacted");
const ren = await tool("directory_register", {
  handle: "tacos-first-pass-2", project: "tacos",
  rename_to: "tacos-alternate", author: "someone else (Claude Design)",
  role: "first-pass",
});
check("renamed before contact", ren.handle === "tacos-alternate", ren);
check("the contact channel moved with it",
  ren.contact_channel === "agent-tacos-alternate", ren);

console.log("\n5. contacting creates the channel, once");
const contact = await tool("contact_agent", {
  handle: "tacos-first-pass", needs_reply: true, tags: "summary-request",
  body: "Pass your summary on: what did the first pass conclude?", ...LATER,
});
check("the note landed", typeof contact.note_id === "string", contact);
check("the channel was created on first contact",
  contact.channel_created === true && contact.topic === "agent-tacos-first-pass", contact);
check("the reply says plainly that nothing was woken",
  contact.note.includes("Nothing wakes"), contact.note);
check("and hands the user the locator",
  contact.note.includes("claude --resume 7a3f"), contact.note);
const second = await tool("contact_agent", {
  handle: "tacos-first-pass", body: "Still after that summary.", ...LATER,
});
check("a later contact does not re-create it", second.channel_created === false, second);

console.log("\n6. the handle is fixed once it is an address with history");
const lateRename = await tool("directory_register", {
  handle: "tacos-first-pass", project: "tacos",
  rename_to: "tacos-renamed", ...FIRST,
});
check("renaming after contact is refused",
  lateRename.isError === true && lateRename.message.includes("already been contacted"),
  lateRename);

console.log("\n7. list_topics excludes contact channels by anti-join, not by name");
await tool("post_note", {
  topic: "agent-orange", body: "A genuine work topic that looks like one.",
  author: "defoliation researcher",
});
const work = await tool("list_topics", { author: "browser" });
const names = work.topics.map((t) => t.topic);
check("the contact channel is hidden by default",
  !names.includes("agent-tacos-first-pass"), names);
check("a work topic that merely looks like one is NOT hidden",
  names.includes("agent-orange"), names);
const agents = await tool("list_topics", { kind: "agents", author: "browser" });
const agentNames = agents.topics.map((t) => t.topic);
check("kind=agents shows the contact channel",
  agentNames.includes("agent-tacos-first-pass"), agentNames);
check("and excludes the lookalike work topic",
  !agentNames.includes("agent-orange"), agentNames);
const all = await tool("list_topics", { kind: "all", author: "browser" });
check("kind=all shows both",
  ["agent-tacos-first-pass", "agent-orange"].every((n) =>
    all.topics.map((t) => t.topic).includes(n)), all.topics.map((t) => t.topic));
const badKind = await tool("list_topics", { kind: "sideways", author: "browser" });
check("an unknown kind is rejected", badKind.isError === true, badKind);

console.log("\n8. ownership");
const steal = await tool("directory_register", {
  handle: "tacos-first-pass", project: "tacos", summary: "Mine now.", ...LATER,
});
check("a non-owner cannot register over a listing",
  steal.isError === true && steal.message.includes("another agent"), steal);
const badRemove = await tool("directory_remove", { handle: "tacos-first-pass", ...LATER });
check("a non-owner cannot remove one",
  badRemove.isError === true && badRemove.message.includes("another agent"), badRemove);

console.log("\n9. claiming moves ownership and hands over what was waiting");
const RETURNED = { author: "tacos first pass (resumed, new id)", role: "first-pass" };
const claim = await tool("directory_claim", { handle: "tacos-first-pass", ...RETURNED });
check("claimed", claim.claimed === true && claim.moved === true, claim);
check("the mail left while it was not running came back",
  claim.waiting && claim.waiting.new === 2, claim.waiting);
check("including the summary request",
  claim.waiting.notes.some((n) => n.body.includes("what did the first pass conclude")),
  claim.waiting.notes);
check("carrying the untrusted-content notice",
  typeof claim.waiting.notice === "string" && claim.waiting.notice.includes("DATA"));
check("the full auto_summary comes back with the listing",
  claim.listing.auto_summary.includes("carnitas"), claim.listing);
const reclaim = await tool("directory_claim", { handle: "tacos-first-pass", ...RETURNED });
check("a second claim delivers nothing twice", reclaim.waiting.new === 0, reclaim.waiting);
const nowOwner = await tool("directory_register", {
  handle: "tacos-first-pass", project: "tacos", summary: "Owned after claiming.",
  ...RETURNED,
});
check("the claimant may now write to it", nowOwner.registered === true, nowOwner);

console.log("\n10. search ordering and truncation");
const long = "x".repeat(1200);
await tool("directory_register", {
  project: "burritos", summary: "Burrito work, unrelated.",
  auto_summary: long, author: "burrito builder", role: "builder",
});
await tool("directory_register", {
  project: "tacos-adjacent", summary: "Mentions tacos but is its own project.",
  author: "adjacent worker", role: "builder",
});
const found = await tool("directory_search", { q: "tacos" });
check("loose matching finds several candidates", found.count >= 3, found.count);
check("an exact project match sorts first",
  found.listings[0].project === "tacos", found.listings.map((l) => l.project));
check("results carry the untrusted-content notice",
  typeof found.notice === "string" && found.notice.includes("DATA"));
check("and tell the caller to show them to the user",
  found.action.includes("pick the one they mean"), found.action);
const big = await tool("directory_search", { q: "burrito" });
check("a long account is truncated in a list",
  big.listings[0].auto_summary === undefined &&
  big.listings[0].auto_summary_preview.length <= 301, big.listings[0]);
check("and reports its real length",
  big.listings[0].auto_summary_chars === 1200, big.listings[0]);
const whole = await tool("directory_search", { handle: big.listings[0].handle });
check("a single lookup returns it whole",
  whole.listings[0].auto_summary.length === 1200, whole.listings[0].auto_summary.length);
const miss = await tool("directory_search", { q: "nothing-matches-this" });
check("an empty result points at directory_projects",
  miss.count === 0 && miss.action.includes("directory_projects"), miss);

console.log("\n10b. a caller can find the listings it already owns");
const mine = await tool("directory_search", { mine: true, ...RETURNED });
check("mine returns only this identity's listings",
  mine.count === 1 && mine.listings[0].handle === "tacos-first-pass", mine);
const mineAnon = await tool("directory_search", { mine: true });
check("mine without an author is refused", mineAnon.isError === true, mineAnon);

console.log("\n11. projects roll up, for when the project name is what was forgotten");
const projects = await tool("directory_projects", { author: "browser" });
const pnames = projects.projects.map((p) => p.project);
check("every project is listed",
  ["tacos", "burritos", "tacos-adjacent"].every((p) => pnames.includes(p)), pnames);
// Two: tacos-first-pass, and tacos-alternate, which was renamed but kept its
// project. A rename moves the handle and the channel, never the project.
check("with listing counts",
  projects.projects.find((p) => p.project === "tacos").listings === 2, projects.projects);
check("a freshly seen listing reads as live",
  projects.projects.find((p) => p.project === "tacos").status === "live", projects.projects);

console.log("\n12. the REST surface the hooks use");
const restSearch = await restGet("/v1/directory?q=tacos");
check("GET /v1/directory searches", restSearch.status === 200 && restSearch.body.count >= 1,
  restSearch.body);
const restProjects = await restGet("/v1/directory/projects");
check("GET /v1/directory/projects rolls up",
  restProjects.status === 200 && Array.isArray(restProjects.body.projects),
  restProjects.body);
const restTopics = await restGet("/v1/topics?kind=agents");
check("GET /v1/topics?kind=agents filters",
  restTopics.status === 200 &&
  restTopics.body.topics.every((t) => t.topic.startsWith("agent-tacos")),
  restTopics.body.topics);

console.log("\n13. delisting leaves the channel and its history behind");
const removed = await tool("directory_remove", { handle: "tacos-first-pass", ...RETURNED });
check("removed", removed.removed === "tacos-first-pass", removed);
const after = await tool("list_topics", { author: "browser" });
const afterNames = after.topics.map((t) => t.topic);
check("its channel is an ordinary topic again",
  afterNames.includes("agent-tacos-first-pass"), afterNames);
const kept = await tool("read_notes", { topic: "agent-tacos-first-pass", author: "browser" });
check("with its notes intact", kept.count === 2, kept.count);
const gone = await tool("directory_search", { handle: "tacos-first-pass" });
check("but the listing is gone", gone.isError === true, gone);

console.log(failures ? "\n" + failures + " FAILED" : "\nthe directory holds up");
process.exit(failures ? 1 : 0);
