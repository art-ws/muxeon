import { describe, expect, test } from "bun:test";
import type { Adapter, NativeStatus } from "@muxeon/adapters";
import type { Session } from "@muxeon/core";
import { SUBMIT_RETRIES, TmuxSessionDriver } from "../src/driver";

const session: Session = { name: "s" };
const noSleep = async (): Promise<void> => undefined;

/** Output-only adapter — the FR-11 baseline: no agent cooperation at all. */
function outputAdapter(): Adapter {
  return {
    type: "fake-output",
    render: (message) => String(message.payload),
    detect: { readyPrompt: /READY>\s*$/ },
    slashCommand: (name) => `/${name}`,
  };
}

/** Adapter with the opportunistic native accelerator on top (§5.2). */
function nativeAdapter(): Adapter {
  return {
    type: "fake-native",
    render: (message) => String(message.payload),
    detect: { readyPrompt: /READY>\s*$/, statusFile: () => "/status.json" },
    slashCommand: (name) => `/${name}`,
  };
}

/** A pane that never shows the ready prompt — keeps the output path silent. */
const foreverBusyPane = async (): Promise<string> => "working...";

describe("TmuxSessionDriver detection (§5.2, FR-11/FR-11b)", () => {
  test("native: idle accepted only at the current turn token (edge, not level)", async () => {
    const responses: (NativeStatus | null)[] = [
      { status: "busy", turn: "t1" },
      { status: "idle", turn: "stale" }, // a stale idle — must be ignored
      { status: "idle", turn: "t1" }, // the real edge
    ];
    let i = 0;
    const driver = new TmuxSessionDriver({
      session,
      adapter: nativeAdapter(),
      sleep: noSleep,
      capture: foreverBusyPane, // output path must not decide this test
      readStatus: async () => responses[Math.min(i++, responses.length - 1)] ?? null,
    });
    await driver.awaitTurn("t1");
    expect(i).toBe(3); // polled past the stale idle to the matching token
  });

  test("output: waits for the prompt to vanish (busy) before its return counts as idle", async () => {
    const panes = ["READY> ", "working...", "done\nREADY> "];
    let i = 0;
    const driver = new TmuxSessionDriver({
      session,
      adapter: outputAdapter(),
      sleep: noSleep,
      capture: async () => panes[Math.min(i++, panes.length - 1)] ?? "",
    });
    await driver.awaitTurn("ignored");
    expect(i).toBe(3); // did not falsely resolve on the initial ready prompt
  });

  // The live T53 regression: an attach-only agent whose owner never installed a
  // native mechanism. The status file stays absent — the output front MUST still
  // complete the turn (the old native-only wait hung in busy forever).
  test("native declared but status file never written → output front completes the turn", async () => {
    const panes = ["READY> ", "working...", "working...", "done\nREADY> "];
    let i = 0;
    const driver = new TmuxSessionDriver({
      session,
      adapter: nativeAdapter(),
      sleep: noSleep,
      capture: async () => panes[Math.min(i++, panes.length - 1)] ?? "",
      readStatus: async () => null, // file missing — forever
    });
    await driver.awaitTurn("t1");
    expect(i).toBeGreaterThanOrEqual(3); // resolved via the output front
  });

  // A stale idle level from a PREVIOUS turn must not let the native path win —
  // the output front decides (§5.2: edge, not level; both paths in parallel).
  test("native stale + output front → output decides, stale native never accepted", async () => {
    const panes = ["READY> ", "working...", "done\nREADY> "];
    let i = 0;
    const driver = new TmuxSessionDriver({
      session,
      adapter: nativeAdapter(),
      sleep: noSleep,
      capture: async () => panes[Math.min(i++, panes.length - 1)] ?? "",
      readStatus: async () => ({ status: "idle", turn: "previous-turn" }),
    });
    await driver.awaitTurn("t1");
    expect(i).toBe(3); // the output front resolved it, exactly as without native
  });

  test("native edge wins while the pane still looks busy; the loser stops polling", async () => {
    let polls = 0;
    const driver = new TmuxSessionDriver({
      session,
      adapter: nativeAdapter(),
      sleep: noSleep,
      capture: async () => {
        polls += 1;
        return "working..."; // output path never fires
      },
      readStatus: async () => ({ status: "idle", turn: "t1" }),
    });
    await driver.awaitTurn("t1"); // resolves via the native edge, not output
    const settled = polls;
    for (let k = 0; k < 5; k += 1) await Promise.resolve(); // drain microtasks
    expect(polls).toBe(settled); // the output loop was aborted, not left polling
  });

  test("inject types the text literally and submits with Enter", async () => {
    const sent: string[] = [];
    const driver = new TmuxSessionDriver({
      session,
      adapter: nativeAdapter(),
      sleep: noSleep,
      capture: foreverBusyPane, // busy right away — a clean submit
      sendLiteral: async (_session, text) => {
        sent.push(`literal:${text}`);
      },
      sendKeys: async (_session, ...keys) => {
        sent.push(`keys:${keys.join(",")}`);
      },
    });
    await driver.inject("hello");
    expect(sent).toEqual(["literal:hello", "keys:Enter"]);
  });
});

