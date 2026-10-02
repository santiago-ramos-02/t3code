import { gentleAiEnabled, ProviderSetupError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import {
  ProviderAdapterOpenSessionError,
  type ProviderAdapterV2Shape,
} from "../orchestration-v2/ProviderAdapter.ts";

/**
 * For a runtime that cannot start without gentle-ai's footprint, such as a server shared by every
 * thread: turning Gentle AI off is refused with the reason instead of silently keeping it on.
 */
export const withoutGentleAiOff = (
  adapter: ProviderAdapterV2Shape,
  reason: string,
): ProviderAdapterV2Shape => ({
  ...adapter,
  planSelectionTransition: (input) =>
    gentleAiEnabled(input.target.options)
      ? adapter.planSelectionTransition(input)
      : Effect.succeed({ type: "reject", reason }),
  openSession: (input) =>
    gentleAiEnabled(input.modelSelection.options)
      ? adapter.openSession(input)
      : Effect.fail(
          new ProviderAdapterOpenSessionError({
            driver: adapter.driver,
            providerSessionId: input.providerSessionId,
            cause: new ProviderSetupError({
              instanceId: adapter.instanceId,
              operation: "session",
              detail: reason,
            }),
          }),
        ),
});

/**
 * Every adapter decides Gentle AI when its process starts: the agent's home, environment, or
 * settings source changes with it. Turning Gentle AI off or on for a thread therefore restarts
 * the provider session, unless the provider refuses the change; any other selection change stays
 * the provider's call.
 */
export const withGentleAiSessionRestart = (
  adapter: ProviderAdapterV2Shape,
): ProviderAdapterV2Shape => ({
  ...adapter,
  planSelectionTransition: (input) =>
    adapter
      .planSelectionTransition(input)
      .pipe(
        Effect.map((plan) =>
          plan.type === "reject" ||
          gentleAiEnabled(input.current.options) === gentleAiEnabled(input.target.options)
            ? plan
            : { type: "restart_session" as const },
        ),
      ),
});
