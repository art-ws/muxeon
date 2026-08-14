# Muxeon — install and configure on a clean machine (agent runbook)

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

Muxeon is a **coordinator**, not an agent. It connects CLI agents that run in
**tmux sessions**, routes messages between them along a declared topology, and
exposes them to a human through channels. Optionally, it **federates**: two or
more Muxeon servers can join so actors on one talk to exported actors on
another (step 11) — a single-server deployment ignores all of that.

The finished deployment is:

```
<deployment root>/          <- you choose this; call it <ROOT>
  muxeon.config.json        <- the only file you author by hand
  .env                      <- secrets, gitignored, mode 600
  queue/                    <- created at boot: per-participant maildirs
                            <-   one per agent AND one per user (§17.5);
                            <-   federation links get theirs under queue/fed/
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

Muxeon needs three things on the machine. Check all three before installing
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
Muxeon is a Bun application — `Bun.serve`, `Bun.spawn`, `Bun.file`. It does not
run on Node, and the `npx` entry point is only a shim that hands over to `bun`.

If `tmux` is missing, install it with the system package manager
(`apt-get install -y tmux`, `brew install tmux`, …). **Do not skip tmux**: agents
are tmux sessions; without it the coordinator has nothing to coordinate.

> **Stop condition.** If you cannot install a missing prerequisite (no
> permissions, no network), stop and report which one and why. Do not attempt to
> work around it.

---

## 2. Install Muxeon

Pick **one** of these. Prefer the first unless told otherwise.

**a) Run from npm, no install** — best for a first deployment:

```bash
npx @art-ws/muxeon      # or: bunx @art-ws/muxeon
```

**b) Install globally** — best when it will be run repeatedly:

```bash
npm i -g @art-ws/muxeon
muxeon                  # the command is `muxeon`, scope or not
```

**c) From source** — only when you were asked to run a specific commit:

```bash
git clone https://github.com/art-ws/muxeon.git
cd muxeon
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

**Run Muxeon from `<ROOT>` from now on.** This matters more than it looks:

- the config is discovered from the current directory upward, and
- **`bun` loads `.env` from the current working directory**, not from the config
  directory.

If you launch from somewhere else, `$env` secrets silently fail to resolve and
the server refuses to boot. Keep cwd == `<ROOT>`.

---

## 4. Write the config

Create `<ROOT>/muxeon.config.json`. Start from the smallest thing that works and
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
muxeon: topology references unknown participant "alex" (at /topology/researcher/0)
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
      "auth": { "password": { "$env": "MUXEON_ALEX_PASSWORD" } },
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
| `agents[].title` / `users[].title` | Optional panel label — shown instead of the name, with the name in the tooltip. Presentational only: never an address, no uniqueness rule. |
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
- a **self-chat**: notes to themselves plus everything addressed to them. It is
  an ordinary row of their own sidebar — same place in the sorted list, same
  presence dot / preview / unread / actions menu as any other person, no pinned
  special case;
- **presence**: online while their last outgoing message is younger than
  `server.presenceTtl` (default `15m`) — a note to self counts, too;
- **do not disturb**: they can pause themselves; a `role: "admin"` user can pause
  anyone. While paused, messages from others are refused (not queued) — their own
  notes still land;
- the server-wide transport journal **only** with `role: "admin"`.

### Optional blocks (add only if asked)

```jsonc
{
  "agents": [{
    "name": "researcher", "type": "claude", "tmux": "researcher",
    "title": "Researcher",              // panel label only; `name` stays the address
    "cwd": "/path/to/project",
    "provision": {                      // how Muxeon starts the agent itself
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

Channel credentials — and **federation link tokens** (step 11) — are **`$env`
only**. An inline secret fails validation; a missing variable fails the boot.

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
MUXEON_ALEX_PASSWORD=<value the human gave you>
EOF
chmod 600 .env
```

**Check:** `ls -l .env` shows `-rw-------`.

