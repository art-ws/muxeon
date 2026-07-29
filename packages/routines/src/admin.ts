// Routine file administration (§8.5 CRUD, FR-20/FR-23): atomic writes (tmp+rename,
// §6.2 — discovery never sees a half-written file; the .tmp name is not *.md so a
// concurrent scan skips it), deletion, and the enable/disable kill-switch rewrite.
// The OPERATIONS live here because this package owns the MD+frontmatter format; the
// operator-plane (server) only composes them with discovery.

import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseFrontmatter } from "./frontmatter";

/** Atomically write a routine file (CRUD put, §6.2/§8.5), creating the owner dir. */
export async function writeRoutineFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, content, { encoding: "utf8" });
  await rename(tmp, path); // atomic commit; a torn write is never discoverable
}

/** Delete a routine file (CRUD delete, §8.5). Missing file → error to the caller. */
export async function deleteRoutineFile(path: string): Promise<void> {
  await unlink(path);
}

const FRONTMATTER_BLOCK = /^(﻿?---\r?\n)([\s\S]*?)(\r?\n---)/;

/**
 * Rewrite `enabled:` inside the frontmatter block (kill-switch, FR-23), preserving
 * the rest of the source verbatim (comments, field order, the body). The result is
 * re-validated by parseFrontmatter before it is returned.
 */
export function setEnabledInContent(content: string, enabled: boolean): string {
  const match = FRONTMATTER_BLOCK.exec(content);
  if (match === null) throw new Error("missing YAML frontmatter (--- … ---)");
  const [, open = "", yaml = "", close = ""] = match;
  const line = `enabled: ${enabled}`;
  const next = /^enabled:.*$/m.test(yaml)
    ? yaml.replace(/^enabled:.*$/m, line)
    : `${yaml}\n${line}`;
  // Replacer FUNCTION so "$" sequences in the yaml are inserted literally.
  const updated = content.replace(FRONTMATTER_BLOCK, () => `${open}${next}${close}`);
  const spec = parseFrontmatter(updated); // must still parse (§6.2)
  if (spec.enabled !== enabled) throw new Error("enabled rewrite did not take effect");
  return updated;
}
