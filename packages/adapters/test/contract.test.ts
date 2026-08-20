import { describe, expect, test } from "bun:test";
import type { Message, Signal } from "@muxeon/core";
import { defaultRender, makeDefaultRender, renderAttribution, renderRaw } from "../src/contract";

function msg(overrides: Partial<Message> = {}): Message {
  return {
    id: "abc-123",
    from: "researcher",
    to: "writer",
    kind: "message",
    ts: 0,
    payload: "hello",
    ...overrides,
  };
}

describe("default render / attribution (§8.3, FR-6)", () => {
  test("attribution carries from + id so the agent can reply", () => {
    expect(renderAttribution(msg())).toBe("[muxeon] from=researcher id=abc-123");
  });

  test("attribution includes replyTo when present", () => {
    expect(renderAttribution(msg({ replyTo: "xyz" }))).toBe(
      "[muxeon] from=researcher id=abc-123 replyTo=xyz",
    );
  });

  test("defaultRender is attribution + reply hint + payload (T57)", () => {
    const text = defaultRender(msg({ payload: "do the thing" }));
    expect(text).toContain("[muxeon] from=researcher id=abc-123");
    expect(text).toContain("do the thing");
    expect(text).toMatch(/from=researcher/);
    // The reply hint names the EXACT call — live finding: bare attribution is
    // not enough, the model answers in the terminal and never calls the tool.
    expect(text).toContain('send(to="researcher", replyTo="abc-123")');
    expect(text).toContain("plain-text payload");
  });

  test("payload rendering: string, {text}, and JSON fallback", () => {
    expect(defaultRender(msg({ payload: "raw" }))).toContain("raw");
    expect(defaultRender(msg({ payload: { text: "nested" } }))).toContain("nested");
    expect(defaultRender(msg({ payload: { n: 1 } }))).toContain('{"n":1}');
  });
});

describe("renderRaw (FR-88, §14.1)", () => {
  test("the payload text reaches the terminal VERBATIM — no preamble/hint", () => {
    const text = renderRaw(msg({ payload: "ls -la", raw: true }));
    expect(text).toBe("ls -la");
    expect(text).not.toContain("[muxeon]"); // no attribution (§14.1)
    expect(text).not.toContain("send("); // no reply hint
  });

  test("an object payload degrades to its text part (attachments dropped)", () => {
    expect(renderRaw(msg({ payload: { text: "echo hi", blobs: [{ blob: "x" }] } }))).toBe(
      "echo hi",
    );
    // a blobs-only payload has no text to inject → empty (raw mode has no media)
    expect(renderRaw(msg({ payload: { blobs: [{ blob: "x" }] } }))).toBe("");
  });
});

// --- T70 (FR-52, §13.2): the hybrid file-contract instruction ------------------

