#!/usr/bin/env node
// Stands up a noticeboard on your own Cloudflare account: SETUP.md steps 3
// to 10, and 13 and 14 if asked, in one run. Run it yourself and it asks what it
// needs; or have Claude Code run it with the answers as options, since Claude
// cannot type into a prompt.
//
//   node setup.mjs                              asks as it goes
//   node setup.mjs --workers-dev --hooks        no questions
//   node setup.mjs --domain board.example.com
//   node setup.mjs --check                      re-run the checks only
//   node setup.mjs --dry-run --workers-dev      say what would happen
//   node setup.mjs --notify                     add push notifications
//   node setup.mjs --notify --notify-topic X    ...to the private topic X
//   node setup.mjs --notify-test                send a test notification
//
// Things it cannot do, because only a person can: create the Cloudflare
// token (SETUP.md step 2), add the connector in Claude (step 11), paste the
// preferences block (step 12), and, for notifications, set up the ntfy.sh
// account, its private topic and its token, and sign in on a phone (step 14).
// It never asks for a token to be typed: you save each one to a file with the
// one-liner in its step, and it reads the file.
//
// It refuses to touch a board it did not create in this checkout. Running it
// over an existing board would replace that board's key and cut off every
// session using it, so every check in assessExisting fails closed.

import {
  readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, chmodSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createInterface } from "node:readline/promises";

const ROOT = dirname(fileURLToPath(import.meta.url));
const WORKER = join(ROOT, "worker");
const API = "https://api.cloudflare.com/client/v4";
const UA = "claude-noticeboard-setup/1.0";
const NTFY = "https://ntfy.sh";
const MARKER = "# written by setup.mjs";
const HOOK_EVENTS = [
  ["SessionStart", "session-start", 15, null],
  ["PostToolUse", "post-edit", 5, "Edit|Write|MultiEdit|NotebookEdit"],
  ["Stop", "stop", 20, null],
];

export const PATHS = {
  cfToken: () => join(homedir(), ".config/cloudflare/token"),
  boardKey: () => join(homedir(), ".config/claude-noticeboard/token"),
  settings: () => join(homedir(), ".claude/settings.json"),
  hookDir: () => join(homedir(), ".claude/hooks"),
  ntfyTopic: () => join(homedir(), ".config/claude-noticeboard/ntfy-topic"),
  ntfyToken: () => join(homedir(), ".config/ntfy/token"),
};

export class SetupError extends Error {
  constructor(message, hint) { super(message); this.hint = hint; }
}

// ------------------------------------------------------------ pure parts
// Exported so setup.test.mjs can exercise them without a network or an
// account. Everything that decides what gets written lives here.

export function parseArgs(argv) {
  const o = { name: "claude-noticeboard", hooks: null, notify: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (!v || v.startsWith("--")) throw new SetupError(a + " needs a value");
      return v;
    };
    if (a === "--workers-dev") o.workersDev = true;
    else if (a === "--domain") o.domain = val().toLowerCase();
    else if (a === "--name") o.name = val();
    else if (a === "--account-id") o.accountId = val();
    else if (a === "--hooks") o.hooks = true;
    else if (a === "--no-hooks") o.hooks = false;
    else if (a === "--check") o.check = true;
    else if (a === "--notify") o.notify = true;
    else if (a === "--no-notify") o.notify = false;
    else if (a === "--notify-topic") { o.notify = true; o.notifyTopic = val(); }
    else if (a === "--notify-test") o.notifyTest = true;
    else if (a === "--dry-run") o.dryRun = true;
    else if (a === "--help" || a === "-h") o.help = true;
    else throw new SetupError("unknown option: " + a, "Run node setup.mjs --help");
  }
  if (o.workersDev && o.domain) {
    throw new SetupError("choose --workers-dev or --domain, not both");
  }
  // The name becomes a DNS label on workers.dev, so it is held to those rules.
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(o.name)) {
    throw new SetupError("--name must be lowercase letters, digits and dashes, " +
                         "not starting or ending with a dash");
  }
  if (o.notifyTopic) checkTopicName(o.notifyTopic);
  if (o.domain && !/^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(o.domain)) {
    throw new SetupError("--domain should be a hostname like board.example.com, " +
                         "with no https:// and no path");
  }
  return o;
}

