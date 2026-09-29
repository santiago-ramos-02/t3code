import { assert, describe, it } from "vite-plus/test";

import {
  claudeSlotModelOptions,
  profilePhaseModels,
  withPhaseModels,
  withSlotModel,
  withSlotUse,
} from "./GentleAiClaudeProfiles.logic";

const base = { name: "Dynamic", slots: {} };

describe("Claude Code profiles", () => {
  it("offers the proxy's models to slots, by the ID Claude Code sends", () => {
    const options = claudeSlotModelOptions({
      agent: "claude-code",
      presets: [],
      currentPreset: null,
      phases: [],
      current: {},
      options: {
        claude: {
          models: [
            { id: "opus", label: "opus", efforts: [] },
            { id: "custom:claude-fable-5-dd-anul-6-tpg", label: "GPT 6.0 Luna", efforts: [] },
          ],
        },
      },
    });
    assert.deepStrictEqual(options, [
      { id: "claude-fable-5-dd-anul-6-tpg", label: "GPT 6.0 Luna" },
    ]);
    assert.deepStrictEqual(claudeSlotModelOptions(null), []);
  });

  it("keeps a slot's note when its model changes and drops it when cleared", () => {
    let profile = withSlotModel(base, "haiku", { id: "luna", label: "Luna" });
    profile = withSlotUse(profile, "haiku", "bounded | tasks");
    assert.deepStrictEqual(profile.slots.haiku, {
      model: "luna",
      label: "Luna",
      useFor: "bounded   tasks",
    });
    profile = withSlotModel(profile, "haiku", { id: "muse", label: "Muse" });
    assert.strictEqual(profile.slots.haiku?.useFor, "bounded   tasks");
    assert.deepStrictEqual(withSlotUse(profile, "haiku", " ").slots.haiku, {
      model: "muse",
      label: "Muse",
    });
    assert.deepStrictEqual(withSlotModel(profile, "haiku", null).slots, {});
  });

  it("pins phases only while some phase has a model", () => {
    const pinned = withPhaseModels(base, {
      claudePhaseAssignments: { "odd-worker": { model: "sonnet" } },
    });
    assert.deepStrictEqual(profilePhaseModels(pinned), {
      claudePhaseAssignments: { "odd-worker": { model: "sonnet" } },
    });
    assert.notProperty(withPhaseModels(pinned, { claudePhaseAssignments: {} }), "phases");
    assert.notProperty(withPhaseModels(pinned, null), "phases");
  });
});