**User passwords have one relaxation** (§17.2): `users[].auth.password` may be a
literal instead of an `$env` reference — the config sits on a trusted host, so it
is allowed, and the boot warns about it. Prefer `$env` anyway. The third option
is a hash, which is not a secret and may live inline:

```bash
muxeon hash-password            # reads the password without echoing it
muxeon hash-password --stdin    # or from a pipe, for non-interactive use
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

**b) Muxeon starts them** (config has `provision`): nothing to do here — with
`"auto": true` the server provisions at boot, and a message to a `down` agent
that has a `provision` block revives it.

A missing session is **not** a boot error: the agent is reported `down`, its
queue accumulates, and a liveness sweep flips it to `idle` as soon as the
session appears. You may create sessions before or after starting the server.

### Giving an agent the file exchange (optional, no MCP needed)

An agent talks back through files. Its exchange directory is `<cwd>/.muxeon` by
default (or `exchangeDir`, or a directory under the queue root when the agent
has no `cwd`). The protocol, which you should put into the agent's own
instructions file:

- An incoming message appears as `.muxeon/inbox/<id>/message.json`.
- The agent writes its answer to `reply.md` **next to** that file. Other files
  it leaves in that folder are returned as attachments.
- The agent then **deletes `message.json`** — that ends its turn.
- To start a conversation, it drops `{"to": "...", "payload": "..."}` as a JSON
  file into `.muxeon/outbox/`.

If the agent also has a live MCP session (step 11), Muxeon injects a shorter
contract instead: reply with one `send(to, replyTo)` call, which delivers the
answer **and** ends the turn — no `reply.md`, no deletion. That is chosen per
message from whether the session is connected at that moment; nothing to
configure. Pin it with `agents[].replyVia`: `"auto"` (default), `"exchange"`
(always files, the safe pin if the agent's MCP client is unreliable), `"mcp"`.

Write only the form you actually want into the agent's instructions file. Do not
document both as alternatives "just in case" — agents that are told two ways to
answer use both, and the sender receives the answer twice.

---

## 7. Validate the config before starting

Do not discover a config error by watching the server die. Validate first, with a
bounded run so you never end up holding a foreground server:

```bash
cd <ROOT>
timeout 5 npx @art-ws/muxeon 2>&1 | head -20
```

Two possible outcomes:

- **A config error**, naming the offending field with a JSON pointer, e.g.
  `… (at /commandGrants/writer/researcher/0)`. Fix that field and re-run.
- **`muxeon: booted; N agent(s)`**, then `timeout` kills it at 5s. The config is
  good — go to step 8 and start it properly.

**Check:** you saw one of those two. Repeat until it is the second.

---

## 8. Start the server

Run it inside a dedicated tmux session so it survives your shell:

```bash
cd <ROOT>
tmux new-session -d -s muxeon-serve -c <ROOT> 'npx @art-ws/muxeon'
```

Watch it come up:

```bash
sleep 5
tmux capture-pane -t muxeon-serve -p | tail -20
```

**Check:** the pane contains `muxeon: booted; N agent(s)` followed by the agent
list and the plane lines. If it contains a config error, the server exited —
fix and repeat step 7.

---

## 9. Verify the deployment

Run every check. Report the results as a group.

```bash
# 1. admin plane answers (loopback)
curl -s -o /dev/null -w 'admin %{http_code}\n' http://localhost:8080/admin/agents

# 2. agents and their state
npx @art-ws/muxeon agents

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
npx @art-ws/muxeon signals send --from <user> --to <agent> "reply with the single word OK"
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

