// Where a chain lives between the moment it is planned and the hour it fires
// (§21.5): <config_dir>/state/schedules/<agent>/<chainId>.json, one file per
// chain, written ATOMICALLY (tmp + rename) — the same discipline routine state
// keeps (§6), for the same reason: the coordinator may die between two items of
// a chain and must wake up knowing exactly which ones already happened.
//
// The agent component is percent-encoded (as in routines) so a name can never
// introduce a path separator; the chain id is validated instead of encoded
// (chain.ts), because the agent has to be able to name it back when cancelling.

import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Chain } from "./chain";

export interface ScheduleStore {
  /** Every chain of one agent, newest last. Unreadable files are skipped. */
  list(agent: string): Promise<Chain[]>;
  /** Every chain of every agent — the tick and the operator view read this. */
  listAll(): Promise<Chain[]>;
  read(agent: string, id: string): Promise<Chain | null>;
  write(chain: Chain): Promise<void>;
  remove(agent: string, id: string): Promise<void>;
}

const enc = encodeURIComponent;
const dec = decodeURIComponent;

export function createFsScheduleStore(stateDir: string): ScheduleStore {
  const base = join(stateDir, "schedules");
  const dirFor = (agent: string): string => join(base, enc(agent));
  const fileFor = (agent: string, id: string): string => join(dirFor(agent), `${id}.json`);

  const readChain = async (agent: string, file: string): Promise<Chain | null> => {
    try {
      const parsed = JSON.parse(await readFile(file, "utf8")) as Chain;
      // A half-written or hand-edited file must not become a chain that fires
      // something unrecognizable into a terminal — it is skipped, with the same
      // "keep going" posture §6.2 takes towards a broken routine file.
      if (typeof parsed?.id !== "string" || !Array.isArray(parsed.items)) return null;
      return { ...parsed, agent };
    } catch {
      return null;
    }
  };

  const listIn = async (agent: string): Promise<Chain[]> => {
    let files: string[];
    try {
      files = await readdir(dirFor(agent));
    } catch {
      return [];
    }
    const chains: Chain[] = [];
    for (const file of files.sort()) {
      if (!file.endsWith(".json")) continue;
      const chain = await readChain(agent, join(dirFor(agent), file));
      if (chain !== null) chains.push(chain);
    }
    return chains.sort((a, b) => a.created - b.created);
  };

  return {
    list: listIn,

    async listAll() {
      let agents: string[];
      try {
        agents = await readdir(base);
      } catch {
        return [];
      }
      const chains: Chain[] = [];
      for (const agentEnc of agents) {
        chains.push(...(await listIn(dec(agentEnc))));
      }
      return chains;
    },

    async read(agent, id) {
      return readChain(agent, fileFor(agent, id));
    },

    async write(chain) {
      const path = fileFor(chain.agent, chain.id);
      await mkdir(dirname(path), { recursive: true });
      const tmp = `${path}.tmp`;
      await writeFile(tmp, JSON.stringify(chain, null, 2));
      await rename(tmp, path); // atomic commit
    },

    async remove(agent, id) {
      try {
        await unlink(fileFor(agent, id));
      } catch {
        // already gone — removal is idempotent
      }
    },
  };
}
