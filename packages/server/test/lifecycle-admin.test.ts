// Lifecycle admin onUp wiring (FR-51, §8.5): a SUCCESSFUL operator provision or
// restart re-arms the auto-revive budget (Reviver.reset via onUp); kill and failed
// ops do not. The lane is drained manually here — these are unit tests without a
// dispatcher loop.

import { describe, expect, test } from "bun:test";
import type { Adapter } from "@teamai/adapters";
import type { AgentTarget, SessionControl } from "@teamai/lifecycle";
import { AgentState, ControlLane } from "@teamai/orchestrator";
import { createLifecycleAdmin } from "../src/admin/lifecycle";

function fakeControl(): SessionControl & { live: Set<string> } {
  const live = new Set<string>();
  return {
    live,
    hasSession: async (name) => live.has(name),
    newSession: async (name) => {
      live.add(name);
    },
    killSession: async (name) => {
      live.delete(name);
    },
    sendLiteral: async () => undefined,
    sendKeys: async () => undefined,
    capturePane: async () => "",
  };
}

function makeTarget(
  opts: { provision?: boolean; status?: "idle" | "busy" | "down" } = {},
): AgentTarget {
  const adapter: Adapter = {
    type: "dummy",
    render: (message) => String(message.payload),
    detect: { readyPrompt: /READY>\s*$/ },
    slashCommand: (name) => `/${name}`,
  };
  return {
    agent: {
      name: "researcher",
      type: "dummy",
      tmux: "researcher-s",
      ...(opts.provision === false ? {} : { provision: { command: "dummy-agent" } }),
    },
    adapter,
    state: new AgentState(opts.status ?? "down"),
  };
}

/** Run an admin op and the lane that owns it concurrently (submit-then-drain). */
async function ranThrough<T>(lane: ControlLane, op: () => Promise<T>): Promise<T> {
  const result = op();
  // Drain until the op settles — mirrors the dispatcher run loop draining the control
  // lane between turns. An op may enqueue its lane submit only AFTER an await (e.g.
  // restart kills off-lane first), so a one-shot `while (lane.size > 0)` would miss it.
  let settled = false;
  void result.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  while (!settled) {
    if (lane.size > 0) await lane.drain();
    else await new Promise((resolve) => setTimeout(resolve, 0)); // let the op enqueue
  }
  return result;
}

describe("lifecycle admin re-arms auto-revive (FR-51, §8.5)", () => {
  function setup(target: AgentTarget) {
    const control = fakeControl();
    const lane = new ControlLane();
    const onUp: string[] = [];
    const admin = createLifecycleAdmin({
      agents: new Map([
        ["researcher", { name: "researcher", target, lane, onUp: () => onUp.push("reset") }],
      ]),
      control,
      configDir: "/cfg",
    });
    return { control, lane, onUp, admin };
  }

  test("a successful provision calls onUp", async () => {
    const { lane, onUp, admin } = setup(makeTarget());
    expect(await ranThrough(lane, () => admin.provision("researcher"))).toBe("idle");
    expect(onUp).toEqual(["reset"]);
  });

  test("a successful restart calls onUp; kill does not", async () => {
    const target = makeTarget({ status: "idle" });
    const { control, lane, onUp, admin } = setup(target);
    control.live.add("researcher-s");
    expect(await admin.kill("researcher")).toBe("down"); // immediate, no lane
    expect(onUp).toEqual([]);
    expect(await ranThrough(lane, () => admin.restart("researcher"))).toBe("idle");
    expect(onUp).toEqual(["reset"]);
  });

  test("restart INTERRUPTS a busy turn — the kill is immediate and off the lane (T145)", async () => {
    const target = makeTarget({ status: "busy" }); // mid-turn: the lane is blocked
    const { control, lane, admin } = setup(target);
    control.live.add("researcher-s");

    const pending = admin.restart("researcher");
    pending.catch(() => undefined); // resolved below via drain — avoid an unhandled rejection
    await new Promise((resolve) => setTimeout(resolve, 0)); // flush the immediate kill

    // The interrupt happened WITHOUT any lane drain: the session is gone and the agent
    // is down, so restart never hangs behind the busy turn (the whole point).
    expect(control.live.has("researcher-s")).toBe(false);
    expect(target.state.status).toBe("down");
    expect(lane.size).toBe(1); // only the re-provision is queued on the lane

    // Draining the lane runs the ordered kill(no-op)+provision → back up idle.
    while (lane.size > 0) await lane.drain();
    expect(await pending).toBe("idle");
    expect(control.live.has("researcher-s")).toBe(true);
  });

  test("a failed provision (attach-only) does not call onUp", async () => {
    const { lane, onUp, admin } = setup(makeTarget({ provision: false }));
    const attempt = admin.provision("researcher");
    attempt.catch(() => undefined); // surfaced below; avoid an unhandled rejection
    while (lane.size > 0) await lane.drain();
    await expect(attempt).rejects.toThrow(/no provision block/);
    expect(onUp).toEqual([]);
  });
});

