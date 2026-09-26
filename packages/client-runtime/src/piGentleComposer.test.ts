import { describe, expect, it } from "vite-plus/test";
import {
  ProviderInstanceId,
  type ModelSelection,
  type PiGentleSddChange,
  type ServerProviderModel,
} from "@t3tools/contracts";

import {
  gentleProfileModelChange,
  gentleSddChangeStep,
  gentleSddTaskSummary,
} from "./piGentleComposer.ts";

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

describe("Gentle profile model change", () => {
  const opus: ServerProviderModel = {
    slug: "anthropic/claude-opus-5-5",
    name: "Claude Opus 5.5",
    isCustom: false,
    capabilities: {
      optionDescriptors: [
        {
          id: "thinkingLevel",
          label: "Thinking level",
          type: "select",
          options: [
            { id: "medium", label: "Medium", isDefault: true },
            { id: "high", label: "High" },
          ],
        },
      ],
    },
  };
  const current: ModelSelection = {
    instanceId: ProviderInstanceId.make("pi"),
    model: "openai-codex/gpt-6-luna",
    options: [
      { id: "thinkingLevel", value: "low" },
      { id: "gentleAi", value: true },
    ],
  };

  it("moves the thread to the orchestrator and its thinking level, keeping thread options", () => {
    expect(
      gentleProfileModelChange(
        current,
        { name: "deep", orchestrator: { model: opus.slug, thinking: "high" } },
        [opus],
      ),
    ).toEqual({
      kind: "switch",
      selection: {
        instanceId: current.instanceId,
        model: opus.slug,
        options: [
          { id: "gentleAi", value: true },
          { id: "thinkingLevel", value: "high" },
        ],
      },
      label: "Claude Opus 5.5 · High",
    });
  });

  it("uses the model's default thinking when the profile names a level it lacks", () => {
    const change = gentleProfileModelChange(
      current,
      { name: "deep", orchestrator: { model: opus.slug, thinking: "max" } },
      [opus],
    );
    expect(change.kind === "switch" && change.selection.options).toEqual([
      { id: "gentleAi", value: true },
    ]);
  });

  it("keeps the model without an orchestrator and reports one Pi does not list", () => {
    expect(gentleProfileModelChange(current, { name: "plain" }, [opus])).toEqual({ kind: "keep" });
    expect(
      gentleProfileModelChange(
        current,
        { name: "gone", orchestrator: { model: "anthropic/retired" } },
        [opus],
      ),
    ).toEqual({ kind: "unavailable", model: "anthropic/retired" });
  });
});