export function readState(toml) {
  if (!toml) return null;
  const pick = (re) => { const m = re.exec(toml); return m ? m[1] : null; };
  return {
    ours: toml.includes(MARKER),
    name: pick(/^name\s*=\s*"([^"]+)"/m),
    databaseId: pick(/^database_id\s*=\s*"([^"]+)"/m),
    boardUrl: pick(/^# board_url = (\S+)/m),
    domain: /^\[\[routes\]\]/m.test(toml) ? pick(/^pattern\s*=\s*"([^"]+)"/m) : null,
  };
}

export function renderToml({ name, databaseId, domain, boardUrl, compatibilityDate,
                             digest = digestTime() }) {
  const lines = [
    MARKER + ". Re-running setup.mjs reads this file to pick up",
    "# where it left off, so edit it by hand only if you know you need to.",
    "# board_url = " + boardUrl,
    "",
    `name = "${name}"`,
    `main = "src/index.js"`,
    `compatibility_date = "${compatibilityDate}"`,
    "",
    `workers_dev = ${domain ? "false" : "true"}`,
  ];
  if (domain) {
    lines.push("", "[[routes]]", `pattern = "${domain}"`, "custom_domain = true");
  }
  lines.push(
    "", "[[d1_databases]]", `binding = "DB"`,
    `database_name = "${name}"`, `database_id = "${databaseId}"`,
    "",
    "# Every five minutes: batched notification summaries, and the weekly",
    "# digest of stale questions when the day and hour below come round.",
    "[triggers]", `crons = ["*/5 * * * *"]`,
    "",
    "# Monday 09:00 on the installer's clock, in UTC.",
    "[vars]", `DIGEST_UTC_DAY = "${digest.day}"`, `DIGEST_UTC_HOUR = "${digest.hour}"`,
    "");
  return lines.join("\n");
}

// Decides whether it is safe to go ahead, from what this checkout's
// wrangler.toml says and what already exists in the account. Every refusal
// here protects a board that is already running: setting up over it would
// replace its key and cut off every session using it.
export function assessExisting({ state, dbs, scriptIds, name }) {
  const inAccount = (id) => dbs.some((d) => d.uuid === id);
  if (state && state.databaseId && inAccount(state.databaseId)) {
    if (!state.ours) {
      throw new SetupError(
        "worker/wrangler.toml belongs to a board that already exists in your account",
        "This checkout is configured for a live board, and setting up over it " +
        "would replace its key. To upgrade that board, follow README.md, " +
        "'Operating'. To set up another one, use a fresh copy of the repository.");
    }
    if (state.name !== name) {
      throw new SetupError(
        `this checkout already set up the board "${state.name}"`,
        `Run with --name ${state.name} to finish or check that one, or use a ` +
        "fresh copy of the repository for a second board.");
    }
    return { resuming: true };
  }
  if (state && state.ours && state.name === name && state.databaseId) {
    throw new SetupError(
      "the database this checkout was set up with no longer exists",
      "Restore worker/wrangler.toml with git, then run this again.");
  }
  const clash = dbs.some((d) => d.name === name) ? "database"
    : scriptIds.includes(name) ? "worker" : null;
  if (clash) {
    throw new SetupError(
      `a ${clash} called "${name}" already exists in this account`,
      "Setting up over it would replace that board's key. Use --name to " +
      "choose a different name, or README.md 'Operating' to upgrade it.");
  }
  return { resuming: false };
}

// Monday 09:00 on this machine's clock, expressed as a UTC day (0 = Sunday)
// and hour, because Cloudflare's scheduler runs on UTC. tzOffset is
// Date.getTimezoneOffset(): minutes to add to local time to reach UTC.
export function digestTime(tzOffset = new Date().getTimezoneOffset()) {
  const week = 7 * 1440;
  const utc = (((1 * 1440 + 9 * 60 + tzOffset) % week) + week) % week;
  return { day: Math.floor(utc / 1440), hour: Math.floor((utc % 1440) / 60) };
}

// ntfy topic names are letters, digits, '-' and '_', up to 64 characters.
// The topic is reserved as private, so its name needs no secrecy.
export function checkTopicName(name) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(name || ""))) {
    throw new SetupError(
      "a topic name is 1 to 64 letters, digits, dashes or underscores");
  }
  return name;
}

