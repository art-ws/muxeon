# TEAMAI — install and configure on a clean machine (agent runbook)

**You are an agent. This document is your task input.** It is written to be
executed, not skimmed: every step has a command and a check, and the checks are
what you report on. Follow the steps in order.

Rules for this task:

1. **Verify, do not assume.** After each step, run its check. If a check fails,
   stop at that step and report the failure with the actual output. Do not
   continue past a failed check hoping a later step fixes it.
2. **Never invent configuration values.** Agent names, tmux session names,
   working directories, tokens and ports come from the human who assigned this
   task. If a value you need was not given, stop and ask for exactly that value.
3. **Everything here is non-interactive.** No command below prompts. If one
   appears to hang waiting for input, you have deviated — stop and report.
4. **Idempotent where possible.** Re-running a step should be safe. Where it is
   not, the step says so explicitly.
5. **Secrets never go in the config file, in logs, or in your reply.** They live
   in environment variables only (see step 5).

---

## 0. What you are building

TEAMAI is a **coordinator**, not an agent. It connects CLI agents that run in
**tmux sessions**, routes messages between them along a declared topology, and
exposes them to a human through channels.

The finished deployment is:

```
<deployment root>/          <- you choose this; call it <ROOT>
  teamai.config.json        <- the only file you author by hand
  .env                      <- secrets, gitignored, mode 600
  queue/                    <- created at boot: per-participant maildirs
                            <-   one per agent AND one per user (§17.5)
  webchat/                  <- created by the panel: per-user history + sessions
  state/                    <- created only once routines exist (and pause flags)
  routines/                 <- optional: scheduled markdown tasks you author
```

`<ROOT>` is derived from where the config file sits — the server calls it
`<config_dir>` and resolves `queue/`, `state/`, `routines/` and relative paths
from it.

One process serves everything: a loopback-only admin plane and an MCP
agent-plane share `server.port`; each channel that needs a port declares its own.

---

## 1. Check the prerequisites

TEAMAI needs three things on the machine. Check all three before installing
anything.

```bash
bun --version      # required: >= 1.2
tmux -V            # required: any recent version
node --version     # required: >= 20 (only for the `npx` entry point)
```

**Check:** all three print a version.

If `bun` is missing:

```bash
curl -fsSL https://bun.sh/install | bash
```

Then re-open the shell (or source the profile the installer names) and re-check.
TEAMAI is a Bun application — `Bun.serve`, `Bun.spawn`, `Bun.file`. It does not
run on Node, and the `npx` entry point is only a shim that hands over to `bun`.

If `tmux` is missing, install it with the system package manager
(`apt-get install -y tmux`, `brew install tmux`, …). **Do not skip tmux**: agents
are tmux sessions; without it the coordinator has nothing to coordinate.

> **Stop condition.** If you cannot install a missing prerequisite (no
> permissions, no network), stop and report which one and why. Do not attempt to
> work around it.

---

## 2. Install TEAMAI

Pick **one** of these. Prefer the first unless told otherwise.

**a) Run from npm, no install** — best for a first deployment:

```bash
npx @art-ws/teamai      # or: bunx @art-ws/teamai
```

**b) Install globally** — best when it will be run repeatedly:

```bash
npm i -g @art-ws/teamai
teamai                  # the command is `teamai`, scope or not
```

**c) From source** — only when you were asked to run a specific commit:

```bash
git clone https://github.com/art-ws/teamai.git
cd teamai
bun install
bun packages/server/src/index.ts
```

**Check:** the command runs and complains about a missing config, listing the
paths it searched. That error means the binary works — you have not written a
config yet. Anything else (`bun not found`, a stack trace) is a real failure.

---

## 3. Create the deployment root

```bash
mkdir -p <ROOT>
cd <ROOT>
```

**Run TEAMAI from `<ROOT>` from now on.** This matters more than it looks:

- the config is discovered from the current directory upward, and
- **`bun` loads `.env` from the current working directory**, not from the config
  directory.

If you launch from somewhere else, `$env` secrets silently fail to resolve and
the server refuses to boot. Keep cwd == `<ROOT>`.

---

## 4. Write the config

Create `<ROOT>/teamai.config.json`. Start from the smallest thing that works and
grow it — a config that fails validation prevents boot entirely.

The smallest config that actually boots — two agents and one edge:

```json
{
  "name": "my-team",
  "server": { "port": 8080 },
  "agents": [
    { "name": "researcher", "type": "claude", "tmux": "researcher" },
    { "name": "writer", "type": "claude", "tmux": "writer" }
  ],
  "topology": { "researcher": ["writer"] },
  "channels": []
}
```