{ "type": "web", "port": 8090, "deliverUrl": "https://hooks.example/muxeon",
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

## 11. Federation — joining stands (only if asked)

Federation connects two or more Muxeon servers so actors on one reach actors
on another. **Do not add it unless the human asked to join stands** — a config
without `imports`/`federation` behaves exactly as before, and nothing below
applies to a single server.

Names across a link are email-style FQNs: `dev@hq` means "the actor exported
as `dev` by the server this config imports under the name `hq`". Chains grow
on the right (`bob@c@b`) and resolve by the **last** `@`. The `@` character is
therefore reserved — a local name containing it fails validation.

A link has two sides; the same server may play both roles at once, and two
servers importing each other is legal (an instance-id cycle guard keeps the
namespace from looping).

**Exporter** — the side that accepts a connection:

```jsonc
{
  "federation": {
    "port": 8092,                 // its OWN listener: ≠ server.port, ≠ any channel port
    "bind": "127.0.0.1",          // default; put a TLS reverse-proxy in front for a network
    "accept": [                   // one token per importer; the name you choose here
      { "name": "branch",         //   suffixes THEIR senders as seen on this side
        "token": { "$env": "MUXEON_FED_BRANCH_TOKEN" } }
    ]
  },
  "agents": [ { "name": "dev", "type": "claude", "tmux": "dev", "exported": true } ],
  "users":  [ { "name": "alex", "exported": "alexander" } ]   // export under an alias
}
```

Only actors marked `exported` exist to the other side. Everything else —
including their names — is invisible, even by enumeration.

**Importer** — the side that connects:

```jsonc
{
  "imports": [
    { "name": "hq",                              // your local alias for that server;
      "url": "http://127.0.0.1:8092",            //   it becomes the FQN suffix AND a
      "token": { "$env": "MUXEON_FED_HQ_TOKEN" } //   topology node. Token: issued by
    }                                            //   the EXPORTER (same value both .env's)
  ],
  "topology": { "researcher": ["hq"] }   // an edge on the IMPORT NAME grants that
}                                        // actor ALL of hq's exported actors
```

Rules that save a debugging cycle:

- **Tokens are `$env`-only** (step 5) and the same value lives in both `.env`
  files: the exporter's `accept` entry and the importer's `import` entry.
- `federation.port` must differ from `server.port` and from every channel port
  — validation says so.
- `transit` on an import (default `true`) re-exports that neighbour's actors
  to **your** importers, suffix appended: your `bob@c` shows up one hop further
  as `bob@c@b`. Set `transit: false` to keep an import to yourself.
- **Delivery is store-and-forward.** A send to `dev@hq` lands in a persistent
  per-link queue (`queue/fed/hq/`, visible to `muxeon queues`); a dead link
  accumulates and drains on reconnect — nothing is lost. A refusal on the far
  side (paused, WIP-full, unknown actor) comes back **later** as a
  `[federation] not delivered: …` message in the sender's own chat with that
  peer — asynchronous by design, do not wait for it synchronously.
- **Remote statuses are a read-only projection.** Agents show
  `idle`/`busy`/`down` (+ pause), users show presence — published by the owner.
  When the link (or a transit hop) is down, or the neighbour sets
  `federation.publishStatus: false`, they read **`unknown`** (a hollow gray dot
  in the panel, with the cause in the tooltip) — never a stale value.
- An exported actor can **reply** to whoever wrote to it (the stamped
  `name@link` sender, with `replyTo`); cold initiative in the reverse direction
  needs a mutual import — or relay mode, below.
- What never crosses a link: slash commands, lifecycle, raw mode, screen
  capture, group/tag broadcasts, the transport journal.
- On a machine that exports `HTTP_PROXY`, loopback links need
  `NO_PROXY=127.0.0.1,localhost` in the server's environment — otherwise the
  link client dials the proxy instead of the neighbour.

### Relay through a hub (when the two servers cannot reach each other)

Use this when both servers sit behind NAT/firewalls with no inbound port —
i.e. **neither can be the exporter** — but both can dial a third server. The
two satellites each import the hub and **publish** their surface up that link;
the hub **relays** each publication to all its neighbours. The result behaves
like a direct mutual import.

Satellite (both A and B look like this — note there is **no `federation`
block**: no listener, no port, no reverse-proxy):

```jsonc
{
  "imports": [
    { "name": "c", "url": "https://hub.example:8092",
      "token": { "$env": "MUXEON_FED_C_TOKEN" },
      "publish": true }                       // send MY export surface up this link
  ],
  "agents": [ { "name": "ann", "type": "claude", "tmux": "ann", "exported": true } ],
  "topology": { "ann": ["c"] }                // the hub edge covers relayed actors too
}
```

Hub:

```jsonc
{
  "federation": {
    "port": 8092,
    "accept": [
      { "name": "a", "token": { "$env": "MUXEON_FED_A_TOKEN" }, "relay": true },
      { "name": "b", "token": { "$env": "MUXEON_FED_B_TOKEN" }, "relay": true }
    ]
  }
}
```

Rules:

- **Both flags are required and both default to false.** `publish` without the
  hub's `relay` is a warning in the satellite's log
  (`publish requested but the hub did not grant relay`) and the link runs in
  plain import mode; `relay` without `publish` relays nothing.
- On the hub the published actors appear under the **accept's name** (`ann@a`);
  one server further the chain grows as usual (`ann@a@c`). A relay-enabled
  accept name becomes a **topology node** exactly like an import name — the
  hub's own actors need an edge on it to talk to the satellite.
- The hub **queues for an offline satellite** (`queue/fed/<accept>/`) — a
  mailbox that drains when the satellite reconnects. Delivery through the hub
  is two hops of the same store-and-forward as everything else.
- Published actors are **first-class addressees** — the reply-only restriction
  of plain federation does not apply to them.
- **State this to the human**: `publish` is a broad consent — the satellite's
  exported actors become reachable to the hub's *entire* downstream (its
  importers and their transit), and the hub sees the A↔B traffic in plain
  text. Relay is for hubs the satellites trust.

