#!/usr/bin/env node
// npx / `npm i -g` entry point.
//
// Muxeon is a Bun application, not a Node one: the four HTTP surfaces are
// Bun.serve (with its WebSocket upgrade), process control is Bun.spawn, and the
// panel statics are Bun.file. None of that has a Node equivalent here, so this
// shim does exactly one thing — locate a bun runtime and hand over to it.
//
// `bunx muxeon` skips this file entirely and runs dist/index.js directly.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, "..", "dist", "index.js");

if (!existsSync(entry)) {
  process.stderr.write(
    `muxeon: the bundle is missing (${entry}).
This package ships it prebuilt — a broken install is the likely cause; reinstall it.
`,
  );
  process.exit(1);
}

// MUXEON_BUN lets an operator pin a specific runtime (a pinned version, a
// non-PATH install); otherwise the one on PATH.
const bun = process.env.MUXEON_BUN ?? "bun";

const child = spawn(bun, [entry, ...process.argv.slice(2)], {
  stdio: "inherit",
  // The server reads .env from the current directory, so keep the caller's cwd.
  cwd: process.cwd(),
});

child.on("error", (error) => {
  if (error.code === "ENOENT") {
    process.stderr.write(
      `muxeon: bun not found (tried "${bun}").

Muxeon runs on Bun. Install it, then re-run:
  curl -fsSL https://bun.sh/install | bash

Already installed elsewhere? Point MUXEON_BUN at it:
  MUXEON_BUN=/path/to/bun npx muxeon

It also needs tmux — that is where the agents live.
`,
    );
    process.exit(127);
  }
  process.stderr.write(`muxeon: failed to start bun: ${error.message}\n`);
  process.exit(1);
});

// Forward the signals an operator actually sends, so Ctrl-C reaches the server's
// own graceful shutdown instead of orphaning it.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    if (child.exitCode === null) child.kill(signal);
  });
}

child.on("exit", (code, signal) => {
  // Re-raise the child's signal so the caller sees the real cause of death.
  if (signal !== null) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
