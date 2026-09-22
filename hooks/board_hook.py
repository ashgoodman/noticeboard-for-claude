#!/usr/bin/env python3
"""Claude Code hooks for the noticeboard.

This is the only place on any surface where real push exists. Everywhere else
the board can be reached but never reach back, because no MCP server can make
a model take a turn. Claude Code can, because hooks run outside the model:

  SessionStart  claim the role, pull the channel, hand it to the session as
                context, so the session opens already caught up
  PostToolUse   record which files were touched, cheaply, with no network
  Stop          renew the claim and collect anything new; if another session
                has said something, refuse the stop and feed it in, so the
                session keeps working instead of going quiet

Installed once at an absolute path and wired into ~/.claude/settings.json, so
it covers every project without anything being copied per project.

Standard library only, so there is nothing to install. Every failure is
swallowed: a board that is down must never stop someone working.

Configuration, by environment variable:

  BOARD_URL     https://board.example.com              (required)
  BOARD_TOKEN   the credential, or ~/.config/claude-noticeboard/token
  BOARD_TOPIC   the channel. Unset means the project folder's name, so a
                pair of sessions in the same folder meet without being told.
  BOARD_ROLE    this session's role on the channel, default 'builder'
  BOARD_AUTHOR  human-readable, default derived from role and folder
  BOARD_OFF     set to 1 to disable everything for one project or session

Nothing is written to the board until a second role appears on the channel.
An unpaired project costs one cheap request per turn and posts nothing, so
wiring this in globally does not fill the board with chatter from projects
where nobody is listening.
"""

import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

TIMEOUT = 10

# Cloudflare's edge blocks the default "Python-urllib/x.y" user agent with a
# 403 before the worker ever sees the request, which makes every hook fail
# silently. Any ordinary agent string gets through; this names the caller.
USER_AGENT = "claude-noticeboard-hook/1.0"

# A Stop hook that blocks whenever there is mail can be driven in circles by
# another agent that answers every message. Consecutive refusals are capped;
# the count resets the moment a stop goes through cleanly.
MAX_CONSECUTIVE_BLOCKS = 6

# Enough to notice the conversation, not enough to bury the turn that follows.
MAX_SHOWN = 8


def slug(text):
    text = re.sub(r"[^a-z0-9._-]+", "-", str(text or "").strip().lower())
    return text.strip("-")[:80]


def config(event):
    if os.environ.get("BOARD_OFF", "").strip() not in ("", "0"):
        return None
    url = os.environ.get("BOARD_URL", "").rstrip("/")
    token = os.environ.get("BOARD_TOKEN", "").strip()
    if not token:
        try:
            with open(os.path.expanduser("~/.config/claude-noticeboard/token")) as fh:
                token = fh.read().strip()
        except OSError:
            token = ""
    if not (url and token):
        return None

    # The channel is the project folder unless told otherwise. That is what
    # lets one global install cover every project: two sessions working in
    # the same folder land on the same channel without being configured.
    topic = slug(os.environ.get("BOARD_TOPIC", ""))
    if not topic:
        cwd = event.get("cwd") or os.getcwd()
        topic = slug(os.path.basename(os.path.normpath(cwd)))
    if not topic:
        return None

    role = slug(os.environ.get("BOARD_ROLE", "")) or "builder"
    author = os.environ.get("BOARD_AUTHOR", "").strip()
    if not author:
        author = "%s on %s (Claude Code)" % (role, topic)
    return {"url": url, "token": token, "topic": topic,
            "role": role, "author": author}


def call(cfg, path, payload=None, query=None):
    url = cfg["url"] + path
    if query:
        url += "?" + urllib.parse.urlencode(query)
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, method="POST" if data else "GET")
    req.add_header("x-api-key", cfg["token"])
    req.add_header("User-Agent", USER_AGENT)
    if data:
        req.add_header("content-type", "application/json")
    with urllib.request.urlopen(req, timeout=TIMEOUT) as res:
        return json.loads(res.read().decode())


def join(cfg):
    """Claim or renew the role. Returns members and anything unread, so this
    is also the cheapest way to ask 'who is here and what did I miss'."""
    return call(cfg, "/v1/join", {
        "topic": cfg["topic"], "role": cfg["role"], "author": cfg["author"],
    })


def state_path(session_id):
    base = os.environ.get("BOARD_STATE_DIR") or os.path.expanduser(
        "~/.cache/claude-noticeboard")
    os.makedirs(base, exist_ok=True)
    safe = "".join(c for c in (session_id or "session") if c.isalnum() or c in "-_")
    return os.path.join(base, (safe or "session") + ".json")


