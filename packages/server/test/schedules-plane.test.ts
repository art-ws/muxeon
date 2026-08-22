// Where authority lives for deferred self-chains (§21.6, inv. §10.33): the plane
// accepts plans, the EXECUTORS decide whether an item may touch the pane — and
// they decide it when the item fires, not when it was written down.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandGrants, SessionGrants } from "@muxeon/core";
import { DEFAULT_LIMITS, createFsScheduleStore } from "@muxeon/schedules";
import { SchedulePlane, scheduleExecutors } from "../src/schedules";

const ran: string[] = [];

const executors = (commandGrants: CommandGrants, sessionGrants: SessionGrants) =>
  scheduleExecutors({
    commandGrants,
    sessionGrants,
    isKnownAgent: () => true,
    statusOf: async () => "idle",
    deliver: async ({ text }) => {
      ran.push(`deliver ${text}`);
    },
    runCommand: async ({ agent, slash }) => {
      ran.push(`command ${agent} ${slash}`);
      return "";
    },
    control: async ({ agent, action }) => {
      ran.push(`control ${agent} ${action}`);
    },
  });

const refusal = async (fn: () => Promise<unknown>): Promise<string> => {
  try {
    await fn();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "no error";
};

describe("the self grants decide, at firing time (§21.6)", () => {
  beforeEach(() => {
    ran.length = 0;
  });

  test("a note to oneself needs no grant at all — self-delivery is not a privilege", async () => {
    const exec = executors(new CommandGrants(), new SessionGrants());
    await exec.deliver({ agent: "dev", text: "remember", id: "c:0" });
    expect(ran).toEqual(["deliver remember"]);
  });

  test("a slash on one's own pane without a self grant is refused, and names why", async () => {
    const exec = executors(new CommandGrants(), new SessionGrants());
    const message = await refusal(() => exec.runCommand({ agent: "dev", slash: "clear" }));
    expect(message).toContain("COMMAND_DENIED");
    expect(message).toContain("commandGrants.dev.dev"); // says exactly what is missing
    expect(ran).toEqual([]);
  });

  // The §21.6 rule, enforced where it matters: "*" as a recipient means "any
  // NEIGHBOUR", and an agent is not its own neighbour. Those wildcards were
  // written when no path to one's own pane existed.
  test('a "*" grant over neighbours does NOT reach one\'s own pane', async () => {
    const exec = executors(new CommandGrants({ ceo: { "*": ["clear"] } }), new SessionGrants());
    expect(await refusal(() => exec.runCommand({ agent: "ceo", slash: "clear" }))).toContain(
      "COMMAND_DENIED",
    );
    expect(ran).toEqual([]);
  });

  test("an explicit self grant lets it through — and only for what it lists", async () => {
    const exec = executors(
      new CommandGrants({ dev: { dev: ["clear"] } }),
      new SessionGrants({ dev: { dev: ["restart"] } }),
    );
    await exec.runCommand({ agent: "dev", slash: "clear" });
    await exec.control({ agent: "dev", action: "restart" });
    expect(ran).toEqual(["command dev clear", "control dev restart"]);
    expect(await refusal(() => exec.runCommand({ agent: "dev", slash: "compact" }))).toContain(
      "COMMAND_DENIED",
    );
    expect(await refusal(() => exec.control({ agent: "dev", action: "stop" }))).toContain(
      "CONTROL_DENIED",
    );
  });

  test("restarting oneself is refused without its own grant, even with the command one", async () => {
    const exec = executors(new CommandGrants({ dev: { dev: ["*"] } }), new SessionGrants());
    expect(await refusal(() => exec.control({ agent: "dev", action: "restart" }))).toContain(
      "CONTROL_DENIED",
    );
  });
});

describe("the plane (§21.4)", () => {
  let root: string;
  let plane: SchedulePlane;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "muxeon-schedule-plane-"));
    plane = new SchedulePlane({
      store: createFsScheduleStore(root),
      limits: DEFAULT_LIMITS,
      enabled: true,
      isKnownAgent: (name) => name === "dev",
    });
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test("a plan survives being written and read back", async () => {
    const created = await plane.create("dev", { items: [{ delay: "1m", text: "later" }] });
    expect(created.ok).toBe(true);
    const listed = await plane.list("dev");
    expect(listed.value?.[0]?.items[0]?.text).toBe("later");
  });

  test("an unknown agent gets no schedule — a plan nothing can fire is not a plan", async () => {
    const created = await plane.create("ghost", { items: [{ delay: "1m", text: "x" }] });
    expect(created.code).toBe("UNKNOWN_PEER");
  });

  test("cancelling marks the items, and cancelling nothing says so", async () => {
    const created = await plane.create("dev", {
      id: "two",
      items: [
        { delay: "1m", text: "a" },
        { delay: "1m", text: "b" },
      ],
    });
    expect(created.ok).toBe(true);
    expect((await plane.cancel("dev", "two", 1)).value).toBe(1);
    expect((await plane.cancel("dev", "two", 1)).code).toBe("UNKNOWN_SCHEDULE");
    expect((await plane.cancel("dev", "two")).value).toBe(1); // the one still pending
    expect((await plane.cancel("dev", "nope")).code).toBe("UNKNOWN_SCHEDULE");
  });

  test("a disabled subsystem refuses every entry point by name", async () => {
    const off = new SchedulePlane({
      store: createFsScheduleStore(root),
      limits: DEFAULT_LIMITS,
      enabled: false,
      isKnownAgent: () => true,
    });
    expect((await off.create("dev", { items: [{ delay: "1m", text: "x" }] })).code).toBe(
      "SCHEDULES_DISABLED",
    );
    expect((await off.list("dev")).code).toBe("SCHEDULES_DISABLED");
    expect((await off.cancel("dev", "any")).code).toBe("SCHEDULES_DISABLED");
  });
});
