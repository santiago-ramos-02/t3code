/**
 * PiGentleDriver — upstream's Pi driver plus what the fork adds to it: Gentle AI's session
 * launch hook, gentle-pi's subagents and todo list, the cache lifetime Claude Code reports for
 * claude-bridge calls, and gentle-pi's settings on the instance. The Pi adapter takes the first
 * three through its PiGentleHooks service, so @t3tools/provider-pi stays upstream's.
 */
import type { PiSettings } from "@t3tools/provider-pi/settings";
import type { ProviderDriver, ProviderUsageReaderEnv } from "@t3tools/provider-core/server/driver";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { PiDriver, type PiDriverEnv } from "@t3tools/provider-pi/server";
import { PiGentleHooks } from "@t3tools/provider-pi/server/gentleHooks";
import type * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { HttpClient } from "effect/http";
import { ChildProcessSpawner } from "effect/process";

import { makePiGentleSession } from "../../gentleAi/GentleAiSessions.ts";
import * as ClaudeCacheLifetime from "../../orchestration-v2/Adapters/ClaudeCacheLifetime.ts";
import { makePiGentle } from "../../orchestration-v2/Adapters/PiGentle.ts";
import { piCallCacheTtlSeconds } from "../../orchestration-v2/Adapters/promptCacheLifetime.ts";
import { makePiGentleSettings } from "../PiGentleSettings.ts";

export type PiGentleDriverEnv = PiDriverEnv | Crypto.Crypto;

export const PiGentleDriver: ProviderDriver<
  PiSettings,
  PiGentleDriverEnv,
  ProviderUsageReaderEnv<typeof PiDriver>
> = {
  ...PiDriver,
  create: (input) =>
    Effect.gen(function* () {
      const claudeCacheLifetime = yield* ClaudeCacheLifetime.ClaudeCacheLifetime;
      const instance = yield* PiDriver.create(input).pipe(
        Effect.provideService(PiGentleHooks, {
          prepareSession: yield* makePiGentleSession(PiDriver.driverKind),
          callCacheTtlSeconds: (usage, call) =>
            claudeCacheLifetime.latest.pipe(
              Effect.map((claudeCodeTtlSeconds) =>
                piCallCacheTtlSeconds(usage, call, claudeCodeTtlSeconds),
              ),
            ),
          makeGentle: makePiGentle,
        }),
      );
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
