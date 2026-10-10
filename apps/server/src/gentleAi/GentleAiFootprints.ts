/**
 * GentleAiFootprints — what gentle-ai added to each agent, asked from gentle-ai itself.
 *
 * A thread with Gentle AI off runs its agent on a plain mirror of the agent's config. With a
 * gentle-ai that answers `api footprint`, the mirror follows gentle-ai's own uninstall: the paths
 * it would remove and the shared files it would rewrite. Otherwise callers fall back to the
 * built-in lists in GentleAiFootprint.ts.
 *
 * @module gentleAi/GentleAiFootprints
 */
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { ServerSettingsService } from "../serverSettings.ts";
import { runGentleAiApi } from "./GentleAiApi.ts";
import { resolveGentleAiBinary } from "./GentleAiBinary.ts";
import { footprintKey, type GentleAiPlainFootprint } from "./PlainFootprint.ts";

const FootprintResult = Schema.Struct({
  removed: Schema.Array(Schema.String),
  rewritten: Schema.Array(Schema.Struct({ path: Schema.String, content: Schema.String })),
  unsimulated: Schema.Array(Schema.String),
});
const decodeFootprint = Schema.decodeUnknownEffect(FootprintResult);

export class GentleAiFootprints extends Context.Service<
  GentleAiFootprints,
  {
    /**
     * What gentle-ai added to these agents (gentle-ai's ids), merged; "set-up" means every agent
     * it set up. Agents it did not set up add nothing. Null when this gentle-ai cannot answer
     * completely, so the caller uses the built-in lists instead.
     */
    readonly forAgents: (
      agents: ReadonlyArray<string> | "set-up",
    ) => Effect.Effect<GentleAiPlainFootprint | null>;
  }
>()("t3/gentleAi/GentleAiFootprints") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const settingsService = yield* ServerSettingsService;
  const platform = yield* HostProcess.Platform;
  const environment = yield* HostProcess.Environment;
  const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(HostProcess.Platform, platform),
      Effect.provideService(HostProcess.Environment, environment),
    );

  const forAgents = (agents: ReadonlyArray<string> | "set-up") =>
    Effect.gen(function* () {
      const binaryPath = yield* settingsService.getSettings.pipe(
        Effect.map((settings) => settings.gentleAiBinaryPath),
        Effect.orElseSucceed(() => ""),
        Effect.flatMap(resolveGentleAiBinary),
      );
      if (binaryPath === null) return null;
      // gentle-ai skips agents it did not set up, and simulates the rest together.
      const footprint = yield* runGentleAiApi({
        binaryPath,
        method: "footprint",
        params: agents === "set-up" ? {} : { agents },
        environment,
        timeout: "30 seconds",
      }).pipe(Effect.flatMap(decodeFootprint));
      // A path the uninstall could not simulate (outside the home) would be left in the mirror.
      if (footprint.unsimulated.length > 0) return null;
      return {
        removed: new Set(footprint.removed.map((entry) => footprintKey(path, entry, platform))),
        rewritten: new Map(
          footprint.rewritten.map((entry) => [
            footprintKey(path, entry.path, platform),
            entry.content,
          ]),
        ),
      } satisfies GentleAiPlainFootprint;
    }).pipe(
      provide,
      // An older gentle-ai without the method, or any failure: use the built-in lists.
      Effect.catch((error) =>
        Effect.logWarning("gentle-ai footprint unavailable", error).pipe(Effect.as(null)),
      ),
    );

  return GentleAiFootprints.of({ forAgents });
});

export const layer = Layer.effect(GentleAiFootprints, make);

/**
 * Asks for footprints when the service is provided. Adapters built without it, as in tests, get
 * null and use the built-in lists.
 */
export const gentleAiFootprintLookup = Effect.serviceOption(GentleAiFootprints).pipe(
  Effect.map(
    (service) =>
      (agents: ReadonlyArray<string> | "set-up"): Effect.Effect<GentleAiPlainFootprint | null> =>
        Option.isSome(service) ? service.value.forAgents(agents) : Effect.succeed(null),
  ),
);
