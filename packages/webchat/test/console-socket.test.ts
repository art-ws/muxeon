// Console socket (§12.9, FR-160): the panel's interactive terminal.
//
// The gates are the point of this file: the socket is the ONE surface that
// carries input into a pane, so auth (§10.12) and the neighbour edge (§10.2)
// must both refuse BEFORE the upgrade — the console port must never be touched
// by a request that would not have been allowed to run a command either.

import { describe, expect, test } from "bun:test";
import { SESSION_COOKIE, WebchatConnector } from "../src/connector";
import type { ConsoleAttachment, ConsoleHandlers } from "../src/ports";

const ports = {
  listPeers: () => ["researcher", "gone"],
  peerStatus: () => "idle" as const,
  queueDepth: async () => 0,
  messagePhase: async () => undefined,
};

function fakeConsolePort() {
  const state = {
    attached: [] as string[],
    typed: [] as string[],
    closed: 0,
    handlers: undefined as ConsoleHandlers | undefined,
  };
  const port = {
    actions: () => ({ shutdown: true, reload: true }),
    shutdown: async () => "down" as const,
    reload: async () => "idle" as const,
    commands: () => [],
    runCommand: async () => "",
    console: async (name: string, handlers: ConsoleHandlers): Promise<ConsoleAttachment> => {
      state.attached.push(name);
      if (name === "gone") throw new Error(`no live session for "${name}"`);
      state.handlers = handlers;
      return {
        cols: 111,
        rows: 29,
        screen: "PRIMED-SCREEN",
        write: (bytes) => state.typed.push(new TextDecoder().decode(bytes)),
        close: () => {
          state.closed += 1;
        },
      };
    },
  };
  return { state, port };
}

async function started(
  overrides: Partial<ConstructorParameters<typeof WebchatConnector>[0]> = {},
): Promise<WebchatConnector> {
  const connector = new WebchatConnector({
    bindOperator: "operator-web",
    port: 0,
    password: "hunter2",
    ports,
    ...overrides,
  });
  await connector.start(async () => undefined);
  return connector;
}

async function login(connector: WebchatConnector): Promise<string> {
  const response = await connector.handleRequest(
    new Request("http://panel.test/api/login", {
      method: "POST",
      headers: { "content-type": "application/json", host: "panel.test" },
      body: JSON.stringify({ password: "hunter2" }),
    }),
  );
  const token = /muxeon_webchat=([^;]+)/.exec(response.headers.get("set-cookie") ?? "")?.[1];
  if (token === undefined) throw new Error("no session cookie issued");
  return token;
}

/** An open console socket plus everything it has received so far. */
interface OpenConsole {
  socket: WebSocket;
  frames: string[];
  bytes: Uint8Array[];
  closed: Promise<void>;
}

async function openConsole(
  connector: WebchatConnector,
  agent: string,
  token: string,
  base = "",
): Promise<OpenConsole> {
  const socket = new WebSocket(
    `ws://127.0.0.1:${connector.port}${base}/api/agents/${agent}/console`,
    { headers: { cookie: `${SESSION_COOKIE}=${token}` } },
  );
  socket.binaryType = "arraybuffer";
  const frames: string[] = [];
  const bytes: Uint8Array[] = [];
  let resolveClosed: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  socket.addEventListener("message", (event) => {
    if (typeof event.data === "string") frames.push(event.data);
    else bytes.push(new Uint8Array(event.data as ArrayBuffer));
  });
  socket.addEventListener("close", () => resolveClosed());
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  return { socket, frames, bytes, closed };
}

/** Waits for a condition the socket satisfies asynchronously (real listener). */
async function until(probe: () => boolean, what: string, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}

const request = (connector: WebchatConnector, path: string, token?: string): Promise<Response> =>
  fetch(`http://127.0.0.1:${connector.port}${path}`, {
    headers: token === undefined ? {} : { cookie: `${SESSION_COOKIE}=${token}` },
  });

describe("console socket gates (§12.9, FR-160)", () => {
  test("unauthenticated → 401 and the console port is NEVER touched (§10.12)", async () => {
    const fake = fakeConsolePort();
    const connector = await started({ lifecycle: fake.port });
    try {
      const response = await request(connector, "/api/agents/researcher/console");
      expect(response.status).toBe(401);
      expect(fake.state.attached).toEqual([]);
    } finally {
      await connector.stop();
    }
  });

  test("a non-neighbour agent → 404, before any attach (§10.2)", async () => {
    const fake = fakeConsolePort();
    const connector = await started({ lifecycle: fake.port });
    try {
      const token = await login(connector);
      const response = await request(connector, "/api/agents/stranger/console", token);
      expect(response.status).toBe(404);
      expect(fake.state.attached).toEqual([]);
    } finally {
      await connector.stop();
    }
  });

  test("an unwired console port → 503 (the menu item simply does not work)", async () => {
    const connector = await started({
      lifecycle: {
        actions: () => ({ shutdown: true, reload: true }),
        shutdown: async () => "down" as const,
        reload: async () => "idle" as const,
        commands: () => [],
        runCommand: async () => "",
      },
    });
    try {
      const token = await login(connector);
      const response = await request(connector, "/api/agents/researcher/console", token);
      expect(response.status).toBe(503);
    } finally {
      await connector.stop();
    }
  });

  test("under a basePath the socket lives under the prefix only (§12.6)", async () => {
    const fake = fakeConsolePort();
    const connector = await started({ lifecycle: fake.port, basePath: "/team" });
    try {
      const response = await connector.handleRequest(
        new Request("http://panel.test/team/api/login", {
          method: "POST",
          headers: { "content-type": "application/json", host: "panel.test" },
          body: JSON.stringify({ password: "hunter2" }),
        }),
      );
      const token = /muxeon_webchat=([^;]+)/.exec(response.headers.get("set-cookie") ?? "")?.[1];
      expect(token).toBeDefined();
      const outside = await request(connector, "/api/agents/researcher/console", token);
      expect(outside.status).toBe(404); // out of prefix: a plain 404, not a console
      const console = await openConsole(connector, "researcher", token as string, "/team");
      await until(() => console.frames.length > 0, "the init frame");
      console.socket.close();
      await console.closed;
    } finally {
      await connector.stop();
    }
  });
});