**A human is a declared participant.** People go in `users[]`; each one is a full
transport node — own topology edges, own queue, own history. Referencing a name
in the topology that is neither an agent nor a declared user is a fatal config
error:

```
teamai: topology references unknown participant "alex" (at /topology/researcher/0)
```

So the moment you want a human in the topology, they arrive with the channel
they log in through:

```json
{
  "name": "my-team",
  "server": { "port": 8080 },
  "agents": [
    { "name": "researcher", "type": "claude", "tmux": "researcher" }
  ],
  "users": [
    { "name": "alex", "role": "admin",
      "auth": { "password": { "$env": "TEAMAI_ALEX_PASSWORD" } },
      "channels": { "web": true } }
  ],
  "topology": { "researcher": ["alex"] },
  "channels": [
    { "name": "web", "type": "webchat", "port": 8091, "basePath": "/team",
      "auth": { "mode": "users" } }
  ]
}
```

`channels[].name` is the binding key (default: the channel `type`), and
`users[].channels` says which channels that person reaches you through. A
webchat binding is `true` — the login *is* the identity.

> **Legacy shape.** A channel may instead carry `bindOperator: "operator"` plus
> `auth.password`, which makes one shared login and declares that operator
> implicitly. It still works and nothing about it changed — but do not mix the
> two on one channel (validation rejects that), and prefer `users[]` for anything
> new. Ask the human which they want if the task does not say.

Field by field:

| Field | Meaning |
|---|---|
| `name` | Optional label shown in the panel and page title. Omitted ⇒ the hostname. |
| `server.port` | Admin plane **and** MCP agent-plane. Loopback only. |
| `server.mcp` | `false` disables the agent-plane entirely. Default on. |
| `agents[].name` | Topology identity. This is the name used everywhere else. |
| `agents[].type` | Adapter: **`claude`**, **`codex`**, or **`auto`** (detects). |
| `agents[].tmux` | The tmux session name. **Stable** — it keys the queue across restarts. |
| `agents[].cwd` | Optional working directory; also where the file exchange lands. |
| `users[].name` | A person's topology identity — and their queue key. |
| `users[].role` | `"admin"` or `"user"` (default). Panel capability only, never a transport ACL. |
| `users[].auth` | Exactly one of `password` (literal or `$env`) or `passwordHash`. |
| `users[].channels` | Bindings keyed by `channels[].name`: `true` for webchat, `{ "alias": "…" }` elsewhere. |
| `channels[].name` | Channel instance name = the binding key. Default: the `type`. |
| `topology` | Undirected. An edge is permission to talk. No edge ⇒ delivery refused. |

Every name in `topology` must resolve to a declared participant: an agent from
`agents`, a user from `users`, a group/tag, or an operator that some channel
binds. A name that resolves to none of those aborts the boot.

**What a user gets** (state it to the human, they usually ask):

- their own chat history and unread counters — another user's is unreachable,
  not merely hidden;
- a pinned **self-chat**: notes to themselves plus everything addressed to them;
- **presence**: online while their last outgoing message is younger than
  `server.presenceTtl` (default `15m`);
- **do not disturb**: they can pause themselves; a `role: "admin"` user can pause
  anyone. While paused, messages from others are refused (not queued) — their own
  notes still land;
- the server-wide transport journal **only** with `role: "admin"`.

### Optional blocks (add only if asked)

```jsonc
{
  "agents": [{
    "name": "researcher", "type": "claude", "tmux": "researcher",
    "cwd": "/path/to/project",
    "provision": {                      // how TEAMAI starts the agent itself
      "command": ["claude"],            // argv array — never a shell string
      "cwd": "/path/to/project",
      "env": {},
      "auto": true,                     // start it at boot
      "teardown": { "slash": "exit", "graceMs": 5000, "idle": "1h" }
    },
    "commands": [{ "slash": "clear" }], // slash commands operators may run
    "group": "workers",                 // one group per agent
    "tags": ["research"],               // flat labels, many per agent
    "wipLimit": 3                       // un-drained records before backpressure
  }],

  "groups": [{ "name": "workers" }],    // an ARRAY of {name, parent?}, not an object

  "commandGrants": {                    // agent -> agent slash commands
    "writer": { "researcher": ["clear"] }
  },
  "sessionGrants": {                    // agent -> agent session control
    "writer": { "researcher": ["restart"] }
  }
}
```

Validation is **fail-fast**: an unknown agent in a grant, a grant pair with no
topology edge, a group name that collides with an agent name, or a command not
in the recipient's catalog all abort the boot. That is intentional — fix the
config, do not work around it.

---

