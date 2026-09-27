import { assert, describe, it } from "vite-plus/test";

import {
  agentModels,
  groupPhases,
  readPhase,
  writeOpenCodePhases,
  writePhase,
} from "./GentleAiModelEditor.logic";

describe("groupPhases", () => {
  it("orders known groups like the TUI and keeps unknown groups last", () => {
    const groups = groupPhases([
      { id: "future", label: "Future", group: "later" },
      { id: "odd-worker", label: "ODD Worker", group: "odd" },
      { id: "orchestrator", label: "Orchestrator", group: "orchestrator" },
      { id: "odd-verify", label: "ODD Verify", group: "odd" },
    ]);
    assert.deepStrictEqual(
      groups.map((group) => [group.id, group.label, group.phases.map((phase) => phase.id)]),
      [
        ["orchestrator", "Orchestrator", ["orchestrator"]],
        ["odd", "ODD", ["odd-worker", "odd-verify"]],
        ["later", "later", ["future"]],
      ],
    );
  });
});

describe("phase choices", () => {
  it("stores Codex models and efforts in their separate maps", () => {
    const value = writePhase("codex", {}, "odd-worker", { model: "gpt-6-luna", effort: "high" });
    assert.deepStrictEqual(value, {
      codexPhaseModelAssignments: { "odd-worker": "gpt-6-luna" },
      codexModelAssignments: { "odd-worker": "high" },
    });
    assert.deepStrictEqual(readPhase("codex", value, "odd-worker"), {
      model: "gpt-6-luna",
      effort: "high",
    });
    const cleared = writePhase("codex", value, "odd-worker", { effort: "high" });
    assert.deepStrictEqual(cleared.codexPhaseModelAssignments, {});
  });

  it("drops a Claude phase back to the default when its model is cleared", () => {
    const value = writePhase("claude-code", {}, "odd-worker", { model: "opus", effort: "max" });
    assert.deepStrictEqual(value.claudePhaseAssignments, {
      "odd-worker": { model: "opus", effort: "max" },
    });
    assert.deepStrictEqual(
      writePhase("claude-code", value, "odd-worker", { effort: "max" }).claudePhaseAssignments,
      {},
    );
  });

  it("sets every listed OpenCode phase at once and leaves others alone", () => {
    const model = { providerId: "anthropic", modelId: "opus", effort: "high" };
    const other = { providerId: "openai", modelId: "gpt-6" };
    const value = writeOpenCodePhases(
      { modelAssignments: { review: other } },
      ["odd-worker", "odd-verify"],
      model,
    );
    assert.deepStrictEqual(value.modelAssignments, {
      review: other,
      "odd-worker": model,
      "odd-verify": model,
    });
  });

  it("saves only the fields the edited agent owns", () => {
    assert.deepStrictEqual(
      agentModels("kiro-ide", { kiroModelAssignments: { a: "x" }, modelAssignments: {} }),
      { kiroModelAssignments: { a: "x" } },
    );
  });
});
