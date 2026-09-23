import { describe, expect, it } from "vite-plus/test";
import type { PiGentleSddStatus } from "@t3tools/contracts";

import { gentleComposerAction } from "./piGentleComposer.ts";

const status = (nextRecommended: PiGentleSddStatus["nextRecommended"]): PiGentleSddStatus => ({
  changeName: "checkout-flow",
  nextRecommended,
  blockedReasons: [],
  taskProgress: { total: 2, completed: 1, pending: 1 },
});

describe("Gentle composer action", () => {
  it("asks for the goal when there is no SDD change", () => {
    expect(gentleComposerAction({ ...status("sdd-new"), changeName: null })).toEqual({
      kind: "start",
      label: "Start SDD",
      draft: "Use Gentle SDD to ",
    });
  });

  it("uses the native next phase without inferring a route from task progress", () => {
    expect(gentleComposerAction(status("verify"))).toEqual({
      kind: "continue",
      label: "Continue verification",
      draft: 'Continue Gentle SDD change "checkout-flow" with its next permitted phase.',
    });
  });

  it("does not present a phase when Gentle needs a change choice or reports blockers", () => {
    expect(gentleComposerAction(status("select-change"))).toEqual({
      kind: "select-change",
      label: "Choose SDD change",
      draft: "Use Gentle SDD to continue. Help me select an existing change.",
    });
    expect(gentleComposerAction(status("resolve-blockers"))?.kind).toBe("blocked");
    expect(gentleComposerAction({ ...status("apply"), changeName: null })).toBeNull();
  });
});
