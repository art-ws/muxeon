// Stages the built panel next to the server bundle for packaging.
//
// In the workspace the server finds the SPA by resolving @teamai/webchat-ui. An
// npm tarball has no workspace to resolve, so the panel has to ship INSIDE the
// package — resolveUiDist() (server/src/wire-channels.ts) looks for `ui/` beside
// the running bundle first, which is exactly what this produces:
//
//   dist/index.js   the server bundle
//   dist/ui/        packages/webchat-ui/dist, verbatim
//
// Run via `bun run build:dist`, which builds both halves first.
import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "packages", "webchat-ui", "dist");
const target = join(root, "dist", "ui");

if (!existsSync(join(source, "index.html"))) {
  console.error(
    `stage-ui: the panel is not built (${join(source, "index.html")} missing).
Run \`bun run build:ui\` first, or use \`bun run build:dist\` which does both.`,
  );
  process.exit(1);
}

// Replace rather than merge: a stale asset left behind from an older build would
// still be served, since the panel is served from disk per request.
rmSync(target, { recursive: true, force: true });
cpSync(source, target, { recursive: true });

console.log(`stage-ui: ${source} → ${target}`);
