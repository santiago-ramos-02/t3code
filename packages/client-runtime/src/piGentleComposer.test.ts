import { describe, expect, it } from "vite-plus/test";
import type { PiGentleComposerState, PiGentleSddStatus } from "@t3tools/contracts";

import { gentleComposerAction } from "./piGentleComposer.ts";

const status = (nextRecommended: PiGentleSddStatus["nextRecommended"]): PiGentleSddStatus => ({
  changeName: "checkout-flow",
  artifactStore: "openspec",
  nextRecommended,
  blockedReasons: [],
  dependencies: {
    proposal: "ready",
    specs: "ready",
    design: "ready",
    tasks: "ready",
    apply: "ready",
    verify: "ready",
    archive: "ready",
  },
  actionContext: { mode: "repo-local", allowedEditRoots: ["/repo"] },
  remediationState: { required: true, complete: false, failedEvidenceRevision: "rev-1" },
  taskProgress: { total: 2, completed: 1, pending: 1 },
});

const state = (nextRecommended: PiGentleSddStatus["nextRecommended"]): PiGentleComposerState => ({
  available: true,
  projectInitNeeded: false,
  sddStatus: status(nextRecommended),
});

describe("Gentle composer action", () => {
  it("asks for the goal when there is no SDD change", () => {
    expect(
      gentleComposerAction({
        ...state("sdd-new"),
        sddStatus: { ...status("sdd-new"), changeName: null },
      }),
    ).toEqual({
      kind: "start",
      label: "Ready for a new SDD change",
    });
  });

  it("uses the native next phase without inferring a route from task progress", () => {
    expect(gentleComposerAction(state("verify"))).toEqual({
      kind: "continue",
      label: "Next: verification",
    });
  });

  it("does not present a phase when Gentle needs a change choice or reports blockers", () => {
    expect(gentleComposerAction(state("select-change"))).toEqual({
      kind: "select-change",
      label: "Choose an SDD change",
    });
    expect(gentleComposerAction(state("resolve-blockers"))?.kind).toBe("blocked");
    expect(
      gentleComposerAction({
        ...state("apply"),
        sddStatus: { ...status("apply"), changeName: null },
      })?.kind,
    ).toBe("blocked");
  });

  it("offers setup before a new change and hides it when the command is missing", () => {
    expect(gentleComposerAction({ ...state("sdd-new"), projectInitNeeded: true })).toEqual({
      kind: "setup",
      label: "Set up SDD",
    });
    expect(
      gentleComposerAction({ ...state("sdd-new"), projectInitNeeded: true }, false)?.kind,
    ).toBe("blocked");
  });

  it("gates phases on their own dependency, blockers, and editable scope", () => {
    const blockedApply = {
      ...status("apply"),
      dependencies: { ...status("apply").dependencies, apply: "blocked" as const },
    };
    expect(gentleComposerAction({ ...state("apply"), sddStatus: blockedApply })?.kind).toBe(
      "blocked",
    );
    expect(
      gentleComposerAction({
        ...state("spec"),
        sddStatus: {
          ...status("spec"),
          dependencies: { ...status("spec").dependencies, apply: "blocked" },
        },
      })?.kind,
    ).toBe("continue");
    expect(
      gentleComposerAction({
        ...state("verify"),
        sddStatus: { ...status("verify"), blockedReasons: ["Approval needed"] },
      })?.kind,
    ).toBe("blocked");
    expect(
      gentleComposerAction({
        ...state("verify"),
        sddStatus: {
          ...status("verify"),
          actionContext: { mode: "workspace-planning", allowedEditRoots: [] },
        },
      })?.kind,
    ).toBe("blocked");
    expect(
      gentleComposerAction({
        ...state("remediate"),
        sddStatus: {
          ...status("remediate"),
          remediationState: { required: false, complete: false, failedEvidenceRevision: "" },
        },
      })?.kind,
    ).toBe("blocked");
  });
});
