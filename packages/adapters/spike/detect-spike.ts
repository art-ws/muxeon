// THROWAWAY — T13 de-risk spike (§5.2). NOT baseline. Run:
//   bun packages/adapters/spike/detect-spike.ts
//
// Drives the dummy agent through a real tmux session and confirms BOTH detection
// paths the dispatcher (T16) will rely on:
//   - output: ready prompt disappears (busy) then reappears (idle) — front edge;
//   - native: status reaches idle ONLY at the new turn token — edge, not level.

import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capturePane, killSession, newSession, sendKeys, sendLiteral } from "@muxeon/tmux";

const READY = /DUMMY_READY>\s*$/;
const session = `muxeon-spike-${randomUUID()}`;
const workDir = mkdtempSync(join(tmpdir(), "muxeon-spike-"));
const statusFile = join(workDir, "status.json");
const dummy = join(import.meta.dir, "dummy-agent.ts");

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const log = (message: string): void => process.stdout.write(`${message}\n`);

interface Status {
  status: "idle" | "busy";
  turn: string;
}

function readStatus(): Status | null {
  try {
    return JSON.parse(readFileSync(statusFile, "utf8")) as Status;
  } catch {
    return null;
  }
}

async function waitUntil(label: string, predicate: () => Promise<boolean> | boolean, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`timeout waiting for: ${label}`);
    await sleep(40);
  }
}

try {
  log(`spike: starting dummy agent in tmux session ${session}`);
  await newSession(session, {
    command: ["bun", dummy],
    cwd: workDir,
    env: { MUXEON_STATUS_FILE: statusFile },
  });

  await waitUntil("initial output prompt", async () => READY.test(await capturePane(session)));
  await waitUntil("initial native idle", () => readStatus()?.status === "idle");
  log(`✔ initial: output prompt present; native ${JSON.stringify(readStatus())}`);

  log("\nspike: injecting message #1");
  await sendLiteral(session, "first message");
  await sendKeys(session, "Enter");

  // OUTPUT — front edge: must see busy (prompt gone) BEFORE idle (prompt back).
  await waitUntil("output busy (prompt gone)", async () => !READY.test(await capturePane(session)));
  log("✔ output: prompt disappeared → busy (front idle→busy)");
  await waitUntil("output idle (prompt back)", async () => READY.test(await capturePane(session)));
  log("✔ output: prompt reappeared → idle (front busy→idle)");

  // NATIVE — edge: idle accepted only at the NEW turn token, not the stale init.
  await waitUntil("native idle@turn-1", () => {
    const s = readStatus();
    return s?.status === "idle" && s.turn === "turn-1";
  });
  log(`✔ native: idle at new turn token ${JSON.stringify(readStatus())} (edge, not stale init)`);

  log("\nspike: injecting message #2 (proves the token advances → edge, not level)");
  await sendLiteral(session, "second message");
  await sendKeys(session, "Enter");
  await waitUntil("native idle@turn-2", () => {
    const s = readStatus();
    return s?.status === "idle" && s.turn === "turn-2";
  });
  log(`✔ native: turn token advanced to ${JSON.stringify(readStatus())} — edge-triggered`);

  log("\nSPIKE PASSED — both §5.2 detect paths confirmed against real tmux.");
} finally {
  await killSession(session).catch(() => undefined);
  rmSync(workDir, { recursive: true, force: true });
}
