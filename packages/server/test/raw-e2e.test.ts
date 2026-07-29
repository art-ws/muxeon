// Raw-mode e2e (FR-88, §14): a raw turn injects the operator's text into the
// terminal VERBATIM (no attribution, no exchange instruction, no inbox dir) and
// routes the captured console back as the reply. Here `writer` sends a raw
// message to `researcher`; the researcher's dispatcher injects the text as-is,
// captures the pane by the default rule, and the captured console is delivered
// back into the writer session.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Session } from "@teamai/core";
import type { SessionDriver } from "@teamai/orchestrator";
import { type TeamaiServer, bootstrap } from "../src/bootstrap";

let dir: string;
let server: TeamaiServer;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "teamai-raw-e2e-"));
});

afterEach(async () => {
  await server.stop();
  rmSync(dir, { recursive: true, force: true });
});

async function waitFor(cond: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > ms) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const CONSOLE = "total 24\ndrwxr-xr-x  .git\n❯ ";

test("raw turn: verbatim inject, NO inbox dir, captured console routed back (FR-88)", async () => {
  const configFile = join(dir, "teamai.config.json");
  writeFileSync(
    configFile,
    JSON.stringify({
      server: { port: 0, mcp: false, queueDir: "./queue", cadence: { outputPollMs: 5 } },
      agents: [
        { name: "researcher", type: "claude", tmux: "researcher-s" },
        { name: "writer", type: "claude", tmux: "writer-s" },
      ],
      topology: { researcher: ["writer"], writer: ["researcher"] },
    }),
  );
  const root = join(dir, "queue");
  await mkdir(root, { recursive: true });

  // Both drivers complete the turn immediately (output detection fires); raw has
  // no file-detect, so awaitTurn MUST resolve for the captured reply to be sent.
  const researcherInjected: string[] = [];
  const writerInjected: string[] = [];
  const makeDriver = (session: Session): SessionDriver => ({
    inject: async (text) => {
      (session.name === "writer-s" ? writerInjected : researcherInjected).push(text);
    },
    awaitTurn: async () => undefined,
  });

  server = await bootstrap({
    configFile,
    probe: async () => true,
    makeDriver: (session) => makeDriver(session),
    sessionControl: {
      hasSession: async () => true,
      newSession: async () => undefined,
      killSession: async () => undefined,
      sendLiteral: async () => undefined,
      sendKeys: async () => undefined,
      capturePane: async () => CONSOLE, // the console the raw rule snapshots
    },
    startRoutines: false,
    // a fast stabilize keeps the capture loop quick (the default rule polls)
    retentionSweepMs: 60_000,
  });

  // writer → researcher in RAW mode.
  const result = await server.router.route({
    id: "r1",
    from: "writer",
    to: "researcher",
    kind: "message",
    ts: 0,
    payload: "ls -la",
    raw: true,
  });
  expect(result.ok).toBe(true);

  // the researcher saw the text VERBATIM — no [teamai] preamble, no exchange hint
  await waitFor(() => researcherInjected.length > 0);
  expect(researcherInjected).toEqual(["ls -la"]);

  // NO inbox projection was materialized for a raw turn (§14.1)
  expect(existsSync(join(root, "researcher-s", "exchange", "inbox", "r1"))).toBe(false);

  // the captured console came back as the reply, delivered into the writer session
  await waitFor(() => writerInjected.some((text) => text.includes("drwxr-xr-x")));
  const reply = writerInjected.find((text) => text.includes("drwxr-xr-x"));
  expect(reply).toContain("from=researcher"); // a normal (non-raw) reply envelope
  expect(reply).toContain("❯"); // the console as-is
}, 15000);
