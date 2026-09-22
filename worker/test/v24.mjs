// v2.4: briefs, attachment versions, closing and ageing questions, and push
// notifications to the board's owner. Driven through the worker's own HTTP
// surface against a database rebuilt from schema.sql. Notifications go to a
// stand-in for ntfy that records what the worker tried to send, so nothing
// here ever reaches a real phone.
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
const DB = { prepare: (s) => new Stmt(s),
             batch: async (ss) => { for (const s of ss) await s.run(); return []; } };
const env = { BOARD_TOKEN: TOKEN, DB, NTFY_TOPIC: "lantern-violet-timber",
              NTFY_SERVER: "https://ntfy.test" };
const ctx = { waitUntil: (p) => p.catch(() => {}) };

// The stand-in for ntfy. Every POST the worker makes is recorded; `mode`
// makes it fail or throw when a test needs that.
const pushes = [];
let mode = "ok";
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (String(url).startsWith("https://ntfy.test")) {
    if (mode === "throw") throw new Error("network down");
    pushes.push({ url: String(url), body: JSON.parse(init.body), headers: init.headers });
    return new Response("{}", { status: mode === "fail" ? 500 : 200 });
  }
  return realFetch(url, init);
};
const lastPush = () => pushes[pushes.length - 1];

let rpcId = 0;
async function tool(name, args, e = env) {
  const req = new Request("https://board.test/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": TOKEN },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call",
                           params: { name, arguments: args } }),
  });
  const body = await (await worker.fetch(req, e, ctx)).json();
  const text = body.result.content[0].text;
  if (body.result.isError) return { isError: true, message: text };
  return JSON.parse(text);
}
async function rest(method, path, payload, e = env) {
  const req = new Request("https://board.test" + path, {
    method, headers: { "x-api-key": TOKEN, "content-type": "application/json" },
    body: payload ? JSON.stringify(payload) : undefined,
  });
  const res = await worker.fetch(req, e, ctx);
  return { status: res.status, body: await res.json() };
}
async function tick(at) {
  const waits = [];
  await worker.scheduled({ scheduledTime: at, cron: "*/5 * * * *" }, env,
                         { waitUntil: (p) => waits.push(p) });
  await Promise.all(waits);
}
const sql = (q, ...a) => sqlite.prepare(q).run(...a);
const daysAgo = (d) => new Date(Date.now() - d * 86400000).toISOString();

let failures = 0;
function check(label, cond, detail) {
  if (cond) { console.log("  ok   " + label); return; }
  failures++;
  console.log("  FAIL " + label + (detail !== undefined ? "\n       " + JSON.stringify(detail) : ""));
}

const A = { author: "q3-report writer (Claude)", role: "writer" };
const B = { author: "q3-report researcher (Claude Code)", role: "researcher" };

console.log("\n1. a brief for each channel");
let g = await tool("get_brief", { topic: "q3-report", ...A });
check("no brief yet says how to write one", g.brief === null && g.next.includes("set_brief"), g);
let s1 = await tool("set_brief", { topic: "q3-report", base_version: 0,
  body: "Goal: the Q3 report.\nDecisions: none yet.", ...A });
check("first write is version 1", s1.updated === true && s1.version === 1, s1);
g = await tool("get_brief", { topic: "q3-report", ...B });
check("reads back with its version and author",
  g.brief.version === 1 && g.brief.body.startsWith("Goal") && g.brief.updated_by === A.author, g);
check("behind the untrusted-content notice", g.brief.notice.includes("DATA"));
const marker = sqlite.prepare("SELECT body, tags FROM notes WHERE topic = 'q3-report' AND tags = 'brief'").all();
check("a short marker note tells the channel it changed",
  marker.length === 1 && marker[0].body === "Updated the brief (v1)." && !marker[0].body.includes("Goal"), marker);
const s2 = await tool("set_brief", { topic: "q3-report", base_version: 1,
  body: "Goal: the Q3 report.\nDecisions: lead with revenue.", ...B });
check("an update from the current version is accepted", s2.updated === true && s2.version === 2, s2);
const stale = await tool("set_brief", { topic: "q3-report", base_version: 1,
  body: "Goal: something else entirely.", ...A });
