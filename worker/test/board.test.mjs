// End-to-end exercise of the noticeboard worker against a real SQLite,
// driving it through its own HTTP surface exactly as Claude's connector and
// the Claude Code hooks will.
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import worker from "../src/index.js";

const TOKEN = "test-token";
const sqlite = new DatabaseSync(":memory:");
// schema.sql is the whole truth: the suite runs against a database rebuilt
// from it, which is what proves a from-empty rebuild actually serves.
sqlite.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));

class Stmt {
  constructor(sql, args) { this.sql = sql; this.args = args || []; }
  bind(...args) { return new Stmt(this.sql, args.map(norm)); }
  async run() { sqlite.prepare(this.sql).run(...this.args); return { success: true }; }
  async first() { return sqlite.prepare(this.sql).get(...this.args) ?? null; }
  async all() { return { results: sqlite.prepare(this.sql).all(...this.args) }; }
}
function norm(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  return v;
}
const env = {
  BOARD_TOKEN: TOKEN,
  DB: {
    prepare: (sql) => new Stmt(sql),
    batch: async (stmts) => { for (const s of stmts) await s.run(); return []; },
  },
};
const ctx = { waitUntil: (p) => p.catch(() => {}) };

let rpcId = 0;
async function tool(name, args) {
  const req = new Request("https://board.test/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": TOKEN },
    body: JSON.stringify({
      jsonrpc: "2.0", id: ++rpcId,
      method: "tools/call", params: { name, arguments: args },
    }),
  });
  const res = await worker.fetch(req, env, ctx);
  const body = await res.json();
  const text = body.result.content[0].text;
  if (body.result.isError) return { isError: true, message: text };
  return JSON.parse(text);
}
async function restGet(path) {
  const req = new Request("https://board.test" + path, {
    headers: { "x-api-key": TOKEN },
  });
  const res = await worker.fetch(req, env, ctx);
  return { status: res.status, body: await res.json() };
}
// Like tool(), but hands back the raw MCP result so a test can look at the
// content blocks directly - get_attachment returns an image as its own block.
async function rawTool(name, args) {
  const req = new Request("https://board.test/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": TOKEN },
    body: JSON.stringify({
      jsonrpc: "2.0", id: ++rpcId,
      method: "tools/call", params: { name, arguments: args },
    }),
  });
  const res = await worker.fetch(req, env, ctx);
  return (await res.json()).result;
}

let failures = 0;
function check(label, cond, detail) {
  if (cond) { console.log("  ok   " + label); return; }
  failures++;
  console.log("  FAIL " + label + (detail ? "\n       " + JSON.stringify(detail) : ""));
}

const DESIGNER = { author: "aimmorpg designer (Claude Design)", role: "designer" };
const BUILDER = { author: "aimmorpg builder (Claude Code, WSL)", role: "builder" };
const TOPIC = "aimmorpg-design";

console.log("\n1. two sessions join the same channel");
const dj = await tool("join_channel", { topic: TOPIC, ...DESIGNER });
check("designer joined", dj.joined === true, dj);
const bj = await tool("join_channel", { topic: TOPIC, ...BUILDER });
check("builder joined", bj.joined === true, bj);
check("builder sees the designer as a member",
  bj.members.some((m) => m.role === "designer" && m.live), bj.members);

console.log("\n2. designer asks a question, builder gets it unasked");
const q = await tool("post_note", {
  topic: TOPIC, body: "Inventory grid: 4 columns or 5?",
  needs_reply: true, ...DESIGNER,
});
check("question posted", q.posted === true, q);
check("flagged as awaiting a reply", q.awaiting_reply === true, q);
check("designer told the builder is on the channel",
  (q.on_this_channel || []).some((m) => m.startsWith("builder")), q);
check("designer's own note is not echoed back to it", q.inbox === undefined, q.inbox);

// The builder does something ordinary. The inbox rides along with the result.
const bPost = await tool("post_note", {
  topic: TOPIC, body: "Scaffolded the inventory component.", ...BUILDER,
});
check("builder's inbox arrived unasked", bPost.inbox && bPost.inbox.new === 1, bPost.inbox);
check("it is the designer's question",
  bPost.inbox.notes[0].body.includes("4 columns"), bPost.inbox.notes[0]);
check("marked as an open question",
  bPost.inbox.notes[0].awaiting_reply === true, bPost.inbox.notes[0]);
check("carries the untrusted-content notice",
  typeof bPost.inbox.notice === "string" && bPost.inbox.notice.includes("DATA"));

