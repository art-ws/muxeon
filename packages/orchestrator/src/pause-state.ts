// Crash-safe pause persistence (§16.4, FR-116). ONE file for the whole set —
// <stateDir>/paused.json — unlike the per-sender rendezvous files (§8.2, FR-105):
// the paused set is small, read once at boot and written only when an operator
// flips a flag. Writes are ATOMIC (tmp + rename, §5.3). A missing / mid-write /
// corrupt file reads as null and the registry starts empty (§16.4): nothing paused
// is the safe direction — messages flow and the panel shows it.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PauseFile } from "./pause";

export interface PauseStateStore {
  read(): Promise<PauseFile | null>;
  write(file: PauseFile): Promise<void>;
}

export function createFsPauseStore(stateDir: string): PauseStateStore {
  const path = join(stateDir, "paused.json");
  return {
    async read() {
      try {
        return JSON.parse(await readFile(path, "utf8")) as PauseFile;
      } catch {
        return null; // missing or mid-write/corrupt → treat as nothing paused
      }
    },
    async write(file) {
      await mkdir(dirname(path), { recursive: true });
      const tmp = `${path}.tmp`;
      await writeFile(tmp, JSON.stringify(file));
      await rename(tmp, path); // atomic commit
    },
  };
}