describe("exchange render (FR-52, §13.2)", () => {
  const FILE = "/work/.muxeon/inbox/abc-123/message.json";

  test("short payload: inlined text + the file contract LAST (T57)", () => {
    const text = defaultRender(msg({ payload: "привет" }), { messageFile: FILE });
    expect(text).toContain("[muxeon] from=researcher id=abc-123");
    expect(text).toContain("привет"); // readable live chat in tmux
    expect(text).toContain(`full message: ${FILE}`);
    expect(text).toContain("reply.md");
    expect(text).toContain("DELETE message.json");
    // T75 live finding: deletion must be spelled out as the FINAL step — an
    // agent that deletes first ends the turn before its reply is written.
    expect(text).toContain("FIRST write your answer");
    expect(text).toContain("VERY LAST action");
    // T76: the reply mirrors the request language (the instruction itself is EN)
    expect(text).toContain("SAME LANGUAGE as the message");
    expect(text).toContain("mirror the request language");
    // T239 live finding: the folder is the COORDINATOR's to remove — an agent
    // that polls it after its own delete sees the collection window and thinks
    // the exchange dropped the answer.
    expect(text).toContain("REMOVES that folder itself");
    expect(text).toContain("do NOT inspect it afterwards");
    expect(text).toContain("do NOT duplicate your answer through another channel");
    expect(text).not.toContain("READ the message file first"); // it was inlined
    expect(text).not.toContain("send(to="); // file contract replaces the MCP hint
    // the action contract is the TAIL of the input (T57)
    expect(text.trim().endsWith("]")).toBe(true);
    expect(text.indexOf("привет")).toBeLessThan(text.indexOf("full message:"));
  });

  test("long payload: text NOT inlined, explicit read-the-file marker", () => {
    const long = "х".repeat(2000);
    const text = defaultRender(msg({ payload: long }), { messageFile: FILE });
    expect(text).not.toContain(long);
    expect(text).toContain("READ the message file first");
    expect(text).toContain(`full message: ${FILE}`);
  });

  test("the inline threshold is configurable (adapter detail)", () => {
    const render = makeDefaultRender({ inlineMaxChars: 3 });
    expect(render(msg({ payload: "abcd" }), { messageFile: FILE })).toContain(
      "READ the message file first",
    );
    expect(render(msg({ payload: "abc" }), { messageFile: FILE })).toContain("abc");
  });

  test("attachment lines always render inline — message.json has opaque refs (FR-43)", () => {
    const render = makeDefaultRender({ blobsDir: "/q/blobs" });
    const payload = { text: "х".repeat(2000), blobs: [{ blob: "b1", name: "a.png" }] };
    const text = render(msg({ payload }), { messageFile: FILE });
    expect(text).toContain("[attachment] a.png → /q/blobs/b1"); // resolved path inline
    expect(text).toContain("READ the message file first"); // text itself is in the file
  });

  test("without a render context the legacy MCP-hint shape is unchanged", () => {
    const text = defaultRender(msg({ payload: "hello" }));
    expect(text).toContain('send(to="researcher", replyTo="abc-123")');
    expect(text).not.toContain("reply.md");
  });
});

// --- T261 (FR-156/FR-157, §13.6): the compact MCP reply contract ---------------

describe("compact MCP reply contract (§13.6, FR-156)", () => {
  const FILE = "/work/.muxeon/inbox/abc-123/message.json";

  test("replyVia mcp: one send call, and it is stated to end the turn", () => {
    const text = defaultRender(msg({ payload: "привет" }), {
      messageFile: FILE,
      replyVia: "mcp",
    });
    expect(text).toContain("[muxeon] from=researcher id=abc-123");
    expect(text).toContain("привет");
    // The file is still named: message.json is materialized in BOTH forms, and a
    // long payload lives only there (the hybrid rule §13.2).
    expect(text).toContain(`full message: ${FILE}`);
    expect(text).toContain('send(to="researcher", replyTo="abc-123")');
    expect(text).toContain("ENDS YOUR TURN");
    // T76 holds in both forms — the wrapper is EN, the answer mirrors the request.
    expect(text).toContain("SAME LANGUAGE as the message");
    // the action contract is still the TAIL of the input (T57)
    expect(text.trim().endsWith("]")).toBe(true);
    expect(text.indexOf("привет")).toBeLessThan(text.indexOf("full message:"));
  });

  test("the other path is never named — not even to forbid it (T267)", () => {
    const text = defaultRender(msg(), { messageFile: FILE, replyVia: "mcp" });
    // A prohibition still teaches the alternative, and since T262 stripped the file
    // contract from the agents' own CLAUDE.md this instruction would be the ONLY
    // place a compact-contract agent could learn reply.md exists. So it appears
    // nowhere — not as a step, not as a ban.
    expect(text).not.toContain("reply.md");
    expect(text).not.toMatch(/delete/i); // no deletion instruction, positive or negative
    expect(text).not.toContain("FIRST write your answer");
    expect(text).not.toContain("VERY LAST action");
    // …and the single positive clause that replaces all three prohibitions covers
    // writing AND deleting without naming either.
    expect(text).toContain("leave the message folder untouched");
  });

  test("the message file is still named — reading it is not the same as answering in it", () => {
    // Dropping the prohibitions must not drop the PATH: a long payload lives only
    // in message.json (the hybrid rule §13.2), so the agent still has to be told
    // where to read. Only the ANSWER path is single.
    const text = defaultRender(msg({ payload: "х".repeat(2000) }), {
      messageFile: FILE,
      replyVia: "mcp",
    });
    expect(text).toContain(`full message: ${FILE}`);
    expect(text).toContain("READ the message file first");
  });

  test("the compact form is materially shorter than the file contract", () => {
    const mcp = defaultRender(msg(), { messageFile: FILE, replyVia: "mcp" });
    const file = defaultRender(msg(), { messageFile: FILE });
    expect(mcp.length).toBeLessThan(file.length);
  });

  test("a long payload still gets the read-the-file marker", () => {
    const text = defaultRender(msg({ payload: "х".repeat(2000) }), {
      messageFile: FILE,
      replyVia: "mcp",
    });
    expect(text).toContain("READ the message file first");
    expect(text).toContain('send(to="researcher"');
  });

  test("absent or explicit exchange ⇒ the file contract, unchanged", () => {
    for (const ctx of [{ messageFile: FILE }, { messageFile: FILE, replyVia: "exchange" as const }])
      expect(defaultRender(msg(), ctx)).toBe(defaultRender(msg(), { messageFile: FILE }));
    expect(defaultRender(msg(), { messageFile: FILE })).toContain("DELETE message.json");
  });
});