const bAgain = await tool("list_topics", BUILDER);
check("inbox does not repeat what was already delivered",
  bAgain.inbox === undefined, bAgain.inbox);

console.log("\n3. builder answers, designer is waiting and gets it at once");
const r = await tool("reply", {
  note_id: bPost.inbox.notes[0].id, body: "Five. The mock is 5.", ...BUILDER,
});
check("reply accepted", r.replied === true, r);
const waited = await tool("await_message", { topic: TOPIC, timeout_seconds: 3, ...DESIGNER });
check("designer received it while waiting", waited.new === 2, waited);
check("the answer is in there",
  waited.notes.some((n) => n.body.includes("Five")), waited.notes);
check("wait returned immediately, not after the timeout",
  waited.waited_seconds <= 1, waited.waited_seconds);

const empty = await tool("await_message", { topic: TOPIC, timeout_seconds: 3, ...DESIGNER });
check("an empty wait returns nothing new", empty.new === 0, empty);
check("and tells the caller what to do next", typeof empty.next === "string");

console.log("\n4. bugs found in the review");
// Threads stay one level deep, which only works if reply_to is actually read.
const r2 = await tool("reply", { note_id: r.id, body: "Confirmed, 5.", ...DESIGNER });
check("a reply to a reply attaches to the original question",
  r2.in_reply_to === q.id, { got: r2.in_reply_to, want: q.id });
const read = await tool("read_notes", { topic: TOPIC, ...BUILDER });
const question = read.notes.find((n) => n.id === q.id);
check("both replies hang off the question", question && question.replies.length === 2,
  question && question.replies);
check("no reply is stranded as a top-level note",
  !read.notes.some((n) => n.body === "Confirmed, 5."), read.notes.map((n) => n.body));
check("the question is no longer open", question.awaiting_reply === false, question);

const topics = await tool("list_topics", BUILDER);
const t = topics.topics.find((x) => x.topic === TOPIC);
check("note count excludes replies", t.notes === 2, t);
check("replies counted separately", t.replies === 2, t);
check("no open questions left", t.open_questions === 0, t);
check("members listed with liveness",
  t.members.length === 2 && t.members.every((m) => m.includes("(live)")), t.members);

// A bare date as an expiry used to mean midnight, so the note was born expired.
const today = new Date().toISOString().slice(0, 10);
const exp = await tool("post_note", {
  topic: "expiry-check", body: "CI is down.", expires_at: today,
  author: "tester",
});
check("a bare date expires at the end of that day",
  exp.expires_at === today + "T23:59:59.999Z", exp.expires_at);
const visible = await tool("read_notes", { topic: "expiry-check", author: "reader" });
check("so the note is still visible today", visible.count === 1, visible);
const badDate = await tool("post_note", {
  topic: "expiry-check", body: "x", expires_at: "next tuesday", author: "tester",
});
check("an unreadable date is rejected rather than stored",
  badDate.isError === true, badDate);

console.log("\n5. identity without a claimed role");
const anon = await tool("post_note", {
  topic: TOPIC, body: "Drive-by note from a Cowork run.",
  author: "Cowork recruitment automation",
});
check("posting works with no role at all", anon.posted === true, anon);
const designerSees = await tool("list_topics", DESIGNER);
check("and the drive-by note still reaches the designer",
  designerSees.inbox && designerSees.inbox.new === 1, designerSees.inbox);
check("a first post here does not silently swallow the backlog",
  typeof anon.first_post_here === "string" && anon.first_post_here.includes("join_channel"),
  anon.first_post_here);
// Something happens on the channel after the drive-by session first spoke.
await tool("post_note", {
  topic: TOPIC, body: "Noted, thanks.", ...DESIGNER,
});
const anonAgain = await tool("post_note", {
  topic: TOPIC, body: "Second drive-by note.",
  author: "Cowork recruitment automation",
});
check("and the warning is not repeated once subscribed",
  anonAgain.first_post_here === undefined, anonAgain.first_post_here);
check("the author-only session now has a working inbox",
  anonAgain.inbox && anonAgain.inbox.notes.some((n) => n.body === "Noted, thanks."),
  anonAgain.inbox);
const freshTopic = await tool("post_note", {
  topic: "brand-new-topic", body: "Nothing here before me.", author: "a runner",
});
check("no warning on a topic with no history",
  freshTopic.first_post_here === undefined, freshTopic.first_post_here);

console.log("\n6. the hook surface, following the real join-then-poll flow");
// A hook joins as its own author (SessionStart), which catches it up. Then a
// new note lands, and its zero-wait inbox poll (Stop) must deliver just that.
const hookJoin = await restGet("/v1/join?topic=" + TOPIC +
  "&role=observer&author=hook-observer");