**Check** (run on one satellite once all three are up): the other satellite's
actor shows up as `<name>@<their-accept>@<your-import>` (e.g. `bob@b@c`) in the
panel/`list_peers`, and a send to it round-trips:

```bash
npx @art-ws/muxeon signals send --from <user> --to bob@b@c "reply with the single word OK"
```

On the far satellite the record arrives with the sender named
`<user>@a@c` — each hop stamps its own suffix.

**Check** — exporter first, then importer, then end-to-end:

```bash
# 1. the exporter's listener answers with the export surface (run on the exporter)
curl -s -H "authorization: Bearer <the accept token value>" \
  http://127.0.0.1:8092/fed/actors
# expected: {"actors":[{"name":"dev","type":"agent",...}]} — exactly the exported set

# 2. the importer sees the peers (panel sidebar gets a "Servers" section; or MCP
#    list_peers of an agent with an edge on the import shows dev@hq with a status)

# 3. a message crosses (run on the importer; the sender needs an edge on "hq")
npx @art-ws/muxeon signals send --from <user> --to dev@hq "reply with the single word OK"
```

**Expected:** check 1 lists only the exported actors; check 3 prints
`queued <id> → dev@hq`, and on the **exporter** the record shows up in
`queue/<dev-tmux>/pending` (or `done/` once the turn ran) with the sender named
`<user>@branch` — the receiving side stamps that suffix itself, which is why a
federated `from` cannot be forged.

---