// ntfy access tokens start tk_. Checking the shape first turns a pasted
// password, or the wrong token, into a clear message rather than a refusal.
export function checkNtfyToken(token) {
  if (!/^tk_[A-Za-z0-9]{20,}$/.test(String(token || ""))) {
    throw new SetupError(
      "the file at " + PATHS.ntfyToken() + " does not hold an ntfy access token",
      "ntfy access tokens start tk_. Create one on ntfy.sh under Account -> " +
      "Access tokens (SETUP.md step 14.3) and save it again.");
  }
  return token;
}

export function privateTopics(account) {
  return ((account && account.reservations) || [])
    .filter((r) => r.everyone === "deny-all").map((r) => r.topic);
}

// Decides the topic from what ntfy.sh says about the token's account, before
// anything is stored. A free account is refused: ntfy.sh counts a free
// account's messages per sending address, and a Worker shares its addresses,
// so every notification would be turned away. The topic must be one the
// account has reserved as private.
export function chooseNtfyTopic(account, requested) {
  if (!account || account.role === "anonymous" || !account.username) {
    throw new SetupError("ntfy.sh did not accept the token",
      "Check the whole token is in " + PATHS.ntfyToken() + ", and that it has " +
      "not been deleted or expired (SETUP.md step 14.3).");
  }
  if (!account.tier || !account.limits || account.limits.basis !== "tier") {
    throw new SetupError("this ntfy.sh account has no paid plan",
      "ntfy.sh counts a free account's messages per sending address, and the " +
      "board sends from addresses shared with other Cloudflare customers, so " +
      "its notifications would be refused. Any paid plan works (SETUP.md step 14.1).");
  }
  const reserved = privateTopics(account);
  const topic = requested || (reserved.length === 1 ? reserved[0] : null);
  if (!topic) {
    throw new SetupError(
      reserved.length ? "this account has " + reserved.length + " private topics"
                      : "this account has no private topic yet",
      reserved.length ? "Choose one with --notify-topic: " + reserved.join(", ")
                      : "Reserve one so only you can publish and subscribe (SETUP.md step 14.2).");
  }
  checkTopicName(topic);
  if (!reserved.includes(topic)) {
    throw new SetupError(topic + " is not a private topic on this account",
      "On ntfy.sh, under Account -> Reserved topics, reserve it so only you can " +
      "publish and subscribe (SETUP.md step 14.2)." +
      (reserved.length ? " Private topics now: " + reserved.join(", ") : ""));
  }
  return topic;
}

// base64url, so the key is safe in the /mcp/<key> path form, and no newline,
// because the worker compares the key exactly.
export function generateBoardKey() {
  return randomBytes(32).toString("base64url");
}

function hookCommand(mode) {
  return `python3 -S -E "$HOME/.claude/hooks/board_hook.py" ${mode}`;
}

// Adds the board to a settings object without disturbing anything already
// there. Idempotent: an entry that already runs board_hook.py for that event
// is left alone, so a second run changes nothing. An existing BOARD_URL that
// points somewhere else is left alone too, with a warning, because silently
// re-pointing somebody's hooks at a different board would be a nasty surprise.
export function mergeHookSettings(existing, boardUrl) {
  const s = existing ? JSON.parse(JSON.stringify(existing)) : {};
  const changes = [];
  const warnings = [];
  if (typeof s.env !== "object" || s.env === null) s.env = {};
  if (!s.env.BOARD_URL) {
    s.env.BOARD_URL = boardUrl;
    changes.push("set BOARD_URL");
  } else if (s.env.BOARD_URL.replace(/\/+$/, "") !== boardUrl) {
    warnings.push(
      "BOARD_URL is already set to " + s.env.BOARD_URL + ", so it was left " +
      "alone and your hooks still point there. Change it by hand to use " +
      "this board instead.");
  }
  if (typeof s.hooks !== "object" || s.hooks === null) s.hooks = {};
  for (const [event, mode, timeout, matcher] of HOOK_EVENTS) {
    const list = Array.isArray(s.hooks[event]) ? s.hooks[event] : (s.hooks[event] = []);
    const runs = new RegExp("board_hook\\.py\"?\\s+" + mode + "(\\s|$)");
    const present = list.some((group) => (group.hooks || []).some(
      (h) => typeof h.command === "string" && runs.test(h.command)));
    if (present) continue;
    // matcher first, so the file reads the same as the example in SETUP.md.
    const hook = [{ type: "command", timeout, command: hookCommand(mode) }];
    list.push(matcher ? { matcher, hooks: hook } : { hooks: hook });
    changes.push("added the " + event + " hook");
  }
  return { settings: s, changes, warnings };
}