## 5. Secrets

Channel credentials are **`$env` only**. An inline secret fails validation; a
missing variable fails the boot.

In the config, reference the variable:

```json
{ "name": "tg-main", "type": "telegram", "token": { "$env": "TG_TOKEN" } }
```

Put the value in `<ROOT>/.env`:

```bash
cd <ROOT>
umask 077
cat > .env <<'EOF'
TG_TOKEN=<value the human gave you>
TEAMAI_ALEX_PASSWORD=<value the human gave you>
EOF
chmod 600 .env
```

**Check:** `ls -l .env` shows `-rw-------`.

**User passwords have one relaxation** (§17.2): `users[].auth.password` may be a
literal instead of an `$env` reference — the config sits on a trusted host, so it
is allowed, and the boot warns about it. Prefer `$env` anyway. The third option
is a hash, which is not a secret and may live inline:

```bash
teamai hash-password            # reads the password without echoing it
teamai hash-password --stdin    # or from a pipe, for non-interactive use
```

```json
{ "name": "alex", "auth": { "passwordHash": "$argon2id$v=19$m=65536,t=2,p=1$…" } }
```

It needs neither a running server nor a config — it is a pure local computation.

Rules you must not break:

- Never print a secret value, not into the terminal, a log, a commit, or your
  report. Refer to it by variable name.
- Never commit `.env`.
- If a needed secret was not provided, **stop and ask for it by name**. Do not
  invent a placeholder and do not leave the variable unset "for now" — the boot
  will fail either way, and a placeholder fails less obviously.

---

## 6. Prepare the agent sessions

Each agent in the config must correspond to a **tmux session** with that exact
name. Two ways:

**a) You start them by hand** (config has no `provision`):

```bash
tmux new-session -d -s researcher -c /path/to/project 'claude'
tmux has-session -t researcher && echo present
```

**b) TEAMAI starts them** (config has `provision`): nothing to do here — with
`"auto": true` the server provisions at boot, and a message to a `down` agent
that has a `provision` block revives it.

A missing session is **not** a boot error: the agent is reported `down`, its
queue accumulates, and a liveness sweep flips it to `idle` as soon as the
session appears. You may create sessions before or after starting the server.

### Giving an agent the file exchange (optional, no MCP needed)

An agent talks back through files. Its exchange directory is `<cwd>/.teamai` by
default (or `exchangeDir`, or a directory under the queue root when the agent
has no `cwd`). The protocol, which you should put into the agent's own
instructions file:

- An incoming message appears as `.teamai/inbox/<id>/message.json`.
- The agent writes its answer to `reply.md` **next to** that file. Other files
  it leaves in that folder are returned as attachments.
- The agent then **deletes `message.json`** — that ends its turn.
- To start a conversation, it drops `{"to": "...", "payload": "..."}` as a JSON
  file into `.teamai/outbox/`.

---

## 7. Validate the config before starting

Do not discover a config error by watching the server die. Validate first, with a
bounded run so you never end up holding a foreground server:

```bash
cd <ROOT>
timeout 5 npx @art-ws/teamai 2>&1 | head -20
```

Two possible outcomes:

- **A config error**, naming the offending field with a JSON pointer, e.g.
  `… (at /commandGrants/writer/researcher/0)`. Fix that field and re-run.
- **`teamai: booted; N agent(s)`**, then `timeout` kills it at 5s. The config is
  good — go to step 8 and start it properly.

**Check:** you saw one of those two. Repeat until it is the second.

---

## 8. Start the server

Run it inside a dedicated tmux session so it survives your shell:

```bash
cd <ROOT>
tmux new-session -d -s teamai-serve -c <ROOT> 'npx @art-ws/teamai'
```

Watch it come up:

```bash
sleep 5
tmux capture-pane -t teamai-serve -p | tail -20
```

**Check:** the pane contains `teamai: booted; N agent(s)` followed by the agent
list and the plane lines. If it contains a config error, the server exited —
fix and repeat step 7.

---

## 9. Verify the deployment

Run every check. Report the results as a group.

```bash
# 1. admin plane answers (loopback)
curl -s -o /dev/null -w 'admin %{http_code}\n' http://localhost:8080/admin/agents

# 2. agents and their state
npx @art-ws/teamai agents

# 3. the queue root was created
ls -d queue
```

**Expected:**

1. `admin 200`
2. one line per agent: `<name> (<tmux>): idle|busy|down`
3. `queue` exists — with one directory per participant, **including one named
   after each user**: that pseudo-session is where their messages land

`state/` is **not** created until routines exist — its absence here is normal,
not a failure.

