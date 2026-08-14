# Muxeon operator guide

How to run a team, talk to it, and keep it healthy.

> `§`/`FR-` markers in parentheses are traceability labels pointing into the
> project's internal specification, which is not part of this repository. This
> guide is self-contained — you never need the spec to operate Muxeon.

## 1. Launching

```
muxeon [path/to/config.json]      # or: muxeon --config <path>
```

Without a path the config is discovered by convention (§7.4): the current
directory, then upward, looking for `muxeon.config.json`, then
`.muxeon/config.json`. The directory of the found config is `<config_dir>` —
the base for queues (`<config_dir>/queue`), routine state
(`<config_dir>/state`), central routines (`<config_dir>/routines`) and
relative `$ref`s.

Boot is fail-fast on configuration (every §7.5 rule), but tolerant on agents:
a missing tmux session makes the agent `down`, not the boot fatal — its queue
accumulates until you bring it up. You can start (or kill) a session **by hand**
at any time after boot: a liveness sweep (FR-93, §5.1) re-probes every non-busy
session every `livenessProbeMs` and reconciles its status (`down` → `idle` on a
hand-start, `idle` → `down` on a hand-kill), so the panel reflects reality
without a server restart. The sweep is attach-only — it never starts a session
itself (bring-up stays `provision`/auto-revive/operator territory).

## 2. Configuration reference (§7)

```jsonc
{
  "name": "prod-cluster",         // optional (FR-90): a label for this instance — shown in
                                  //   the panel topbar next to the logo and in the page title
                                  //   ("<name> - Muxeon"); omitted ⇒ the server's hostname()
  "server": {
    "port": 8080,                 // both planes share this port (§8.1)
    "mcp": true,                  // agent-plane gate; false = no agent coordination
    "queueDir": "./queue",        // queue root override (default <config_dir>/queue)
    "retain": { "age": "7d", "count": 1000 },   // done/-window double cap (§5.4)
    "cadence": {                  // NFR-10, calibrated defaults — all optional
      "outputPollMs": 100, "downProbeMs": 1000,
      "routineTickMs": 1000, "routineRescanMs": 30000, "retentionSweepMs": 60000,
      "idleTeardownSweepMs": 60000,  // idle auto-teardown sweep (§5.1/FR-92)
      "livenessProbeMs": 2000,       // liveness re-probe of non-busy sessions (§5.1/FR-93)
      "presenceSweepMs": 60000       // user-presence fade-out sweep (§17.5/FR-133)
    },
    "presenceTtl": "15m"            // a user counts as online this long after their
                                    //   last outgoing message (§17.5/FR-133)
  },
  "agents": [
    {
      "name": "researcher",       // topology identity
      "title": "Researcher",      // optional label for the panel (FR-156); the panel
                                  //   prints it instead of the name and keeps the
                                  //   name in the tooltip. Labels only — you still
                                  //   address, route and grep by `name`
      "type": "claude",           // adapter
      "tmux": "researcher-session", // the stable session name = queue key
      "cwd": "/path/to/repo",     // optional; enables cwd routines (§6.2)
      "provision": {
        "command": ["claude"], "cwd": "...", "env": {},   // argv, no shell
        "auto": true,                                     // provision on boot (FR-50)
        "teardown": { "slash": "exit", "graceMs": 5000,   // graceful shutdown (FR-64)
          "idle": "1h" }            // auto-teardown after 1h idle (FR-92); true = 1h
      },
      "retain": { "age": "3d" }   // optional per-agent retention override
    }
  ],
  "topology": {                   // undirected: an edge = permission to talk
    "researcher": ["writer", "operator"]
  },
  "commandGrants": {              // opt. (FR-94/95): who may run which slash commands on whom
    "writer": { "researcher": ["clear", "compact"] },  // directed: <from>: { <to>: [<slash>] }
    "*": { "researcher": ["*"] }  // "*" = any sender / any recipient / every command
  },
  "sessionGrants": {              // opt. (FR-96/97): who may start/stop/… whose session
    "writer": { "researcher": ["restart", "stop"] },   // directed: <from>: { <to>: [<action>] }
    "*": { "researcher": ["*"] }  // "*" = any sender / any recipient / every action
  },
  "users": [                      // the PEOPLE on this stand (§17.2, section 8.1a)
    { "name": "alex", "role": "admin",
      "auth": { "password": { "$env": "MUXEON_ALEX_PASSWORD" } },
      "channels": { "web": true, "tg-main": { "alias": "alex_tg" } } }
  ],
  "channels": [                   // `name` = the binding key (default: the type)
    { "name": "tg-main", "type": "telegram",           // users mode: identities
      "token": { "$env": "TELEGRAM_TOKEN" } },         //   come from users[]
    { "name": "web", "type": "webchat", "port": 8091,  // web panel (§12, section 8)
      "auth": { "mode": "users" } },
    // legacy single-login channels still work — one channel binds ONE operator (§7.5):
    { "type": "slack", "token": { "$env": "SLACK_TOKEN" }, "channel": "C0123456",
      "bindOperator": "ops2" },
    { "type": "web", "port": 8090, "deliverUrl": "https://hooks.example/muxeon",
      "secret": { "$env": "WEB_HOOK_SECRET" }, "bindOperator": "ops3" }
  ]
}
```

