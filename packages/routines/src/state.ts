// Crash-safe routine execution state (§6). One file per routine,
// <config_dir>/state/routines/<owner>/<id>.json: `lastRun` for cron, `done`/`doneAt`
// for once. Writes are ATOMIC (tmp + rename) and the scheduler advances the mark only
// AFTER a successful enqueue (§6) — so a crash in between replays the tick (a repeat,
// quenched by dedup on the deterministic id, §5.3/§10.9) rather than losing it.
//
// Filename components are percent-encoded (reversible, no path separators), keeping
// each file a single component under its owner dir.

import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface RoutineState {
  /** cron: the last fired scheduled time, unix ms. */
  readonly lastRun?: number;
  /** once: whether it has fired. */
  readonly done?: boolean;
  readonly doneAt?: number;
}

export interface RoutineRef {
  readonly owner: string;
  readonly id: string;
}

export interface StateStore {
  read(owner: string, id: string): Promise<RoutineState | null>;
  write(owner: string, id: string, state: RoutineState): Promise<void>;
  /** Every (owner,id) that currently has a state file — for orphan pruning (§6.3, T27). */
  list(): Promise<RoutineRef[]>;
  /** Remove a routine's state file (orphan pruning, §6.3, T27). */
  remove(owner: string, id: string): Promise<void>;
}

const enc = encodeURIComponent;
const dec = decodeURIComponent;

export function createFsStateStore(stateDir: string): StateStore {
  const base = join(stateDir, "routines");
  const fileFor = (owner: string, id: string): string => join(base, enc(owner), `${enc(id)}.json`);

  return {
    async read(owner, id) {
      try {
        return JSON.parse(await readFile(fileFor(owner, id), "utf8")) as RoutineState;
      } catch {
        return null; // missing or mid-write/corrupt → treat as no state
      }
    },

    async write(owner, id, state) {
      const path = fileFor(owner, id);
      await mkdir(dirname(path), { recursive: true });
      const tmp = `${path}.tmp`;
      await writeFile(tmp, JSON.stringify(state));
      await rename(tmp, path); // atomic commit
    },

    async list() {
      const refs: RoutineRef[] = [];
      let owners: string[];
      try {
        owners = await readdir(base);
      } catch {
        return refs; // no state dir yet
      }
      for (const ownerEnc of owners) {
        let files: string[];
        try {
          files = await readdir(join(base, ownerEnc));
        } catch {
          continue;
        }
        for (const file of files) {
          if (file.endsWith(".json"))
            refs.push({ owner: dec(ownerEnc), id: dec(file.slice(0, -5)) });
        }
      }
      return refs;
    },

    async remove(owner, id) {
      await unlink(fileFor(owner, id)).catch(() => undefined);
    },
  };
}
