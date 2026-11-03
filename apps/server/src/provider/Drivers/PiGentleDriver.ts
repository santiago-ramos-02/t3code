/**
 * PiGentleDriver — upstream's Pi driver plus the fork's Gentle AI session launch, gentle-pi's
 * subagents, todo list and provider limits, claude-bridge cache lifetimes, and gentle-pi's
 * settings. All but the settings go through the PiGentleHooks service, so
 * @t3tools/provider-pi stays upstream's.
 */
import type { ServerProviderUsageLimits } from "@t3tools/contracts";
import type { PiSettings } from "@t3tools/provider-pi/settings";
import type { ProviderDriver, ProviderUsageReaderEnv } from "@t3tools/provider-core/server/driver";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import type { ManagedServerProvider } from "@t3tools/provider-core/server/snapshot";
import { applyUsageLimitsUpdate } from "@t3tools/provider-core/server/usageLimits";
import { PiDriver, type PiDriverEnv } from "@t3tools/provider-pi/server";
import { PiGentleHooks } from "@t3tools/provider-pi/server/gentleHooks";
import type * as SecureRandom from "effect/crypto/SecureRandom";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { HttpClient } from "effect/http";
import * as Ref from "effect/Ref";
import { ChildProcessSpawner } from "effect/process";

import { makePiGentleSession } from "../../gentleAi/GentleAiSessions.ts";
import * as ClaudeCacheLifetime from "../../orchestration-v2/Adapters/ClaudeCacheLifetime.ts";
import { makePiGentle } from "../../orchestration-v2/Adapters/PiGentle.ts";
import { piCallCacheTtlSeconds } from "../../orchestration-v2/Adapters/promptCacheLifetime.ts";
import { makePiGentleSettings } from "../PiGentleSettings.ts";

export type PiGentleDriverEnv = PiDriverEnv | SecureRandom.SecureRandom;

export const PiGentleDriver: ProviderDriver<
  PiSettings,
  PiGentleDriverEnv,
  ProviderUsageReaderEnv<typeof PiDriver>
> = {
  ...PiDriver,
  create: Effect.fn("PiGentleDriver.create")(function* (input) {
    const claudeCacheLifetime = yield* ClaudeCacheLifetime.ClaudeCacheLifetime;
    // Pi's own probe reports no limits, so the instance keeps gentle-pi's and every probe reattaches them.
    const gentleLimits = yield* Ref.make<ServerProviderUsageLimits | undefined>(undefined);
    const instanceSnapshot = yield* Deferred.make<ManagedServerProvider>();
    const onUsageLimits: ManagedServerProvider["applyUsageLimits"] = (update) =>
      Ref.update(gentleLimits, (previous) =>
        applyUsageLimitsUpdate({ previous, update, checkedAt: update.checkedAt }),
      ).pipe(
        Effect.andThen(Deferred.await(instanceSnapshot)),
        Effect.flatMap((snapshot) => snapshot.applyUsageLimits(update)),
      );
    const instance = yield* PiDriver.create(input).pipe(
      Effect.provideService(PiGentleHooks, {
        prepareSession: yield* makePiGentleSession(PiDriver.driverKind),
        callCacheTtlSeconds: (usage, call) =>
          claudeCacheLifetime.latest.pipe(
            Effect.map((claudeCodeTtlSeconds) =>
              piCallCacheTtlSeconds(usage, call, claudeCodeTtlSeconds),
            ),
          ),
        makeGentle: (deps) => makePiGentle(deps, onUsageLimits),
        usageLimits: Ref.get(gentleLimits),
      }),
    );
    yield* Deferred.succeed(instanceSnapshot, instance.snapshot);
    // gentle-pi settings, profiles, and setup, read through its own API.
    const piGentle = yield* makePiGentleSettings({
      environment: yield* mergeProviderInstanceEnvironment(input.environment),
      httpClient: yield* HttpClient.HttpClient,
      piBinaryPath: input.config.binaryPath,
      fileSystem: yield* FileSystem.FileSystem,
      path: yield* Path.Path,
      spawner: yield* ChildProcessSpawner.ChildProcessSpawner,
    });
    return { ...instance, piGentle };
  }),
};