- **Secrets only via `$env`** (§7.3) — an inline token fails validation; a
  missing variable fails the boot. Resolved secrets never appear in queue
  records, logs, or error responses (§8.7).
- Humans are declared **explicitly** in `users[]` (§17.2) — or implicitly by a
  channel's `bindOperator` in the legacy shape. Either way they become topology
  nodes; give them edges or they can neither send nor receive (warning at boot).
  A user with no edges still has a working self-chat.
- **Agent→agent slash commands (`commandGrants`, FR-94/95)** let one agent run
  another's slash commands over MCP (`send_command`), and introspect what it may
  run (`list_commands`). The grant is **directed** — `{ "<from>": { "<to>":
  ["<slash>"] } }` — and only NARROWS: a command still needs a topology edge
  (§10.2) **and** the command in the recipient's catalog (its `commands` ∪ the
  internal ones). `"*"` is a wildcard for any sender, any recipient, or every
  command. No block ⇒ no agent→agent commands (the default). An operator is never
  a sender or recipient (it commands via the operator-plane / CLI, section 4).
  Validation is fail-fast: unknown agent, an explicit pair without an edge, or an
  unknown command name all fail the boot (§7.5).
- **Agent→agent session control (`sessionGrants`, FR-96/97)** let one agent
  start/stop/restart a peer's tmux session over MCP (`control_session`), and
  introspect what it may do (`list_controls`) — agents hard-managing each other
  (forced restart, emergency shutdown). The grant is the **directed** twin of
  `commandGrants` — `{ "<from>": { "<to>": ["<action>"] } }` — where `<action>` is
  one of `start` (=provision), `stop` (=kill, immediate), `shutdown` (graceful),
  `restart` (=kill+provision), `reload` (graceful). It only NARROWS: an action
  still needs a topology edge (§10.2) **and** to be applicable to the recipient
  (`stop`/`shutdown` work on any session; `start`/`restart`/`reload` need a
  `provision` command). `"*"` wildcards any sender/recipient/action. No block ⇒ no
  agent→agent session control (the default); an operator is never a sender or
  recipient. Fail-fast validation: unknown agent, an explicit pair without an edge,
  an unknown action, or `start`/`restart`/`reload` on a provision-less recipient all
  fail the boot (§7.5).
- **Users (`users[]`, FR-121…FR-135)** declare the PEOPLE on this stand — see
  section 8.1a. Each one is a full transport participant (their own topology
  edges, queue, history and channel identities), so `users[]` is what replaces
  the single shared `bindOperator` login. `channels[].name` names a channel
  instance and is the key of a user's binding; it defaults to the channel `type`.
- The config may be split across files with local `$ref` (§7.2); the monolith
  stays equivalent.
- **Idle auto-teardown (`teardown.idle`, FR-92)** retires an agent **the system
  raised** (a `provision`ed session — not one you attached to) after it has been
  idle with no transport traffic for the window (`"1h"`/`"30m"`/…, or `true` = 1h).
  `idle` lives in the `teardown` block, so it resolves agent → `types.<type>`
  like the rest of the strategy, and uses that strategy to close gracefully
  (an idle-only block ⇒ a hard kill). A new message later lazy-revives the agent
  (FR-51) — a bring-up/idle-down cycle. Hand-started / attach-only sessions are
  left alone (the liveness sweep marks them `external` precisely so this holds).

## 3. Talking to agents through a channel (§3.2)

