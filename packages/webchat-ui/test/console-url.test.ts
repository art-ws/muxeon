// Console socket URL (§12.9, FR-160). bun test has no DOM, so window.location is
// stubbed — the point of the rule is that the URL is DERIVED from the document,
// never hardcoded: the panel is served under any reverse-proxy prefix (§12.6),
// and a console that ignored that would attach nowhere behind /team.

import { afterEach, describe, expect, test } from "bun:test";
import { consoleSocketUrl } from "../src/api";

const original = Object.getOwnPropertyDescriptor(globalThis, "window");

afterEach(() => {
  if (original === undefined) (globalThis as { window?: unknown }).window = undefined;
  else Object.defineProperty(globalThis, "window", original);
});

function servedAt(href: string): void {
  (globalThis as { window?: unknown }).window = { location: { href } };
}

describe("consoleSocketUrl (§12.9, FR-160)", () => {
  test("http page → ws socket next to the panel", () => {
    servedAt("http://localhost:8091/");
    expect(consoleSocketUrl("dev")).toBe("ws://localhost:8091/api/agents/dev/console");
  });

  test("a basePath is kept — the socket lives under the prefix (§12.6)", () => {
    servedAt("http://localhost:8091/team/");
    expect(consoleSocketUrl("dev")).toBe("ws://localhost:8091/team/api/agents/dev/console");
  });

  test("a deep route still resolves against the panel root, not the route", () => {
    servedAt("http://localhost:8091/team/#/chat/dev");
    expect(consoleSocketUrl("dev")).toBe("ws://localhost:8091/team/api/agents/dev/console");
  });

  test("https → wss (a proxied panel keeps its transport)", () => {
    servedAt("https://panel.example.com/team/");
    expect(consoleSocketUrl("dev")).toBe("wss://panel.example.com/team/api/agents/dev/console");
  });

  test("an agent name is encoded, never interpolated raw", () => {
    servedAt("http://localhost:8091/");
    expect(consoleSocketUrl("a b/c")).toBe("ws://localhost:8091/api/agents/a%20b%2Fc/console");
  });
});