With a webchat channel, also prove a person can actually get in (this is the
step humans notice when it is missing):

```bash
curl -s -o /dev/null -w 'panel %{http_code}\n' http://localhost:8091/team/
curl -s -X POST http://localhost:8091/team/api/login \
  -H 'content-type: application/json' \
  -d '{"user":"<user>","password":"<the value from .env>"}'
```

**Expected:** `panel 200`, and the login answers
`{"ok":true,"user":"<user>","role":"…"}`. A `400 "user" is required` means the
channel runs in users mode and you omitted the name; a `401 invalid credentials`
means the name or the password is wrong — the two are deliberately
indistinguishable, so check both. Do **not** put the password in your report.

> **If a request to localhost hangs or returns something strange**, check
> whether the shell exports `HTTP_PROXY`. A proxy intercepts loopback. Re-run
> with `env -u HTTP_PROXY -u http_proxy …`.

### End-to-end check

Prove a message actually reaches an agent. Pick an agent that is `idle`:

```bash
npx @art-ws/teamai signals send --from <user> --to <agent> "reply with the single word OK"
```

`<user>` is a name from `users[]` (or the legacy operator) that has an edge to
that agent — the router refuses anything else.

**Check:** the command prints `queued <id> → <agent>`. Then, within a few
seconds:

```bash
tmux capture-pane -t <agent-tmux> -p | tail -5   # the text arrived in the pane
ls queue/<agent-tmux>/done | tail -1             # the turn completed
```

A record in `done/` is the real proof: it means the message was injected, the
turn was detected as finished, and the record was archived. If the record stays
in `cur/`, the agent received it but its turn never completed — report that,
including the pane contents.

---

## 10. Channels (only if asked)

A channel is how people reach the stand. In users mode it carries **many**
people, each identified by their binding; in the legacy shape it binds **one**
operator.

**Default to `webchat`.** It is the only channel that needs nothing outside this
machine — a port and a password — so it is the right answer unless the human
named a different one. The others require an account, a bot registration or a
public endpoint, and none of that is yours to invent.

```jsonc
"channels": [
  { "name": "web", "type": "webchat", "port": 8091, "basePath": "/team",
    "auth": { "mode": "users" } }        // identities come from users[]
]
```

The other types, for when the human asks for one and supplies the credential:

```jsonc
{ "name": "tg-main", "type": "telegram", "token": { "$env": "TELEGRAM_TOKEN" } }
// …and in users[]: "channels": { "tg-main": { "alias": "<their telegram @username>" } }

{ "name": "slack-main", "type": "slack", "token": { "$env": "SLACK_TOKEN" },
  "channel": "C0123456" }

{ "type": "web", "port": 8090, "deliverUrl": "https://hooks.example/teamai",
  "secret": { "$env": "WEB_HOOK_SECRET" }, "bindOperator": "ops-hook" }
```

Notes that save a debugging cycle:

- **`webchat` rejects `defaultTarget`** — the panel picks the recipient in the
  UI, so the field is a config error there, not a harmless extra. It belongs to
  the text channels (telegram / slack / web) only.
- In those text channels, inbound text is addressed by a leading `@agent`. In
  **users mode** the fallback is a note to self, so `defaultTarget` is rejected
  there too; in the **legacy** shape the fallback is `defaultTarget`, and without
  either the message is refused with a clear reply.
- An **alias** must be unique within its channel — two people behind one alias
  makes the sender unresolvable, and validation says so.
- A telegram/slack account that no user binds is **refused politely** and never
  reaches the transport. There is no guest access; add the person to `users[]`.
- The `@agent` must be a **topology neighbour of that sender**, or delivery is
  refused.
- The generic `web` channel has no per-user identity, so it still requires
  `bindOperator`.
- With `basePath: "/team"` the panel lives at `http://host:8091/team/` and the
  **root path 404s**. That is not a bug; check the right URL.

**Check for webchat:** `curl -s -o /dev/null -w '%{http_code}\n'
http://localhost:8091/team/` returns `200`.

---

## 11. Routines (only if asked)

Scheduled tasks are markdown files with frontmatter, discovered under
`<ROOT>/routines/<owner>/*.md`. The **directory name is the owner** and must
match an agent name.

```markdown
---
id: daily-standup
schedule: "0 9 * * *"    # cron, or the literal `once`
tz: Europe/Berlin        # optional; UTC if omitted
target: researcher       # optional; defaults to the owner
enabled: true
---
Summarise what changed yesterday.
```

The body is the message sent on schedule.

```bash
npx @art-ws/teamai routines list
```

**Check:** your routine appears with the expected owner and schedule.

---

## 12. Operating it