// The live stand hang (T78, FR-58): a paste-detected Enter lands INSIDE the input
// box instead of submitting — the pane stays "ready", no detector ever fires, and
// the turn waits for a human. inject must confirm the busy front and re-press.
describe("TmuxSessionDriver submit confirmation (T78, FR-58)", () => {
  function injectDriver(panes: string[], sent: string[]): TmuxSessionDriver {
    let i = 0;
    return new TmuxSessionDriver({
      session,
      adapter: outputAdapter(),
      sleep: noSleep,
      capture: async () => panes[Math.min(i++, panes.length - 1)] ?? "",
      sendLiteral: async (_session, text) => {
        sent.push(`literal:${text}`);
      },
      sendKeys: async (_session, ...keys) => {
        sent.push(`keys:${keys.join(",")}`);
      },
    });
  }

  test("a swallowed Enter is re-pressed until the busy front appears", async () => {
    const sent: string[] = [];
    // capture 1 is the pre-Enter baseline; two more still show the SAME ready pane
    // (the text sits unsubmitted — nothing moved), the fourth is busy.
    const driver = injectDriver(["READY> ", "READY> ", "READY> ", "working..."], sent);
    await driver.inject("hello");
    expect(sent).toEqual(["literal:hello", "keys:Enter", "keys:Enter", "keys:Enter"]);
  });

  // The counterpart trap: an agent whose turn is shorter than the confirm delay is
  // already back at its prompt when we look. Reading that as "not submitted" and
  // re-pressing injects an empty turn AND strands the real message in cur/ — the
  // pane MOVED, so submission is proven even though the prompt is back.
  test("a turn shorter than the confirm delay is not mistaken for a swallowed Enter", async () => {
    const sent: string[] = [];
    const driver = injectDriver(
      ["READY> hello", "[working: hello]\n[done]\nREADY> "], // baseline, then answered
      sent,
    );
    await driver.inject("hello");
    expect(sent).toEqual(["literal:hello", "keys:Enter"]); // exactly one Enter, no empty turn
  });

  test("retries are bounded — a never-busy pane does not loop forever", async () => {
    const sent: string[] = [];
    const driver = injectDriver(["READY> "], sent); // ready forever
    await driver.inject("hello");
    // initial Enter + SUBMIT_RETRIES re-presses, then give up (detection owns the turn)
    expect(sent[0]).toBe("literal:hello");
    expect(sent.filter((s) => s === "keys:Enter").length).toBe(1 + SUBMIT_RETRIES);
  });

  test("a capture failure does not fail an already-typed injection", async () => {
    const sent: string[] = [];
    const driver = new TmuxSessionDriver({
      session,
      adapter: outputAdapter(),
      sleep: noSleep,
      capture: async () => {
        throw new Error("tmux capture-pane failed");
      },
      sendLiteral: async (_session, text) => {
        sent.push(`literal:${text}`);
      },
      sendKeys: async (_session, ...keys) => {
        sent.push(`keys:${keys.join(",")}`);
      },
    });
    await driver.inject("hello"); // resolves — the §5.2 detectors decide the turn
    expect(sent).toEqual(["literal:hello", "keys:Enter"]);
  });

  test("the paste settles before the first Enter (separate input bursts)", async () => {
    const events: string[] = [];
    const driver = new TmuxSessionDriver({
      session,
      adapter: outputAdapter(),
      sleep: async (ms) => {
        events.push(`sleep:${ms}`);
      },
      capture: async () => {
        events.push("capture");
        return "working...";
      },
      sendLiteral: async () => {
        events.push("literal");
      },
      sendKeys: async () => {
        events.push("enter");
      },
    });
    await driver.inject("hello");
    // literal → settle pause → baseline capture → Enter → confirm pause → capture (busy ⇒ done)
    expect(events).toEqual(["literal", "sleep:1000", "capture", "enter", "sleep:350", "capture"]);
  });
});

// T145: killing/losing a session mid-turn makes `tmux capture-pane` throw. The output
// detector must NOT propagate that reject — it is the down-probe's business (§5.1). A
// propagated reject wins/loses the processOne race and escapes the dispatcher's
// fire-and-forget loop as an unhandled rejection, which Bun turns into a full-server
// crash (live finding: a busy agent's kill took down the whole stand).
describe("TmuxSessionDriver crash-safety (T145 — vanished session mid-turn)", () => {
  test("awaitTurn does not reject when capture throws — it yields to the down-probe on abort", async () => {
    const ac = new AbortController();
    let polls = 0;
    const driver = new TmuxSessionDriver({
      session,
      adapter: outputAdapter(), // the output-only path `auto`/codex/claude all use
      // the down-probe would win the race and abort this detector ~here
      sleep: async () => {
        polls += 1;
        if (polls >= 3) ac.abort();
      },
      capture: async () => {
        throw new Error("tmux capture-pane -t =s: -p failed (exit 1): can't find session: s");
      },
    });
    // Must RESOLVE via the abort — never reject with the capture error.
    await expect(driver.awaitTurn("ignored", ac.signal)).resolves.toBeUndefined();
    expect(polls).toBeGreaterThanOrEqual(3);
  });
});