Address an agent with `@name` anywhere in the message — the first matching
token wins; with no match the channel's `defaultTarget` applies; with neither
you get a clear error back in the same chat. Attach files/media: they are
stored as blobs and delivered to the agent as opaque references. Agent replies
come back on the same channel, attributed `[agent-name] …`.

Delivery is **at-least-once**: after a crash or a channel outage the same
message may be pushed twice; dedup by id suppresses most repeats.

**With `users[]` (§17.6) a channel carries many people.** The sender is resolved
through the bindings — `users[].channels[<channel>].alias` — to exactly one user;
an account nobody claims gets a polite refusal and never reaches the transport
(there are no guests). The recipient is then resolved in order: a channel-native
mention of another bound user, else an `@name` of one of the sender's peers, else
the message is a **note to self** and lands in their own chat. `defaultTarget`
does not apply in that mode — there is no single sender to authorize it against.
Outbound messages fan out to **every** channel the user is bound to; their panel
history is the durable copy, each channel push is best-effort.

### 3.1 Agent replies: the file exchange (§13, FR-52..56) — the default path

Every agent gets an **exchange directory** (`agent.exchangeDir` → `<cwd>/.muxeon`
→ `<queue root>/<session>/exchange`) and needs NOTHING configured — no MCP, no
hooks. Each delivered message materializes as
`<exchange>/inbox/<id>/message.json`, and the injected text is a self-sufficient
instruction telling the agent the contract:

- write the answer into `reply.md` next to `message.json` (plain text/markdown),
  **in the same language as the request** (mirror request language; the
  instruction text itself is always English — an invariant protocol surface);
- any **other files** created in that folder go back to the sender as
  attachments (capped at 25 MiB each);
- **delete `message.json`** as the **very last step** — deleting it ends the
  turn immediately (file-detect, FR-53), so anything written afterwards is no
  longer collected; an agent that forgets to delete is still finished by the
  output detector (§5.2).

The collected reply routes back to the sender as the agent's own message
(`<id>:reply`); with no `reply.md` the console-scrape/nudge chain (FR-47/45)
applies as before. To **initiate** a send (not a reply), the agent drops a file
into `<exchange>/outbox/`:

```jsonc
// <exchange>/outbox/anything.json
{ "to": "writer", "payload": "текст", "files": ["report.pdf"] } // files optional, cwd-relative
```

The system picks it up (cadence `outboxPollMs`), validates the topology edge and
file containment, and routes it as the folder's owner. A refused message comes
back as `<name>.rejected.json` in the same folder with a logged reason.

#### The compact form for agents with MCP (§13.6, FR-156/FR-157)

The file contract costs the agent **two extra model round-trips** at the end of
every turn (write `reply.md`, then a second call to delete `message.json`), and
the answer only leaves once the turn has ended. So when an agent has a **live**
agent-plane session (§3.2), Muxeon injects a shorter instruction instead: reply
with **one** `send(to, replyTo)` call, which delivers the answer *and* ends the
turn. Nothing else changes — `message.json` is still materialized, and a long
payload still lives only in that file.

You configure nothing for this. The choice is made **per message, at injection
time**, from whether that agent's MCP session is connected *right now*: unplug
the shim and the next message arrives with the file contract again, with no
config edit and no restart. A merely *configured* MCP server does not count —
only one that actually connected.

The two forms are never mixed. An instruction offering a fallback path gets both
used, and the sender receives every answer twice (this happened in production);
so the compact form forbids `reply.md` outright, and a turn closed by `send` is
not collected from the exchange at all.

Override per agent when you need to:

```jsonc
{ "name": "researcher", "type": "claude", "tmux": "researcher-s",
  "replyVia": "auto" }   // "auto" (default) | "exchange" | "mcp"
```

`"exchange"` is the safe pin — it keeps an agent on the universal path even with
MCP up, which is what you want if that agent's shim is flaky: the liveness signal
is only true at injection time, and a client that dies mid-turn leaves the compact
form with nowhere to answer. `"mcp"` forces the compact form for a client the
server cannot observe.

Two things worth knowing about `send` as a turn-ender: it closes the turn only
after the message was actually **accepted** (a WIP-limit or paused-recipient
refusal leaves the agent holding the floor, so it can retry), and it closes only
the **caller's own** turn. The receipt carries `turnClosed` whenever the call had
a `replyTo`.