// ------------------------------------------------------------ plumbing

const interactive = () => Boolean(process.stdin.isTTY && process.stdout.isTTY);
const say = (m = "") => process.stdout.write(m + "\n");
let stepNo = 0;
const STEPS = 10;
const step = (m) => say(`\n[${++stepNo}/${STEPS}] ${m}`);
const done = (m) => say("      " + m);

async function ask(question, fallback) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const a = (await rl.question("      " + question)).trim();
    return a || fallback;
  } finally {
    rl.close();
  }
}

async function cf(token, path, { method = "GET", body } = {}) {
  let res, data = null;
  try {
    res = await fetch(API + path, {
      method,
      headers: { Authorization: "Bearer " + token, "content-type": "application/json",
                 "user-agent": UA },
      body: body ? JSON.stringify(body) : undefined,
    });
    data = await res.json();
  } catch (e) {
    if (!res) throw new SetupError("could not reach the Cloudflare API: " + e.message);
  }
  return { ok: Boolean(res.ok && data && data.success !== false), status: res.status, data };
}

function cfErrors(r) {
  const errs = (r.data && r.data.errors) || [];
  return errs.map((e) => (e.code ? e.code + ": " : "") + e.message).join("; ") ||
         "HTTP " + r.status;
}

let wranglerFound;
function wranglerCmd() {
  if (!wranglerFound) {
    const probe = spawnSync("wrangler", ["--version"], { encoding: "utf8" });
    wranglerFound = probe.status === 0 ? ["wrangler"] : ["npx", "--yes", "wrangler"];
  }
  return wranglerFound;
}

function wrangler(args, env, input) {
  const [cmd, ...pre] = wranglerCmd();
  const r = spawnSync(cmd, [...pre, ...args], {
    cwd: WORKER, encoding: "utf8", input,
    env: { ...process.env, ...env, WRANGLER_SEND_METRICS: "false", CI: "1" },
    maxBuffer: 20 * 1024 * 1024,
  });
  return { ok: r.status === 0, out: (r.stdout || "") + (r.stderr || "") };
}

function tail(text, n = 12) {
  return text.trim().split("\n").slice(-n).map((l) => "        | " + l).join("\n");
}

// A new hostname can take a little while to answer, a custom domain's
// certificate longer, and a secret takes a moment to reach the running
// worker. So each check retries rather than failing on the first miss.
async function until(fn, seconds) {
  const end = Date.now() + seconds * 1000;
  let last;
  while (Date.now() < end) {
    try { last = await fn(); if (last === true) return true; } catch (e) { last = e.message; }
    await new Promise((r) => setTimeout(r, 4000));
  }
  return last === true ? true : (last || "no answer");
}