// Composer ownership (T359, FR-58 — live finding 2026-10-08). Codex IGNORES
// Enter while its own turn runs: a message injected into a busy agent parks in
// the composer while its pane still reads READY (the composer stays visible in
// both states, like claude's ❯). The old confirmation read that busy/ready as
// proof of submission — on the live stand it marked messages done while their
// text sat unsent for an hour, and a human had to press Enter by hand
// (operator report through the panel). The driver now holds the turn open while
// the adapter's composer visibly still shows our paste, and re-presses Enter on
// the ready pane itself — the exact manual action, automated.
describe("TmuxSessionDriver composer ownership (T359, FR-58)", () => {
  const EMPTY = "› Ask Codex to do anything";
  const PARKED = "› [Pasted Content 1328 chars]";
  const ready = (composer: string): string =>
    `• Ran bin/dsh -s dev1-inspect 'cd …'\n  └ 4 files changed\n\n${composer}\n  GPT-6-Sol high · /srv/agents/dev1 · 831K used\n  ? for shortcuts`;
  const busy = (composer: string): string =>
    `• Working (58m 29s • esc to interrupt) · 2 background terminals running\n\n${composer}\n  GPT-6-Sol high · /srv/agents/dev1 · 831K used\n  ? for shortcuts`;

  /** The pane a live codex pane in a repaint window can look like: ready, composer not drawn. */
  const TORN = "• Ran bin/dsh …\n  └ output…\n\n  ? for shortcuts";

  function codexLikeAdapter(): Adapter {
    return {
      type: "fake-codex",
      render: (message) => String(message.payload),
      detect: {
        readyPrompt: /^(?![\s\S]*esc to interrupt)/,
        composer: {
          pending: /\[Pasted Content \d+ chars?\]/,
          empty: /^\s*›\s*(?:Ask Codex to do anything)?\s*$/m,
        },
      },
      slashCommand: (name) => `/${name}`,
    };
  }

  function driver(panes: string[]): {
    driver: TmuxSessionDriver;
    sent: string[];
    polls: () => number;
  } {
    const sent: string[] = [];
    let i = 0;
    let clock = 0;
    const instance = new TmuxSessionDriver({
      session,
      adapter: codexLikeAdapter(),
      sleep: async (ms) => {
        clock += ms; // virtual time: the re-press cadence works as in production
      },
      now: () => clock,
      capture: async () => panes[Math.min(i++, panes.length - 1)] ?? "",
      sendLiteral: async (_session, text) => {
        sent.push(`literal:${text}`);
      },
      sendKeys: async (_session, ...keys) => {
        sent.push(keys.join(","));
      },
    });
    return { driver: instance, sent, polls: () => i };
  }

  test("a parked message is re-submitted on the ready pane, not completed (T359)", async () => {
    const {
      driver: d,
      sent,
      polls,
    } = driver([
      busy(PARKED), // the agent's OWN long turn — our paste waits in the composer
      busy(PARKED),
      ready(PARKED), // its turn ended: the exact pane of the operator's screenshot
      busy(PARKED), // our automatic re-press landed — the CLI took the message
      ready(EMPTY), // our turn ran and ended
      ready(EMPTY),
    ]);
    await d.awaitTurn("id1");
    expect(sent).toEqual(["Enter"]); // one press, on the READY+PARKED poll — never into busy
    expect(polls()).toBe(6); // completed only once the composer was visibly empty
  });

  test("a torn repaint frame (composer not drawn) does not complete the turn (T359)", async () => {
    const {
      driver: d,
      sent,
      polls,
    } = driver([
      busy(PARKED),
      TORN, // the false-ready window that used to complete the message
      ready(PARKED),
      busy(PARKED),
      ready(EMPTY),
      ready(EMPTY),
    ]);
    await d.awaitTurn("id1");
    expect(sent).toEqual(["Enter"]); // no press on a pane whose composer is not visible
    expect(polls()).toBe(6);
  });

  test("inject keeps pressing while the paste is parked instead of declaring a fast turn (T359)", async () => {
    const { driver: d, sent } = driver([ready(PARKED)]); // ready forever, paste never taken
    await d.inject("hello");
    expect(sent[0]).toBe("literal:hello");
    // initial Enter + the whole confirm window of re-presses — the T78 fallback
    // is unchanged, it just no longer counts a parked paste as a completed turn.
    expect(sent.filter((s) => s === "Enter").length).toBe(1 + SUBMIT_RETRIES);
  });

  test("a cleared composer on a changed pane still proves the fast turn (T359)", async () => {
    const {
      driver: d,
      sent,
      polls,
    } = driver([
      ready(PARKED), // pre-Enter baseline: the paste is in the composer
      ready(EMPTY), // the whole turn happened inside the window — composer cleared
    ]);
    await d.inject("hello");
    expect(sent).toEqual(["literal:hello", "Enter"]); // no empty-turn re-presses
    const before = polls();
    await d.awaitTurn("id1"); // the flag is consumed: returns without polling
    expect(polls()).toBe(before);
  });
});
