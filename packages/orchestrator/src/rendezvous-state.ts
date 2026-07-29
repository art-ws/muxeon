// Crash-safe rendezvous persistence (§8.2, FR-105). One file per sender,
// <stateDir>/rendezvous/<sender>.json, mirroring the sender's intent queue so the
// FR-105 guarantee ("a WIP-blocked A→B is eventually reconnected") survives a server
// restart (§5.3/§10.9). Writes are ATOMIC (tmp + rename). The sender name is
// percent-encoded into a single path component. Missing / mid-write / corrupt reads
// as null — the coordinator then starts that sender empty (an unrecoverable loss of a
// notice is a repeat at worst, quenched by the deterministic notice id, §10.9).

import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { RendezvousFile } from "./rendezvous";

const enc = encodeURIComponent;
const dec = decodeURIComponent;

export interface RendezvousStateStore {
  read(sender: string): Promise<RendezvousFile | null>;
  write(sender: string, file: RendezvousFile): Promise<void>;
  /** Remove a sender's file (queue drained empty). */
  remove(sender: string): Promise<void>;
  /** Every sender that currently has a state file — for startup rehydrate. */
  list(): Promise<readonly string[]>;
}

export function createFsRendezvousStore(stateDir: string): RendezvousStateStore {
  const base = join(stateDir, "rendezvous");
  const fileFor = (sender: string): string => join(base, `${enc(sender)}.json`);

  return {
    async read(sender) {
      try {
        return JSON.parse(await readFile(fileFor(sender), "utf8")) as RendezvousFile;
      } catch {
        return null; // missing or mid-write/corrupt → treat as no state
      }
    },

    async write(sender, file) {
      const path = fileFor(sender);
      await mkdir(dirname(path), { recursive: true });
      const tmp = `${path}.tmp`;
      await writeFile(tmp, JSON.stringify(file));
      await rename(tmp, path); // atomic commit
    },

    async remove(sender) {
      await unlink(fileFor(sender)).catch(() => undefined);
    },

    async list() {
      try {
        return (await readdir(base))
          .filter((f) => f.endsWith(".json"))
          .map((f) => dec(f.slice(0, -5)));
      } catch {
        return []; // no state dir yet
      }
    },
  };
}