async function boardCall(boardUrl, key, method, extra) {
  const headers = { "content-type": "application/json", "user-agent": UA };
  if (key) headers["x-api-key"] = key;
  const res = await fetch(boardUrl + "/mcp", {
    method: "POST", headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: extra || {} }),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

export async function checkBoard(boardUrl, key, seconds = 120) {
  const results = [];
  const record = (label, outcome) => {
    results.push({ label, pass: outcome === true, detail: outcome });
    return outcome === true;
  };
  const health = await until(async () => {
    const r = await fetch(boardUrl + "/health", { headers: { "user-agent": UA } });
    return r.ok && (await r.json()).ok === true;
  }, seconds);
  if (!record("the board answers at " + boardUrl, health)) return results;
  record("it refuses a request without the board key", await until(async () =>
    (await boardCall(boardUrl, null, "initialize")).status === 404, 60));
  record("it accepts the board key", await until(async () => {
    const r = await boardCall(boardUrl, key, "initialize");
    return r.status === 200 && r.body && r.body.result && r.body.result.serverInfo
      ? true : "HTTP " + r.status;
  }, 60));
  const list = await boardCall(boardUrl, key, "tools/list").catch(() => null);
  const count = list && list.body && list.body.result ? list.body.result.tools.length : 0;
  record(`it offers its tools (${count})`, count > 0 ? true : "none listed");
  return results;
}

// ------------------------------------------------------------ the run

function help() {
  // The comment block at the top of this file is the help text, however long
  // it grows.
  const lines = readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1);
  const end = lines.findIndex((l) => !l.startsWith("//"));
  say(lines.slice(0, end).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
}

function loadCloudflareToken() {
  if (process.env.CLOUDFLARE_API_TOKEN) return process.env.CLOUDFLARE_API_TOKEN.trim();
  const file = PATHS.cfToken();
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  throw new SetupError(
    "no Cloudflare token found at " + file,
    "Create one (SETUP.md step 2) and save it with:\n" +
    `  mkdir -p ~/.config/cloudflare && install -m 600 /dev/null ~/.config/cloudflare/token && ` +
    `read -rsp "Cloudflare token: " t && printf '%s' "$t" > ~/.config/cloudflare/token && unset t && echo " saved"`);
}

async function runChecks(boardUrl, key) {
  const results = await checkBoard(boardUrl, key);
  for (const r of results) {
    done((r.pass ? "ok     " : "NOT YET") + "  " + r.label +
         (r.pass ? "" : "  (" + r.detail + ")"));
  }
  return results.every((r) => r.pass);
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) return help();

  if (Number(process.versions.node.split(".")[0]) < 18) {
    throw new SetupError("Node.js 18 or newer is needed; this is " + process.version);
  }
  if (!existsSync(join(WORKER, "src/index.js"))) {
    throw new SetupError("run this from the noticeboard repository: " +
                         "worker/src/index.js is not next to it");
  }

  const tomlPath = join(WORKER, "wrangler.toml");
  const toml = existsSync(tomlPath) ? readFileSync(tomlPath, "utf8") : null;
  const state = readState(toml);

  if (o.notifyTest) {
    if (!state || !state.ours || !state.boardUrl) {
      throw new SetupError("no board set up by setup.mjs in this checkout");
    }
    const key = existsSync(PATHS.boardKey()) ? readFileSync(PATHS.boardKey(), "utf8").trim() : "";
    if (!key) throw new SetupError("no board key at " + PATHS.boardKey());
    const r = await testNotification(state.boardUrl, key, 30);
    say(r.sent ? "Sent. It should be on your phone now."
      : r.configured === false ? "Notifications are not set up yet: node setup.mjs --notify"
      : "The notification server did not accept it (" + (r.reason || "HTTP " + r.status) + ").");
    return r.sent ? 0 : 2;
  }

  if (o.check) {
    if (!state || !state.ours || !state.boardUrl) {
      throw new SetupError("nothing to check: this checkout has no board " +
                           "set up by setup.mjs");
    }
    const key = existsSync(PATHS.boardKey()) ? readFileSync(PATHS.boardKey(), "utf8").trim() : "";
    if (!key) throw new SetupError("no board key at " + PATHS.boardKey());
    say("Checking " + state.boardUrl);
    return (await runChecks(state.boardUrl, key)) ? 0 : 2;
  }

  // 1. The Cloudflare token, confirmed live before anything else uses it.
  step("Checking your Cloudflare token");
  const token = loadCloudflareToken();
  const verify = await cf(token, "/user/tokens/verify");
  if (!verify.ok) {
    throw new SetupError(
      "Cloudflare does not recognise that token (" + cfErrors(verify) + ")",
      "It should start with cfut_ and be about 53 characters. If not, you " +
      "saved something else. SETUP.md step 2.");
  }
  done("valid and active");

  // 2. Which account.
  step("Finding your Cloudflare account");
  let accountId = o.accountId || process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!accountId) {
    const r = await cf(token, "/accounts");
    if (!r.ok) throw new SetupError("could not list your accounts (" + cfErrors(r) + ")");
    const accounts = r.data.result || [];
    if (accounts.length === 1) {
      accountId = accounts[0].id;
    } else if (accounts.length > 1 && interactive()) {
      accounts.forEach((a, i) => done(`${i + 1}. ${a.name}`));
      const pick = Number(await ask("Which account? ", "1"));
      accountId = (accounts[pick - 1] || {}).id;
    }
    if (!accountId) {
      throw new SetupError("this token can see " + accounts.length + " accounts",
                           "Say which with --account-id <id>.");
    }
  }
  done("account " + accountId);

  // 3. Where the board lives.
  step("Choosing the board's address");
  let domain = o.domain;
  // Re-running on a board this checkout already set up needs no address
  // flags: the config it wrote remembers where the board lives.
  if (!domain && !o.workersDev && state && state.ours && state.name === o.name) {
    if (state.domain) domain = state.domain;
    else o.workersDev = true;
  }
  if (!domain && !o.workersDev) {
    if (!interactive()) {
      throw new SetupError("choose where the board lives",
                           "Pass --workers-dev, or --domain board.example.com.");
    }
    done("1. workers.dev (no domain of your own needed)");
    done("2. a domain of your own on this Cloudflare account");
    const choice = await ask("1 or 2? ", "1");
    if (choice === "2") {
      domain = (await ask("Hostname, e.g. board.example.com: ", "")).toLowerCase();
      parseArgs(["--domain", domain]);
    }
  }
  let boardUrl;
  if (domain) {
    boardUrl = "https://" + domain;
  } else {
    const r = await cf(token, `/accounts/${accountId}/workers/subdomain`);
    const sub = r.ok && r.data.result && r.data.result.subdomain;
    if (!sub) {
      throw new SetupError(
        "this account has no workers.dev subdomain yet",
        "Open Workers & Pages in the Cloudflare dashboard once; Cloudflare " +
        "creates one automatically. Then run this again.");
    }
    boardUrl = `https://${o.name}.${sub}.workers.dev`;
  }
  done(boardUrl);

  // 4. The guards. Both fail closed: running over a board this checkout did
  // not create would replace its key and cut off every session using it.
  step("Making sure this will not touch an existing board");
  const dbs = await cf(token, `/accounts/${accountId}/d1/database?per_page=100`);
  const scripts = await cf(token, `/accounts/${accountId}/workers/scripts`);
  if (!dbs.ok || !scripts.ok) {
    throw new SetupError("could not list your databases and workers (" +
                         cfErrors(dbs.ok ? scripts : dbs) + ")");
  }
  const allDbs = dbs.data.result || [];
  // The API's name filter matches loosely, so assessExisting compares exactly.
  const { resuming } = assessExisting({
    state, dbs: allDbs, name: o.name,
    scriptIds: (scripts.data.result || []).map((x) => x.id),
  });
  done(resuming ? "picking up where the last run left off" : "nothing called " + o.name + " yet");

  const hooks = o.hooks !== null ? o.hooks
    : interactive() ? /^y/i.test(await ask("Also install the Claude Code hooks? [y/N] ", "n"))
    : false;
  const notify = o.notify !== null ? o.notify
    : interactive() ? /^y/i.test(await ask(
        "Set up push notifications to your phone (needs a paid ntfy.sh account)? [y/N] ", "n"))
    : false;
  // Checked now, so a token or topic problem stops the run before anything
  // is created rather than at the end.
  const ntfy = notify ? await prepareNotifications(o) : null;

  if (o.dryRun) {
    say("\nDry run. Nothing has been created. This would:");
    say(resuming ? "  - reuse database " + state.databaseId
                 : `  - create a D1 database called ${o.name}`);
    say("  - write worker/wrangler.toml for " + boardUrl);
    say("  - load schema.sql, deploy the worker, and give it a board key");
    say(hooks ? "  - install the Claude Code hooks" : "  - leave the hooks alone");
    say(notify ? "  - send push notifications to the ntfy.sh topic " + ntfy.topic
               : "  - leave notifications off");
    return 0;
  }

  // 5. The database, created through the API so no wrangler prompt can add a
  // second, conflicting binding to the config.
  step("Creating the database");
  let databaseId = resuming ? state.databaseId : null;
  if (!databaseId) {
    const r = await cf(token, `/accounts/${accountId}/d1/database`,
                       { method: "POST", body: { name: o.name } });
    if (!r.ok) throw new SetupError("could not create the database (" + cfErrors(r) + ")");
    databaseId = r.data.result.uuid;
    done("created " + o.name);
  } else {
    done("already there");
  }

  const example = readFileSync(join(WORKER, "wrangler.toml.example"), "utf8");
  const compatibilityDate = (/^compatibility_date\s*=\s*"([^"]+)"/m.exec(example) || [])[1]
    || "2026-09-01";
  writeFileSync(tomlPath, renderToml({ name: o.name, databaseId, domain, boardUrl,
                                       compatibilityDate, digest: digestTime() }));
  done("wrote worker/wrangler.toml");

  const wenv = { CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: accountId };

  // 6. Schema. Every statement in schema.sql is CREATE ... IF NOT EXISTS, so a
  // second run is harmless.
  step("Loading the schema");
  const schema = wrangler(["d1", "execute", o.name, "--remote", "--file", "schema.sql", "-y"], wenv);
  if (!schema.ok) {
    throw new SetupError("loading schema.sql failed:\n" + tail(schema.out),
                         "SETUP.md step 7 covers the usual causes.");
  }
  done("tables created");

  // 7. Deploy.
  step("Deploying the worker");
  const deploy = wrangler(["deploy"], wenv);
  if (!deploy.ok) {
    throw new SetupError("wrangler deploy failed:\n" + tail(deploy.out),
                         domain ? "For a custom domain, check the domain is a zone in this " +
                                  "account and the hostname has no CNAME record."
                                : undefined);
  }
  done("deployed");

  // 8. The board key. An existing key file is reused rather than replaced,
  // because the hooks read that one file and replacing it would strand
  // whatever already uses it.
  step("Giving the board its key");
  const keyFile = PATHS.boardKey();
  let key;
  if (existsSync(keyFile) && readFileSync(keyFile, "utf8").trim()) {
    key = readFileSync(keyFile, "utf8").trim();
    done("reusing the board key already in " + keyFile);
  } else {
    key = generateBoardKey();
    mkdirSync(dirname(keyFile), { recursive: true, mode: 0o700 });
    writeFileSync(keyFile, key, { mode: 0o600 });
    chmodSync(keyFile, 0o600);
    done("generated a new board key in " + keyFile);
  }
  const secret = wrangler(["secret", "put", "BOARD_TOKEN"], wenv, key);
  if (!secret.ok) throw new SetupError("setting the board key failed:\n" + tail(secret.out));
  done("stored as the worker's BOARD_TOKEN secret");

  // 9. Hooks, if asked for.
  step(hooks ? "Installing the Claude Code hooks" : "Skipping the Claude Code hooks");
  if (hooks) installHooks(boardUrl);
  else done("run again with --hooks to add them, or see SETUP.md step 13");

  step(notify ? "Setting up push notifications" : "Skipping push notifications");
  let notifyResult = null;
  if (notify) notifyResult = await setupNotifications(ntfy, wenv, boardUrl, key);
  else done("run again with --notify to add them, or see SETUP.md step 14");

  say("\nChecking the board end to end (a new address can take a minute to answer)");
  const healthy = await runChecks(boardUrl, key);

  say("\n" + "=".repeat(70));
  say(healthy ? "Your board is ready." : "Your board is deployed, but not answering yet.");
  if (!healthy) {
    say("A new address can take a few minutes. Check again with:  node setup.mjs --check");
  }
  say("\nTwo things only you can do, in Claude's settings:\n");
  say("1. Add a custom connector (Settings -> Connectors):");
  say("     Server URL:  " + boardUrl + "/mcp");
  say("     Header:      name x-api-key, value your BOARD KEY");
  say("   Show the board key in your own terminal (not in a chat) with:");
  say("     cat ~/.config/claude-noticeboard/token; echo");
  say("   The 'Checking server' probe will fail. That is expected; carry on.");
  say("\n2. Paste the block from PREFERENCES.md into Settings -> Profile ->");
  say("   personal preferences.");
  say("\nThen start a new chat to see the board's tools.");
  if (notifyResult && notifyResult.topic) {
    say("\nNotifications: in the ntfy app, sign in to ntfy.sh (Settings -> Users)");
    say("and subscribe to  " + notifyResult.topic);
  }
  return healthy ? 0 : 2;
}

