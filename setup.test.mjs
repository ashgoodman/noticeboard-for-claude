// Tests for setup.mjs: everything that decides what gets written, with no
// network and no Cloudflare account. The guards get the most attention,
// because they are what stands between this script and replacing the key
// of a board somebody is already using.
import { readFileSync } from "node:fs";
import {
  parseArgs, readState, renderToml, assessExisting, generateBoardKey,
  mergeHookSettings, SetupError, digestTime, checkTopicName, checkNtfyToken,
  chooseNtfyTopic,
} from "./setup.mjs";

let failures = 0;
function check(label, cond, detail) {
  if (cond) { console.log("  ok   " + label); return; }
  failures++;
  console.log("  FAIL " + label + (detail !== undefined ? "\n       " + JSON.stringify(detail) : ""));
}
function throws(fn, includes) {
  try { fn(); return false; } catch (e) {
    return e instanceof SetupError && (!includes || e.message.includes(includes));
  }
}

const BOARD = "https://claude-noticeboard.example.workers.dev";

console.log("\n1. options");
check("defaults", parseArgs([]).name === "claude-noticeboard" && parseArgs([]).hooks === null);
check("--workers-dev", parseArgs(["--workers-dev"]).workersDev === true);
check("--domain is lowercased", parseArgs(["--domain", "Board.Example.COM"]).domain === "board.example.com");
check("--domain refuses a URL", throws(() => parseArgs(["--domain", "https://board.example.com"]), "hostname"));
check("--domain refuses a path", throws(() => parseArgs(["--domain", "board.example.com/mcp"]), "hostname"));
check("not both kinds of address", throws(() => parseArgs(["--workers-dev", "--domain", "a.example.com"]), "not both"));
check("--name must be a DNS label", throws(() => parseArgs(["--name", "-bad"]), "--name"));
check("--name accepts a dashed name", parseArgs(["--name", "my-board-2"]).name === "my-board-2");
check("an option missing its value is caught", throws(() => parseArgs(["--domain"]), "needs a value"));
check("unknown options are caught", throws(() => parseArgs(["--yolo"]), "unknown option"));

console.log("\n2. the config it writes");
const dev = renderToml({ name: "claude-noticeboard", databaseId: "db-1", domain: null,
                         boardUrl: BOARD, compatibilityDate: "2026-09-01" });
const custom = renderToml({ name: "claude-noticeboard", databaseId: "db-2",
                            domain: "board.example.com", boardUrl: "https://board.example.com",
                            compatibilityDate: "2026-09-01" });
check("workers.dev config turns workers_dev on", dev.includes("workers_dev = true") && !dev.includes("[[routes]]"));
check("custom-domain config turns it off and adds the route",
  custom.includes("workers_dev = false") && custom.includes('pattern = "board.example.com"') &&
  custom.includes("custom_domain = true"));
check("the database binding is DB, as the worker expects", dev.includes('binding = "DB"'));
const round = readState(dev);
check("it reads its own config back",
  round.ours && round.name === "claude-noticeboard" && round.databaseId === "db-1" &&
  round.boardUrl === BOARD, round);
// A config written by hand for an existing board, with no setup.mjs marker.
const handWritten = readState([
  'name = "claude-noticeboard"', 'main = "src/index.js"',
  '[[routes]]', 'pattern = "board.example.com"', 'custom_domain = true',
  '[[d1_databases]]', 'binding = "DB"', 'database_name = "claude-noticeboard"',
  'database_id = "11111111-2222-3333-4444-555555555555"'].join("\n"));
check("a hand-written config for an existing board is not mistaken for its own",
  handWritten.ours === false && handWritten.databaseId.startsWith("1111"), handWritten);
const example = readState(readFileSync(new URL("./worker/wrangler.toml.example", import.meta.url), "utf8"));
check("nor is the example", example.ours === false && example.databaseId === "YOUR_DATABASE_ID", example);

console.log("\n3. the guards");
const liveDb = { uuid: "live-uuid", name: "claude-noticeboard" };
check("refuses a checkout configured for a board in this account",
  throws(() => assessExisting({ state: { ours: false, name: "claude-noticeboard", databaseId: "live-uuid" },
                                dbs: [liveDb], scriptIds: ["claude-noticeboard"], name: "claude-noticeboard" }),
         "already exists in your account"));