check("hooks can join over plain HTTP", hookJoin.body.joined === true, hookJoin);
await tool("post_note", { topic: TOPIC, body: "landed after the hook joined",
  author: "someone after the hook" });
const hookInbox = await restGet("/v1/inbox?author=hook-observer&topic=" + TOPIC);
check("hooks can poll an inbox over plain HTTP", hookInbox.status === 200, hookInbox);
check("and it returns only what arrived since it joined",
  hookInbox.body.new === 1 &&
  hookInbox.body.notes[0].body.includes("landed after"),
  hookInbox.body);
check("hook inbox returns at once, it does not hold the session",
  hookInbox.body.waited_seconds === 0, hookInbox.body);

console.log("\n7. auth and logging");
const noAuth = await worker.fetch(
  new Request("https://board.test/mcp", { method: "POST", body: "{}" }), env, ctx);
check("unauthenticated requests 404", noAuth.status === 404, noAuth.status);
const pathAuth = await worker.fetch(new Request("https://board.test/mcp/" + TOKEN, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 99, method: "tools/list" }),
}), env, ctx);
check("path auth still works", pathAuth.status === 200, pathAuth.status);
const logged = sqlite.prepare("SELECT path FROM hits WHERE path LIKE '/mcp/%'").all();
check("the token is never written into the hits log",
  logged.every((h) => !h.path.includes(TOKEN)), logged);
const withOrigin = await worker.fetch(new Request("https://board.test/mcp", {
  method: "POST", headers: { "x-api-key": TOKEN, Origin: "https://evil.test" },
  body: "{}",
}), env, ctx);
check("a browser Origin is refused", withOrigin.status === 403, withOrigin.status);

const tools = await worker.fetch(new Request("https://board.test/mcp", {
  method: "POST", headers: { "content-type": "application/json", "x-api-key": TOKEN },
  body: JSON.stringify({ jsonrpc: "2.0", id: 100, method: "tools/list" }),
}), env, ctx);
const listed = (await tools.json()).result.tools.map((t) => t.name);
check("nineteen tools advertised", listed.length === 19, listed);
check("my_channels and leave_channel are advertised",
  listed.includes("my_channels") && listed.includes("leave_channel"), listed);
check("attach and get_attachment are advertised",
  listed.includes("attach") && listed.includes("get_attachment"), listed);
check("the six directory tools are advertised",
  ["directory_register", "directory_search", "directory_projects",
   "directory_claim", "contact_agent", "directory_remove"]
    .every((t) => listed.includes(t)), listed);

console.log("\n8. membership: a chat knows and controls what it follows");
const M = { author: "multi-home designer (Design)", role: "designer" };
await tool("join_channel", { topic: "home-one", ...M });
await tool("join_channel", { topic: "home-two", ...M });
const mine = await tool("my_channels", M);
check("my_channels reports both memberships", mine.member_of === 2, mine);
check("each carries the role label",
  mine.channels.every((c) => c.role === "designer"), mine.channels);
const left = await tool("leave_channel", { topic: "home-one", ...M });
check("leaving a channel succeeds", left.left === true, left);
check("and it reports what is still followed",
  left.still_following.includes("home-two") &&
  !left.still_following.includes("home-one"), left);
const mine2 = await tool("my_channels", M);
check("my_channels now shows only the remaining channel",
  mine2.member_of === 1 && mine2.channels[0].topic === "home-two", mine2);
// A note lands on the channel it left; it must not reach its inbox anymore.
await tool("post_note", { topic: "home-one", body: "after you left",
  author: "someone else" });
const afterLeave = await tool("list_topics", M);
check("a left channel no longer feeds the inbox",
  !afterLeave.inbox || !afterLeave.inbox.notes.some((n) => n.topic === "home-one"),
  afterLeave.inbox);

console.log("\n9. identity: same role on two projects does not cross-wire");
const alpha = { author: "proj-alpha designer (Design)", role: "designer" };
const beta = { author: "proj-beta designer (Design)", role: "designer" };
await tool("join_channel", { topic: "proj-alpha", ...alpha });
await tool("join_channel", { topic: "proj-beta", ...beta });
// Traffic on beta, from someone other than alpha.
await tool("post_note", { topic: "proj-beta", body: "beta-only note",
  author: "proj-beta builder" });
const alphaInbox = await tool("list_topics", alpha);
check("the alpha designer never sees beta's traffic",
  !alphaInbox.inbox || !alphaInbox.inbox.notes.some((n) => n.topic === "proj-beta"),
  alphaInbox.inbox);