### 3.2 Optional acceleration: connecting an agent to the agent-plane MCP (§8.6, FR-44)

The MCP client is **no longer required** for replies (before §13 an agent
without one was receive-only). It remains useful for mid-turn
reactions/progress, `get_status`, `get_screen` (read a neighbour's console as
text — see below) and tool-style sends — and it is what earns an agent the
compact reply contract above, which is the cheapest way to shorten the gap
between "the agent finished thinking" and "the sender has the answer".
Connecting it is the **owner's deliberate action** — Muxeon never touches agent
configuration (FR-11b). Step by step:

1. **Prerequisites.** `server.mcp` must not be `false` in `muxeon.config.json`
   (default `true`); know the agent's **topology name** (`agents[].name`) and
   its workspace (`agents[].cwd` — the dir its CLI runs in) and `server.port`.
2. **Register the shim** in the agent's own MCP-client config. A CLI agent's
   native MCP client cannot declare the agent's topology name at `initialize`,
   so use the shipped stdio-shim. For claude/openclaude — `.mcp.json` in the
   agent's workspace (MERGE with existing `mcpServers`, don't clobber them; use
   an absolute path to the shim):

   ```jsonc
   {
     "mcpServers": {
       "muxeon": {
         "command": "bun",
         "args": ["/path/to/muxeon/packages/server/src/mcp/shim.ts"],
         "env": {
           "MUXEON_AGENT_NAME": "researcher",            // agents[].name, EXACTLY
           "MUXEON_MCP_URL": "http://127.0.0.1:8080/mcp" // server.port
         }
       }
     }
   }
   ```

3. **Restart the agent** so its client picks the config up: `muxeon restart
   <name>` (CLI §4) or restart its CLI inside the tmux session by hand. A
   mid-turn restart re-sends the in-flight message after the agent is back
   (§10.9). (This is needed once, to load `.mcp.json` — NOT after every server
   restart; see the durability note below.)