describe("graceful shutdown/reload (T85, FR-64, §8.5)", () => {
  function setup(target: AgentTarget, types?: Parameters<typeof createLifecycleAdmin>[0]["types"]) {
    const control = fakeControl();
    const lane = new ControlLane();
    const onUp: string[] = [];
    const sent: string[] = [];
    control.sendLiteral = async (_name, text) => {
      sent.push(text);
    };
    const admin = createLifecycleAdmin({
      agents: new Map([
        ["researcher", { name: "researcher", target, lane, onUp: () => onUp.push("reset") }],
      ]),
      control,
      configDir: "/cfg",
      ...(types !== undefined ? { types } : {}),
    });
    return { control, lane, onUp, sent, admin };
  }

  test("shutdown without any strategy is the hard kill (immediate, no lane)", async () => {
    const target = makeTarget({ status: "idle" });
    const { control, sent, admin } = setup(target);
    control.live.add("researcher-s");
    expect(await admin.shutdown("researcher")).toBe("down");
    expect(sent).toEqual([]); // nothing graceful was attempted
    expect(control.live.has("researcher-s")).toBe(false);
  });

  test("shutdown resolves the TYPE-level strategy and asks via the slash", async () => {
    const target = makeTarget({ status: "idle" });
    const { control, sent, admin } = setup(target, {
      dummy: { teardown: { slash: "exit", graceMs: 0 } },
    });
    control.live.add("researcher-s");
    expect(await admin.shutdown("researcher")).toBe("down");
    expect(sent).toEqual(["/exit"]); // adapter-rendered ask (graceMs 0 → instant hard kill)
  });

  test("the AGENT-level strategy overrides the type default", async () => {
    const target = makeTarget({ status: "idle" });
    target.agent.provision !== undefined &&
      Object.assign(target.agent.provision, { teardown: { slash: "quit", graceMs: 0 } });
    const { control, sent, admin } = setup(target, {
      dummy: { teardown: { slash: "exit", graceMs: 0 } },
    });
    control.live.add("researcher-s");
    await admin.shutdown("researcher");
    expect(sent).toEqual(["/quit"]);
  });

  test("reload = teardown + provision through the lane; onUp re-arms revive", async () => {
    const target = makeTarget({ status: "idle" });
    const { control, lane, onUp, admin } = setup(target, {
      dummy: { teardown: { slash: "exit", graceMs: 0 } },
    });
    control.live.add("researcher-s");
    expect(await ranThrough(lane, () => admin.reload("researcher"))).toBe("idle");
    expect(control.live.has("researcher-s")).toBe(true); // re-provisioned
    expect(onUp).toEqual(["reset"]);
  });
});

describe("slash commands (T86, FR-66, §8.5)", () => {
  function setup(target: AgentTarget, types?: Parameters<typeof createLifecycleAdmin>[0]["types"]) {
    const control = fakeControl();
    const lane = new ControlLane();
    const typed: string[] = [];
    control.sendLiteral = async (_name, text) => {
      typed.push(text);
    };
    control.capturePane = async () => "console output as-is";
    const admin = createLifecycleAdmin({
      agents: new Map([["researcher", { name: "researcher", target, lane }]]),
      control,
      configDir: "/cfg",
      ...(types !== undefined ? { types } : {}),
    });
    return { control, lane, typed, admin };
  }

  test("commands() merges type ∪ agent — agent wins by slash name; internal appended", () => {
    const target = makeTarget({ status: "idle" });
    Object.assign(target.agent, {
      commands: [{ slash: "usage", keys: "capture Escape" }, { slash: "todo" }],
    });
    const { admin } = setup(target, {
      dummy: { commands: [{ slash: "clear" }, { slash: "usage" }] },
    });
    expect(admin.commands("researcher")).toEqual([
      { slash: "clear" },
      { slash: "usage", keys: "capture Escape" }, // agent override flipped keys
      { slash: "todo" },
      { slash: "screenshot" }, // internal (FR-67) — present on every agent
    ]);
  });

  test("internal commands are listed even with NO commands config (FR-67)", () => {
    const { admin } = setup(makeTarget({ status: "idle" }));
    expect(admin.commands("researcher")).toEqual([{ slash: "screenshot" }]);
  });

  test("an allowed command runs through the lane and returns the pane as-is", async () => {
    const target = makeTarget({ status: "idle" });
    const { lane, typed, admin } = setup(target, { dummy: { commands: [{ slash: "clear" }] } });
    const output = await ranThrough(lane, () => admin.command("researcher", "clear"));
    expect(output).toBe("console output as-is");
    expect(typed).toEqual(["/clear"]);
  });

  test("an unconfigured command is refused — the list IS the allowlist", () => {
    const target = makeTarget({ status: "idle" });
    const { admin } = setup(target, { dummy: { commands: [{ slash: "clear" }] } });
    expect(() => admin.command("researcher", "exit")).toThrow(/not configured/);
  });

  test("/screenshot runs system-side: BUSY agent, no lane, nothing typed (FR-67)", async () => {
    const target = makeTarget({ status: "busy" }); // a configured command would refuse this
    const { lane, typed, admin } = setup(target);
    const output = await admin.command("researcher", "screenshot"); // resolves with the lane idle
    expect(output).toBe("console output as-is");
    expect(typed).toEqual([]); // read-only: no input injected
    expect(lane.size).toBe(0); // laneless — never queues behind the stuck turn
  });

  test("/screenshot of a down agent is an operator-facing 409", async () => {
    const target = makeTarget({ status: "down" });
    const { admin } = setup(target);
    await expect(admin.command("researcher", "screenshot")).rejects.toThrow(/down — no console/);
  });
});

