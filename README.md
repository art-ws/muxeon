<p align="center">
  <img src="assets/logo/teamai-mark.png" alt="" width="110" />
</p>

<h1 align="center">TEAMAI</h1>

TEAMAI is a **transport and coordinator** for local CLI agents (`claude`,
`codex`, …) running in **tmux sessions**. It is not an agent itself: it
connects agents, tracks their lifecycle, routes messages between them along a
declared topology, and lets a human operator reach them through channels
(Telegram, Slack, a web panel, a minimal webhook) — the operator is modeled as
just another agent.

TypeScript monorepo on [bun](https://bun.sh). MIT licensed.

## Quick start

```bash
bun install

# describe your team (start from the shipped example)
cp teamai.config.example.json teamai.config.json

# launch (finds teamai.config.json by convention; or pass a path / --config)
bun packages/server/src/index.ts
```

A minimal config is two agents and an edge between them:

```json
{
  "server": { "port": 8080 },
  "agents": [
    { "name": "researcher", "type": "claude", "tmux": "researcher-session" }
  ],
  "topology": { "researcher": ["operator"] },
  "channels": [
    { "type": "telegram", "token": { "$env": "TELEGRAM_TOKEN" },
      "bindOperator": "operator", "defaultTarget": "researcher" }
  ]
}
```

Channel secrets are `$env`-only — an inline token fails validation, a missing
variable fails the boot.

The same binary carries the operator subcommands (a thin client to the
loopback HTTP-admin):

```bash
teamai agents                         # names + idle/busy/down
teamai kill researcher                # interrupt; queue keeps accumulating
teamai restart researcher             # kill + provision; queue drains
teamai signals send --from operator --to researcher "ship the report"
teamai queues peek researcher         # inspect pending/ and cur/
teamai routines list                  # scheduled MD routines
```

See the **[operator guide](docs/operator-guide.md)** for the full surface:
configuration reference, CLI, channels, routines, the web panel, and
troubleshooting.

## How it works (one paragraph)

The filesystem is the source of truth: every participant owns a maildir-style
queue (`tmp/pending/cur/done/failed`) whose transitions are atomic renames, so
"one message at a time per agent" and crash recovery are filesystem invariants,
not code conventions. All producers (MCP `send`, channels, signals, routines)
deliver through a single router that enforces the topology; one dispatcher loop
per session injects into tmux, detects the turn end via the agent type's
adapter, and archives the record. Agents coordinate over a least-privilege MCP
agent-plane; the operator manages everything over a separate loopback-only
HTTP-admin plane. Delivery is at-least-once with id-based dedup.

Agents that cannot (or should not) speak MCP use the **file exchange** instead:
an incoming message is materialized as `.teamai/inbox/<id>/message.json` in the
agent's working directory, the agent writes `reply.md` next to it and deletes
the message file to end its turn. Dropping a `{ "to": …, "payload": … }` file
into `.teamai/outbox/` sends. The exchange is a projection — the queue stays
the truth.

## Packages

Layering is acyclic and enforced by `tools/architecture.test.ts` — a dependency
edge against the layering, a cycle, or an unauthorized consumer of
`@teamai/queue` fails the suite.

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
> self-contained; you never need the spec to read, build, or extend TEAMAI.