async function testNotification(boardUrl, key, seconds) {
  // The secret reaches the running worker a few seconds after it is set, so
  // this retries until the board reports notifications as configured.
  let last = {};
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) {
    try {
      const res = await fetch(boardUrl + "/v1/notify/test", {
        method: "POST", headers: { "x-api-key": key, "user-agent": UA },
      });
      last = await res.json();
      if (last.configured) return last;
    } catch (e) {
      last = { sent: false, reason: e.message };
    }
    await new Promise((r) => setTimeout(r, 4000));
  }
  return last;
}

async function prepareNotifications(o) {
  const file = PATHS.ntfyToken();
  if (!existsSync(file)) {
    throw new SetupError("no ntfy token found at " + file,
      "Create one (SETUP.md step 14.3) and save it with:\n" +
      `  mkdir -p ~/.config/ntfy && install -m 600 /dev/null ~/.config/ntfy/token && ` +
      `read -rsp "ntfy token: " t && printf '%s' "$t" > ~/.config/ntfy/token && unset t && echo " saved"`);
  }
  const token = checkNtfyToken(readFileSync(file, "utf8").trim());
  let account;
  try {
    const res = await fetch(NTFY + "/v1/account", {
      headers: { authorization: "Bearer " + token, "user-agent": UA },
    });
    account = await res.json();
  } catch (e) {
    throw new SetupError("could not reach ntfy.sh: " + e.message);
  }
  let requested = o.notifyTopic;
  const reserved = privateTopics(account);
  if (!requested && reserved.length > 1 && interactive()) {
    requested = await ask("Which private topic? (" + reserved.join(", ") + ") ", reserved[0]);
  }
  const topic = chooseNtfyTopic(account, requested);
  done("ntfy.sh: paid account, private topic " + topic);
  return { token, topic };
}