check("a write from an out-of-date version is refused",
  stale.updated === false && stale.conflict === true && stale.current_version === 2, stale);
check("and hands back the current brief to merge into",
  stale.current.body.includes("lead with revenue"), stale.current);
g = await tool("get_brief", { topic: "q3-report", ...A });
check("the refused write changed nothing", g.brief.version === 2 && g.brief.body.includes("revenue"), g.brief);
const over = await tool("set_brief", { topic: "q3-report", body: "x".repeat(6001), ...A });
check("a brief over 6,000 characters is refused", over.isError && over.message.includes("6000"), over);
const forced = await tool("set_brief", { topic: "q3-report", body: "Overwritten on purpose.", ...A });
check("leaving out base_version overwrites, as documented", forced.updated && forced.version === 3, forced);
const j = await tool("join_channel", { topic: "q3-report", ...{ author: "q3-report editor (Cowork)", role: "editor" } });
const keys = Object.keys(j);
check("join_channel returns the brief", j.brief && j.brief.version === 3, j.brief);
check("before the catch-up", keys.indexOf("brief") < keys.indexOf("catch_up"), keys);
const rg = await rest("GET", "/v1/brief?topic=q3-report");
const rp = await rest("POST", "/v1/brief", { topic: "q3-report", base_version: 3, body: "Via REST.", ...A });
check("GET and POST /v1/brief work", rg.body.brief.version === 3 && rp.body.version === 4, [rg.body, rp.body]);

console.log("\n2. versions of an attachment");
const v1 = await tool("attach", { topic: "q3-report", filename: "outline.md", content: "first", ...A });
const v2 = await tool("attach", { topic: "q3-report", filename: "outline.md", content: "second", ...A });
const other = await tool("attach", { topic: "q3-report", filename: "notes.md", content: "n", ...A });
const elsewhere = await tool("attach", { topic: "another-topic", filename: "outline.md", content: "x", ...A });
check("the first is version 1", v1.version === 1 && v1.supersedes === undefined, v1);
check("the same name again is version 2, superseding the first",
  v2.version === 2 && v2.supersedes === v1.attachment_id, v2);
check("a different name starts again at 1", other.version === 1, other);
check("the same name on another topic starts again at 1", elsewhere.version === 1, elsewhere);
let ga = await tool("get_attachment", { topic: "q3-report", filename: "outline.md" });
check("by name gets the latest", ga.content === "second" && ga.attachment.version === 2 && ga.attachment.versions === 2, ga.attachment);
ga = await tool("get_attachment", { topic: "q3-report", filename: "outline.md", version: 1 });
check("by name and version gets that one", ga.content === "first" && ga.attachment.newer_version_exists === true, ga.attachment);
ga = await tool("get_attachment", { attachment_id: v1.attachment_id });
check("by id still works, and says a newer one exists",
  ga.content === "first" && ga.attachment.version === 1 && ga.attachment.newer_version_exists === true, ga.attachment);
const nope = await tool("get_attachment", { topic: "q3-report", filename: "outline.md", version: 3 });
check("a version that does not exist is refused, saying how many there are",
  nope.isError && nope.message.includes("2 version"), nope);
const rn = await tool("read_notes", { topic: "q3-report", author: "reader" });
const markers = rn.notes.flatMap((n) => n.attachments || []).filter((m) => m.filename === "outline.md");
const m1 = markers.find((m) => m.attachment_id === v1.attachment_id);
const m2 = markers.find((m) => m.attachment_id === v2.attachment_id);
check("markers show their version", m1.version === 1 && m2.version === 2, markers);
check("and flag the stale one", m1.newer_version_exists === true && m2.newer_version_exists === undefined, markers);

