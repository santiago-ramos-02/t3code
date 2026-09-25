import { describe, expect, it } from "vite-plus/test";
import type { PiGentleSddChange } from "@t3tools/contracts";

import { gentleSddChangeStep, gentleSddTaskSummary } from "./piGentleComposer.ts";

const change = (
  nextRecommended: PiGentleSddChange["nextRecommended"],
  overrides: Partial<PiGentleSddChange> = {},
): PiGentleSddChange => ({
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
  ...overrides,
});

describe("Gentle SDD change step", () => {
  it("offers the native next phase with an explicit SDD prompt for that change", () => {
    expect(gentleSddChangeStep(change("apply"))).toEqual({
      kind: "ready",
      label: "Implement",
      prompt:
        "SDD checkout-flow: run the apply phase. Continue the SDD workflow for the OpenSpec change `checkout-flow`.",
    });
    expect(gentleSddChangeStep(change("spec"))).toMatchObject({
      kind: "ready",
      label: "Write specs",
    });
  });

  it("gates a phase on its own dependency, reported blockers, and editable scope", () => {
    const blockedApply = change("apply", {
      dependencies: { ...change("apply").dependencies, apply: "blocked" },
    });
    expect(gentleSddChangeStep(blockedApply)).toMatchObject({
      kind: "blocked",
      reason: "Waiting for an earlier phase.",
    });
    expect(
      gentleSddChangeStep(change("verify", { blockedReasons: ["Tests are failing."] })),
    ).toMatchObject({ kind: "blocked", reason: "Tests are failing." });
    expect(
      gentleSddChangeStep(
        change("apply", { actionContext: { mode: "repo-local", allowedEditRoots: [] } }),
      ).kind,
    ).toBe("blocked");
    expect(gentleSddChangeStep(change("resolve-blockers")).kind).toBe("blocked");
  });

  it("offers remediation only while a failed verification awaits a fix", () => {
    expect(gentleSddChangeStep(change("remediate")).kind).toBe("ready");
    expect(
      gentleSddChangeStep(
        change("remediate", {
          remediationState: { required: true, complete: true, failedEvidenceRevision: "rev-1" },
        }),
      ).kind,
    ).toBe("blocked");
  });

  it("treats archived changes as done and summarizes task progress", () => {
    expect(gentleSddChangeStep(change("archived"))).toEqual({ kind: "done", label: "Archived" });
    expect(gentleSddTaskSummary(change("apply"))).toBe("1 of 2 tasks");
    expect(
      gentleSddTaskSummary(
        change("spec", { taskProgress: { total: 0, completed: 0, pending: 0 } }),
      ),
    ).toBeNull();
  });
});
