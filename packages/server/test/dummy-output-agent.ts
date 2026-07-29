// Output-mode dummy agent for the Checkpoint 4 skeleton smoke (§5.2). NOT a test —
// run inside tmux by skeleton.test.ts. Prints a ready prompt; on each input line the
// prompt vanishes (busy) and then reappears (idle), exercising output-front detection.

import { createInterface } from "node:readline";

const READY = "SKELETON_READY>";
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

process.stdout.write(`${READY} `);

const rl = createInterface({ input: process.stdin });
for await (const line of rl) {
  process.stdout.write(`\n[working: ${line}]\n`);
  await sleep(300);
  process.stdout.write(`[done]\n${READY} `);
}