4. **Verify.** The agent now sees the §8.6 read/route tools
   (`whoami`/`list_peers`/`send`/`get_status`/`get_history`/`get_screen`): in its
   session run `/mcp` (the client's server list) or ask it to call `whoami` — the
   echo must be the topology name. On the server side a rebind under an existing
   name logs `identity … taken over` (FR-44b).

**Watching a neighbour's console (`get_screen`, FR-147).** Every agent may read
the **visible terminal pane** of any agent it has a topology edge with, as plain
text — the same capture the panel's Screen Live shows. It answers "what is this
peer actually doing" when `get_status` only says `busy`: which prompt it sits on,
what it printed last, whether it is waiting for input. The edge is the whole
gate — no grant to configure, symmetric with being allowed to talk to it. It is
**read-only**: nothing is typed, sent or changed. `historyLines` (default 0, max
500) adds scrollback above the visible screen. A peer with no console (a person,
a group, a tag) answers `NOT_CAPTURABLE`, a peer with no live session
`AGENT_DOWN`, a non-neighbour `UNKNOWN_PEER`. The text is scrubbed of resolved
`$env` secrets before it leaves the server (§8.7) — but remember that whatever is
on an agent's screen becomes readable by its neighbours: that is what the edge
now means.

**Durable across server restarts (FR-89).** The shim is a self-healing stdio
interface: it connects to the agent-plane lazily and reconnects on any upstream
failure, so a Muxeon **server** restart (a deploy) no longer severs agents — you
do NOT need to `muxeon restart <name>` afterwards. The next tool call simply
re-initializes (the old session 404s, the shim re-handshakes); during the blip
`get_status`/`send` return a retryable `UPSTREAM_UNAVAILABLE`, and `tools/list`
serves the last-known set. A shim started **before** the server warms up in the
background and surfaces the tools (`tools/list_changed`) once the server appears.

**Operational notes.** A crashed agent/shim does NOT lock its name: a new
`initialize` under the same name takes the identity over (FR-44b); the same log
line is your trace of a duplicate-name misconfiguration (two live agents
claiming one name). The shim bypasses local `*_PROXY` interception itself
(re-exec with a clean env).

**Disconnecting** is the reverse: remove the `muxeon` entry from the agent's
`.mcp.json` (delete the file if it held nothing else) and restart the agent.
The exchange path (§3.1) keeps working either way.

## 4. Operator CLI (§7.4/§8.5)

The CLI talks to the loopback HTTP-admin on `server.port` (`/admin`). It reads
the port from the discovered config (`--config <path>` to point elsewhere) or
takes `--url http://127.0.0.1:8080/admin` explicitly.

```
muxeon agents                                  # list: name (session): status [paused]
muxeon provision|kill|restart <agent>          # lifecycle (§4)
muxeon pause|resume <agent|user>               # block/unblock message delivery (§16/§17.8)
muxeon channels                                # operator bindings + deliver status
muxeon signals send --from <node> --to <node> [--id <id>] [--reply-to <id>] <text…>
muxeon queues peek <participant>               # pending/ + cur/ records
muxeon queues cancel <participant> <id>        # remove from pending (cur is refused)
muxeon queues requeue <participant> <id>       # failed/ → pending tail, same id
muxeon routines list [<owner>]
muxeon routines get|delete|enable|disable|run-once <owner> <id>
muxeon routines put <owner> <id> <file.md>
muxeon hash-password [--stdin]                 # argon2id hash for users[].auth (§17.4)
```

Notes:

- `kill` is the interrupt: it works mid-turn; the in-flight message stays in
  `cur/` and is re-sent after `restart`/`provision` (at-least-once, §10.9).
- `provision`/`restart` and queue mutations run **inside the session's own
  loop** between turns — a mid-turn restart waits for the current turn.
- `requeue` of an id already in the done/ window is an explicit no-op.
- `signals send` requires `--from` to be an existing agent/operator (§8.7).
- `hash-password` needs **no running server and no config**: it reads a password
  without echoing it (or from stdin with `--stdin`) and prints the hash to paste
  into `users[].auth.passwordHash`.
- `pause` blocks the **transport**, not the agent: the session keeps running,
  slash commands and lifecycle still work, and a turn already in flight finishes.
  Anyone sending to a paused agent is refused **immediately** (`AGENT_PAUSED`,
  HTTP 409 on the admin plane) and **the message is discarded** — senders must
  retry after the resume, nothing is queued up behind the pause. Whatever was
  already queued stays put and drains on `resume`. The flag is recorded in
  `<config_dir>/state/paused.json`, so it survives a restart; `muxeon agents`
  and the panel both mark it. A **user** can be paused too (§17.8) — that is
  Do-not-disturb: everything from others is refused, their own notes to self
  still land.

## 5. Routines (§6)

A routine is a Markdown file with YAML frontmatter; the body is the signal text
sent to the agent:

```markdown
---
id: nightly-report
schedule: "0 9 * * *"     # cron, or the literal "once"
at: "2026-07-01T09:00:00" # optional, for schedule: once
tz: "Europe/Moscow"       # optional IANA zone (default UTC), DST-aware
target: writer            # optional; default = the owning agent (self)
enabled: true
---
Compile the nightly report.
```

Two locations, merged by id (§6.2):

- **central** — `<config_dir>/routines/<agent>/*.md`, owned by the operator
  (this is what the CLI CRUD edits);
- **cwd** — `<agent.cwd>/.muxeon/routines/*.md`, versioned with the agent's
  repo.

Central wins a collision — in particular a central `enabled: false` is the
kill-switch for an agent-native routine. Missed ticks during server downtime
are skipped, never replayed; a `once` routine survives restarts as "done".
Edits take effect within one re-scan interval (default 30s). `run-once` fires
immediately, ignores `enabled: false`, and does not touch the schedule state.

## 6. Queues on disk (§5.3, NFR-9)

Everything is inspectable under `<root>/<session>/`:

```
tmp/      in-progress writes        pending/  the queue (FIFO by filename)
cur/      the ONE in-flight record  done/     archive = the dedup window
failed/   render/inject errors (requeue-able)
```

`done/` and `failed/` are pruned by `retain.age`/`retain.count`; blobs under
`<root>/blobs/` are garbage-collected once unreferenced and older than
`retain.age`. Editing queue files by hand while the server runs is unsupported
— use `muxeon queues …`, which serializes through the owning dispatcher.

## 7. Troubleshooting

| Symptom | Likely cause / action |
|---|---|
| Agent shows `down` at boot | tmux session absent — `muxeon provision <agent>` (needs a `provision` block) or start the session and `restart`. |
| Agent stuck `busy` | The turn never finished (no per-message timeout in baseline) — `muxeon kill <agent>` then `restart`; the in-flight message is re-sent. |
| Operator gets no replies | `muxeon channels` — `pending` means the connector has not registered its deliver port; for telegram the bot cannot initiate: write to it once first. |
| Message sits in `pending/` | Recipient down or busy — queues drain on idle; `muxeon queues peek` to confirm. |
| "no topology edge" errors | Add the edge in `topology` and restart the server (config is read at boot). |
| A routine never fires | `muxeon routines get <owner> <id>` — check `enabled`, `tz`, and that the owner directory name is a configured agent. |

## 8. Web panel (`webchat`, §12)

A ChatGPT-style chat with any topology neighbor of the panel's operator: text,
files, voice notes (microphone), photos/clips (camera); per-agent history with
live status and message-lifecycle ticks. It runs on its **own port** and is
meant to face the internet only through a TLS reverse-proxy.

The topbar shows the instance label next to the logo and the browser tab reads
`<name> - Muxeon`, where `<name>` is the optional top-level `name` (§2) or, when
omitted, the server's hostname — handy for telling apart several panels.

Each chat's actions menu (the ⋮ kebab) carries **Pause / Resume** (§16): a
reversible switch — no confirm step — that blocks message delivery to that agent
while leaving its session and console alone. A paused agent is marked in the
sidebar (the status line reads `paused`, the dot goes hollow, the row dims; the
real session status stays in the row's tooltip) and in the chat header, and the
composer explains that messages will be rejected rather than queued. The marker
is server state, so every open tab reflects a flip within a poll tick.

The **Settings** page has a build-info footer (FR-91): the server version, the
deployed commit, and its date (the server runs from source, so "build time" is
the HEAD commit's date). It is served behind auth, so it never leaks the version
to unauthenticated visitors; a non-git deployment simply shows the version.

### 8.1 Configuration (§12.2)

```jsonc
{
  "name": "web",                    // the binding key for users[].channels (§17.2)
  "type": "webchat",
  "auth": { "mode": "users" },      // identities = the users bound to this channel
  // legacy alternative, mutually exclusive with the two lines above:
  //   "bindOperator": "operator-web",  // its topology edges = the visible agents (§10.2)
  //   "auth": { "password": { "$env": "MUXEON_WEB_PASSWORD" } },  // $env only
  "port": 8091,                     // REQUIRED, ≠ server.port
  "bind": "127.0.0.1",              // default; keep loopback, proxy from outside
  "upload": { "maxBytes": 26214400, "mime": ["image/*", "audio/*", "video/*",
              "application/pdf", "text/*"] },                 // defaults shown
  "history": { "retain": { "age": "90d", "count": 10000 } }   // defaults shown
}
```

`defaultTarget` is rejected here — the recipient is always chosen in the UI.
Chat history lives in `<config_dir>/webchat/history/<user>/<agent>.jsonl`
(append-only; survives restarts; pruned by `history.retain`; its blob
references keep media alive past the queue's `done/` window).

**Raw mode (§14, FR-88) — driving the terminal directly.** Toggle "Raw mode" on
the Settings page (`#/settings`). While it is on, what you type is sent to the
agent's terminal **as-is** (no protocol wrapping) and the **console snapshot**
comes back as the reply, rendered monospace. Media is disabled in this mode. It
goes through the normal queue (one turn at a time), so it never collides with a
running turn. By default the panel stabilizes and captures the visible pane; to
customize the capture (e.g. navigate a pager before snapping) set a key-DSL rule
— the SAME grammar as slash-command `keys` (FR-80) — per type or per agent:

```jsonc
"types": { "claude": { "raw": { "keys": "capture" } } }   // default = stabilize + capture
// "agents": [{ ..., "raw": { "keys": "C-b capture q" } }]  // per-agent override
```

Raw mode is direct terminal access for the (already trusted, loopback+auth)
operator; it adds no new capability to agents (the flag is operator-side only).

### 8.1a Many people on one stand: `users[]` (§17)

Since §17 the panel can carry **named people** instead of one shared login. A
user is a full transport participant: their own topology edges, their own
pseudo-session queue, their own history, and — optionally — their own telegram
or slack identity.

```jsonc
{
  "users": [
    {
      "name": "alex",                    // one namespace with agents/groups/tags
      "title": "Alexander",             // optional label in the panel (name in the tooltip)
      "color": "#4488ff",                // optional accent, like an agent's
      "role": "admin",                   // "admin" | "user" (default) — see below
      "group": "managers",               // optional; a broadcast to the group reaches them
      "tags": ["leadership"],            // optional; same rules as an agent's
      "auth": { "password": { "$env": "MUXEON_ALEX_PASSWORD" } },
      "channels": { "web": true, "tg-main": { "alias": "alex_tg" } }
    }
  ],
  "channels": [
    { "name": "web", "type": "webchat", "port": 8091, "auth": { "mode": "users" } },
    { "name": "tg-main", "type": "telegram", "token": { "$env": "TG_TOKEN" } }
  ],
  "topology": { "alex": ["researcher", "kim"] }
}
```

- **`channels[].name`** is the stable instance name and the key of a user's
  binding; it defaults to the `type`, which is enough while there is only one
  channel of that type. Naming them lets you run two telegram bots side by side.
- **Passwords** (`auth`, exactly one of the two): `password` — a literal or an
  `$env` reference — or `passwordHash`, an inline argon2id hash produced by
  `muxeon hash-password` (works offline, reads the password without echoing it).
  A literal password is allowed but warns at boot.
- **Roles** are a panel capability, never a transport ACL: who may talk to whom
  is the topology and nothing else. `admin` additionally sees the Transport
  journal and may toggle another user's Do-not-disturb.
- **Self-chat**: you are a row of your own sidebar, listed and sorted among the
  others and rendered exactly like any other person — presence dot, last-message
  preview, unread badge, your group, the same actions menu. Notes to yourself
  plus everything addressed to you. It always works — self-delivery needs no
  edge — and writing to yourself counts as activity, so your own dot turns
  online just like anyone else's.
- **Do not disturb** (§16 for people): you can pause yourself, an `admin` can
  pause anyone. While paused, messages from others are rejected (not queued) —
  your own notes still land.
- **Presence**: a user shows online while their last outgoing message is younger
  than `server.presenceTtl` (default `15m`); it is derived, never set by hand.
- **External channels**: an inbound telegram/slack message is attributed to the
  user whose `alias` matches the sender — an unlinked account is refused politely
  and never reaches the transport. Addressing inside the channel: a mention of
  another bound user, else an `@name` of one of your peers, else it is a note to
  self. Outbound messages fan out to **every** channel you are bound to; the
  panel history is the durable copy, a channel push is best-effort.

The legacy `bindOperator` shape keeps working unchanged (with a deprecation
warning once `users[]` exists), so migration is a config edit, not a data move:
keep the operator's name as a user name and the history/queue stay where they
are.

**Agent initiative without a recipient (§17.11).** An outbox file (§13.4) with
no `to` is fanned out to every `role:"admin"` user — one addressed copy each.
With no admins configured, `to` stays mandatory and such a file is rejected as
before.

### 8.2 Building the UI

The SPA ships as a workspace package and is served automatically once built:

```
cd packages/webchat-ui && bun install && bun run build   # → dist/, auto-served
```

Without a build the panel still answers its API (useful for scripting); the
browser shell just 404s.

### 8.3 Reverse-proxy reference (NGINX)

```nginx
server {
  listen 443 ssl;
  server_name team.example.com;
  # ... ssl_certificate / ssl_certificate_key ...
  client_max_body_size 25m;                  # ≥ upload.maxBytes

  location / {
    proxy_pass http://127.0.0.1:8091;        # the webchat port
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;   # turns on Secure cookies
    proxy_set_header X-Forwarded-Host $host;
    proxy_http_version 1.1;                  # WebSocket (§12.4)
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 300s;                 # keep the push feed open
  }
}
```

Checklist before exposing it:

- `MUXEON_WEB_PASSWORD` is long and unique — everyone holding it acts as the
  same operator (one shared credential; per-user logins are OOS-14).
- TLS terminates at the proxy; the panel itself stays on loopback.
- Login is rate-limited app-side; add proxy-side request-rate caps for depth
  (`limit_req`) — there is no per-message flood cap past login (OOS-5).
- Sessions are durable with a TTL (FR-57): a server restart does NOT log
  browsers out; a session lives `auth.session.ttl` (default `1d`, same duration
  grammar as `retain.age`). The store under `<config_dir>/webchat/sessions/`
  keeps only SHA-256 hashes of the tokens — delete the file to force a global
  logout.

## 9. Federation (§18)

Federation joins several Muxeon servers so agents and users on different
instances interact as if they shared one machine. Names are email-style FQNs:
`dev@hq` is "the actor exported as `dev` by the server I import as `hq`";
chains grow on the right (`bob@c@b`) and resolve by the last `@`.

**Exporting** (the incoming side): declare a `federation` block — a separate
listener port, loopback by default (put a TLS reverse-proxy in front for the
open network) — and issue one token per importer in `accept`. Mark the actors
that should exist to the outside with `exported: true` (own name) or
`exported: "<alias>"` on `agents[]`/`users[]`; everything else is invisible,
even by enumeration. Tokens are `$env`-only, like every channel secret.

**Importing** (the outgoing side): list the neighbours in `imports` — the
`name` you choose becomes the FQN suffix and a topology node: an edge on it
(`"operator": ["hq"]`) grants the actor access to *all* actors of that server.
`transit: true` (the default) re-exports the neighbour's actors to your own
importers, suffix appended.

```jsonc
{
  "imports": [
    { "name": "hq", "url": "https://hq.example.com:8092",
      "token": { "$env": "MUXEON_FED_HQ_TOKEN" } }
  ],
  "federation": {
    "port": 8092,                       // its own listener, never server.port
    "accept": [ { "name": "branch", "token": { "$env": "MUXEON_FED_BRANCH_TOKEN" } } ]
  },
  "agents": [ { "name": "dev", "...": "...", "exported": true } ]
}
```

**Relay mode** (§18.11): two servers that cannot reach each other directly —
typically both behind NAT — talk through a shared hub they both import. The
satellite adds `"publish": true` to its import (it needs **no** `federation`
block at all: no listener, no port, no reverse-proxy); the hub consents with
`"relay": true` on that satellite's `accept` entry. Both flags default to
false, and without either one the link behaves exactly as before. Once both
are set, the satellite's export surface travels *up* its own link and the hub
re-exports it to every neighbour: on the hub the branch appears under the
accept's name (`ann@a`), one server further as `ann@a@c`. The accept name then
becomes a topology node like an import's, and the hub queues for an offline
satellite (`fed/<accept>/`) — a mailbox that drains on reconnect. Note that
`publish` is a broad consent: your exported actors become reachable to the
hub's whole downstream, and the hub sees the transit traffic in plain text —
relay is for hubs you trust.

What to expect at runtime:

- **Delivery is store-and-forward.** A send to `dev@hq` lands in a persistent
  per-link queue (`<queue root>/fed/<name>/`, visible to `muxeon queues`); a
  dead link accumulates and drains on reconnect — nothing is lost. Receipts
  (delivered / WIP_LIMIT / AGENT_PAUSED / UNKNOWN_ACTOR) come back
  asynchronously; a failure appears as a `[federation]` notice in the sender's
  own chat with that peer.
- **`from` cannot be forged.** The receiving link stamps its own suffix on
  every inbound sender name (`alex` → `alex@branch`).
- **Replies flow back without extra config**: an exported actor answering an
  importer's message uses the stamped FQN with `replyTo`. Full initiative in
  the reverse direction needs a mutual import — or relay mode, where published
  actors are first-class addressees.
- **Statuses are a read-only projection.** Remote agents show
  `idle`/`busy`/`down` (+ pause), remote users show presence — published by
  the owner, coalesced (`statusDebounceMs`). When the link (or a transit hop)
  is down, or the neighbour sets `publishStatus: false`, the panel and
  `list_peers` show **`unknown`** — never a stale value, never a fake `down`.
  The panel groups remote actors in a **Servers** sidebar section with a link
  marker per import; a remote chat is an ordinary 1:1 without console,
  lifecycle or pause controls.
- **What never crosses the link**: slash commands, lifecycle, raw mode, Screen
  Live/`get_screen`, group/tag broadcasts, the transport journal. Local queue
  internals stay home; only the availability flags travel.
- **Local testing**: several instances on one machine are a first-class
  scenario — `http://127.0.0.1:<port>` URLs (a warning, fine on loopback),
  mutual imports, one `<config_dir>` per instance. If your shell exports
  `HTTP_PROXY`, exempt loopback (`NO_PROXY=127.0.0.1,localhost`) or the link
  client will try to reach the neighbour through the proxy.

Security posture, the trust boundary and the reporting process are documented in
[SECURITY.md](../SECURITY.md); the invariants the test suite defends are listed
in [CONTRIBUTING.md](../CONTRIBUTING.md).