async function setupNotifications(ntfy, wenv, boardUrl, key) {
  for (const [name, value] of [["NTFY_TOKEN", ntfy.token], ["NTFY_TOPIC", ntfy.topic]]) {
    const r = wrangler(["secret", "put", name], wenv, value);
    if (!r.ok) throw new SetupError("setting " + name + " failed:\n" + tail(r.out));
  }
  const file = PATHS.ntfyTopic();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, ntfy.topic, { mode: 0o600 });
  chmodSync(file, 0o600);
  done("the token and topic are on the board; the topic is saved in " + file);
  done("");
  done("On your phone, in the ntfy app: Settings -> Users, add one for");
  done("https://ntfy.sh with your ntfy.sh username and password. Then tap +");
  done("and subscribe to:");
  done("");
  done("      " + ntfy.topic);
  done("");
  if (interactive()) await ask("Press Enter once you have subscribed, to send a test... ", "");
  const r = await testNotification(boardUrl, key, 60);
  if (r.sent) {
    done("test notification sent" + (interactive() ? " - it should be on your phone now" : ""));
  } else {
    done("the test was not delivered (" + (r.reason || (r.status ? "HTTP " + r.status : "no answer")) + ")");
  }
  if (!interactive()) {
    done("If you had not subscribed yet, do that, then: node setup.mjs --notify-test");
  }
  return { topic: ntfy.topic, sent: !!r.sent };
}

