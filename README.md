<p align="center">
  <img src="assets/logo/muxeon-mark.png" alt="" width="110" />
</p>

<h1 align="center">Muxeon</h1>

<p align="center"><em><strong>mux</strong> — from <strong>tmux</strong>, the terminal multiplexer<br>
<strong>eon</strong> — from Ancient Greek <strong>αἰών</strong> (aiōn): an age, a lifetime, an eternity<br>
literally, the place where tmux sessions live</em></p>

Muxeon is a **transport and coordinator** for local CLI agents (`claude`,
`codex`, …) running in **tmux sessions**. It is not an agent itself: it
connects agents, tracks their lifecycle, routes messages between them along a
declared topology, and lets **people** reach them through channels (a web panel
out of the box; Telegram, Slack and a minimal webhook when you bring the
credentials) — a human is modeled as just another participant, with their own
edges, queue and history.

TypeScript monorepo on [bun](https://bun.sh). MIT licensed.

## Requirements

- **[Bun](https://bun.sh) ≥ 1.2** — Muxeon is a Bun application (the HTTP
  surfaces, process control and static serving are all Bun APIs). The `npx`
  entry point is a thin Node shim that hands over to `bun`; it will tell you so
  if bun is missing. Set `MUXEON_BUN` to use a bun outside `PATH`.
- **tmux** — that is where the agents live.

## Quick start

```bash
# describe your team
curl -o muxeon.config.json \
  https://raw.githubusercontent.com/art-ws/muxeon/main/muxeon.config.example.json

# run it straight from npm — no install. The config is found by convention
# (./muxeon.config.json, then upward), or pass a path / --config
npx @art-ws/muxeon
```

`bunx @art-ws/muxeon` works too and skips the Node shim entirely. To install it
once:

```bash
npm i -g @art-ws/muxeon     # or: bun i -g @art-ws/muxeon
muxeon agents               # the package is scoped, the command is not
```

From a clone, run it from source instead:

```bash
bun install
cp muxeon.config.example.json muxeon.config.json
bun packages/server/src/index.ts
```

A minimal config is one agent, a human, and the edge between them:

```json
{
  "server": { "port": 8080 },
  "agents": [
    { "name": "researcher", "type": "claude", "tmux": "researcher-session" }
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

That gives you the web panel on `http://localhost:8091/team/` — the quickest way
in, since it needs nothing but a name and a password. People are declared in
`users[]`: each is a full participant with their own topology edges, queue,
history and channel identities, so several humans can share one stand and still
see only what they are wired to. Add more by adding entries — and give someone
`"role": "admin"` if they should also see the server-wide transport journal.

The older single-login shape (a channel with `bindOperator` and one shared
password) still works unchanged; it is simply the `users[]` case with one
nameless person.

Channel secrets are `$env`-only — an inline token fails validation, a missing
variable fails the boot.

The same binary carries the operator subcommands (a thin client to the
loopback HTTP-admin):

```bash
muxeon agents                         # names + idle/busy/down
muxeon kill researcher                # interrupt; queue keeps accumulating
muxeon restart researcher             # kill + provision; queue drains
muxeon signals send --from alex --to researcher "ship the report"
muxeon queues peek researcher         # inspect pending/ and cur/
muxeon routines list                  # scheduled MD routines
```

See the **[operator guide](docs/operator-guide.md)** for the full surface:
configuration reference, CLI, channels, routines, the web panel, and
troubleshooting.

Deploying it with an AI agent? Hand it **[docs/LLM.md](docs/LLM.md)** — the same
install, configure and verify path written as an executable runbook, with a
check after every step.

## How it works (one paragraph)

The filesystem is the source of truth: every participant owns a maildir-style
queue (`tmp/pending/cur/done/failed`) whose transitions are atomic renames, so
"one message at a time per agent" and crash recovery are filesystem invariants,
not code conventions. All producers (MCP `send`, channels, signals, routines)
deliver through a single router that enforces the topology; one dispatcher loop
per session injects into tmux, detects the turn end via the agent type's
adapter, and archives the record. Agents coordinate over a least-privilege MCP
agent-plane; the operator manages everything over a separate loopback-only
HTTP-admin plane. Delivery is at-least-once with id-based dedup. Several
servers can **federate** over token-authenticated links — actors get
email-style names (`dev@hq`), each link is store-and-forward, and two servers
that cannot reach each other can relay through a shared hub they both import.

Agents that cannot (or should not) speak MCP use the **file exchange** instead:
an incoming message is materialized as `.muxeon/inbox/<id>/message.json` in the
agent's working directory, the agent writes `reply.md` next to it and deletes
the message file to end its turn. Dropping a `{ "to": …, "payload": … }` file
into `.muxeon/outbox/` sends. The exchange is a projection — the queue stays
the truth.

## Packages

Layering is acyclic and enforced by `tools/architecture.test.ts` — a dependency
edge against the layering, a cycle, or an unauthorized consumer of
`@muxeon/queue` fails the suite.

| Package | Responsibility |
|---|---|
| `core` | Domain types (Signal/Message, Session, Topology, name codec). No I/O. |
| `config` | Load → `$ref` → `$env` → validate pipeline; fail-fast rules; discovery. |
| `queue` | Maildir queues + blob store with containment. Dumb FS layer; reachable only via `orchestrator`. |
| `tmux` | Thin tmux transport (send/capture/has/new/kill). |
| `adapters` | Per-agent-type specifics: render, busy-detection strategy, hooks, slash commands. |
| `orchestrator` | Router (single delivery point), per-session dispatcher, egress dispatcher, status, control lane, retention. |
| `lifecycle` | attach / provision (argv, no shell) / kill / restart / slash. |
| `signals` | Signal envelope + on-demand send through the router. |
| `routines` | MD+frontmatter routines: discovery (central + cwd), cron/once scheduler, crash-safe state. |
| `channels` | Unified connector interface + telegram / slack / web. |
| `federation` | Server-to-server links (§18): handshake + WS wire protocol, link client/listener, remote-actor registry, status publisher. Routing authority stays in `orchestrator`. |
| `webchat` | Operator web panel surface: own port, auth gate, REST + WS, durable chat history, media via blobs. |
| `webchat-ui` | React SPA of the panel — build-time only (`bun run build` → `dist/`), served by `webchat`, outside the runtime graph. |
| `server` | Composition root: both network planes, channel wiring, admin, CLI. |

## Development

```bash
bun run typecheck   # tsc --noEmit
bun run lint        # biome
bun test            # everything incl. invariant guards (tmux tests skip without tmux)
bun run build       # bundle the server binary to dist/
```

Some tests bind loopback ports (8080/8091) — stop a locally running instance
first, or they fail with `EADDRINUSE`. If your shell exports `HTTP_PROXY`, drop
it for the suite (`env -u HTTP_PROXY bun test`) so loopback calls are not
hijacked.

See **[CONTRIBUTING.md](CONTRIBUTING.md)** before opening a pull request, and
**[SECURITY.md](SECURITY.md)** for the trust model and how to report a
vulnerability.

> **A note on `§`/`FR-` markers.** Comments and docs carry references like
> `§10.2` or `FR-93`. They point into the project's internal specification and
> requirement register, which are not part of this repository. Treat them as
> stable traceability labels — the code and the operator guide are
> self-contained; you never need the spec to read, build, or extend Muxeon.

## License

[MIT](./LICENSE)

---

<p align="center"><em>Not a single line of code written by a human.<br>
Not a single idea taken from AI.<br>
Made by Human &amp; AI, with Love to art. ❤️</em></p>
