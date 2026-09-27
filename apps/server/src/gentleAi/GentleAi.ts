/**
 * GentleAi — the Gentle AI ecosystem on this environment, independent of any provider.
 *
 * Gentle AI installs into each coding agent's own configuration, and its `gentle-ai` binary
 * records which agents it set up in `~/.gentle-ai/state.json`. This service finds that binary,
 * reads what gentle-ai records, and runs the ecosystem commands that work the same for every
 * agent. Providers learn from it whether Gentle AI is set up for their agent.
 *
 * @module gentleAi/GentleAi
 */
import * as NodeOS from "node:os";

import {
  GENTLE_AI_AGENT_DRIVERS,
  GENTLE_AI_PACKAGE,
  GentleAiError,
  GentleAiSddStatus,
  ProviderDriverKind,
  type GentleAiActionInput,
  type GentleAiActionResult,
  type GentleAiSddChange,
  type GentleAiSddChanges,
  type GentleAiStatus,
  type ServerProvider,
} from "@t3tools/contracts";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { resolveCommandPath, resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { piPackages } from "../provider/PiPlainExtensions.ts";
import { isGentleAiResource } from "./GentleAiFootprint.ts";
import { spawnAndCollect } from "../provider/providerSnapshot.ts";
import { ServerSettingsService } from "../serverSettings.ts";

const isGentleAiError = Schema.is(GentleAiError);

export class GentleAi extends Context.Service<
  GentleAi,
  {
    readonly current: Effect.Effect<GentleAiStatus>;
    /** The current status followed by every change, with repeats dropped. */
    readonly streamChanges: Stream.Stream<GentleAiStatus>;
    /** Re-read the binary and gentle-ai's state now. Never fails. */
    readonly refresh: Effect.Effect<void>;
    /** The gentle-ai binary to run, or null when there is none. */
    readonly binary: Effect.Effect<string | null>;
    readonly action: (
      input: GentleAiActionInput,
    ) => Effect.Effect<GentleAiActionResult, GentleAiError>;
    /** A project's active SDD changes with gentle-ai's native status for each. */
    readonly sddChanges: (cwd: string) => Effect.Effect<GentleAiSddChanges, GentleAiError>;
  }
>()("t3/gentleAi/GentleAi") {}

// The fields of gentle-ai's state.json T3 Code reads; gentle-ai owns the rest.
const StateFile = Schema.Struct({
  installed_agents: Schema.optional(Schema.Array(Schema.String)),
  installed_binary_version: Schema.optional(Schema.String),
  components: Schema.optional(Schema.Array(Schema.String)),
  preset: Schema.optional(Schema.String),
  persona: Schema.optional(Schema.String),
  pending_sync: Schema.optional(Schema.Boolean),
});
const decodeStateFile = Schema.decodeUnknownEffect(Schema.fromJsonString(StateFile));
const decodeSddStatus = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      schemaName: Schema.Literal("gentle-ai.sdd-status"),
      schemaVersion: Schema.Literal(2),
      ...GentleAiSddStatus.fields,
      planningHome: Schema.optionalKey(Schema.Struct({ path: Schema.String })),
    }),
  ),
);
// OpenSpec change folders are kebab-case names; anything else under `changes/` is not a change.
const CHANGE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Status when no gentle-ai binary is available. */
export const NOT_INSTALLED: GentleAiStatus = {
  installed: false,
  version: null,
  binaryPath: null,
  agents: [],
  drivers: [],
  preset: null,
  persona: null,
  components: [],
  syncNeeded: false,
};

const AGENT_DRIVERS: ReadonlyMap<string, string> = new Map(Object.entries(GENTLE_AI_AGENT_DRIVERS));

/** Provider drivers whose agent gentle-ai set up, from gentle-ai's own agent ids. */
export function gentleAiDrivers(agents: ReadonlyArray<string>): ReadonlyArray<ProviderDriverKind> {
  return agents.flatMap((agent) => {
    const driver = AGENT_DRIVERS.get(agent);
    return driver === undefined ? [] : [ProviderDriverKind.make(driver)];
  });
}

/** Tags the skills or slash commands gentle-ai installed with its package name. */
function tagGentleAiResources<
  T extends { readonly name: string; readonly package?: string | undefined },
>(items: ReadonlyArray<T>): ReadonlyArray<T> {
  return items.map((item) =>
    item.package === undefined && isGentleAiResource(item.name)
      ? { ...item, package: GENTLE_AI_PACKAGE }
      : item,
  );
}

type GentleAiProvider = Pick<ServerProvider, "driver" | "installed" | "gentleAi"> &
  Partial<Pick<ServerProvider, "skills" | "slashCommands" | "workspaceSnapshots">>;

/**
 * Marks each provider whose agent gentle-ai set up, and tags the skills and commands gentle-ai
 * installed into it. A driver that knows better, like Pi, which gets Gentle AI through its own
 * packages, reports the flag and tags itself, and keeps them.
 */