const betaInbox = await tool("my_channels", beta);
check("the beta designer is a member of beta only, not alpha",
  betaInbox.member_of === 1 && betaInbox.channels[0].topic === "proj-beta",
  betaInbox);

console.log("\n10. attachments: hand a whole file across without pasting it");
// A text file - the common case: a source file or mockup too big for a note.
const svg = "<svg xmlns='http://www.w3.org/2000/svg' width='10' height='10'></svg>";
const att = await tool("attach", {
  topic: TOPIC, filename: "inventory.svg", content: svg,
  note: "Here is the grid mock.", ...DESIGNER,
});
check("attach stored the file", att.attached === true, att);
check("it reports a fetchable id, name and byte size",
  att.attachment_id.startsWith("att_") && att.filename === "inventory.svg" &&
  att.size === new TextEncoder().encode(svg).length, att);
check("content type inferred from the extension",
  att.content_type === "image/svg+xml", att);

// The builder, doing something ordinary, gets the marker on its inbox but
// never the bytes.
const bSees = await tool("list_topics", BUILDER);
const marker = ((bSees.inbox && bSees.inbox.notes) || [])
  .flatMap((n) => n.attachments || [])
  .find((a) => a.attachment_id === att.attachment_id);
check("the marker rides the inbox", !!marker, bSees.inbox);
check("the marker carries name and size, not the bytes",
  marker && marker.filename === "inventory.svg" &&
  marker.content === undefined && marker.content_base64 === undefined, marker);

// The builder fetches the bytes on purpose - the only call that pulls them in.
const got = await tool("get_attachment", { attachment_id: att.attachment_id, ...BUILDER });
check("get_attachment returns the exact text", got.content === svg, got);
check("with metadata and the untrusted-content notice",
  got.attachment.filename === "inventory.svg" &&
  typeof got.notice === "string" && got.notice.includes("DATA"), got);

// A hook can fetch the same file over plain HTTP.
const restAtt = await restGet(
  "/v1/attachment?attachment_id=" + att.attachment_id + "&author=hook-observer");
check("hooks can fetch an attachment over plain HTTP",
  restAtt.status === 200 && restAtt.body.content === svg, restAtt);

// A binary file goes in as base64; the size is measured on the real bytes.
const raw = "hello\x00world";                       // 11 bytes, includes a NUL
const b64 = Buffer.from(raw, "binary").toString("base64");
const bin = await tool("attach", {
  topic: TOPIC, filename: "blob.bin", content_base64: b64, ...BUILDER,
});
check("a binary attachment stores by decoded byte size", bin.size === 11, bin);
const gotBin = await tool("get_attachment", { attachment_id: bin.attachment_id, ...DESIGNER });
check("and comes back as base64 that decodes to the original",
  Buffer.from(gotBin.content_base64, "base64").toString("binary") === raw, gotBin);

// An image comes back as a viewable image block, not just bytes.
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4" +
            "2mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const imgAtt = await tool("attach", {
  topic: TOPIC, filename: "px.png", content_base64: png, ...DESIGNER,
});
check("png type inferred from the extension", imgAtt.content_type === "image/png", imgAtt);
const imgRes = await rawTool("get_attachment", { attachment_id: imgAtt.attachment_id, ...BUILDER });
check("an image comes back as a viewable image block",
  imgRes.content.some((c) => c.type === "image" &&
    c.mimeType === "image/png" && c.data === png),
  imgRes.content.map((c) => c.type));

// Guards.
const both = await tool("attach", {
  topic: TOPIC, filename: "x.txt", content: "a", content_base64: b64, ...DESIGNER,
});
check("passing both content and content_base64 is rejected", both.isError === true, both);
const neither = await tool("attach", { topic: TOPIC, filename: "x.txt", ...DESIGNER });
check("passing neither is rejected", neither.isError === true, neither);
const badB64 = await tool("attach", {
  topic: TOPIC, filename: "x.bin", content_base64: "!!! not base64 !!!", ...DESIGNER,
});
check("invalid base64 is rejected", badB64.isError === true, badB64);
const tooBig = await tool("attach", {
  topic: TOPIC, filename: "big.txt", content: "x".repeat(256 * 1024 + 1), ...DESIGNER,
});
check("a file over the size cap is rejected", tooBig.isError === true, tooBig);
const missing = await tool("get_attachment", { attachment_id: "att_nope", ...DESIGNER });
check("fetching an unknown id errors", missing.isError === true, missing);

console.log(failures ? "\n" + failures + " FAILED\n" : "\nall passed\n");
process.exit(failures ? 1 : 0);