// --- T48 (FR-43, §12.5): blob refs render as local paths -----------------------

describe("blob attachment rendering (T48, FR-43, §12.5)", () => {
  const blobPayload = {
    text: "see the photo",
    blobs: [{ blob: "b-1", name: "photo.jpg", mime: "image/jpeg", size: 11 }],
  };

  test("with blobsDir the ref renders as a resolved local path + name/mime", () => {
    const render = makeDefaultRender({ blobsDir: "/queue/blobs" });
    const text = render(msg({ payload: blobPayload }));
    expect(text).toContain("see the photo");
    expect(text).toContain("[attachment] photo.jpg (image/jpeg) → /queue/blobs/b-1");
  });

  test("without blobsDir the ref stays an opaque id (baseline shape)", () => {
    const text = defaultRender(msg({ payload: blobPayload }));
    expect(text).toContain("[attachment] photo.jpg (image/jpeg) → b-1");
    expect(text).not.toContain("/queue/blobs");
  });

  test("blobs-only payload renders attachment lines without a text part", () => {
    const render = makeDefaultRender({ blobsDir: "/queue/blobs" });
    const text = render(msg({ payload: { blobs: [{ blob: "b-2" }] } }));
    expect(text).toContain("[attachment] b-2 → /queue/blobs/b-2");
  });

  test("string refs and malformed refs degrade safely", () => {
    const render = makeDefaultRender({ blobsDir: "/queue/blobs" });
    expect(render(msg({ payload: { blobs: ["plain-id"] } }))).toContain("/queue/blobs/plain-id");
    expect(render(msg({ payload: { blobs: [42, null] } }))).not.toContain("[attachment]");
  });

  test("a hostile id never becomes a path — printed as-is (§8.7 defense)", () => {
    const render = makeDefaultRender({ blobsDir: "/queue/blobs" });
    const text = render(msg({ payload: { blobs: [{ blob: "../../etc/passwd" }] } }));
    expect(text).toContain("→ ../../etc/passwd"); // the raw ref, NOT a joined path
    expect(text).not.toContain("/queue/blobs/..");
    const hidden = render(msg({ payload: { blobs: [{ blob: ".ssh" }] } }));
    expect(hidden).not.toContain("/queue/blobs/.ssh");
  });

  test("text-only messages are untouched by the extension (baseline regression)", () => {
    const render = makeDefaultRender({ blobsDir: "/queue/blobs" });
    expect(render(msg({ payload: "just text" }))).toBe(
      defaultRender(msg({ payload: "just text" })),
    );
  });
});

