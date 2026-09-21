import {
  PiSettings,
  ProviderDriverKind,
  TextGenerationError,
  TrimmedNonEmptyString,
  type ModelCapabilities,
  type ServerProvider,
  type ServerProviderModel,
  type ServerProviderSkill,
  type ServerProviderSlashCommand,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { compareSemverVersions } from "@t3tools/shared/semver";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import type * as TextGeneration from "../../textGeneration/TextGeneration.ts";
import { ProviderAdapterRequestError, ProviderDriverError } from "../Errors.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import { makePiRpc, PI_THINKING_LEVELS, type PiThinkingLevel } from "../PiRpc.ts";
import {
  buildServerProvider,
  COMPACT_SLASH_COMMAND,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
} from "../providerSnapshot.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { withInstanceIdentity } from "./instanceIdentity.ts";

const DRIVER_KIND = ProviderDriverKind.make("pi");
const MINIMUM_PI_VERSION = "0.86.1";
const PI_RPC_ARGS = ["--no-session"] as const;
const VERSION_TIMEOUT = "4 seconds";
const PROCESS_FORCE_KILL_AFTER = "1 second";
const decodePiSettings = Schema.decodeSync(PiSettings);
const PiModelSchema = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  provider: TrimmedNonEmptyString,
  reasoning: Schema.Boolean,
  thinkingLevelMap: Schema.optionalKey(
    Schema.Struct({
      off: Schema.optionalKey(Schema.NullOr(Schema.String)),
      minimal: Schema.optionalKey(Schema.NullOr(Schema.String)),
      low: Schema.optionalKey(Schema.NullOr(Schema.String)),
      medium: Schema.optionalKey(Schema.NullOr(Schema.String)),
      high: Schema.optionalKey(Schema.NullOr(Schema.String)),
      xhigh: Schema.optionalKey(Schema.NullOr(Schema.String)),
      max: Schema.optionalKey(Schema.NullOr(Schema.String)),
    }),
  ),
  input: Schema.Array(Schema.Literals(["text", "image"])),
});
const decodeModelsResponse = Schema.decodeUnknownEffect(
  Schema.Struct({
    data: Schema.Struct({
      models: Schema.Array(PiModelSchema),
    }),
  }),
);
const PiCommandSchema = Schema.Struct({
  name: TrimmedNonEmptyString,
  description: Schema.optionalKey(TrimmedNonEmptyString),
  source: Schema.Literals(["extension", "prompt", "skill"]),
  sourceInfo: Schema.Struct({
    path: TrimmedNonEmptyString,
    source: TrimmedNonEmptyString,
    scope: Schema.Literals(["user", "project", "temporary"]),
    origin: Schema.Literals(["package", "top-level"]),
    baseDir: Schema.optionalKey(TrimmedNonEmptyString),
  }),
});
const decodeCommandsResponse = Schema.decodeUnknownEffect(
  Schema.Struct({
    data: Schema.Struct({
      commands: Schema.Array(PiCommandSchema),
    }),
  }),
);

const MAINTENANCE_CAPABILITIES = makeManualOnlyProviderMaintenanceCapabilities({
  provider: DRIVER_KIND,
  packageName: "@earendil-works/pi-coding-agent",
});

export type PiDriverEnv = ChildProcessSpawner.ChildProcessSpawner;

type PiModel = typeof PiModelSchema.Type;
type PiCommand = typeof PiCommandSchema.Type;

function titleCase(value: string): string {
  return value
    .split(/[-_]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function thinkingLevelsForModel(model: PiModel): ReadonlyArray<PiThinkingLevel> {
  if (!model.reasoning) return ["off"];
  return PI_THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    return level !== "xhigh" && level !== "max" ? true : mapped !== undefined;
  });
}

