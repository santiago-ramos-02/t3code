import { ProviderSetupError, type ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import type {
  PiGentleAction,
  PiGentleInstance,
  PiGentleSettingsError,
} from "./PiGentleSettings.ts";
import type * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";

/**
 * Runs one gentle-pi operation on a Pi provider instance, for its RPC handlers. An instance that
 * is not a Pi one, or a failed operation, becomes a setup error naming the operation.
 */
export const runPiGentle = <A>(
  registry: ProviderInstanceRegistry.ProviderInstanceRegistry["Service"],
  instanceId: ProviderInstanceId,
  operation: string,
  run: (gentle: PiGentleInstance) => Effect.Effect<A, PiGentleSettingsError>,
) =>
  Effect.gen(function* () {
    const gentle = (yield* registry.getInstance(instanceId))?.piGentle;
    if (gentle === undefined) {
      return yield* new ProviderSetupError({
        instanceId,
        operation,
        detail: "This provider is not an available Pi instance.",
      });
    }
    return yield* run(gentle).pipe(
      Effect.mapError(
        (cause) => new ProviderSetupError({ instanceId, operation, detail: cause.message }),
      ),
    );
  });

/**
 * Runs a gentle-pi settings action. An update first closes the instance's Pi sessions: each one
 * keeps Gentle AI's files open, which Windows will not let `pi update` replace, and each would
 * keep running the old code. They reopen on their next turn. While a Pi thread is still working,
 * the update fails instead of stopping that work.
 */
export const runPiGentleAction = (
  registry: ProviderInstanceRegistry.ProviderInstanceRegistry["Service"],
  sessions: ProviderSessionManager.ProviderSessionManagerV2["Service"],
  instanceId: ProviderInstanceId,
  action: PiGentleAction,
) =>
  Effect.gen(function* () {
    const operation = "pi-gentle-action";
    if (action.type === "update") {
      const closed = yield* sessions
        .closeIdleInstance({ instanceId, detail: "Gentle AI is updating." })
        .pipe(
          Effect.mapError(
            () =>
              new ProviderSetupError({
                instanceId,
                operation,
                detail: "Could not stop Pi before updating Gentle AI.",
              }),
          ),
        );
      if (closed === "busy") {
        return yield* new ProviderSetupError({
          instanceId,
          operation,
          detail: "Pi is still working in a thread. Update Gentle AI once it finishes.",
        });
      }
    }
    return yield* runPiGentle(registry, instanceId, operation, (gentle) => gentle.action(action));
  });
