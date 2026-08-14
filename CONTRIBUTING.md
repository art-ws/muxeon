# Contributing to Muxeon

Thanks for taking the time. This document covers what the project expects from
a change and how to get it verified.

## Ground rules

1. **No requirement, no code.** Every change should be explainable as a
   behaviour someone asked for. Speculative generality, unused options and
   "might be handy later" abstractions get removed in review.
2. **Invariants are tested, not assumed.** The system guarantees below are held
   by dedicated guard tests. If a change can violate one, that is a bug with a
   missing test — write the test first.
3. **Small, isolated packages.** The layering in `tools/architecture.test.ts` is
   executable, not advisory. New cross-package edges must respect it.

## The invariants worth knowing

These are the guarantees the test suite defends. Read them before touching the
router, the dispatcher or the queue:

- A **busy session receives nothing new** until it goes idle.
- Delivery happens **only over a topology edge**, enforced in exactly one place
  (the router). Every producer — MCP, channels, signals, routines, panel — goes
  through it.
- **Queues survive a process restart**: the filesystem is the source of truth,
  and every transition is an atomic rename.
- At most **one in-flight message per session** (`|cur| ≤ 1`) under any
  concurrency; a single dispatcher owns dequeue.
- Delivery is **at-least-once with id-based dedup** inside the retention window.
- The MCP agent-plane carries **no ungated operator tools**; operator control
  lives on a separate loopback-only plane.
- **Untrusted input cannot leave its sandbox** — blob refs, ids and session
  names are containment-checked before any filesystem access.
- A **once-routine never runs twice**, across restarts included.
- Across a federation link the **export grant is the only gate**: an unexported
  actor does not exist to the link (even by enumeration), the receiving side
  stamps the sender's suffix itself, and system kinds never cross. Remote
  statuses are an ephemeral read-only projection — an unreachable source reads
  `unknown`, never a stale value.
- **Relay is a two-sided opt-in**: the reverse visibility stream over a link
  exists only when the satellite's `publish` meets the hub's `relay`; without
  either flag the link behaves exactly as base federation, and the dial
  direction alone never adds visibility.
- **Exactly one answer per turn**: the injected instruction names one reply path
  — the file contract or the compact `send` — and never mentions the other, not
  even as a prohibition (a ban teaches the path it bans). A turn closed by `send`
  is not collected from the exchange at all, which is what makes the guarantee
  structural rather than a matter of wording. Offering both is not a harmless
  belt-and-braces: agents use both, and the sender gets the answer twice.

## Working on a change

```bash
bun install
bun run typecheck
bun run lint          # biome; `bun run lint:fix` to autofix
bun test
```

All four must pass before a pull request is ready. `bun run build:dist` — which
builds the panel, bundles the server and stages the panel into `dist/ui` — gates
in CI as well; the panel-serving test exercises the real built bundle, so build
it locally if you touch the SPA. A `secretlint` job scans the tree for secret
values and fails the build on any finding (`bun run secretlint` runs it locally).

Environment notes:

- Tests that exercise tmux **skip** when no `tmux` binary is present; they do
  not fail. Install tmux to run them.
- Tests that bind loopback ports (8080/8091) fail with `EADDRINUSE` if a Muxeon
  instance is already running locally — stop it first.
- If your shell exports `HTTP_PROXY`, run the suite as `env -u HTTP_PROXY bun
  test` so loopback requests are not intercepted by the proxy.

## Releasing

Releases are **manual and operator-initiated** — there is no push or tag
trigger. The `Release` workflow (`workflow_dispatch`) runs
[semantic-release](https://semantic-release.gitbook.io/): it derives the next
version from the commits since the last tag, writes `CHANGELOG.md`, tags, and
publishes to npm with provenance.

`dry_run` defaults to **true** — run it that way first to see the computed
version and changelog with no tag, release or publish side effects.

How commit subjects map to a version bump:

| Subject | Bump |
|---|---|
| `T<nn>: …` (this project's task convention) | patch |
| `fix: …`, `perf: …` | patch |
| `feat: …` | minor |
| any type with `BREAKING CHANGE:` in the body | major |
| `docs: …`, `chore: …` | no release |

What lands in `CHANGELOG.md` (`.releaserc.cjs`): `T<nn>` commits form a
**Changes** group with the task id as the bold prefix, `feat`/`fix`/`perf` keep
their usual groups, and every entry carries **the first paragraph of the commit
body** under the subject — so the changelog says what changed and why, not just
a title. Housekeeping types (`chore`, `ci`, `test`, `style`, `build`) stay out
unless the commit carries a `BREAKING CHANGE:` note, which is never hidden.
Write the body accordingly: the opening paragraph is what your users read.

The npm package is the **root** package: `bin/muxeon.js` (a Node shim that
re-execs `bun`) plus `dist/` (the bundled server and the panel under `dist/ui`).
`files` in `package.json` is the allowlist — nothing under `packages/` ships.

### Authentication: trusted publishing, no token

Publishing uses npm **trusted publishing** (OIDC). There is deliberately **no
`NPM_TOKEN` secret**: the workflow requests a short-lived GitHub Actions identity
token (`id-token: write`) and `@semantic-release/npm` exchanges it for a
registry credential valid for that run alone. Nothing long-lived to store,
leak or rotate. `GITHUB_TOKEN` is provided by Actions.

For this to work, the trusted publisher registered on npmjs.com must name this
repository **and this workflow file** — `release.yml`. The filename is part of
the match, so renaming the workflow breaks publishing until the publisher is
updated. A failure here surfaces as `EINVALIDNPMTOKEN`, which in this setup
means "the OIDC claim did not match a trusted publisher", not "the secret is
missing".

Requirements the workflow already pins: Node ≥ 22.14 and npm CLI ≥ 11.5.1.

## Style

- TypeScript, ESM, `bun` as the runtime and test runner. Formatting and linting
  are [biome](https://biomejs.dev) — do not hand-format against it.
- Comments explain **why**, not what. The existing code documents the reasoning
  behind non-obvious decisions (races, ordering, failure modes); match that
  density rather than narrating syntax.
- `§`/`FR-` markers in comments are traceability labels pointing into the
  project's internal specification, which is not part of this repository. Keep
  existing ones intact when you move code; you are not expected to invent new
  ones.

## Pull requests

- One logical change per pull request, with a description of the behaviour
  before and after.
- Include the tests that prove it. A bug fix without a regression test will be
  asked for one.
- Note explicitly if a change touches an invariant listed above.

## Security

Do not open a public issue for a vulnerability — see
[SECURITY.md](SECURITY.md).
