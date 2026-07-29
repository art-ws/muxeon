import { describe, expect, test } from "bun:test";
import { buildBroadcastResolver } from "../src/broadcast";

// Member resolution for group/tag broadcast targets (§15.4, FR-110): groups are
// hierarchical (a group + every descendant group), tags are flat carriers.
describe("buildBroadcastResolver (§15.4)", () => {
  const groups = [{ name: "eng" }, { name: "devs", parent: "eng" }, { name: "qa", parent: "eng" }];
  const agents = [
    { name: "lead", group: "eng", tags: ["it"] },
    { name: "dev1", group: "devs", tags: ["it", "backend"] },
    { name: "dev2", group: "devs" },
    { name: "tester", group: "qa", tags: ["backend"] },
    { name: "loner", tags: ["it"] }, // no group
  ];
  const resolve = buildBroadcastResolver(groups, agents);

  test("a leaf group resolves to its direct members", () => {
    expect(resolve("devs")).toEqual({ kind: "group", members: ["dev1", "dev2"] });
  });

  test("a parent group resolves hierarchically (itself + all descendants)", () => {
    expect(resolve("eng")).toEqual({
      kind: "group",
      members: ["lead", "dev1", "dev2", "tester"],
    });
  });

  test("a tag resolves to every carrier, across groups and groupless agents", () => {
    expect(resolve("it")).toEqual({ kind: "tag", members: ["lead", "dev1", "loner"] });
    expect(resolve("backend")).toEqual({ kind: "tag", members: ["dev1", "tester"] });
  });

  test("an empty declared group resolves to no members (valid, not null)", () => {
    const r = buildBroadcastResolver([{ name: "empty" }], []);
    expect(r("empty")).toEqual({ kind: "group", members: [] });
  });

  test("a normal agent / operator / unknown name resolves to null", () => {
    expect(resolve("lead")).toBeNull();
    expect(resolve("operator")).toBeNull();
    expect(resolve("ghost")).toBeNull();
  });
});