describe("lifecycle admin — pause / resume (§16.5, FR-119)", () => {
  function setup(opts: { paused?: string[] } = {}) {
    const target = makeTarget({ status: "idle" });
    const control = fakeControl();
    const lane = new ControlLane();
    const paused = new Set(opts.paused ?? []);
    const writes: string[][] = [];
    const admin = createLifecycleAdmin({
      agents: new Map([["researcher", { name: "researcher", target, lane }]]),
      control,
      configDir: "/cfg",
      pause: {
        has: (name) => paused.has(name),
        set: (name, value) => {
          if (value) {
            if (paused.has(name)) return false;
            paused.add(name);
            return true;
          }
          return paused.delete(name);
        },
        persist: async () => {
          writes.push([...paused].sort());
        },
      },
    });
    return { admin, paused, writes, target, lane };
  }

  test("pause sets the flag and mirrors it to the state file; the status is untouched", async () => {
    const { admin, paused, writes, target } = setup();
    expect(await admin.pause("researcher", true)).toBe(true);
    expect(paused.has("researcher")).toBe(true);
    expect(writes).toEqual([["researcher"]]);
    expect(target.state.status).toBe("idle"); // §16.1 — orthogonal to the session
  });

  test("it is IDEMPOTENT — a repeated pause changes nothing and writes nothing", async () => {
    const { admin, writes } = setup();
    expect(await admin.pause("researcher", true)).toBe(true);
    expect(await admin.pause("researcher", true)).toBe(true); // same desired state
    expect(writes).toHaveLength(1); // only the change was persisted
  });

  test("resume clears it, and resuming a live agent is a no-op write", async () => {
    const { admin, paused, writes } = setup({ paused: ["researcher"] });
    expect(await admin.pause("researcher", false)).toBe(false);
    expect(paused.has("researcher")).toBe(false);
    expect(writes).toEqual([[]]);
    expect(await admin.pause("researcher", false)).toBe(false);
    expect(writes).toHaveLength(1);
  });

  test("no lane involvement — the flag applies without any control-lane drain (§16.4)", async () => {
    const { admin, lane } = setup();
    await admin.pause("researcher", true); // would hang if it queued on the lane
    expect(lane.size).toBe(0);
  });

  test("list() reports paused beside the status (§16.1)", async () => {
    const { admin } = setup();
    expect(admin.list()).toEqual([
      { name: "researcher", session: "researcher-s", status: "idle", paused: false },
    ]);
    await admin.pause("researcher", true);
    expect(admin.list()[0]).toMatchObject({ status: "idle", paused: true });
  });

  test("an unknown agent is a 404, and pause without the registry wired is a 503", async () => {
    const { admin } = setup();
    await expect(admin.pause("ghost", true)).rejects.toThrow(/unknown agent/);
    const bare = createLifecycleAdmin({
      agents: new Map([
        ["researcher", { name: "researcher", target: makeTarget(), lane: new ControlLane() }],
      ]),
      control: fakeControl(),
      configDir: "/cfg",
    });
    await expect(bare.pause("researcher", true)).rejects.toThrow(/pause is not wired/);
    expect(bare.list()[0]).toMatchObject({ paused: false }); // reported, not omitted
  });
});