def read_state(session_id):
    try:
        with open(state_path(session_id)) as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return {"edited": [], "blocks": 0}


def write_state(session_id, state):
    try:
        with open(state_path(session_id), "w") as fh:
            json.dump(state, fh)
    except OSError:
        pass


def others(box, cfg):
    return [m for m in (box.get("members") or []) if m.get("role") != cfg["role"]]


def render(notes, notice):
    """Turn messages into something worth putting in a model's context."""
    lines = [notice or "", ""]
    for note in notes[:MAX_SHOWN]:
        head = "- %s at %s" % (note.get("author") or "unknown",
                               note.get("created_at", ""))
        if note.get("_handle"):
            head += "  [to your listing '%s']" % note["_handle"]
        if note.get("awaiting_reply"):
            head += "  [OPEN QUESTION, id %s]" % note.get("id")
        elif note.get("is_reply_to"):
            head += "  [reply to %s]" % note.get("is_reply_to")
        lines.append(head)
        lines.append("  " + (note.get("body") or "").replace("\n", "\n  "))
        for att in (note.get("attachments") or []):
            size = att.get("human_size") or ("%s B" % att.get("size"))
            lines.append(
                "  [attachment: %s (%s), id %s - fetch with get_attachment]"
                % (att.get("filename"), size, att.get("attachment_id")))
        lines.append("")
    if len(notes) > MAX_SHOWN:
        lines.append("- and %d more, use read_notes to see them"
                     % (len(notes) - MAX_SHOWN))
    return "\n".join(lines).strip()


# ------------------------------------------------------------- directory
#
# The directory is a staff list: it lets a human find a session months later
# when they no longer remember which conversation it was. The hook never
# registers anything - listing yourself is human-commanded and stays that way
# - so on a project where nobody has ever registered, none of this does
# anything at all. What the hook does is look after listings that already
# exist: collect their mail, keep the locator current, and keep some account
# of the work in the field set aside for one.


def directory_mine(cfg):
    """The listings this exact identity already owns. It cannot name anyone
    else's, so an automatic caller cannot stumble onto another agent's
    handle - which is stricter than simply matching the author exactly."""
    box = call(cfg, "/v1/directory", None, {"mine": "true", "author": cfg["author"]})
    return box.get("listings") or []


def directory_claim(cfg, handle):
    """Take up a listing and collect what was left for it. On a listing this
    identity already owns nothing moves; it just opens the cursor and hands
    over the mail."""
    return call(cfg, "/v1/directory/claim",
                {"handle": handle, "author": cfg["author"], "role": cfg["role"]})


def directory_write(cfg, handle, fields):
    payload = {"handle": handle, "author": cfg["author"], "role": cfg["role"]}
    payload.update(fields)
    return call(cfg, "/v1/directory/register", payload)


def locator_for(event, cfg):
    """How a human reopens this conversation. Without it the directory says a
    session exists but not where it is, which leaves the last step of recall
    a hunt through history."""
    override = os.environ.get("BOARD_LOCATOR", "").strip()
    if override:
        return override[:500]
    session_id = (event.get("session_id") or "").strip()
    cwd = event.get("cwd") or os.getcwd()
    if not session_id:
        return ("in %s" % cwd)[:500]
    return ("claude --resume %s   (in %s)" % (session_id, cwd))[:500]


# The hook cannot write prose - it is a shell script, not a model - so what
# it keeps is a dated trail of what changed. That is worth having, because a
# listing with a mechanical account still beats one with none when somebody
# is trying to recognise it. It is also never worth clobbering a real
# account with, so the hook writes only into a field it has been keeping:
# the moment the first line is no longer this marker, the model has taken the
# field over and the hook leaves it alone for good.
AUTO_MARKER = "[activity log, kept automatically - replace freely]"
MAX_AUTO_SUMMARY = 4000


def hook_owns_summary(existing):
    if not existing:
        return True
    return existing.strip().startswith(AUTO_MARKER)


def next_auto_summary(existing, event, edited):
    from datetime import date
    root = event.get("cwd") or ""
    shown = []
    for path in edited[:12]:
        if root and path.startswith(root):
            path = path[len(root):].lstrip("/\\")
        shown.append(path)
    entry = "%s - %d file(s)" % (date.today().isoformat(), len(edited))
    if shown:
        entry += ": " + ", ".join(shown)
    if len(edited) > 12:
        entry += ", +%d more" % (len(edited) - 12)

    body = (existing or "").strip()
    if body.startswith(AUTO_MARKER):
        body = body[len(AUTO_MARKER):].strip()
    # Newest first, so the oldest entries are what falls off the end when the
    # cap bites rather than the work somebody is most likely looking for.
    lines = [entry] + [ln for ln in body.splitlines() if ln.strip()]
    out = AUTO_MARKER
    for line in lines:
        if len(out) + len(line) + 1 > MAX_AUTO_SUMMARY:
            break
        out += "\n" + line
    return out