describe("console socket traffic (§12.9, FR-160)", () => {
  test("opens with the pane geometry and the priming screen", async () => {
    const fake = fakeConsolePort();
    const connector = await started({ lifecycle: fake.port });
    try {
      const token = await login(connector);
      const console = await openConsole(connector, "researcher", token);
      await until(() => console.frames.length > 0, "the init frame");
      expect(JSON.parse(console.frames[0] as string)).toEqual({
        t: "init",
        cols: 111,
        rows: 29,
        screen: "PRIMED-SCREEN",
      });
      expect(fake.state.attached).toEqual(["researcher"]);
      console.socket.close();
      await console.closed;
    } finally {
      await connector.stop();
    }
  });

  test("pane output arrives as binary frames, in order", async () => {
    const fake = fakeConsolePort();
    const connector = await started({ lifecycle: fake.port });
    try {
      const token = await login(connector);
      const console = await openConsole(connector, "researcher", token);
      await until(() => console.frames.length > 0, "the init frame");
      fake.state.handlers?.onData(new TextEncoder().encode("one"));
      fake.state.handlers?.onData(new TextEncoder().encode("two"));
      await until(() => console.bytes.length === 2, "two output frames");
      expect(console.bytes.map((chunk) => new TextDecoder().decode(chunk))).toEqual(["one", "two"]);
      console.socket.close();
      await console.closed;
    } finally {
      await connector.stop();
    }
  });

  test("typed bytes are handed to the pane verbatim", async () => {
    const fake = fakeConsolePort();
    const connector = await started({ lifecycle: fake.port });
    try {
      const token = await login(connector);
      const console = await openConsole(connector, "researcher", token);
      await until(() => console.frames.length > 0, "the init frame");
      console.socket.send(new TextEncoder().encode("ls -la\r"));
      console.socket.send(new Uint8Array([0x03])); // Ctrl-C is a byte like any other
      await until(() => fake.state.typed.length === 2, "the typed frames");
      expect(fake.state.typed).toEqual(["ls -la\r", ""]);
      console.socket.close();
      await console.closed;
    } finally {
      await connector.stop();
    }
  });

  test("an oversized input frame is dropped — a console is a keyboard", async () => {
    const fake = fakeConsolePort();
    const connector = await started({ lifecycle: fake.port });
    try {
      const token = await login(connector);
      const console = await openConsole(connector, "researcher", token);
      await until(() => console.frames.length > 0, "the init frame");
      console.socket.send(new Uint8Array(64 * 1024 + 1));
      console.socket.send(new TextEncoder().encode("after"));
      await until(() => fake.state.typed.length > 0, "the accepted frame");
      expect(fake.state.typed).toEqual(["after"]);
      console.socket.close();
      await console.closed;
    } finally {
      await connector.stop();
    }
  });

  test("closing the socket detaches the console — nothing stays attached to the pane", async () => {
    const fake = fakeConsolePort();
    const connector = await started({ lifecycle: fake.port });
    try {
      const token = await login(connector);
      const console = await openConsole(connector, "researcher", token);
      await until(() => console.frames.length > 0, "the init frame");
      console.socket.close();
      await console.closed;
      await until(() => fake.state.closed === 1, "the detach");
    } finally {
      await connector.stop();
    }
  });

  test("a dead session answers with an error frame instead of an empty terminal", async () => {
    const fake = fakeConsolePort();
    const connector = await started({ lifecycle: fake.port });
    try {
      const token = await login(connector);
      const console = await openConsole(connector, "gone", token);
      await until(() => console.frames.length > 0, "the error frame");
      const frame = JSON.parse(console.frames[0] as string) as { t: string; message: string };
      expect(frame.t).toBe("error");
      expect(frame.message).toContain('no live session for "gone"'); // the real reason
      // the popup closes the socket when it sees the frame — the server never does
      console.socket.close();
      await console.closed;
    } finally {
      await connector.stop();
    }
  });

  test("a pane that goes away closes the socket with an exit frame", async () => {
    const fake = fakeConsolePort();
    const connector = await started({ lifecycle: fake.port });
    try {
      const token = await login(connector);
      const console = await openConsole(connector, "researcher", token);
      await until(() => console.frames.length > 0, "the init frame");
      fake.state.handlers?.onExit();
      await until(() => console.frames.length > 1, "the exit frame");
      expect(JSON.parse(console.frames[1] as string)).toEqual({ t: "exit" });
      console.socket.close();
      await console.closed;
    } finally {
      await connector.stop();
    }
  });

  test("stopping the connector detaches every open console", async () => {
    const fake = fakeConsolePort();
    const connector = await started({ lifecycle: fake.port });
    const token = await login(connector);
    const console = await openConsole(connector, "researcher", token);
    await until(() => console.frames.length > 0, "the init frame");
    await connector.stop();
    expect(fake.state.closed).toBe(1);
  });
});
