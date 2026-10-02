import {
  gentleAiEnabled,
  ProviderSetupError,
  type ClaudeSettings,
  type CodexSettings,
  type OpenCodeSettings,
  type ProviderDriverKind,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as Scope from "effect/Scope";

import {
  ProviderAdapterOpenSessionError,
  type ProviderAdapterV2OpenSessionInput,
} from "../orchestration-v2/ProviderAdapter.ts";
import { expandHomePath } from "../pathExpansion.ts";
import { resolveClaudeHomePath } from "../provider/Drivers/ClaudeHome.ts";
import { plainPiExtensionArgs } from "../provider/PiPlainExtensions.ts";
import { goesThroughProxy, readClaudeGentleProfile } from "./ClaudeGentleProfile.ts";
import { gentleAiFootprintLookup } from "./GentleAiFootprints.ts";
import {
  claudeGentleOffOptions,
  gentleAiOffDirectory,
  gentleAiUserHome,
  materializeCodexPlainHome,
  openCodeGentleOffEnvironment,
  type ClaudePlainAgent,
  type ClaudePlainMcpServer,
} from "./GentleAiOff.ts";

/**
 * Adjusts what a provider process starts with for one session. Adapters call it when a session
 * opens; threads with Gentle AI off get a launch without gentle-ai's footprint.
 */
export type PrepareProviderSession<Runtime> = (
  input: ProviderAdapterV2OpenSessionInput,
  runtime: Runtime,
) => Effect.Effect<Runtime, ProviderAdapterOpenSessionError, Scope.Scope>;

/** Runs a Gentle AI off preparation with the services it needs, failing the session open. */
const gentleOffServices = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcessPlatform;
  const footprints = yield* gentleAiFootprintLookup;
  const provide = <A, E>(
    driver: ProviderDriverKind,
    input: ProviderAdapterV2OpenSessionInput,
    effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Scope.Scope>,
  ) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.mapError(
        (cause) =>
          new ProviderAdapterOpenSessionError({
            driver,
            providerSessionId: input.providerSessionId,
            cause,
          }),
      ),
    );
  return { path, platform, footprints, provide };
});

/** Codex with Gentle AI off runs on a plain mirror of its home for the session's lifetime. */
export const makeCodexGentleOffSession = (driver: ProviderDriverKind) =>
  Effect.gen(function* () {
    const { path, platform, footprints, provide } = yield* gentleOffServices;
    const prepare: PrepareProviderSession<{
      readonly settings: CodexSettings;
      readonly environment: NodeJS.ProcessEnv;
    }> = (input, runtime) =>
      gentleAiEnabled(input.modelSelection.options)
        ? Effect.succeed(runtime)
        : provide(
            driver,
            input,
            Effect.gen(function* () {
              const userHome = gentleAiUserHome(runtime.environment, platform);
              const source = runtime.settings.homePath
                ? path.resolve(expandHomePath(runtime.settings.homePath))
                : runtime.environment.CODEX_HOME?.trim() || path.join(userHome, ".codex");
              const target = yield* gentleAiOffDirectory("codex");
              yield* materializeCodexPlainHome({
                source,
                target,
                platform,
                userHome,
                footprint: yield* footprints(["codex"]),
              });
              return { ...runtime, settings: { ...runtime.settings, homePath: target } };
            }),
          );
    return prepare;
  });

/**
 * OpenCode with Gentle AI off runs its session's own server on a plain config home. A server
 * T3 Code does not start loads its own configuration, so Gentle AI cannot be turned off there.
 */
export const makeOpenCodeGentleOffSession = (
  driver: ProviderDriverKind,
  instanceId: ProviderInstanceId,
) =>
  Effect.gen(function* () {
    const { platform, footprints, provide } = yield* gentleOffServices;
    const prepare: PrepareProviderSession<{
      readonly environment: NodeJS.ProcessEnv;
      readonly serverUrl: OpenCodeSettings["serverUrl"];
    }> = (input, runtime) => {
      if (gentleAiEnabled(input.modelSelection.options)) return Effect.succeed(runtime);
      if (runtime.serverUrl?.trim()) {
        return Effect.fail(
          new ProviderAdapterOpenSessionError({
            driver,
            providerSessionId: input.providerSessionId,
            cause: new ProviderSetupError({
              instanceId,
              operation: "session",
              detail: OPENCODE_SERVER_GENTLE_OFF_UNSUPPORTED,
            }),
          }),
        );
      }
      return provide(
        driver,
        input,
        Effect.gen(function* () {
          const environment = yield* openCodeGentleOffEnvironment({
            environment: runtime.environment,
            platform,
            footprint: yield* footprints(["opencode"]),
          });
          return { ...runtime, environment };
        }),
      );
    };
    return prepare;
  });

