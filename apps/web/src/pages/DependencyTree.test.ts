import { describe, expect, it } from "vitest";
import type { TreeNode } from "../types.js";
import { intoWaves } from "./DependencyTree.js";

function node(number: number, blockedBy: Array<{ number: number; open: boolean; inTree?: boolean }>): TreeNode {
  return {
    id: `n${number}`,
    number,
    title: `task ${number}`,
    state: null,
    open: true,
    htmlUrl: "",
    repo: "acme/app",
    crossRepo: false,
    assignees: [],
    blockedBy: blockedBy.map((b) => ({
      id: `n${b.number}`,
      number: b.number,
      title: "",
      state: null,
      open: b.open,
      htmlUrl: "",
      repo: "acme/app",
      inTree: b.inTree ?? true,
    })),
    blocks: [],
    waiting: blockedBy.some((b) => b.open),
    agentHalted: false,
    startStatus: "none",
    approvable: false,
  };
}

describe("intoWaves", () => {
  it("layers a chain into consecutive waves", () => {
    const waves = intoWaves([node(1, []), node(2, [{ number: 1, open: true }]), node(3, [{ number: 2, open: true }])]);
    expect(waves.map((w) => w.map((n) => n.number))).toEqual([[1], [2], [3]]);
  });

  it("a closed blocker no longer holds its dependant back", () => {
    const waves = intoWaves([node(1, []), node(2, [{ number: 1, open: false }])]);
    expect(waves.map((w) => w.map((n) => n.number))).toEqual([[1, 2]]);
  });

  it("out-of-tree blockers do not affect layering; cycles land together at the end", () => {
    const waves = intoWaves([
      node(1, [{ number: 99, open: true, inTree: false }]),
      node(2, [{ number: 3, open: true }]),
      node(3, [{ number: 2, open: true }]),
    ]);
    expect(waves.map((w) => w.map((n) => n.number))).toEqual([[1], [2, 3]]);
  });
});