check("...even when asked for a different name",
  throws(() => assessExisting({ state: { ours: false, name: "claude-noticeboard", databaseId: "live-uuid" },
                                dbs: [liveDb], scriptIds: [], name: "another-board" }),
         "already exists in your account"));
check("a stranger's clone, whose shipped config names a database they do not have, goes ahead",
  assessExisting({ state: { ours: false, name: "claude-noticeboard", databaseId: "somebody-elses" },
                   dbs: [], scriptIds: [], name: "claude-noticeboard" }).resuming === false);
check("refuses when a database by that name already exists",
  throws(() => assessExisting({ state: example, dbs: [liveDb], scriptIds: [], name: "claude-noticeboard" }),
         'database called "claude-noticeboard"'));
check("refuses when a worker by that name already exists",
  throws(() => assessExisting({ state: example, dbs: [], scriptIds: ["claude-noticeboard"], name: "claude-noticeboard" }),
         'worker called "claude-noticeboard"'));
check("does not treat a similar name as a clash",
  assessExisting({ state: example, dbs: [{ uuid: "x", name: "claude-noticeboard-old" }],
                   scriptIds: ["claude-noticeboard-old"], name: "claude-noticeboard" }).resuming === false);
check("picks up its own half-finished run",
  assessExisting({ state: { ours: true, name: "claude-noticeboard", databaseId: "mine" },
                   dbs: [{ uuid: "mine", name: "claude-noticeboard" }], scriptIds: ["claude-noticeboard"],
                   name: "claude-noticeboard" }).resuming === true);
check("will not set up a second board over the first in the same checkout",
  throws(() => assessExisting({ state: { ours: true, name: "first-board", databaseId: "mine" },
                                dbs: [{ uuid: "mine", name: "first-board" }], scriptIds: [], name: "second-board" }),
         'already set up the board "first-board"'));
check("says so when its own database has been deleted",
  throws(() => assessExisting({ state: { ours: true, name: "claude-noticeboard", databaseId: "gone" },
                                dbs: [], scriptIds: [], name: "claude-noticeboard" }),
         "no longer exists"));

console.log("\n4. the board key");
const k = generateBoardKey();
check("43 characters", k.length === 43, k.length);
check("safe in a URL path: no / + or =", /^[A-Za-z0-9_-]+$/.test(k));
check("no trailing newline", !/\s/.test(k));
check("different every time", generateBoardKey() !== k);

console.log("\n5. hook settings");
const fresh = mergeHookSettings(null, BOARD);
check("from nothing: BOARD_URL set", fresh.settings.env.BOARD_URL === BOARD);
check("from nothing: all three hooks added",
  ["SessionStart", "PostToolUse", "Stop"].every((e) => fresh.settings.hooks[e].length === 1));
check("commands use $HOME, so they are the same for everyone",
  fresh.settings.hooks.Stop[0].hooks[0].command === 'python3 -S -E "$HOME/.claude/hooks/board_hook.py" stop');

// The script and SETUP.md 13.4A must describe the same settings. If either
// changes without the other, this fails.
const setup = readFileSync(new URL("./SETUP.md", import.meta.url), "utf8");
const block = setup.slice(setup.indexOf("### 13.4A"), setup.indexOf("### 13.4B"));
const documented = JSON.parse(/```json\n([\s\S]*?)```/.exec(block)[1]);
const documentedWithUrl = { ...documented, env: { BOARD_URL: BOARD } };
check("matches the block SETUP.md tells people to paste",
  JSON.stringify(documentedWithUrl) === JSON.stringify(fresh.settings),
  { documented: documentedWithUrl, script: fresh.settings });

const exampleFile = JSON.parse(readFileSync(new URL("./hooks/settings.example.json", import.meta.url), "utf8"));
check("matches hooks/settings.example.json too",
  JSON.stringify(exampleFile.hooks) === JSON.stringify(fresh.settings.hooks),
  { example: exampleFile.hooks, script: fresh.settings.hooks });
check("and the example uses a placeholder address, not a real board",
  exampleFile.env.BOARD_URL === "https://board.example.com", exampleFile.env);

