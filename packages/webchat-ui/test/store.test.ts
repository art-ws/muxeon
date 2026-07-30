// Panel state logic (T49, §12.7) — the pure reducer behind the React shell:
// WS events, history paging, unread badges, outgoing lifecycle. DOM-free.

import { describe, expect, test } from "bun:test";
import {
  type PanelState,
  applyEvent,
  applyHistoryPage,
  applyOutgoing,
  applyPeers,
  initialState,
  selectPeer,
  threadOf,
} from "../src/store";
import { type ChatRecord, type PeerInfo, payloadParts } from "../src/types";

const isOperator = (name: string) => name === "operator-web" || name === "(me)";

function record(id: string, overrides: Partial<ChatRecord> = {}): ChatRecord {
  return {
    id,
    from: "researcher",
    to: "operator-web",
    kind: "message",
    ts: 1000,
    payload: `text of ${id}`,
    ...overrides,
  };
}

const peer = (name: string, overrides: Partial<PeerInfo> = {}): PeerInfo => ({
  name,
  status: "idle",
  queueDepth: 0,
  unread: 0,
  ...overrides,
});

function withPeers(...names: string[]): PanelState {
  return applyPeers(
    initialState,
    names.map((name) => peer(name)),
  );
}

describe("history-cleared events (FR-84)", () => {
  test("empties the peer's thread and zeroes its badge in every tab", () => {
    let state = applyEvent(initialState, { type: "message", record: record("h-1") }, isOperator);
    state = applyEvent(state, { type: "history-cleared", peer: "researcher" }, isOperator);
    expect(threadOf(state, "researcher")).toEqual({ records: [], loaded: true });
  });
});

describe("message events (§12.4)", () => {
  test("an inbound message lands in the sender's thread and bumps unread when unselected", () => {
    const state = applyEvent(
      withPeers("researcher"),
      { type: "message", record: record("m-1") },
      isOperator,
    );
    expect(threadOf(state, "researcher").records.map((r) => r.id)).toEqual(["m-1"]);
    expect(state.peers[0]?.unread).toBe(1);
  });

  test("no unread bump while the chat is open; selecting clears the badge", () => {
    let state = selectPeer(
      applyPeers(initialState, [peer("researcher", { unread: 3 })]),
      "researcher",
    );
    expect(state.peers[0]?.unread).toBe(0); // select clears
    state = applyEvent(state, { type: "message", record: record("m-1") }, isOperator);
    expect(state.peers[0]?.unread).toBe(0); // open chat — no bump
  });

  test("busySince (FR-63): stamped on the busy edge, kept while busy, dropped on exit", () => {
    let state = withPeers("researcher");
    state = applyEvent(
      state,
      { type: "status", peer: "researcher", status: "busy", queueDepth: 1 },
      isOperator,
      1000,
    );
    expect(state.peers[0]?.busySince).toBe(1000);
    // still busy later — the stamp must NOT move (the timer keeps counting)
    state = applyEvent(
      state,
      { type: "status", peer: "researcher", status: "busy", queueDepth: 2 },
      isOperator,
      5000,
    );
    expect(state.peers[0]?.busySince).toBe(1000);
    // leaving busy drops the stamp — the header timer disappears
    state = applyEvent(
      state,
      { type: "status", peer: "researcher", status: "idle", queueDepth: 0 },
      isOperator,
      9000,
    );
    expect(state.peers[0]?.busySince).toBeUndefined();
  });

  test("busySince (FR-63): a peers refetch keeps the stamp of a still-busy peer", () => {
    let state = applyPeers(initialState, [peer("researcher", { status: "busy" })], 1000);
    expect(state.peers[0]?.busySince).toBe(1000);
    state = applyPeers(state, [peer("researcher", { status: "busy" })], 7000);
    expect(state.peers[0]?.busySince).toBe(1000); // same busy episode
    state = applyPeers(state, [peer("researcher", { status: "idle" })], 9000);
    expect(state.peers[0]?.busySince).toBeUndefined();
  });

  test("deselect (home/transport route, FR-60) — unread counts again", () => {
    let state = selectPeer(withPeers("researcher"), "researcher");
    state = selectPeer(state, undefined); // navigated away from the chat
    expect(state.selected).toBeUndefined();
    state = applyEvent(state, { type: "message", record: record("m-1") }, isOperator);
    expect(state.peers[0]?.unread).toBe(1); // no chat open — the badge bumps
  });

  test("an outgoing message threads under the RECIPIENT; the WS echo dedups", () => {
    const mine = record("out-1", { from: "(me)", to: "researcher" });
    let state = applyOutgoing(withPeers("researcher"), mine);
    expect(state.phases["out-1"]).toBe("queued");
    state = applyEvent(
      state,
      { type: "message", record: { ...mine, from: "operator-web" } },
      isOperator,
    );
    expect(threadOf(state, "researcher").records).toHaveLength(1); // §10.9-style dedup by id
  });
});