// A reaction notice (§19.6, FR-164) is the ONE turn that names no reply path at
// all — not even to forbid one (T267): naming a path is asking for an answer, and
// this turn is a notice. `expectsReply: true` is the operator's explicit opt-in and
// puts the turn back on the ordinary contract rails (§10.29: exactly one path).
describe("reaction notices (§19.6, FR-164)", () => {
  const reaction = (overrides: Partial<Signal> = {}): Signal => ({
    ...msg(),
    kind: "reaction",
    replyTo: "orig-1",
    origin: "reaction:ok",
    payload: "[muxeon reaction] 👍 Accepted from shagin on your message orig-1\nAccepted.",
    ...overrides,
  });

  test("the notice render: attribution, the operator's text, and 'no reply expected'", () => {
    const render = makeDefaultRender();
    const text = render(reaction());
    expect(text).toContain("[muxeon] from=researcher id=abc-123 replyTo=orig-1");
    expect(text).toContain("👍 Accepted from shagin");
    expect(text).toContain("no reply is expected");
    // Not one reply path is named — neither the file contract nor the compact one.
    expect(text).not.toContain("reply.md");
    expect(text).not.toContain("message.json");
    expect(text).not.toContain("send(");
  });

  test("the notice shape holds even WITH an exchange context (nothing to answer in)", () => {
    const render = makeDefaultRender();
    const text = render(reaction(), { messageFile: "/x/inbox/abc/message.json" });
    expect(text).not.toContain("/x/inbox/abc/message.json");
    expect(text).toContain("no reply is expected");
  });

  test("expectsReply:true renders the ORDINARY file contract instead", () => {
    const render = makeDefaultRender();
    const text = render(reaction({ expectsReply: true }), {
      messageFile: "/x/inbox/abc/message.json",
    });
    expect(text).toContain("reply contract:");
    expect(text).toContain("/x/inbox/abc/message.json");
    expect(text).not.toContain("no reply is expected");
  });

  test("expectsReply:true with the compact form names `send` and only `send`", () => {
    const render = makeDefaultRender();
    const text = render(reaction({ expectsReply: true }), {
      messageFile: "/x/inbox/abc/message.json",
      replyVia: "mcp",
    });
    expect(text).toContain('send(to="researcher", replyTo="abc-123")');
    expect(text).not.toContain("reply.md");
  });

  test("a plain message is untouched by the reaction branch (baseline regression)", () => {
    const render = makeDefaultRender();
    expect(render(msg())).not.toContain("no reply is expected");
  });
});

// The receipt (§13.7, FR-180): the same notice render, reached by a MESSAGE whose
// sender said no answer is expected. This is the whole feature — between agents
// there was no free "принято", because the contract asks even when the text says
// not to, and the receiver honours the contract, not the text.
describe("message receipts (§13.7, FR-180)", () => {
  const receipt = (overrides: Partial<Signal> = {}): Signal => ({
    ...msg(),
    from: "tl",
    payload: "принято, ветка закрыта",
    expectsReply: false,
    ...overrides,
  });

  test("names no reply path at all — with or without an exchange context", () => {
    const render = makeDefaultRender();
    for (const ctx of [undefined, { messageFile: "/x/inbox/abc/message.json" }]) {
      const text = render(receipt(), ctx);
      expect(text).toContain("[muxeon] from=tl id=abc-123");
      expect(text).toContain("принято, ветка закрыта");
      expect(text).toContain("no reply is expected");
      expect(text).not.toContain("reply.md");
      expect(text).not.toContain("message.json");
      expect(text).not.toContain("send(");
    }
  });

  test("the compact form does not leak in either — a notice has no contract to pick", () => {
    const render = makeDefaultRender();
    const text = render(receipt(), {
      messageFile: "/x/inbox/abc/message.json",
      replyVia: "mcp",
    });
    expect(text).toContain("no reply is expected");
    expect(text).not.toContain("send(");
  });

  test("attachments still render — a receipt may carry a file (§12.5)", () => {
    const render = makeDefaultRender({ blobsDir: "/blobs" });
    const text = render(
      receipt({ payload: { text: "принято", blobs: [{ blob: "b1", name: "log.txt" }] } }),
    );
    expect(text).toContain("[attachment] log.txt → /blobs/b1");
    expect(text).toContain("no reply is expected");
  });

  test("expectsReply:true (or absent) is the ordinary contract — the default is unchanged", () => {
    const render = makeDefaultRender();
    const ctx = { messageFile: "/x/inbox/abc/message.json" };
    expect(render(receipt({ expectsReply: true }), ctx)).toContain("reply contract:");
    expect(render(msg(), ctx)).toContain("reply contract:");
  });
});