function modelCapabilities(model: PiModel): ModelCapabilities | null {
  if (!model.reasoning) return null;
  const levels = thinkingLevelsForModel(model);
  if (levels.length === 0) return { optionDescriptors: [] };
  const defaultLevel = levels.includes("medium")
    ? "medium"
    : (levels.find((level) => level !== "off") ?? levels[0]);
  return {
    optionDescriptors: [
      {
        id: "thinkingLevel",
        label: "Thinking level",
        type: "select",
        options: levels.map((level) => ({
          id: level,
          label: titleCase(level),
          ...(level === defaultLevel ? { isDefault: true } : {}),
        })),
        ...(defaultLevel === undefined ? {} : { currentValue: defaultLevel }),
      },
    ],
  };
}

function toServerProviderModel(model: PiModel): ServerProviderModel {
  return {
    slug: `${model.provider}/${model.id}`,
    name: model.name,
    subProvider: model.provider,
    isCustom: false,
    capabilities: modelCapabilities(model),
  };
}

function dedupeSlashCommands(
  commands: ReadonlyArray<ServerProviderSlashCommand>,
): ReadonlyArray<ServerProviderSlashCommand> {
  const byName = new Map<string, ServerProviderSlashCommand>();
  byName.set(COMPACT_SLASH_COMMAND.name, COMPACT_SLASH_COMMAND);
  for (const command of commands) {
    if (!byName.has(command.name)) byName.set(command.name, command);
  }
  return [...byName.values()];
}

function commandName(command: PiCommand): string {
  return command.name.startsWith("/") ? command.name.slice(1) : command.name;
}

function skillName(command: PiCommand): string {
  const name = commandName(command);
  return name.startsWith("skill:") ? name.slice("skill:".length) : name;
}

function workspaceInventory(commands: ReadonlyArray<PiCommand>): {
  readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
  readonly skills: ReadonlyArray<ServerProviderSkill>;
} {
  return {
    slashCommands: dedupeSlashCommands(
      commands.flatMap((command) => {
        const name = commandName(command);
        return command.source === "skill" || name.length === 0
          ? []
          : [
              {
                name,
                ...(command.description === undefined ? {} : { description: command.description }),
              },
            ];
      }),
    ),
    skills: commands.flatMap((command) => {
      const name = skillName(command);
      return command.source !== "skill" || name.length === 0
        ? []
        : [
            {
              name,
              ...(command.description === undefined ? {} : { description: command.description }),
              path: command.sourceInfo.path,
              scope: command.sourceInfo.scope,
              enabled: true,
            },
          ];
    }),
  };
}

function placeholderAdapter(): ProviderAdapterShape<ProviderAdapterRequestError> {
  const unavailable = (method: string) =>
    Effect.fail(
      new ProviderAdapterRequestError({
        provider: DRIVER_KIND,
        method,
        detail: "Pi runtime chat support is not implemented yet.",
      }),
    );
  return {
    provider: DRIVER_KIND,
    capabilities: {
      sessionModelSwitch: "unsupported",
      supportsConversationRollback: false,
    },
    startSession: () => unavailable("startSession"),
    sendTurn: () => unavailable("sendTurn"),
    interruptTurn: () => unavailable("interruptTurn"),
    respondToRequest: () => unavailable("respondToRequest"),
    respondToUserInput: () => unavailable("respondToUserInput"),
    stopSession: () => unavailable("stopSession"),
    listSessions: () => Effect.succeed([]),
    hasSession: () => Effect.succeed(false),
    readThread: () => unavailable("readThread"),
    rollbackThread: () => unavailable("rollbackThread"),
    stopAll: () => Effect.void,
    streamEvents: Stream.empty,
  };
}

function placeholderTextGeneration(): TextGeneration.TextGeneration["Service"] {
  const unavailable = (operation: string) =>
    Effect.fail(
      new TextGenerationError({
        operation,
        detail: "Pi text generation support is not implemented yet.",
      }),
    );
  return {
    generateCommitMessage: () => unavailable("generateCommitMessage"),
    generatePrContent: () => unavailable("generatePrContent"),
    generateBranchName: () => unavailable("generateBranchName"),
    generateThreadTitle: () => unavailable("generateThreadTitle"),
  };
}