The same binary is the operator CLI. It is a thin client to the loopback admin
plane, so the server must be running.

```
teamai agents
teamai provision|kill|restart <agent>
teamai pause|resume <agent|user>
teamai command <slash> <selector…>
teamai channels
teamai signals send --from <node> --to <node> [--blob <path>] <text…>
teamai queues peek|cancel|requeue <participant> [<id>]
teamai routines list [<owner>]
teamai routines get|delete|enable|disable|run-once <owner> <id>
teamai routines put <owner> <id> <file.md>
teamai hash-password [--stdin]
options: --url <admin-url> | --config <path>
```

`hash-password` is the one subcommand that talks to nothing — no server, no
config — so it works before the stand exists. `pause` takes a user as well as an
agent: for a person it is do-not-disturb (their own notes still land).

`restart <agent>` restarts an **agent**, not the server. Configuration is read
once at boot — a config edit needs the server process restarted:

```bash
tmux kill-session -t teamai-serve
tmux new-session -d -s teamai-serve -c <ROOT> 'npx @art-ws/teamai'
```

Restarting the server does **not** kill agent sessions; it re-attaches and
re-probes them. Queues live on disk and survive it.

---

## 13. Security posture — state this to the human

Do not deploy this quietly. The trust model is deliberate and the human must
know it:

- TEAMAI coordinates **mutually trusted local agents on one machine**.
- The **admin plane is loopback-only and unauthenticated**. Any local process
  that reaches it can drive the whole system. **Never expose `server.port`**, and
  never put it behind a public reverse proxy.
- Agent identity on the MCP plane is **self-declared**. The topology is a routing
  constraint, not an anti-spoofing control.
- The **web panel is the only authenticated surface**. With `users[]` each person
  has their own login and sees only their own chats, peers and blobs — that is
  isolation between *people*, not a security boundary against the machine: anyone
  with local access still reaches the admin plane.
- A `role: "admin"` user additionally sees the server-wide transport journal —
  i.e. everyone's traffic. Say who you gave that to.

If the human asked you to expose any port publicly, stop and confirm — that is
outside this design and needs an explicit decision.

---

## 14. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Boot dies naming a config field | Fail-fast validation | Fix that field; every rule is checked before anything starts |
| `missing environment variable` at boot | `$env` unresolved | `.env` must be in the **cwd you launch from**; keep cwd == `<ROOT>` |
| Agent shows `down` | No tmux session by that name | Create it, or add `provision`; the liveness sweep picks it up |
| `EADDRINUSE` on boot | Port taken — often an older instance | `tmux ls`, kill the old session; check the port |
| Loopback calls hang or 502 | `HTTP_PROXY` intercepting localhost | Prefix with `env -u HTTP_PROXY -u http_proxy` |
| Panel 404 at `/` | `basePath` is set | Use `http://host:<port>/<basePath>/` |
| Delivery refused | No topology edge, or unknown name | Add the edge; names are the `agents[].name`, not tmux names |
| Message sits in `cur/` | Turn never detected as finished | Capture the pane and report; the agent may be blocked on a prompt |
| `bun: not found` from `npx` | Node shim cannot find bun | Install bun, or set `TEAMAI_BUN=/path/to/bun` |
| Login answers `"user" is required` | Channel is in users mode | Send `{"user":…,"password":…}` — the name is a `users[].name` |
| Login answers `invalid credentials` | Wrong name **or** wrong password | The two are deliberately indistinguishable; check both |
| Boot warns `inline auth.password` | A literal user password | Allowed (§17.2), but move it to `$env` or `passwordHash` |
| Boot warns `no user bound to it` | users-mode channel with no binding | Nobody can log in — add `users[].channels` |
| Telegram replies "not linked to a TEAMAI user" | Sender's alias is not bound | Add that account to some `users[].channels.<channel>.alias` |
| A person sees no peers | No topology edges for that user | Their self-chat still works; add the edges |

---

## 15. Report back

When you finish, report exactly this:

1. **Versions**: bun, tmux, node, and the TEAMAI version you installed.
2. **`<ROOT>`** and the install method you used (a, b or c from step 2).
3. **The config**: agent names, their types and tmux sessions, the topology
   edges, the channels, and **who can log in** — the `users[]` names with their
   roles (say plainly which of them are `admin`) — **with secret values replaced
   by their variable names**.
4. **Check results** from step 9, including the end-to-end message result.
5. **Anything you could not do**, and why. Say it plainly; a partial deployment
   reported accurately is far more useful than a complete-sounding one that
   does not work.

Do not report success unless the step 9 checks passed. If they did not, say
which one failed and what it printed.