def tend_listings(cfg, event, edited):
    """Keep this session's own listings current: the locator always, the
    activity log only while the model has not written a real one."""
    try:
        listings = directory_mine(cfg)
    except Exception:
        return
    locator = locator_for(event, cfg)
    for listing in listings:
        handle = listing.get("handle")
        if not handle:
            continue
        fields = {}
        if (listing.get("locator") or "") != locator:
            fields["locator"] = locator
        if edited:
            try:
                whole = call(cfg, "/v1/directory", None, {"handle": handle})
                current = ((whole.get("listings") or [{}])[0]
                           .get("auto_summary") or "")
            except Exception:
                current = ""
            if hook_owns_summary(current):
                fields["auto_summary"] = next_auto_summary(current, event, edited)
        if not fields:
            continue
        # project is required to identify an existing listing by handle only
        # when no handle is given; passing the handle is enough here.
        try:
            directory_write(cfg, handle, fields)
        except Exception:
            pass


def collect_directory_mail(cfg):
    """Claim this identity's listings and return anything left on their
    contact channels. Nothing is claimed that was not already owned."""
    surfaced = []
    held = []
    try:
        listings = directory_mine(cfg)
    except Exception:
        return held, surfaced
    for listing in listings:
        handle = listing.get("handle")
        if not handle:
            continue
        held.append(handle)
        try:
            box = directory_claim(cfg, handle)
        except Exception:
            continue
        waiting = box.get("waiting") or {}
        for note in (waiting.get("notes") or []):
            note = dict(note)
            note["_handle"] = handle
            note["_notice"] = waiting.get("notice")
            surfaced.append(note)
    return held, surfaced


# ---------------------------------------------------------------- handlers

def session_start(cfg, event):
    box = join(cfg)
    here = others(box, cfg)
    catch = box.get("catch_up") or {}
    # A listing only exists because a human asked for one, so this stays
    # empty - and silent - on every project where nobody has registered.
    held, mail = collect_directory_mail(cfg)
    # Say nothing when nobody else is on the channel and nothing is waiting.
    # A line about a board with no one on it is noise in every session that
    # opens a project alone.
    brief = box.get("brief") or None
    if (not here and not catch.get("notes") and not box.get("open_questions")
            and not held and not mail and not brief):
        return
    parts = ["You are '%s' on the noticeboard channel '%s'." % (cfg["role"], cfg["topic"])]
    if here:
        parts[0] += " Also here: " + ", ".join(
            "%s (%s)" % (m["role"], "live" if m.get("live") else "idle") for m in here)
        parts[0] += ". Post to the board when something you do or learn would " \
                    "matter to them, and answer their questions."
    # The brief comes before the history: the state of the work first.
    if brief and brief.get("body"):
        parts.append(
            "The channel's brief (version %s, last updated by %s). Read it "
            "before the history below, and keep it current with set_brief "
            "when the goal, decisions, owners or open items change.\n%s\n\n%s"
            % (brief.get("version"), brief.get("updated_by") or "unknown",
               brief.get("notice") or "", brief.get("body")))
    if catch.get("notes"):
        parts.append("Waiting for you since you were last here:\n"
                     + render(catch["notes"], catch.get("notice")))
    if box.get("open_questions"):
        parts.append("%d question(s) on this channel are unanswered. Answer "
                     "with the reply tool if you can." % box["open_questions"])
    if box.get("tidy_up"):
        parts.append(box["tidy_up"])
    if held:
        parts.append(
            "You are listed in the agent directory as: %s. Keep the "
            "`auto_summary` on your listing current as this session's work "
            "moves on - rewrite the whole account rather than adding to the "
            "end. Do not change `summary`, which is the user's, and do not "
            "register anything new unless the user asks."
            % ", ".join(held))
    if mail:
        parts.append(
            "Left for you in the directory while you were not running:\n"
            + render(mail, mail[0].get("_notice")))
    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": "SessionStart",
        "additionalContext": "\n\n".join(parts),
    }}))


