import type { PiSettings } from "@t3tools/contracts";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as ServerConfig from "../../config.ts";
import { mergeProviderInstanceEnvironment } from "../../provider/ProviderInstanceEnvironment.ts";
import * as IdAllocator from "../IdAllocator.ts";
import {
  ProviderAdapterDriverCreateError,
  type ProviderAdapterDriverCreateInput,
} from "../ProviderAdapterDriver.ts";
import * as ProviderContinuationRequests from "../ProviderContinuationRequests.ts";
import { makePiAdapterV2, PI_PROVIDER, type PiAdapterV2Options } from "./PiAdapterV2.ts";

/**
 * Upstream's `PiAdapterV2Driver.create`, plus what the fork's Pi driver adds: Gentle AI's session
 * launch hook, and continuation runs for gentle-pi's background wake-ups (see PiGentle). Kept
 * here so PiAdapterV2.ts keeps upstream's driver as is.
 */
export const createPiAdapterV2 = Effect.fn("PiAdapterV2Gentle.create")(
  function* (
    input: ProviderAdapterDriverCreateInput<PiSettings>,
    hooks: Pick<PiAdapterV2Options, "prepareSession">,
  ) {
    const hostEnvironment = yield* HostProcessEnvironment;
    return makePiAdapterV2({
      instanceId: input.instanceId,
      settings: { ...input.config, enabled: input.enabled },
      environment: mergeProviderInstanceEnvironment(input.environment, hostEnvironment),
      spawner: yield* ChildProcessSpawner.ChildProcessSpawner,
      fileSystem: yield* FileSystem.FileSystem,
      idAllocator: yield* IdAllocator.IdAllocatorV2,
      serverConfig: yield* ServerConfig.ServerConfig,
      continuationRequests: yield* ProviderContinuationRequests.ProviderContinuationRequests,
      ...hooks,
    });
  },
  (effect, input) =>
    effect.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterDriverCreateError({
            driver: PI_PROVIDER,
            instanceId: input.instanceId,
            detail: "Failed to create Pi adapter.",
            cause,
          }),
      ),
    ),
);