function discoveryError(input: {
  readonly instanceId: ProviderInstance["instanceId"];
  readonly detail: string;
  readonly cause?: unknown;
}): ProviderDriverError {
  return new ProviderDriverError({
    driver: DRIVER_KIND,
    instanceId: input.instanceId,
    detail: input.detail,
    ...(input.cause === undefined ? {} : { cause: input.cause }),
  });
}

export const PiDriver: ProviderDriver<PiSettings, PiDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Pi",
    supportsMultipleInstances: true,
  },
  configSchema: PiSettings,
  defaultConfig: (): PiSettings => decodePiSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const hostPlatform = yield* HostProcessPlatform;
      const processEnv = mergeProviderInstanceEnvironment(environment);
      const effectiveConfig = { ...config, enabled } satisfies PiSettings;
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const stampIdentity = withInstanceIdentity({
        instanceId,
        driverKind: DRIVER_KIND,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const changes = yield* Effect.acquireRelease(
        PubSub.unbounded<ServerProvider>(),
        PubSub.shutdown,
      );
      const discoverySemaphore = yield* Semaphore.make(1);

      const makeSnapshot = Effect.fn("PiDriver.makeSnapshot")(function* (input: {
        readonly installed: boolean;
        readonly version: string | null;
        readonly status: "ready" | "warning" | "error";
        readonly message?: string;
        readonly models: ReadonlyArray<ServerProviderModel>;
      }) {
        const checkedAt = DateTime.formatIso(yield* DateTime.now);
        return stampIdentity(
          buildServerProvider({
            presentation: { displayName: "Pi", showInteractionModeToggle: false },
            enabled: effectiveConfig.enabled,
            checkedAt,
            models: input.models,
            slashCommands: [COMPACT_SLASH_COMMAND],
            skills: [],
            probe: {
              installed: input.installed,
              version: input.version,
              status: input.status,
              auth: { status: "unknown" },
              ...(input.message === undefined ? {} : { message: input.message }),
            },
          }),
        );
      });

      const initialModels = providerModelsFromSettings([], effectiveConfig.customModels, {});
      const initialSnapshot = yield* makeSnapshot({
        installed: false,
        version: null,
        status: "error",
        ...(effectiveConfig.enabled
          ? { message: "Pi version has not been checked yet." }
          : { message: "Pi is disabled." }),
        models: initialModels,
      });
      const snapshotRef = yield* Ref.make(initialSnapshot);

      const publish = Effect.fn("PiDriver.publish")(function* (next: ServerProvider) {
        yield* Ref.set(snapshotRef, next);
        yield* PubSub.publish(changes, next);
        return next;
      });

      const checkVersion = Effect.fn("PiDriver.checkVersion")(
        function* () {
          const current = yield* Ref.get(snapshotRef);
          if (!effectiveConfig.enabled) {
            return yield* makeSnapshot({
              installed: false,
              version: null,
              status: "error",
              message: "Pi is disabled.",
              models: current.models,
            });
          }

          const execution = yield* Effect.gen(function* () {
            const resolved = yield* resolveSpawnCommand(effectiveConfig.binaryPath, ["--version"], {
              env: processEnv,
            });
            return yield* spawnAndCollect(
              effectiveConfig.binaryPath,
              ChildProcess.make(resolved.command, resolved.args, {
                cwd: process.cwd(),
                detached: hostPlatform !== "win32",
                env: processEnv,
                extendEnv: false,
                forceKillAfter: PROCESS_FORCE_KILL_AFTER,
                shell: resolved.shell,
              }),
            );
          }).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Effect.provideService(HostProcessPlatform, hostPlatform),
            Effect.timeoutOption(VERSION_TIMEOUT),
          );

          if (Option.isNone(execution)) {
            return yield* makeSnapshot({
              installed: true,
              version: null,
              status: "error",
              message: "Pi version check timed out.",
              models: current.models,
            });
          }

          const result = execution.value;
          if (result.code !== 0) {
            return yield* makeSnapshot({
              installed: true,
              version: null,
              status: "error",
              message: `Pi version check exited with code ${result.code}.`,
              models: current.models,
            });
          }
          const version = parseGenericCliVersion(result.stdout);
          if (version === null) {
            return yield* makeSnapshot({
              installed: true,
              version: null,
              status: "error",
              message: "Pi returned an unrecognized version.",
              models: current.models,
            });
          }
          if (compareSemverVersions(version, MINIMUM_PI_VERSION) < 0) {
            return yield* makeSnapshot({
              installed: true,
              version,
              status: "error",
              message: `Pi ${MINIMUM_PI_VERSION} or newer is required.`,
              models: current.models,
            });
          }
          return yield* makeSnapshot({
            installed: true,
            version,
            status: "ready",
            models: current.models,
          });
        },
        Effect.catch((cause) =>
          Ref.get(snapshotRef).pipe(
            Effect.flatMap((current) =>
              makeSnapshot({
                installed: !isCommandMissingCause(cause),
                version: null,
                status: "error",
                message: isCommandMissingCause(cause)
                  ? `Pi CLI (${effectiveConfig.binaryPath}) is not installed or not on PATH.`
                  : "Pi version check failed.",
                models: current.models,
              }),
            ),
          ),
        ),
      );

      const snapshot = {
        resolveMaintenance: () => Effect.succeed(MAINTENANCE_CAPABILITIES),
        getSnapshot: Ref.get(snapshotRef),
        refresh: checkVersion().pipe(Effect.flatMap(publish), Effect.orDie),
        applyUsageLimits: () => Effect.void,
        get streamChanges() {
          return Stream.fromPubSub(changes);
        },
      } satisfies ProviderInstance["snapshot"];

      const refreshModels = () =>
        discoverySemaphore.withPermits(1)(
          !effectiveConfig.enabled
            ? Effect.fail(
                discoveryError({
                  instanceId,
                  detail: "Cannot discover Pi models while the instance is disabled.",
                }),
              )
            : Effect.scoped(
                Effect.gen(function* () {
                  const rpc = yield* makePiRpc({
                    binaryPath: effectiveConfig.binaryPath,
                    cwd: process.cwd(),
                    args: PI_RPC_ARGS,
                    environment: processEnv,
                  });
                  const modelsResponse = yield* rpc.request({ type: "get_available_models" });
                  const { data: modelsData } = yield* decodeModelsResponse(modelsResponse);
                  const discoveredModels = modelsData.models.map(toServerProviderModel);
                  const models = providerModelsFromSettings(
                    discoveredModels,
                    effectiveConfig.customModels,
                    {},
                  );
                  const current = yield* Ref.get(snapshotRef);
                  yield* publish({ ...current, models });
                }),
              ).pipe(
                Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
                Effect.provideService(HostProcessPlatform, hostPlatform),
                Effect.mapError((cause) =>
                  discoveryError({
                    instanceId,
                    detail: "Pi model discovery failed.",
                    cause,
                  }),
                ),
              ),
        );

      const snapshotForCwd = (cwd: string) =>
        !effectiveConfig.enabled
          ? snapshot.getSnapshot
          : Effect.scoped(
              Effect.gen(function* () {
                const rpc = yield* makePiRpc({
                  binaryPath: effectiveConfig.binaryPath,
                  cwd,
                  args: PI_RPC_ARGS,
                  environment: processEnv,
                });
                const response = yield* rpc.request({ type: "get_commands" });
                const { data } = yield* decodeCommandsResponse(response);
                const inventory = workspaceInventory(data.commands);
                const base = yield* snapshot.getSnapshot;
                return {
                  ...base,
                  slashCommands: inventory.slashCommands,
                  skills: inventory.skills,
                };
              }),
            ).pipe(
              Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
              Effect.provideService(HostProcessPlatform, hostPlatform),
              Effect.mapError((cause) =>
                discoveryError({
                  instanceId,
                  detail: `Pi workspace discovery failed for '${cwd}'.`,
                  cause,
                }),
              ),
            );

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        snapshotForCwd,
        refreshModels,
        adapter: placeholderAdapter(),
        textGeneration: placeholderTextGeneration(),
      } satisfies ProviderInstance;
    }),
};
