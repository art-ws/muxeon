// THROWAWAY — T13 de-risk spike (§5.2). NOT part of the baseline (excluded from
// tsconfig, biome, and bun test). A stand-in CLI agent that exercises BOTH busy→idle
// detection paths so the spike can confirm them before the dispatcher (T16) is built:
//
//   output : the ready prompt VANISHES while busy and REAPPEARS when idle (front edge);
//   native : it writes { status, turn } to $MUXEON_STATUS_FILE, advancing the turn
//            token each turn so idle is edge-triggered, not level.

import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const READY = "DUMMY_READY>";
const statusFile = process.env.MUXEON_STATUS_FILE;

function writeStatus(status: "idle" | "busy", turn: string): void {
  if (statusFile !== undefined) {
    writeFileSync(statusFile, JSON.stringify({ status, turn }));
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

let turn = 0;
writeStatus("idle", "init"); // a STALE idle level from before this turn
process.stdout.write(`${READY} `);

const rl = createInterface({ input: process.stdin });
for await (const line of rl) {
  turn += 1;
  const token = `turn-${turn}`;
  // busy: do not reprint the prompt (front idle→busy)
  writeStatus("busy", token);
  process.stdout.write(`\n[busy] processing: ${line}\n`);
  await sleep(400); // simulate a turn longer than the spike's poll interval
  // idle: reprint the prompt (front busy→idle) + native edge at the new turn token
  writeStatus("idle", token);
  process.stdout.write(`[done turn ${turn}]\n${READY} `);
}