## 12. Routines (only if asked)

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
npx @art-ws/muxeon routines list
```

**Check:** your routine appears with the expected owner and schedule.

---

## 13. Operating it

The same binary is the operator CLI. It is a thin client to the loopback admin
plane, so the server must be running.

```
muxeon agents
muxeon provision|kill|restart <agent>
muxeon pause|resume <agent|user>
muxeon command <slash> <selector…>
muxeon channels
muxeon signals send --from <node> --to <node> [--blob <path>] <text…>
muxeon queues peek|cancel|requeue <participant> [<id>]
muxeon routines list [<owner>]
muxeon routines get|delete|enable|disable|run-once <owner> <id>
muxeon routines put <owner> <id> <file.md>
muxeon hash-password [--stdin]
options: --url <admin-url> | --config <path>
```

`hash-password` is the one subcommand that talks to nothing — no server, no
config — so it works before the stand exists. `pause` takes a user as well as an
agent: for a person it is do-not-disturb (their own notes still land). With
federation, `queues` also takes a **link name** (`muxeon queues peek hq`) — the
per-link store-and-forward queue is a participant like any other, and `signals
send --to <actor>@<import>` crosses the link.

`restart <agent>` restarts an **agent**, not the server. Configuration is read
once at boot — a config edit needs the server process restarted:

```bash
tmux kill-session -t muxeon-serve
tmux new-session -d -s muxeon-serve -c <ROOT> 'npx @art-ws/muxeon'
```

Restarting the server does **not** kill agent sessions; it re-attaches and
re-probes them. Queues live on disk and survive it.

---

## 14. Security posture — state this to the human

Do not deploy this quietly. The trust model is deliberate and the human must
know it:

- Muxeon coordinates **mutually trusted local agents on one machine**.
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
- With **federation**, the link listener is a third surface: bearer-token
  authenticated, loopback by default, TLS via a reverse-proxy when it faces a
  network. One accept token grants the holder **all** exported actors (that
  granularity is a design decision — say so). What crosses the link is bounded:
  exported actors, their availability projection, and message traffic — never
  consoles, lifecycle, the journal, or anything unexported.
- With **relay**, `publish: true` widens that consent: the satellite's exported
  actors become reachable to the hub's entire downstream, and the hub carries —
  and can read — the satellite-to-satellite traffic. Both sides opted in
  explicitly (`publish` + `relay`), but the human must know what the hub sees.

If the human asked you to expose any port publicly, stop and confirm — that is
outside this design and needs an explicit decision.

---

## 15. Troubleshooting

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
| `bun: not found` from `npx` | Node shim cannot find bun | Install bun, or set `MUXEON_BUN=/path/to/bun` |
| Login answers `"user" is required` | Channel is in users mode | Send `{"user":…,"password":…}` — the name is a `users[].name` |
| Login answers `invalid credentials` | Wrong name **or** wrong password | The two are deliberately indistinguishable; check both |
| Boot warns `inline auth.password` | A literal user password | Allowed (§17.2), but move it to `$env` or `passwordHash` |
| Boot warns `no user bound to it` | users-mode channel with no binding | Nobody can log in — add `users[].channels` |
| Telegram replies "not linked to a Muxeon user" | Sender's alias is not bound | Add that account to some `users[].channels.<channel>.alias` |
| A person sees no peers | No topology edges for that user | Their self-chat still works; add the edges |
| Boot dies on a name with `@` | `@` is the FQN separator (federation) | Rename the local entity; only federated names carry `@` |
| Send to `dev@hq` refused `TOPOLOGY_DENIED` | Sender has no edge on the import node | Add `"<sender>": ["hq"]` to the topology |
| A `[federation] not delivered: UNKNOWN_ACTOR` note | The remote actor is not exported | The exporter must mark it `exported`; unexported names do not exist across a link |
| Remote peers all read `unknown` | Link down, or the neighbour publishes no statuses | Check the link warns in the exporter's/importer's log; `publishStatus: false` is deliberate |
| Link never comes up, log says connect failed | Wrong URL/token — or a proxy in the way | Same token value in both `.env`s; on proxied hosts set `NO_PROXY=127.0.0.1,localhost` |
| Log warns `publish requested but the hub did not grant relay` | The hub's accept entry lacks `relay: true` | Add `"relay": true` to that satellite's accept on the hub (both flags are required); the link meanwhile works in plain import mode |
| The other satellite's actors never appear (`bob@b@c` missing) | One of the two relay flags is missing, or that actor is not `exported` | Reachability is `publish` ∧ `relay` ∧ `exported` — check all three on the respective servers |

---

## 16. Report back

When you finish, report exactly this:

1. **Versions**: bun, tmux, node, and the Muxeon version you installed.
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