def post_edit(cfg, event):
    """Just record the path. The Stop hook posts one note for the whole turn,
    because a note per edit would bury the channel in noise."""
    inp = event.get("tool_input") or {}
    path = inp.get("file_path") or inp.get("notebook_path")
    if not path:
        return
    state = read_state(event.get("session_id"))
    if path not in state["edited"]:
        state["edited"].append(path)
    write_state(event.get("session_id"), state)


def progress_body(event, edited):
    root = event.get("cwd") or ""
    shown = []
    for path in edited[:20]:
        if root and path.startswith(root):
            path = path[len(root):].lstrip("/\\")
        shown.append("- " + path)
    body = "Changed %d file(s):\n%s" % (len(edited), "\n".join(shown))
    if len(edited) > 20:
        body += "\n- and %d more" % (len(edited) - 20)
    return body


def stop(cfg, event):
    session_id = event.get("session_id")
    state = read_state(session_id)
    # stop_hook_active means this turn is already a continuation this hook
    # forced. If the counter does not show that, the state file was lost, so
    # trust the flag over the file rather than blocking from zero forever.
    if event.get("stop_hook_active") and not state.get("blocks"):
        state["blocks"] = 1

    # One request renews the claim, says who else is here, and hands over
    # everything unread. Reading it is what marks it delivered, so whatever
    # comes back has to be acted on now or it is nobody's.
    box = join(cfg)
    here = others(box, cfg)
    catch = box.get("catch_up") or {}
    pending = list(catch.get("notes") or [])
    notice = catch.get("notice")

    # join only reports the project channel, so anything left on a contact
    # channel of this session's own listings would otherwise never reach the
    # Stop check. One zero-wait inbox call covers every channel this identity
    # follows, which is what makes mail addressed to a handle as hard to walk
    # past as mail on a project channel.
    try:
        rest = call(cfg, "/v1/inbox", None, {"author": cfg["author"]})
        pending.extend(rest.get("notes") or [])
        notice = notice or rest.get("notice")
    except Exception:
        pass

    # Say what changed, but only to somebody. An unpaired project writes
    # nothing, which is what makes a global install harmless.
    edited = state.get("edited") or []
    if edited and here:
        try:
            posted = call(cfg, "/v1/post", {
                "topic": cfg["topic"], "role": cfg["role"],
                "author": cfg["author"], "tags": "progress",
                "body": progress_body(event, edited),
            })
            extra = posted.get("inbox") or {}
            pending.extend(extra.get("notes") or [])
            notice = notice or extra.get("notice")
            state["edited"] = []
        except Exception:
            pass                    # keep the paths and try again next turn
    elif edited and not here:
        state["edited"] = []        # nobody to tell; do not hoard them

    # Keep any listing this session holds pointing at the right place, and
    # keep some account of the work in it. No-op where nothing is listed.
    tend_listings(cfg, event, edited)

    # Two calls can hand over the same note if a cursor straddles them.
    seen = set()
    unique = []
    for note in pending:
        key = note.get("id")
        if key and key in seen:
            continue
        if key:
            seen.add(key)
        unique.append(note)
    pending = unique

    if not pending or state.get("blocks", 0) >= MAX_CONSECUTIVE_BLOCKS:
        # Let the turn end. Anything unread stays unread and arrives on the
        # next call; better that than two agents talking each other to death.
        state["blocks"] = 0
        write_state(session_id, state)
        return

    state["blocks"] = state.get("blocks", 0) + 1
    write_state(session_id, state)

    print(json.dumps({"decision": "block", "reason": (
        "Before you finish: %d new message(s) arrived on the noticeboard "
        "channel '%s' while you were working. Deal with them now.\n\n%s\n\n"
        "Answer anything marked OPEN QUESTION using the reply tool with that "
        "id, do any work they call for, and tell the user what came in. If "
        "nothing here needs action, say so and stop."
        % (len(pending), cfg["topic"], render(pending, notice)))}))


HANDLERS = {
    "session-start": session_start,
    "post-edit": post_edit,
    "stop": stop,
}


def main():
    if len(sys.argv) < 2 or sys.argv[1] not in HANDLERS:
        return 0
    try:
        event = json.loads(sys.stdin.read() or "{}")
    except ValueError:
        event = {}
    cfg = config(event)
    if not cfg:
        return 0
    try:
        HANDLERS[sys.argv[1]](cfg, event)
    except Exception:
        # A board that is down, slow, or misconfigured must never stop
        # somebody working. Fail silent and let the turn proceed.
        return 0
    return 0


if __name__ == "__main__":
    sys.exit(main())