const theirs = {
  permissions: { allow: ["Bash(npm test)"] },
  env: { SOMETHING_ELSE: "1" },
  hooks: { Stop: [{ hooks: [{ type: "command", command: "my-other-tool --on-stop" }] }] },
};
const merged = mergeHookSettings(theirs, BOARD);
check("keeps their other settings", merged.settings.permissions.allow[0] === "Bash(npm test)");
check("keeps their other env vars", merged.settings.env.SOMETHING_ELSE === "1");
check("keeps their existing Stop hook first",
  merged.settings.hooks.Stop[0].hooks[0].command === "my-other-tool --on-stop");
check("and adds the board's after it",
  merged.settings.hooks.Stop.length === 2 &&
  merged.settings.hooks.Stop[1].hooks[0].command.includes("board_hook.py\" stop"));
check("does not change the object it was given", theirs.hooks.Stop.length === 1 && !theirs.env.BOARD_URL);

const again = mergeHookSettings(merged.settings, BOARD);
check("a second run changes nothing", again.changes.length === 0, again.changes);

const absolute = {
  env: { BOARD_URL: BOARD },
  hooks: Object.fromEntries([["SessionStart", "session-start"], ["PostToolUse", "post-edit"], ["Stop", "stop"]]
    .map(([e, m]) => [e, [{ hooks: [{ type: "command", command: `python3 -S -E "/home/someone/.claude/hooks/board_hook.py" ${m}` }] }]])),
};
check("recognises hooks already installed with an absolute path",
  mergeHookSettings(absolute, BOARD).changes.length === 0, mergeHookSettings(absolute, BOARD).changes);

const elsewhere = mergeHookSettings({ env: { BOARD_URL: "https://some-other-board.example.com" } }, BOARD);
check("never re-points hooks already aimed at another board",
  elsewhere.settings.env.BOARD_URL === "https://some-other-board.example.com");
check("and says so", elsewhere.warnings.length === 1 && elsewhere.warnings[0].includes("left"));

console.log("\n5b. notifications: the ntfy.sh account and its private topic");
check("any valid topic name is accepted", checkTopicName("noticeboard") === "noticeboard");
check("a name with spaces or dots is refused", throws(() => checkTopicName("my board.name"), "1 to 64"));
check("so is one over 64 characters", throws(() => checkTopicName("a".repeat(65)), "1 to 64"));
check("--notify-topic is checked", throws(() => parseArgs(["--notify-topic", "no spaces"]), "1 to 64"));
check("--notify-topic implies --notify", parseArgs(["--notify-topic", "noticeboard"]).notify === true);
check("an ntfy token is accepted", checkNtfyToken("tk_abcdefghijklmnopqrstuvwxyz012") !== undefined);
check("a Cloudflare token is not", throws(() => checkNtfyToken("cfut_" + "a".repeat(48)), "ntfy access token"));
check("nor an empty file", throws(() => checkNtfyToken(""), "ntfy access token"));

// Shaped like ntfy.sh's /v1/account answers.
const paid = (reservations) => ({ username: "owner", role: "user", tier: { code: "supporter" },
  limits: { basis: "tier", messages: 2500 }, reservations });
const priv = (topic) => ({ topic, everyone: "deny-all" });
check("a refused token stops it", throws(() => chooseNtfyTopic({ code: 40101, http: 401 }), "did not accept"));
check("so does no token (anonymous)",
  throws(() => chooseNtfyTopic({ role: "anonymous", limits: { basis: "ip" } }), "did not accept"));
check("a free account stops it, since Workers share addresses",
  throws(() => chooseNtfyTopic({ username: "owner", role: "user", limits: { basis: "ip" },
                                  reservations: [] }), "no paid plan"));
check("one private topic is chosen without asking", chooseNtfyTopic(paid([priv("noticeboard")])) === "noticeboard");
check("several need --notify-topic",
  throws(() => chooseNtfyTopic(paid([priv("one"), priv("two")])), "2 private topics"));
check("and the one named is used", chooseNtfyTopic(paid([priv("one"), priv("two")]), "two") === "two");
check("no private topic stops it", throws(() => chooseNtfyTopic(paid([])), "no private topic"));
check("a topic others can read does not count",
  throws(() => chooseNtfyTopic(paid([{ topic: "open", everyone: "read-only" }]), "open"), "not a private topic"));