// Two versions written in the same millisecond must still number in the
// order they were written. Forced here, because it happens only by chance.
const tie1 = await tool("attach", { topic: "ties", filename: "same.md", content: "written first", ...A });
const tie2 = await tool("attach", { topic: "ties", filename: "same.md", content: "written second", ...A });
sql("UPDATE attachments SET created_at = ? WHERE id IN (?, ?)", "2026-01-01T00:00:00.000Z", tie1.attachment_id, tie2.attachment_id);
const tieLatest = await tool("get_attachment", { topic: "ties", filename: "same.md" });
const tieFirst = await tool("get_attachment", { topic: "ties", filename: "same.md", version: 1 });
check("a tie on the timestamp still puts them in the order written",
  tieLatest.content === "written second" && tieFirst.content === "written first",
  [tieFirst.content, tieLatest.content]);

console.log("\n3. closing questions without answering");
const q1 = await tool("post_note", { topic: "q3-report", body: "Include Q2 comparisons?", needs_reply: true, ...A });
let lt = (await tool("list_topics", { author: "x" })).topics.find((t) => t.topic === "q3-report");
check("the question counts as open", lt.open_questions === 1, lt);
const c1 = await tool("close_question", { note_id: q1.id, reason: "no_longer_needed", ...B });
check("closed with a reason", c1.closed === true && c1.reason === "no longer needed" && c1.closed_by === B.author, c1);
lt = (await tool("list_topics", { author: "x" })).topics.find((t) => t.topic === "q3-report");
check("it no longer counts as open", lt.open_questions === 0, lt);
const thread = (await tool("read_notes", { topic: "q3-report", author: "x" })).notes.find((n) => n.id === q1.id);
check("reading it shows who closed it and why",
  thread.closed && thread.closed.reason === "no longer needed" && thread.closed.closed_by === B.author, thread.closed);
check("and the thread carries a reply saying so",
  thread.replies.some((r) => r.body === "Closed this question: no longer needed." && r.author === B.author), thread.replies);
const askerInbox = await tool("post_note", { topic: "q3-report", body: "Drafting.", ...A });
check("the session that asked hears about it on its next call",
  askerInbox.inbox && askerInbox.inbox.notes.some((n) => n.body.startsWith("Closed this question")), askerInbox.inbox);
check("closing it again is refused",
  (await tool("close_question", { note_id: q1.id, reason: "no_longer_needed", ...B })).isError);
check("an unknown reason is refused, listing the valid ones",
  (await tool("close_question", { note_id: askerInbox.id, reason: "meh", ...B })).message.includes("answered_elsewhere"));
check("a note that is not a question cannot be closed",
  (await tool("close_question", { note_id: askerInbox.id, reason: "no_longer_needed", ...B })).message.includes("not a question"));
const q2 = await tool("post_note", { topic: "q3-report", body: "Which chart style?", needs_reply: true, ...A });
const byOwner = await tool("close_question", { note_id: q2.id, reason: "decided_by_owner", detail: "Bar charts.", ...B });
check("the owner's decision reads as the board's owner, not a name",
  byOwner.reason === "decided by the board's owner", byOwner);

console.log("\n4. replacing your own question");
const q3 = await tool("post_note", { topic: "q3-report", body: "Due Friday?", needs_reply: true, ...A });
const before = sqlite.prepare("SELECT COUNT(*) AS n FROM notes").get().n;
const theirs = await tool("post_note", { topic: "q3-report", body: "Due Monday?", needs_reply: true, replaces: q3.id, ...B });
check("someone else's question cannot be replaced", theirs.isError && theirs.message.includes("your own"), theirs);
const noQ = await tool("post_note", { topic: "q3-report", body: "Due Monday.", replaces: q3.id, ...A });
check("replacing needs needs_reply", noQ.isError && noQ.message.includes("needs_reply"), noQ);
check("and a refused replacement writes nothing",
  sqlite.prepare("SELECT COUNT(*) AS n FROM notes").get().n === before);
const q4 = await tool("post_note", { topic: "q3-report", body: "Due Monday instead?", needs_reply: true, replaces: q3.id, ...A });
check("your own question is replaced", q4.posted && q4.replaced === q3.id, q4);
const old = (await tool("read_notes", { topic: "q3-report", author: "x" })).notes.find((n) => n.id === q3.id);
check("the old one is closed as replaced, pointing at the new one",
  old.closed.reason === "replaced by a newer question" && old.closed.detail.includes(q4.id), old.closed);

