import { describe, expect, test } from "bun:test";
import { buildBroadcastResolver } from "../src/broadcast";
import { intersectSelectors } from "../src/intersect";

// Selector intersection for operator slash-commands (§15.8, FR-115, §10.18):
// each selector (group/tag/agent) resolves to an agent set; the target is the
// INTERSECTION of those sets. Distinct from broadcast (§15.4, union).
describe("intersectSelectors (§15.8)", () => {
  const groups = [{ name: "eng" }, { name: "devs", parent: "eng" }, { name: "qa", parent: "eng" }];
  const agents = [
    { name: "lead", group: "eng", tags: ["it"] },
    { name: "dev1", group: "devs", tags: ["it", "backend"] },
    { name: "dev2", group: "devs", tags: ["backend"] },
    { name: "tester", group: "qa", tags: ["backend"] },
    { name: "loner", tags: ["it"] }, // no group
  ];
  const resolve = buildBroadcastResolver(groups, agents);
  const agentNames = new Set(agents.map((a) => a.name));
  const isAgent = (n: string): boolean => agentNames.has(n);
  const run = (selectors: string[]) => intersectSelectors(selectors, resolve, isAgent);

  test("group ∩ tag keeps only agents in BOTH", () => {
    // eng = {lead,dev1,dev2,tester}; backend = {dev1,dev2,tester} → ∩ = {dev1,dev2,tester}
    expect(run(["eng", "backend"])).toEqual({ agents: ["dev1", "dev2", "tester"], unknown: [] });
  });

  test("narrowing a subtree by a tag", () => {
    // devs = {dev1,dev2}; it = {lead,dev1,loner} → ∩ = {dev1}
    expect(run(["devs", "it"])).toEqual({ agents: ["dev1"], unknown: [] });
  });

  test("a single selector = its whole set (∩ of one set)", () => {
    expect(run(["devs"])).toEqual({ agents: ["dev1", "dev2"], unknown: [] });
    expect(run(["backend"])).toEqual({ agents: ["dev1", "dev2", "tester"], unknown: [] });
  });

  test("a plain agent selector is a singleton; agent ∩ group narrows to that agent if a member", () => {
    expect(run(["dev1", "devs"])).toEqual({ agents: ["dev1"], unknown: [] });
    // agent not in the group → empty intersection (valid, not an error)
    expect(run(["lead", "devs"])).toEqual({ agents: [], unknown: [] });
  });

  test("order follows the FIRST selector, deduped", () => {
    // first selector eng gives order lead,dev1,dev2,tester; ∩ backend keeps dev1,dev2,tester
    expect(run(["eng", "backend"]).agents).toEqual(["dev1", "dev2", "tester"]);
    // swapping selectors changes the order to backend's carrier order
    expect(run(["backend", "eng"]).agents).toEqual(["dev1", "dev2", "tester"]);
  });

  test("disjoint selectors → empty intersection (not an error)", () => {
    // it = {lead,dev1,loner}; qa = {tester} → ∩ = {}
    expect(run(["it", "qa"])).toEqual({ agents: [], unknown: [] });
  });

  test("empty declared group makes the intersection empty", () => {
    const r = buildBroadcastResolver([{ name: "empty" }, ...groups], agents);
    expect(intersectSelectors(["empty", "eng"], r, isAgent).agents).toEqual([]);
  });

  test("an unknown selector is reported (caller rejects the whole request)", () => {
    const res = run(["devs", "nope"]);
    expect(res.unknown).toEqual(["nope"]);
    // members present in the unknown selector's (empty) set → empty agents
    expect(res.agents).toEqual([]);
  });

  test("duplicate selectors are idempotent", () => {
    expect(run(["backend", "backend"]).agents).toEqual(["dev1", "dev2", "tester"]);
  });

  test("no selectors → empty (caller treats empty list as INVALID_ARGS)", () => {
    expect(run([])).toEqual({ agents: [], unknown: [] });
  });
});