export function installHooks(boardUrl) {
  const py = spawnSync("python3", ["--version"], { encoding: "utf8" });
  if (py.status !== 0) {
    done("python3 is not installed, and the hooks need it. Skipped.");
    return;
  }
  mkdirSync(PATHS.hookDir(), { recursive: true });
  copyFileSync(join(ROOT, "hooks/board_hook.py"), join(PATHS.hookDir(), "board_hook.py"));
  done("copied board_hook.py to " + PATHS.hookDir());

  const file = PATHS.settings();
  let existing = null;
  if (existsSync(file)) {
    const raw = readFileSync(file, "utf8");
    if (raw.trim()) {
      try {
        existing = JSON.parse(raw);
      } catch (e) {
        done("~/.claude/settings.json is not valid JSON, so it was left alone.");
        done("Fix it, then add the hooks by hand: SETUP.md step 13.4B.");
        return;
      }
    }
  }
  const { settings, changes, warnings } = mergeHookSettings(existing, boardUrl);
  for (const w of warnings) done("note: " + w);
  if (!changes.length) {
    done("settings.json already had everything; left unchanged");
    return;
  }
  if (existing) {
    const backup = file + ".bak-" + new Date().toISOString().replace(/[:.]/g, "-");
    copyFileSync(file, backup);
    done("backed up your settings to " + backup);
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
  done("settings.json: " + changes.join(", "));
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().then((code) => process.exit(code || 0)).catch((e) => {
    process.stderr.write("\nSetup stopped: " + e.message + "\n");
    if (e.hint) process.stderr.write(e.hint + "\n");
    process.exit(1);
  });
}