export const OPENCODE_SERVER_GENTLE_OFF_UNSUPPORTED =
  "Gentle AI cannot be turned off for an OpenCode server T3 Code does not start for this thread.";

/** What a Claude Code session loads beyond T3 Code's own query options. */
export interface ClaudeLaunchQuery {
  readonly settingSources?: Array<"user" | "project" | "local">;
  readonly appendSystemPrompt?: string;
  readonly agents?: Record<string, ClaudePlainAgent>;
  readonly plugins?: Array<{ readonly type: "local"; readonly path: string }>;
  readonly strictMcpConfig?: boolean;
  readonly mcpServers?: Record<string, ClaudePlainMcpServer>;
  /** Settings under the selection's own, which outrank ~/.claude/settings.json. */
  readonly sdkSettings?: Record<string, unknown>;
}

export interface ClaudeSessionLaunch {
  readonly environment: NodeJS.ProcessEnv;
  readonly query: ClaudeLaunchQuery;
}

/**
 * Claude Code with Gentle AI off drops its user settings source, where gentle-ai's footprint
 * lives, and gets back the user's own pieces of it, filtered. With Gentle AI on, a Claude Code
 * session that goes through a proxy gets the applied Gentle AI profile's slot models.
 */
export const makeClaudeGentleSession = (
  driver: ProviderDriverKind,
  settings: Pick<ClaudeSettings, "homePath">,
) =>
  Effect.gen(function* () {
    const { platform, footprints, provide } = yield* gentleOffServices;
    const prepare: PrepareProviderSession<ClaudeSessionLaunch> = (input, launch) =>
      provide(
        driver,
        input,
        Effect.gen(function* () {
          if (gentleAiEnabled(input.modelSelection.options)) {
            if (!goesThroughProxy(launch.environment)) return launch;
            const profile = yield* readClaudeGentleProfile(launch.environment, platform);
            if (profile === null) return launch;
            const hasSlots = Object.keys(profile.env).length > 0;
            return {
              environment: { ...launch.environment, ...profile.env },
              query: {
                ...launch.query,
                ...(hasSlots ? { sdkSettings: { env: { ...profile.env } } } : {}),
                ...(profile.guide ? { appendSystemPrompt: profile.guide } : {}),
              },
            };
          }
          const off = yield* claudeGentleOffOptions({
            claudeHome: yield* resolveClaudeHomePath(settings, launch.environment),
            environment: launch.environment,
            platform,
            cwd: input.runtimePolicy.cwd ?? undefined,
            footprint: yield* footprints(["claude-code"]),
          });
          return {
            environment: launch.environment,
            query: {
              ...launch.query,
              settingSources: ["project", "local"],
              ...(off.instructions
                ? { appendSystemPrompt: `# User instructions\n\n${off.instructions}` }
                : {}),
              ...(Object.keys(off.agents).length > 0 ? { agents: off.agents } : {}),
              ...(off.pluginPath ? { plugins: [{ type: "local", path: off.pluginPath }] } : {}),
              strictMcpConfig: true,
              mcpServers: off.mcpServers,
              sdkSettings: off.settings,
            },
          };
        }),
      );
    return prepare;
  });

/**
 * Pi with Gentle AI on tells gentle-pi it runs under an RPC host, so it publishes subagent
 * activity and interactive questions. Off, Pi loads every installed extension, skill, and prompt
 * template except gentle-pi's, since Pi has no per-package opt-out.
 */
export const makePiGentleSession = (driver: ProviderDriverKind) =>
  Effect.gen(function* () {
    const { provide } = yield* gentleOffServices;
    const prepare: PrepareProviderSession<{
      readonly args: ReadonlyArray<string>;
      readonly environment: NodeJS.ProcessEnv;
      readonly cwd: string;
    }> = (input, launch) => {
      const environment = { ...launch.environment };
      if (gentleAiEnabled(input.modelSelection.options)) {
        environment.GENTLE_SHELL_INTERACTIVE_HOST = "1";
        return Effect.succeed({ ...launch, environment });
      }
      delete environment.GENTLE_SHELL_INTERACTIVE_HOST;
      return provide(
        driver,
        input,
        plainPiExtensionArgs({ cwd: launch.cwd, environment }).pipe(
          Effect.map((plainArgs) => ({
            ...launch,
            environment,
            args: [...launch.args, ...plainArgs],
          })),
        ),
      );
    };
    return prepare;
  });