export function withGentleAi<P extends GentleAiProvider>(
  providers: ReadonlyArray<P>,
  status: GentleAiStatus,
): ReadonlyArray<P> {
  if (status.drivers.length === 0) return providers;
  return providers.map((provider) =>
    provider.gentleAi !== undefined ||
    !provider.installed ||
    !status.drivers.includes(provider.driver)
      ? provider
      : {
          ...provider,
          gentleAi: true,
          ...(provider.skills === undefined
            ? {}
            : { skills: tagGentleAiResources(provider.skills) }),
          ...(provider.slashCommands === undefined
            ? {}
            : { slashCommands: tagGentleAiResources(provider.slashCommands) }),
          ...(provider.workspaceSnapshots === undefined
            ? {}
            : {
                workspaceSnapshots: provider.workspaceSnapshots.map((snapshot) => ({
                  ...snapshot,
                  skills: tagGentleAiResources(snapshot.skills),
                  slashCommands: tagGentleAiResources(snapshot.slashCommands),
                })),
              }),
        },
  );
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const settingsService = yield* ServerSettingsService;
  const hostPlatform = yield* HostProcessPlatform;
  const environment = yield* HostProcessEnvironment;
  const stateRef = yield* Ref.make<GentleAiStatus>(NOT_INSTALLED);
  const changes = yield* Effect.acquireRelease(PubSub.unbounded<GentleAiStatus>(), PubSub.shutdown);

  const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(HostProcessPlatform, hostPlatform),
      Effect.provideService(HostProcessEnvironment, environment),
    );

  /** The configured binary, else gentle-ai on PATH, else the copy gentle-pi bundles. */
  const binary = Effect.gen(function* () {
    const configured = (yield* settingsService.getSettings.pipe(
      Effect.map((settings) => settings.gentleAiBinaryPath),
      Effect.orElseSucceed(() => ""),
    )).trim();
    if (configured) return configured;
    const onPath = yield* resolveCommandPath("gentle-ai").pipe(Effect.orElseSucceed(() => null));
    if (onPath) return onPath;
    const gentlePi = (yield* piPackages({ environment }).pipe(
      Effect.orElseSucceed(() => []),
    )).findLast((entry) => entry.manifest?.name === "gentle-pi");
    const version = gentlePi?.manifest?.version;
    if (gentlePi === undefined || version === undefined) return null;
    const bundled = path.join(
      gentlePi.directory,
      ".gentle-ai",
      `v${version}`,
      hostPlatform === "win32" ? "gentle-ai.exe" : "gentle-ai",
    );
    return (yield* fileSystem.exists(bundled).pipe(Effect.orElseSucceed(() => false)))
      ? bundled
      : null;
  }).pipe(provide);

  /** Runs gentle-ai to completion; `output` is stdout and stderr together, as reports use both. */
  const run = (
    binaryPath: string,
    args: ReadonlyArray<string>,
    timeout: Duration.Input,
    cwd?: string,
  ) =>
    Effect.gen(function* () {
      const resolved = yield* resolveSpawnCommand(binaryPath, args, { env: environment });
      const result = yield* spawnAndCollect(
        binaryPath,
        ChildProcess.make(resolved.command, resolved.args, {
          ...(cwd === undefined ? {} : { cwd }),
          env: environment,
          extendEnv: false,
          shell: resolved.shell,
          stdin: "ignore",
        }),
      ).pipe(
        Effect.timeoutOrElse({
          duration: timeout,
          orElse: () => Effect.fail(new GentleAiError({ detail: "gentle-ai timed out." })),
        }),
      );
      const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
      return { code: result.code, stdout: result.stdout, output };
    }).pipe(
      provide,
      Effect.mapError((cause) =>
        isGentleAiError(cause)
          ? cause
          : new GentleAiError({ detail: "gentle-ai could not be run." }),
      ),
    );

  const readStatus = Effect.gen(function* () {
    const binaryPath = yield* binary;
    if (binaryPath === null) return NOT_INSTALLED;
    const versionRun = yield* run(binaryPath, ["version"], "15 seconds").pipe(
      Effect.orElseSucceed(() => null),
    );
    const version = /(\d+\.\d+\.\d+[\w.+-]*)/.exec(versionRun?.output ?? "")?.[1] ?? null;
    if (version === null) return NOT_INSTALLED;
    // gentle-ai keeps its state under the user's home, which it resolves like Go does.
    const home =
      (hostPlatform === "win32" ? environment.USERPROFILE : environment.HOME) || NodeOS.homedir();
    const statePath = path.join(home, ".gentle-ai", "state.json");
    const state = (yield* fileSystem.exists(statePath).pipe(Effect.orElseSucceed(() => false)))
      ? yield* fileSystem.readFileString(statePath).pipe(
          Effect.flatMap(decodeStateFile),
          Effect.orElseSucceed(() => null),
        )
      : null;
    const agents = state?.installed_agents ?? [];
    return {
      installed: true,
      version,
      binaryPath,
      agents,
      drivers: gentleAiDrivers(agents),
      preset: state?.preset ?? null,
      persona: state?.persona ?? null,
      components: state?.components ?? [],
      syncNeeded:
        state !== null &&
        (state.pending_sync === true ||
          (state.installed_binary_version !== undefined &&
            state.installed_binary_version !== version)),
    } satisfies GentleAiStatus;
  });

  const publish = (next: GentleAiStatus) =>
    Effect.gen(function* () {
      const changed = yield* Ref.modify(stateRef, (previous) =>
        Equal.equals(previous, next) ? [false, previous] : [true, next],
      );
      if (changed) yield* PubSub.publish(changes, next);
    });

  const refreshLock = yield* Semaphore.make(1);
  const refresh = readStatus.pipe(
    Effect.flatMap(publish),
    refreshLock.withPermits(1),
    Effect.ignoreCause({ log: true }),
  );

  const action = (input: GentleAiActionInput) =>
    Effect.gen(function* () {
      if (input.action === "refresh") {
        yield* refresh;
        return { status: yield* Ref.get(stateRef) } satisfies GentleAiActionResult;
      }
      const binaryPath = yield* binary;
      if (binaryPath === null)
        return yield* new GentleAiError({ detail: "Gentle AI is not installed." });
      // Each action is the gentle-ai command of the same name.
      const args = [input.action];
      const result = yield* run(binaryPath, args, "5 minutes");
      yield* refresh;
      // doctor reports problems through its exit code, so its report is the result either way.
      if (result.code !== 0 && input.action !== "doctor") {
        return yield* new GentleAiError({
          detail: `gentle-ai ${args[0]} failed. ${result.output.split("\n").slice(-3).join(" ").slice(-400)}`,
        });
      }
      return {
        status: yield* Ref.get(stateRef),
        output: result.output,
      } satisfies GentleAiActionResult;
    });

  const sddStatus = (binaryPath: string, cwd: string, changeName?: string) =>
    Effect.gen(function* () {
      const result = yield* run(
        binaryPath,
        ["sdd-status", ...(changeName === undefined ? [] : [changeName]), "--cwd", cwd, "--json"],
        "10 seconds",
        cwd,
      );
      if (result.code !== 0) return yield* new GentleAiError({ detail: result.output });
      return yield* decodeSddStatus(result.stdout);
    }).pipe(
      Effect.mapError(
        () =>
          new GentleAiError({
            detail: `Gentle AI could not report SDD status${changeName === undefined ? "" : ` for ${changeName}`}.`,
          }),
      ),
    );

  /**
   * gentle-ai reports one change at a time, so this finds the change folders under the
   * project's planning home first. Stores without one (Engram, none) have nothing to list.
   */
  const sddChanges = (cwd: string) =>
    Effect.gen(function* () {
      if (!path.isAbsolute(cwd))
        return yield* new GentleAiError({ detail: "Choose an absolute project folder." });
      const binaryPath = yield* binary;
      if (binaryPath === null)
        return yield* new GentleAiError({ detail: "Gentle AI is not installed." });
      const overview = yield* sddStatus(binaryPath, cwd);
      const names: Array<string> = [];
      if (overview.planningHome !== undefined) {
        const changesDirectory = path.join(overview.planningHome.path, "changes");
        const entries = yield* fileSystem
          .readDirectory(changesDirectory)
          .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
        for (const name of entries) {
          if (name === "archive" || !CHANGE_NAME.test(name)) continue;
          const info = yield* fileSystem
            .stat(path.join(changesDirectory, name))
            .pipe(Effect.orElseSucceed(() => null));
          if (info?.type === "Directory") names.push(name);
        }
      }
      names.sort((left, right) => left.localeCompare(right));
      const changes = yield* Effect.forEach(
        names,
        (name) =>
          sddStatus(binaryPath, cwd, name).pipe(
            Effect.map(
              ({ schemaName: _name, schemaVersion: _version, planningHome: _home, ...status }) =>
                ({ ...status, changeName: name }) satisfies GentleAiSddChange,
            ),
          ),
        { concurrency: 4 },
      );
      return { artifactStore: overview.artifactStore, changes } satisfies GentleAiSddChanges;
    });

  // A changed binary path points at another gentle-ai, so status re-reads straight away.
  yield* settingsService.streamChanges.pipe(
    Stream.map((settings) => settings.gentleAiBinaryPath),
    Stream.changes,
    Stream.runForEach(() => refresh),
    Effect.forkScoped,
  );
  yield* refresh.pipe(Effect.forkScoped);

  return {
    current: Ref.get(stateRef),
    refresh,
    binary,
    action,
    sddChanges,
    get streamChanges() {
      return Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(changes);
          const snapshot = yield* Ref.get(stateRef);
          return Stream.concat(Stream.make(snapshot), Stream.fromSubscription(subscription)).pipe(
            Stream.changes,
          );
        }),
      );
    },
  } satisfies GentleAi["Service"];
});

export const layer = Layer.effect(GentleAi, make);