describe("history paging (§12.4)", () => {
  test("an older page prepends, keeps the cursor, dedups against live pushes", () => {
    let state = applyEvent(
      withPeers("researcher"),
      { type: "message", record: record("m-3") },
      isOperator,
    );
    state = applyHistoryPage(state, "researcher", {
      records: [record("m-1"), record("m-2"), record("m-3")],
      nextBefore: "m-1",
    });
    const thread = threadOf(state, "researcher");
    expect(thread.records.map((r) => r.id)).toEqual(["m-1", "m-2", "m-3"]);
    expect(thread.nextBefore).toBe("m-1");
    expect(thread.loaded).toBe(true);
  });

  test("the last page leaves no cursor — 'load older' disappears", () => {
    const state = applyHistoryPage(initialState, "researcher", { records: [record("m-0")] });
    expect(threadOf(state, "researcher").nextBefore).toBeUndefined();
  });
});

describe("dynamics events (§12.7)", () => {
  test("status events update the peer row in place", () => {
    const state = applyEvent(
      withPeers("researcher", "writer"),
      { type: "status", peer: "researcher", status: "busy", queueDepth: 2 },
      isOperator,
    );
    expect(state.peers[0]).toMatchObject({ status: "busy", queueDepth: 2 });
    expect(state.peers[1]).toMatchObject({ status: "idle" });
  });

  test("ack and queue-progress drive the outgoing lifecycle ticks", () => {
    let state = applyEvent(
      initialState,
      { type: "ack", id: "out-1", to: "researcher" },
      isOperator,
    );
    expect(state.phases["out-1"]).toBe("queued");
    for (const phase of ["pending", "cur", "done"] as const) {
      state = applyEvent(
        state,
        { type: "queue-progress", id: "out-1", to: "researcher", phase },
        isOperator,
      );
      expect(state.phases["out-1"]).toBe(phase);
    }
  });
});

describe("payload parts (§5.3 convention)", () => {
  test("string, {text, blobs} and blobs-only payloads normalize", () => {
    expect(payloadParts("plain")).toEqual({ text: "plain", blobs: [] });
    expect(payloadParts({ text: "t", blobs: [{ blob: "b-1" }] })).toEqual({
      text: "t",
      blobs: [{ blob: "b-1" }],
    });
    expect(payloadParts({ blobs: [{ blob: "b-2" }] }).text).toBeUndefined();
  });
});

describe("pause in the status push (§16.6, FR-120)", () => {
  test("the flag lands on the peer and is orthogonal to the status", () => {
    let state = withPeers("researcher");
    state = applyEvent(
      state,
      { type: "status", peer: "researcher", status: "busy", queueDepth: 1, paused: true },
      isOperator,
      1000,
    );
    expect(state.peers[0]?.paused).toBe(true);
    expect(state.peers[0]?.status).toBe("busy"); // a paused agent can still be busy
    expect(state.peers[0]?.busySince).toBe(1000); // the busy timer is unaffected
  });

  test("a resume clears it, and an older server (no field) normalizes to false", () => {
    let state = withPeers("researcher");
    state = applyEvent(
      state,
      { type: "status", peer: "researcher", status: "idle", queueDepth: 0, paused: true },
      isOperator,
    );
    state = applyEvent(
      state,
      { type: "status", peer: "researcher", status: "idle", queueDepth: 0, paused: false },
      isOperator,
    );
    expect(state.peers[0]?.paused).toBe(false);
    state = applyEvent(
      state,
      { type: "status", peer: "researcher", status: "idle", queueDepth: 0 },
      isOperator,
    );
    expect(state.peers[0]?.paused).toBe(false);
  });

  test("only the named peer is touched", () => {
    let state = withPeers("researcher", "writer");
    state = applyEvent(
      state,
      { type: "status", peer: "writer", status: "idle", queueDepth: 0, paused: true },
      isOperator,
    );
    expect(state.peers.map((p) => [p.name, p.paused ?? false])).toEqual([
      ["researcher", false],
      ["writer", true],
    ]);
  });
});