console.log("\n5. questions that age");
const sOld = await tool("post_note", { topic: "ageing", body: "Old question?", needs_reply: true, ...A });
const sNew = await tool("post_note", { topic: "ageing", body: "Recent question?", needs_reply: true, ...A });
sql("UPDATE notes SET created_at = ? WHERE id = ?", daysAgo(8), sOld.id);
sql("UPDATE notes SET created_at = ? WHERE id = ?", daysAgo(6), sNew.id);
const aged = (await tool("read_notes", { topic: "ageing", author: "x" })).notes;
const o8 = aged.find((n) => n.id === sOld.id), o6 = aged.find((n) => n.id === sNew.id);
check("eight days open is stale, and says how long", o8.stale === true && o8.open_days === 8, o8);
check("six days open is not", o6.stale === undefined && o6.open_days === 6, o6);
lt = (await tool("list_topics", { author: "x" })).topics.find((t) => t.topic === "ageing");
check("list_topics counts it", lt.stale_questions === 1, lt);
const mc = (await tool("my_channels", A)).channels.find((c) => c.topic === "ageing");
check("my_channels counts it", mc.stale_questions === 1, mc);
const ja = await tool("join_channel", { topic: "ageing", author: "ageing reviewer (Claude)", role: "reviewer" });
check("joining the channel says to answer or close it",
  ja.stale_questions === 1 && ja.tidy_up.includes("close_question"), ja);
check("nothing is closed automatically", o8.awaiting_reply === true);

console.log("\n6. notifications to the board's owner");
pushes.length = 0;
await tool("directory_register", { project: "q3-report", summary: "Research for the Q3 report.",
  handle: "q3-researcher", ...B });
const contact = await tool("contact_agent", { handle: "q3-researcher", body: "SECRET-TEXT please send the numbers", ...A });
check("a message left for a listing notifies the owner", contact.owner_notified === "sent" && pushes.length === 1, pushes);
check("naming who left it and for whom", lastPush().body.message === "q3-report writer (Claude) left a message for q3-researcher", lastPush().body);
check("never the message itself", !JSON.stringify(pushes).includes("SECRET-TEXT"));
check("to the configured topic, titled Noticeboard",
  lastPush().body.topic === "lantern-violet-timber" && lastPush().body.title === "Noticeboard", lastPush().body);
check("with no link of any kind", !("click" in lastPush().body) && !("actions" in lastPush().body), lastPush().body);

const owner = await tool("post_note", { topic: "launch", body: "SECRET-TEXT sign off?", needs_owner: true, ...A });
check("a note that needs the owner notifies them", owner.owner_notified === "sent" &&
  lastPush().body.message === "q3-report writer (Claude) needs you on launch", lastPush().body);
const tagged = sqlite.prepare("SELECT tags FROM notes WHERE id = ?").get(owner.id);
check("and is tagged needs-owner on the board", tagged.tags === "needs-owner", tagged);

pushes.length = 0;
const lonely = await tool("post_note", { topic: "lonely", body: "Anyone?", needs_reply: true, ...A });
check("a question where nobody else is running notifies the owner",
  lonely.owner_notified === "sent" && lastPush().body.message.includes("nobody there is running"), pushes);
pushes.length = 0;
await tool("join_channel", { topic: "busy", ...B });
const answered = await tool("post_note", { topic: "busy", body: "Quick question?", needs_reply: true, ...A });
check("a question where someone else is live does not", answered.owner_notified === undefined && pushes.length === 0, pushes);
const plain = await tool("post_note", { topic: "lonely", body: "Progress note.", ...A });
check("an ordinary note never does", plain.owner_notified === undefined && pushes.length === 0, pushes);