check("nor does one the account never reserved",
  throws(() => chooseNtfyTopic(paid([priv("mine")]), "someone-elses"), "not a private topic"));

console.log("\n5c. the weekly digest lands at Monday 09:00 local");
const dt = (off) => JSON.stringify(digestTime(off));
check("UTC+8: Monday 01:00 UTC", dt(-480) === JSON.stringify({ day: 1, hour: 1 }), dt(-480));
check("UTC: Monday 09:00 UTC", dt(0) === JSON.stringify({ day: 1, hour: 9 }), dt(0));
check("UTC-8: Monday 17:00 UTC", dt(480) === JSON.stringify({ day: 1, hour: 17 }), dt(480));
check("UTC+10: Sunday 23:00 UTC, the day before", dt(-600) === JSON.stringify({ day: 0, hour: 23 }), dt(-600));
check("UTC+5:30: Monday 03:00 UTC", dt(-330) === JSON.stringify({ day: 1, hour: 3 }), dt(-330));
const withSchedule = renderToml({ name: "b", databaseId: "d", domain: null, boardUrl: BOARD,
                                  compatibilityDate: "2026-09-01", digest: { day: 1, hour: 1 } });
check("the config it writes has the five-minute schedule",
  withSchedule.includes('crons = ["*/5 * * * *"]'), withSchedule);
check("and the digest day and hour", withSchedule.includes('DIGEST_UTC_DAY = "1"') &&
  withSchedule.includes('DIGEST_UTC_HOUR = "1"'), withSchedule);
check("a custom-domain config remembers its domain",
  readState(custom).domain === "board.example.com" && readState(dev).domain === null);

console.log("\n6. installing the hooks into a home folder");
// A throwaway HOME, so a real ~/.claude is never touched.
const { mkdtempSync, writeFileSync, existsSync, readdirSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const { installHooks } = await import("./setup.mjs");
const realHome = process.env.HOME;
const quiet = (fn) => { const w = process.stdout.write; process.stdout.write = () => true;
                        try { fn(); } finally { process.stdout.write = w; } };
try {
  process.env.HOME = mkdtempSync(join(tmpdir(), "nb-home-"));
  quiet(() => installHooks(BOARD));
  const home = process.env.HOME;
  check("copies board_hook.py into ~/.claude/hooks", existsSync(join(home, ".claude/hooks/board_hook.py")));
  const written = JSON.parse(readFileSync(join(home, ".claude/settings.json"), "utf8"));
  check("writes a settings.json with the board in it", written.env.BOARD_URL === BOARD && written.hooks.Stop.length === 1);
  check("no backup when there was nothing to back up",
    !readdirSync(join(home, ".claude")).some((f) => f.includes(".bak-")));

  process.env.HOME = mkdtempSync(join(tmpdir(), "nb-home-"));
  const h2 = process.env.HOME;
  const { mkdirSync } = await import("node:fs");
  mkdirSync(join(h2, ".claude"));
  writeFileSync(join(h2, ".claude/settings.json"), JSON.stringify(theirs, null, 2));
  quiet(() => installHooks(BOARD));
  const after = JSON.parse(readFileSync(join(h2, ".claude/settings.json"), "utf8"));
  check("merges into existing settings", after.permissions && after.hooks.Stop.length === 2);
  check("and leaves a timestamped backup of the original",
    readdirSync(join(h2, ".claude")).some((f) => f.startsWith("settings.json.bak-")));

  process.env.HOME = mkdtempSync(join(tmpdir(), "nb-home-"));
  const h3 = process.env.HOME;
  mkdirSync(join(h3, ".claude"));
  writeFileSync(join(h3, ".claude/settings.json"), '{ "broken": true, }');
  quiet(() => installHooks(BOARD));
  check("never overwrites a settings file it cannot read",
    readFileSync(join(h3, ".claude/settings.json"), "utf8") === '{ "broken": true, }');
} finally {
  process.env.HOME = realHome;
}

console.log(failures ? "\n" + failures + " FAILED" : "\nsetup.mjs holds up");
process.exit(failures ? 1 : 0);
