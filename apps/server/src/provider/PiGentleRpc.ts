import { ProviderSetupError, type ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { PiGentleInstance, PiGentleSettingsError } from "./PiGentleSettings.ts";
import type * as ProviderInstanceRegistry from "./Services/ProviderInstanceRegistry.ts";

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