console.log("\n7. throttling and the schedule");
// Earlier sections leave held notifications on other channels; clear them so
// this section measures the throttle on its own.
sql("DELETE FROM push_state");
pushes.length = 0;
const t1 = await tool("post_note", { topic: "throttle", body: "one", needs_owner: true, ...A });
const t2 = await tool("post_note", { topic: "throttle", body: "two", needs_owner: true, ...B });
const t3 = await tool("post_note", { topic: "throttle", body: "three", needs_owner: true, ...A });
check("the first goes straight out", t1.owner_notified === "sent");
check("the next ones inside five minutes are held", t2.owner_notified === "batched" && t3.owner_notified === "batched");
check("so only one notification was sent", pushes.length === 1, pushes);
await tick(Date.now() + 2 * 60000);
check("a scheduled run inside the window sends nothing", pushes.length === 1, pushes);
await tick(Date.now() + 6 * 60000);
check("once the window has passed, one summary goes out",
  pushes.length === 2 && lastPush().body.message === "2 more on throttle", pushes);
await tick(Date.now() + 12 * 60000);
check("and it is not sent again", pushes.length === 2, pushes);

pushes.length = 0;
const monday = (() => {
  const d = new Date(Date.now() + 86400000);
  d.setUTCHours(1, 2, 0, 0);
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
  return d.getTime();
})();
await tick(monday);
check("the weekly digest goes out at the configured hour",
  pushes.length === 1 && /^\d+ questions? open over a week: /.test(lastPush().body.message), pushes);
// How many of the ageing questions count depends on how far ahead the next
// Monday is, so this checks the channel is named with a count, not the number.
check("naming the channels with stale questions", /ageing \(\d\)/.test(lastPush().body.message), lastPush().body);
await tick(monday + 5 * 60000);
check("and only once, however often the schedule runs", pushes.length === 1, pushes);
await tick(monday + 86400000);
check("not on other days", pushes.length === 1, pushes);

console.log("\n8. what a notification may contain");
pushes.length = 0;
await tool("post_note", { topic: "safety", needs_owner: true, body: "x",
  author: "evil https://phish.example/login www.phish.example (Claude)", role: "x" });
const msg = lastPush().body.message;
check("URLs in a session's name are removed", !msg.includes("://") && !msg.includes("www"), msg);
check("and no dots survive for a phone to turn into a link", !msg.includes("."), msg);

console.log("\n9. when notifications are off or failing");
pushes.length = 0;
const off = { ...env, NTFY_TOPIC: "" };
const quiet = await tool("post_note", { topic: "launch", body: "x", needs_owner: true, ...A }, off);
check("with no topic set, nothing is sent", quiet.posted && quiet.owner_notified === undefined && pushes.length === 0);
mode = "throw";
const down = await tool("post_note", { topic: "down", body: "x", needs_owner: true, ...A });
check("an unreachable notification server never fails the call", down.posted === true, down);
mode = "fail";
const refused = await tool("post_note", { topic: "refused", body: "x", needs_owner: true, ...A });
check("nor does one that refuses the message", refused.posted === true && refused.owner_notified === undefined, refused);
mode = "ok";

console.log("\n10. the setup test endpoint");
pushes.length = 0;
const nt = await rest("POST", "/v1/notify/test");
check("sends a test through the real path", nt.status === 200 && nt.body.configured && nt.body.sent, nt.body);
check("and never reveals the topic", !JSON.stringify(nt.body).includes("lantern"), nt.body);
check("with no token, sends no authorization", !("authorization" in lastPush().headers), lastPush().headers);
const withToken = { ...env, NTFY_TOKEN: " tk_testtoken000000000000000000 \n" };
const ntTok = await rest("POST", "/v1/notify/test", null, withToken);
check("with a token, sends it as a bearer token, trimmed",
      lastPush().headers.authorization === "Bearer tk_testtoken000000000000000000", lastPush().headers);
check("and never reveals the token", !JSON.stringify(ntTok.body).includes("tk_"), ntTok.body);
const ntOff = await rest("POST", "/v1/notify/test", null, off);
check("says so when notifications are not set up", ntOff.body.configured === false && ntOff.body.sent === false, ntOff.body);
check("GET is refused", (await rest("GET", "/v1/notify/test")).status === 405);
const rc = await rest("POST", "/v1/close", { note_id: sOld.id, reason: "answered_elsewhere", ...B });
check("POST /v1/close closes a question", rc.body.closed === true, rc.body);

console.log(failures ? "\n" + failures + " FAILED" : "\nv2.4 holds up");
process.exit(failures ? 1 : 0);
