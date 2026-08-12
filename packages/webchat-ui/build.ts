// SPA build (§12.7, R1): bundle with bun itself — no extra toolchain. Output is
// plain statics in dist/ (relative paths only, §12.6 — proxyable under any
// prefix); @muxeon/webchat serves them.

import { cp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

const root = import.meta.dir;
const dist = join(root, "dist");

await rm(dist, { recursive: true, force: true });
await mkdir(join(dist, "assets"), { recursive: true });

const result = await Bun.build({
  entrypoints: [join(root, "src", "main.tsx")],
  outdir: join(dist, "assets"),
  target: "browser",
  minify: true,
  // splitting: mermaid (FR-100) is imported lazily, so it lands in its own chunk
  // loaded on demand rather than bloating the entry bundle. The entry keeps a
  // stable name; chunks get hashed names (all under assets/, served as statics).
  splitting: true,
  naming: { entry: "[name].[ext]", chunk: "[name]-[hash].[ext]", asset: "[name]-[hash].[ext]" },
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

await cp(join(root, "index.html"), join(dist, "index.html"));
await cp(join(root, "src", "styles.css"), join(dist, "assets", "styles.css"));
// KaTeX stylesheet + fonts (FR-99): katex.min.css references ./fonts/* relatively,
// so the fonts sit next to it under assets/. Resolved from the installed package.
const katexDist = join(root, "..", "..", "node_modules", "katex", "dist");
await cp(join(katexDist, "katex.min.css"), join(dist, "assets", "katex.min.css"));
await cp(join(katexDist, "fonts"), join(dist, "assets", "fonts"), { recursive: true });
// branding (T88): the designer's logo as-is + the favicon derived from its mark
await cp(join(root, "assets", "logo.png"), join(dist, "assets", "logo.png"));
await cp(join(root, "assets", "favicon.png"), join(dist, "assets", "favicon.png"));
// translations (T114, FR-78) — OPTIONAL: no dir, no files, English-only UI
try {
  await cp(join(root, "assets", "i18n"), join(dist, "assets", "i18n"), { recursive: true });
} catch {
  // no translations shipped — the UI stays English
}
console.log("webchat-ui built → dist/");
