// instanceName() (FR-90): reads the connector-injected <meta name="teamai-name">.
// bun test has no DOM, so we stub a minimal document.querySelector.

import { afterEach, describe, expect, test } from "bun:test";
import { instanceName } from "../src/instance";

const original = Object.getOwnPropertyDescriptor(globalThis, "document");
afterEach(() => {
  if (original === undefined) (globalThis as { document?: unknown }).document = undefined;
  else Object.defineProperty(globalThis, "document", original);
});

function stubMeta(content: string | null): void {
  const meta = content === null ? null : { getAttribute: () => content };
  (globalThis as { document?: unknown }).document = { querySelector: () => meta };
}

describe("instanceName (FR-90)", () => {
  test("returns the injected meta content", () => {
    stubMeta("prod-cluster");
    expect(instanceName()).toBe("prod-cluster");
  });

  test("trims surrounding whitespace", () => {
    stubMeta("  prod-cluster  ");
    expect(instanceName()).toBe("prod-cluster");
  });

  test("no meta ⇒ empty (the topbar shows the logo alone)", () => {
    stubMeta(null);
    expect(instanceName()).toBe("");
  });

  test("no document (dev serve / SSR) ⇒ empty, never throws", () => {
    (globalThis as { document?: unknown }).document = undefined;
    expect(instanceName()).toBe("");
  });
});
