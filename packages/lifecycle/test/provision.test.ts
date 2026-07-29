import { describe, expect, test } from "bun:test";
import { provision, toArgv } from "../src/provision";
import { fakeControl, makeTarget } from "./helpers";

const deps = (control = fakeControl()) => ({ control, configDir: "/cfg" });

describe("toArgv — argv, never a shell string (§8.7)", () => {
  test("an array passes through verbatim", () => {
    expect(toArgv(["claude", "--resume", "x"])).toEqual(["claude", "--resume", "x"]);
  });

  test("a string is a SINGLE program token — not whitespace-split", () => {
    expect(toArgv("claude")).toEqual(["claude"]);
    expect(toArgv("claude --resume")).toEqual(["claude --resume"]); // one token, not ["claude","--resume"]
  });

  test("shell metacharacters in a string stay inert (no command injection)", () => {
    // As argv this is one (absent) program name; it is never parsed by a shell.
    expect(toArgv("claude; rm -rf ~")).toEqual(["claude; rm -rf ~"]);
    expect(toArgv("$(whoami)")).toEqual(["$(whoami)"]);
    expect(toArgv("a && b | c")).toEqual(["a && b | c"]);
  });
});

describe("provision (§4, FR-8, §8.7)", () => {
  test("creates a detached session running command as argv; agent config untouched (FR-11b)", async () => {
    const control = fakeControl();
    const kit = makeTarget({ tmux: "rs", provision: { command: ["claude", "--flag"] } });
    const status = await provision(kit.target, deps(control));

    expect(control.calls.newSession).toHaveLength(1);
    expect(control.calls.newSession[0]?.name).toBe("rs");
    expect(control.calls.newSession[0]?.options.command).toEqual(["claude", "--flag"]);
    expect(status).toBe("idle"); // down → idle (§5.1)
    expect(kit.target.state.status).toBe("idle");
    expect(kit.target.state.origin).toBe("system"); // WE raised it (§5.1, FR-92)
  });

  test("a malicious string command is one argv token — no shell, no injection (§8.7)", async () => {
    const control = fakeControl();
    const kit = makeTarget({ provision: { command: "claude; rm -rf ~" } });
    await provision(kit.target, deps(control));
    expect(control.calls.newSession[0]?.options.command).toEqual(["claude; rm -rf ~"]);
  });

  test("cwd precedence: provision.cwd > agent.cwd > <config_dir> (§7.1)", async () => {
    const explicit = fakeControl();
    await provision(
      makeTarget({ cwd: "/agent", provision: { command: "claude", cwd: "/explicit" } }).target,
      deps(explicit),
    );
    expect(explicit.calls.newSession[0]?.options.cwd).toBe("/explicit");

    const agentCwd = fakeControl();
    await provision(
      makeTarget({ cwd: "/agent", provision: { command: "claude" } }).target,
      deps(agentCwd),
    );
    expect(agentCwd.calls.newSession[0]?.options.cwd).toBe("/agent");

    const fallback = fakeControl();
    await provision(makeTarget({ provision: { command: "claude" } }).target, deps(fallback));
    expect(fallback.calls.newSession[0]?.options.cwd).toBe("/cfg"); // <config_dir>
  });

  test("explicit env is forwarded to the session", async () => {
    const control = fakeControl();
    const kit = makeTarget({ provision: { command: "claude", env: { FOO: "bar" } } });
    await provision(kit.target, deps(control));
    expect(control.calls.newSession[0]?.options.env).toEqual({ FOO: "bar" });
  });

  test("provisioning an attach-only agent (no provision block) throws", async () => {
    const kit = makeTarget({}); // no provision
    await expect(provision(kit.target, deps())).rejects.toThrow(/no provision block/);
  });
});
