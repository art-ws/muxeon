# Security

## Trust model — read this before deploying

TEAMAI coordinates **mutually trusted local agents on one machine**. That
assumption is load-bearing; the following are properties of the design, not
oversights:

- **Agent identity is self-declared.** On the MCP agent-plane an agent states
  its name at `initialize`. The topology is a *routing constraint*, not an
  anti-spoofing control — a malicious local process could claim another agent's
  name. Per-agent tokens or unix sockets are the hardening path and plug in
  without changing the core.
- **The operator plane is loopback-only and unauthenticated.** Any local process
  that can reach loopback can drive it. The guarantee the design makes is the
  *absence of operator tools on the agent-plane*, not cryptographic protection
  of the admin plane from a hostile local process. Do not expose that port.
- **The web panel is the one authenticated surface.** It gates on a password
  from `$env`; unauthenticated requests never reach the core ports, and an
  authenticated session is capability-capped to the operator's own channel and
  topology neighbours.
- **The federation listener is a third, bearer-token surface.** Loopback by
  default; TLS is the reverse-proxy's job when it faces a network. One accept
  token grants its holder every `exported` actor — server-level granularity by
  design. What crosses a link is bounded: exported actors, their availability
  projection and message traffic; never consoles, lifecycle, the journal, or
  anything unexported, and the receiving side stamps the sender's suffix
  itself, so a federated `from` cannot be forged. **Relay mode widens the
  consent knowingly**: a satellite that sets `publish` makes its exported
  actors reachable to the hub's entire downstream, and the hub carries — and
  can read — the satellite-to-satellite traffic (no end-to-end encryption).
  Both flags (`publish` on the satellite, `relay` on the hub's accept) default
  to false; relay is for hubs the satellites trust.

In short: run TEAMAI on a machine whose local processes you trust, and keep its
ports off the network.

## What *is* defended

Everything crossing the process boundary is treated as hostile and sanitized,
each with a negative test in the suite:

- **Blob references** in payloads (`..`, absolute paths, symlinks) — opaque ids
  only, with realpath containment before every read and write.
- **Message ids and session names** — sanitized before they are used to build
  any filesystem path.
- **Channel and webhook bodies** — validated before reaching the router.
- **Provisioning** — argv arrays, never a shell string.
- **Secrets** — channel credentials come from `$env` only; an inline secret
  fails validation, and resolved values never appear in queue records, logs or
  error responses.
- **File exchange operations** — confined to the agent's exchange directory.

## Reporting a vulnerability

Please do **not** open a public issue. Report privately via GitHub's
[security advisory form](https://github.com/art-ws/teamai/security/advisories/new).

Include what you can reproduce, the impact you believe it has, and the version
or commit you tested. You will get an acknowledgement, and a fix or an
explanation of why the behaviour is intended under the trust model above.
