import { describe, expect, test } from "bun:test";
import { Topology } from "../src/topology";

describe("Topology (undirected graph, §7, §10.2)", () => {
  const topo = new Topology({
    researcher: ["writer", "operator"],
    writer: ["researcher"],
  });

  test("neighbors are symmetric and sorted", () => {
    expect(topo.neighbors("researcher")).toEqual(["operator", "writer"]);
    expect(topo.neighbors("writer")).toEqual(["researcher"]);
    // operator appeared only in researcher's list, yet the edge is mutual:
    expect(topo.neighbors("operator")).toEqual(["researcher"]);
  });

  test("hasEdge is symmetric; non-edges and unknowns are false", () => {
    expect(topo.hasEdge("researcher", "writer")).toBe(true);
    expect(topo.hasEdge("writer", "researcher")).toBe(true);
    expect(topo.hasEdge("writer", "operator")).toBe(false);
    expect(topo.hasEdge("unknown", "writer")).toBe(false);
  });

  test("nodes() includes implicitly-declared neighbors (operators)", () => {
    expect(topo.nodes()).toEqual(["operator", "researcher", "writer"]);
    expect(topo.hasNode("operator")).toBe(true);
    expect(topo.hasNode("ghost")).toBe(false);
  });

  test("canDeliver: an edge is required only when from !== to (§10.2)", () => {
    expect(topo.canDeliver("researcher", "writer")).toBe(true);
    expect(topo.canDeliver("writer", "operator")).toBe(false);
    // self-delivery is allowed without an edge, even for an unknown node:
    expect(topo.canDeliver("writer", "writer")).toBe(true);
    expect(topo.canDeliver("lonely", "lonely")).toBe(true);
  });

  test("self-loops in the declared graph are not edges", () => {
    const t = new Topology({ a: ["a", "b"], b: [] });
    expect(t.neighbors("a")).toEqual(["b"]);
    expect(t.hasEdge("a", "a")).toBe(false);
    expect(t.hasNode("a")).toBe(true);
    expect(t.canDeliver("a", "a")).toBe(true); // still allowed by the self rule
  });

  test("duplicate edge declarations are harmless", () => {
    const t = new Topology({ a: ["b", "b"], b: ["a"] });
    expect(t.neighbors("a")).toEqual(["b"]);
    expect(t.neighbors("b")).toEqual(["a"]);
  });

  test("empty topology", () => {
    const t = new Topology({});
    expect(t.nodes()).toEqual([]);
    expect(t.neighbors("x")).toEqual([]);
    expect(t.hasEdge("x", "y")).toBe(false);
  });
});
