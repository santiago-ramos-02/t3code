import { describe, expect, it } from "vite-plus/test";
import {
  ProviderInstanceId,
  type ModelSelection,
  type ServerProviderModel,
} from "@t3tools/contracts";

import { gentleProfileModelChange, resourcesForGentle } from "./piGentleComposer.ts";

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

describe("Pi resources with Gentle AI off", () => {
  const commands = [
    { name: "review" },
    { name: "gentle:status", package: "gentle-pi" },
    { name: "gentle-sdd-new", package: "gentle-ai" },
    { name: "mem-search", package: "gentle-engram" },
    { name: "web-search", package: "pi-web-access" },
  ];

  it("offers everything while Gentle AI is on", () => {
    expect(resourcesForGentle(commands, true)).toEqual(commands);
  });

  it("drops only what Gentle AI's packages provide once it is off", () => {
    expect(resourcesForGentle(commands, false).map((command) => command.name)).toEqual([
      "review",
      "web-search",
    ]);
  });
});
