// @teamai/server — composition root + network surface. Boot order: config →
// attach → dispatchers → channel connectors → routines; MCP agent-plane /
// operator-plane. ONE binary (§7.4): `teamai [config]` launches the server;
// `teamai <subcommand> …` runs the operator CLI against the HTTP-admin (§8.5).
// — T18, T21–T23, T30–T33.

import { parseConfigArg } from "@teamai/config";
import { bootstrap } from "./bootstrap";
import { CLI_COMMANDS, runCli } from "./cli/cli";
import { createShutdownHandler } from "./shutdown";

export * from "./bootstrap";
export * from "./wire-channels";
export * from "./cli/cli";
export * from "./redact";
export * from "./shutdown";

async function launch(argv: readonly string[]): Promise<void> {
  // Last-resort safety net (R2, §10): TEAMAI is a transport for many agents — a stray
  // async fault touching ONE agent (e.g. a background dispatcher loop capturing a
  // vanished tmux session) must never terminate the whole coordinator and drop every
  // agent's transport with it. Under Bun an unhandled rejection is fatal by default;
  // log and survive instead (T145 — killing a busy agent crashed the stand). The
  // targeted fixes (driver capture guard, processOne race catch) prevent the known
  // path; this catches the unknown ones. Boot failures still exit 1 via the try/catch
  // below — those handlers are for the RUNNING server only.
  process.on("unhandledRejection", (reason) => {
    const detail = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
    process.stderr.write(`teamai: warning: unhandled rejection (survived): ${detail}\n`);
  });
  process.on("uncaughtException", (error) => {
    process.stderr.write(
      `teamai: warning: uncaught exception (survived): ${error.stack ?? error.message}\n`,
    );
  });
  try {
    const configFile = parseConfigArg(argv);
    const server = await bootstrap(configFile !== undefined ? { configFile } : {});
    for (const warning of server.warnings) process.stderr.write(`teamai: warning: ${warning}\n`);
    process.stdout.write(`teamai: booted; ${server.agents.size} agent(s)\n`);
    for (const agent of server.agents.values()) {
      process.stdout.write(`  - ${agent.name} (${agent.session}): ${agent.state.status}\n`);
    }
    if (server.agentPlane !== undefined) {
      process.stdout.write(`teamai: agent-plane (MCP) on ${server.agentPlane.url}\n`);
    }
    process.stdout.write(`teamai: operator-plane on ${server.adminUrl} (loopback)\n`);
    for (const channel of server.channels.values()) {
      process.stdout.write(`teamai: channel ${channel.type} → operator "${channel.operator}"\n`);
    }
    const onSignal = createShutdownHandler({
      stop: () => server.stop(),
      exit: (code) => process.exit(code),
      warn: (message) => process.stderr.write(`teamai: warning: ${message}\n`),
    });
    process.on("SIGINT", () => onSignal("SIGINT"));
    process.on("SIGTERM", () => onSignal("SIGTERM"));
  } catch (error) {
    process.stderr.write(`teamai: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const first = argv[0];
  if (first !== undefined && CLI_COMMANDS.has(first)) {
    // operator subcommand (§7.4/§8.5) — thin client to the admin plane
    process.exit(
      await runCli(argv, {
        stdout: (line) => process.stdout.write(`${line}\n`),
        stderr: (line) => process.stderr.write(`${line}\n`),
      }),
    );
  } else {
    await launch(argv);
  }
}
