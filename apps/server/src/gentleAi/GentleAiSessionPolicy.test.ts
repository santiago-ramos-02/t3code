import { describe, expect, it } from "@effect/vitest";
import {
  GENTLE_AI_OPTION_ID,
  ProviderInstanceId,
  type ModelSelection,
  type OrchestrationV2ProviderCapabilities,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { ProviderAdapterV2 } from "@t3tools/provider-core/server/ProviderAdapter";
import { withGentleAiSessionRestart, withoutGentleAiOff } from "./GentleAiSessionPolicy.ts";

const selection = (gentleAi?: boolean): ModelSelection => ({
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5",
  ...(gentleAi === undefined ? {} : { options: [{ id: GENTLE_AI_OPTION_ID, value: gentleAi }] }),
});

const adapter = {
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
} as unknown as ProviderAdapterV2["Service"];

const plan = (current: ModelSelection, target: ModelSelection) =>
  withGentleAiSessionRestart(adapter).planSelectionTransition({
    current,
    target,
    sessionCapabilities: {} as OrchestrationV2ProviderCapabilities,
  });

describe("withGentleAiSessionRestart", () => {
  it.effect("restarts the session when Gentle AI is turned off or on", () =>
    Effect.gen(function* () {
      expect(yield* plan(selection(true), selection(false))).toEqual({ type: "restart_session" });
      expect(yield* plan(selection(false), selection(true))).toEqual({ type: "restart_session" });
    }),
  );

  it.effect("treats a selection without the option as Gentle AI on", () =>
    Effect.gen(function* () {
      expect(yield* plan(selection(), selection(true))).toEqual({ type: "apply_on_next_turn" });
      expect(yield* plan(selection(), selection(false))).toEqual({ type: "restart_session" });
    }),
  );

  it.effect("refuses Gentle AI off where the runtime cannot honor it", () =>
    Effect.gen(function* () {
      const shared = withoutGentleAiOff(adapter, "Shared server.");
      const transition = (target: ModelSelection) =>
        shared.planSelectionTransition({
          current: selection(true),
          target,
          sessionCapabilities: {} as OrchestrationV2ProviderCapabilities,
        });
      expect(yield* transition(selection(false))).toEqual({
        type: "reject",
        reason: "Shared server.",
      });
      expect(yield* transition(selection(true))).toEqual({ type: "apply_on_next_turn" });
      // The registry's restart rule keeps the refusal.
      expect(
        yield* withGentleAiSessionRestart(shared).planSelectionTransition({
          current: selection(true),
          target: selection(false),
          sessionCapabilities: {} as OrchestrationV2ProviderCapabilities,
        }),
      ).toEqual({ type: "reject", reason: "Shared server." });
    }),
  );

  it.effect("leaves other selection changes to the provider", () =>
    Effect.gen(function* () {
      expect(yield* plan(selection(false), { ...selection(false), model: "gpt-5-mini" })).toEqual({
        type: "apply_on_next_turn",
      });
    }),
  );
});