// A human quoted an earlier message in the panel (§12.7, FR-178): the envelope
// carries the id, and the render must turn it into something the agent can ACT
// on — while staying silent on the agent-to-agent correlation that uses the very
// same field on every answer in the park (FR-179).
describe("reply reference (§13.7, FR-179)", () => {
  const quoted = (extra: Partial<Message> = {}): Message =>
    msg({ replyTo: "old-1", origin: "webchat", ...extra });

  test("a channel reply names the quoted id AND how to read it (MCP form)", () => {
    const text = makeDefaultRender()(quoted(), {
      messageFile: "/x/inbox/abc/message.json",
      replyVia: "mcp",
    });
    expect(text).toContain("in reply to message old-1");
    expect(text).toContain('get_history(peer="researcher", around="old-1")');
    // the quote itself is NOT pasted in — the agent fetches what it needs
    expect(text).not.toContain("quoted text");
  });

  test("the file contract states the relation without naming a tool it cannot call", () => {
    const text = makeDefaultRender()(quoted(), { messageFile: "/x/inbox/abc/message.json" });
    expect(text).toContain("in reply to message old-1");
    expect(text).not.toContain("get_history");
  });

  test("the reference sits with the header, above the payload", () => {
    const text = makeDefaultRender()(quoted({ payload: "run it again" }), {
      messageFile: "/x/inbox/abc/message.json",
      replyVia: "mcp",
    });
    const lines = text.split("\n");
    expect(lines[0]).toStartWith("[muxeon] from=researcher");
    expect(lines[1]).toContain("in reply to message old-1");
    expect(lines[2]).toBe("run it again");
  });

  test("an AGENT's answer carries replyTo too — and gets no reference line", () => {
    // no `origin`: this is another agent's send(replyTo=…) correlating its answer,
    // and pointing an agent back at the question it just asked is noise per turn
    const text = makeDefaultRender()(msg({ replyTo: "old-1" }), {
      messageFile: "/x/inbox/abc/message.json",
      replyVia: "mcp",
    });
    expect(text).not.toContain("in reply to message");
  });

  test("a message with no reference is untouched", () => {
    expect(makeDefaultRender()(msg({ origin: "webchat" }))).not.toContain("in reply to message");
  });
});

// T294: the file-contract answer path stamps `origin: "exchange"`, so "origin is
// set" was never the test for "a human chose to quote this" — a park of
// file-contract agents would have grown the reference line on every answer.
describe("who counts as having chosen the quote (T294)", () => {
  const render = makeDefaultRender();
  const ctx = { messageFile: "/x/inbox/abc/message.json", replyVia: "mcp" as const };

  test("an agent's file-contract answer gets NO reference line", () => {
    const answer = msg({ replyTo: "old-1", origin: "exchange" });
    expect(render(answer, ctx)).not.toContain("in reply to message");
  });

  test("every human channel does get one", () => {
    for (const origin of ["webchat", "web", "telegram", "slack", "console", "operator-plane"]) {
      expect(render(msg({ replyTo: "old-1", origin }), ctx)).toContain("in reply to message old-1");
    }
  });

  test("machinery does not: raw capture, broadcast copy, federation hop", () => {
    for (const origin of [
      "raw",
      "tmux-fallback",
      "broadcast:backend",
      "fed:hub",
      "outbox:admins",
    ]) {
      expect(render(msg({ replyTo: "old-1", origin }), ctx)).not.toContain("in reply to message");
    }
  });
});
