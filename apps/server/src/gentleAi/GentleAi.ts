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
import { hostUserHome } from "../hostUserHome.ts";

import {
  GENTLE_AI_AGENT_DRIVERS,
  GENTLE_AI_PACKAGE,
  GENTLE_AI_METHODS,
  GentleAiError,
  ProviderDriverKind,
  type GentleAiJob,
  type GentleAiJobMethod,
  type GentleAiQueryMethod,
  type GentleAiActionInput,
  type GentleAiActionResult,
  type GentleAiStatus,
  type ServerProvider,
} from "@t3tools/contracts";
import {
  HostProcessArchitecture,
  HostProcessEnvironment,
  HostProcessPlatform,
} from "@t3tools/shared/hostProcess";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { GENTLE_AI_PROFILE_HOST } from "./ClaudeGentleProfile.ts";
import { isGentleAiResource } from "./GentleAiFootprint.ts";
import { DescribeResult, runGentleAiApi, type GentleAiApiEvent } from "./GentleAiApi.ts";
import {
  GENTLE_AI_RELEASE_REPOSITORY,
  gentleAiInstallPath,
  gentleAiReleaseAsset,
  resolveGentleAiBinary,
} from "./GentleAiBinary.ts";
import { makeGitHubReleases } from "../githubRelease.ts";
import { spawnAndCollect } from "../provider/providerSnapshot.ts";
import { ServerSettingsService } from "../serverSettings.ts";

const isGentleAiError = Schema.is(GentleAiError);
const HOSTED_PROFILE_METHODS: ReadonlySet<string> = new Set([
  "claude.profiles.apply",
  "claude.profiles.save",
]);
const FootprintRemoved = Schema.Struct({ removed: Schema.Array(Schema.String) });

/** One read of gentle-ai's API; equal method and params are the same read. */
class QueryKey extends Data.Class<{
  readonly method: GentleAiQueryMethod;
  /** The params as JSON, so equal params compare equal. */
  readonly params: string;
  /** Asked to skip what gentle-ai remembers, such as "Check now" for updates. */
  readonly forced: boolean;
}> {}
const queryKey = (method: GentleAiQueryMethod, params: unknown) =>
  new QueryKey({
    method,
    params: JSON.stringify(params ?? {}),
    forced:
      typeof params === "object" && params !== null && "force" in params && params.force === true,
  });

/** How long a read's answer stands in for running gentle-ai again. */
function queryTimeToLive({ method, forced }: QueryKey): Duration.Input {
  if (forced) return Duration.zero;
  switch (method) {
    // Diagnostics and the feature list (which agents write as they work) are read fresh.
    case "doctor":
    case "odd.features":
      return Duration.zero;
    // Checking for updates asks the network.
    case "updates":
      return Duration.minutes(10);
    // Discovery asks each agent's CLI for its models.
    case "models.get":
      return Duration.minutes(5);
    default:
      return Duration.minutes(1);
  }
}

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
    /** Answers a read-only API method; the result is validated and encoded for the wire. */
    readonly query: (
      method: GentleAiQueryMethod,
      params: unknown,
    ) => Effect.Effect<unknown, GentleAiError>;
    /** Starts an API job; fails while another job runs. */
    readonly startJob: (
      method: GentleAiJobMethod,
      params: unknown,
    ) => Effect.Effect<GentleAiJob, GentleAiError>;
    /** The current or last job, then every change. */
    readonly streamJob: Stream.Stream<GentleAiJob | null>;
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
/** Status when no gentle-ai binary is available. */
export const NOT_INSTALLED: GentleAiStatus = {
  apiVersion: null,
  oddFeatures: false,
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

/**
 * Tags the skills or slash commands gentle-ai installed with its package name: the ones its
 * footprint names, or, from an older gentle-ai, the ones the built-in list knows.
 */
function tagGentleAiResources<
  T extends { readonly name: string; readonly package?: string | undefined },
>(items: ReadonlyArray<T>, resources: ReadonlyArray<string> | undefined): ReadonlyArray<T> {
  const owned = (name: string) =>
    resources === undefined ? isGentleAiResource(name) : resources.includes(name);
  return items.map((item) =>
    item.package === undefined && owned(item.name) ? { ...item, package: GENTLE_AI_PACKAGE } : item,
  );
}

/**
 * The skill and command names in a footprint's removed paths: the entries of a `skills` folder,
 * and the `.md` files of a `commands` one.
 */
export function gentleAiResourceNames(removed: ReadonlyArray<string>): ReadonlyArray<string> {
  const names = new Set<string>();
  for (const entry of removed) {
    const parts = entry.split(/[\\/]/);
    const name = parts.at(-1) ?? "";
    const parent = parts.at(-2) ?? "";
    if (parent === "skills" || parent === "skill") names.add(name);
    else if ((parent === "commands" || parent === "command") && name.endsWith(".md"))
      names.add(name.slice(0, -".md".length));
  }
  return [...names].toSorted();
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
            : { skills: tagGentleAiResources(provider.skills, status.resources) }),
          ...(provider.slashCommands === undefined
            ? {}
            : { slashCommands: tagGentleAiResources(provider.slashCommands, status.resources) }),
          ...(provider.workspaceSnapshots === undefined
            ? {}
            : {
                workspaceSnapshots: provider.workspaceSnapshots.map((snapshot) => ({
                  ...snapshot,
                  skills: tagGentleAiResources(snapshot.skills, status.resources),
                  slashCommands: tagGentleAiResources(snapshot.slashCommands, status.resources),
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
  const crypto = yield* Crypto.Crypto;
  const arch = yield* HostProcessArchitecture;
  const releases = yield* makeGitHubReleases;
  const installLock = yield* Semaphore.make(1);
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
  const binary = settingsService.getSettings.pipe(
    Effect.map((settings) => settings.gentleAiBinaryPath),
    Effect.orElseSucceed(() => ""),
    Effect.flatMap(resolveGentleAiBinary),
    provide,
  );

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
    const describe = yield* runGentleAiApi({
      binaryPath,
      method: "describe",
      params: {},
      environment,
      timeout: "15 seconds",
    }).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(DescribeResult)),
      provide,
      Effect.orElseSucceed(() => null),
    );
    // A gentle-ai with the API answers everything here; its state file stays its own.
    const api =
      describe === null
        ? null
        : yield* runGentleAiApi({
            binaryPath,
            method: "status",
            params: {},
            environment,
            timeout: "30 seconds",
          }).pipe(
            Effect.flatMap(GENTLE_AI_METHODS.status.decodeResult),
            provide,
            Effect.orElseSucceed(() => null),
          );
    if (describe !== null && api !== null) {
      // The page asks for this same answer first; keep it so it does not run gentle-ai again.
      yield* GENTLE_AI_METHODS.status.encodeResult(api).pipe(
        Effect.flatMap((encoded) => Cache.set(queryCache, queryKey("status", {}), encoded)),
        Effect.ignore,
      );
      const agents = api.agents.filter((agent) => agent.installed).map((agent) => agent.id);
      // What gentle-ai installed into the agents it set up, to tag their skills and commands.
      const footprint = describe.methods.includes("footprint")
        ? yield* runGentleAiApi({
            binaryPath,
            method: "footprint",
            params: {},
            environment,
            timeout: "30 seconds",
          }).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(FootprintRemoved)),
            provide,
            Effect.orElseSucceed(() => null),
          )
        : null;
      return {
        apiVersion: describe.apiVersion,
        oddFeatures: describe.methods.includes("odd.features"),
        claudeProfiles: describe.methods.includes("claude.profiles"),
        installed: true,
        version,
        binaryPath,
        agents,
        drivers: gentleAiDrivers(agents),
        preset: api.state.preset ?? null,
        persona: api.state.persona ?? null,
        components: api.components
          .filter((component) => component.installed)
          .map((component) => component.id),
        syncNeeded: api.state.syncNeeded ?? api.state.pendingSync,
        ...(footprint === null ? {} : { resources: gentleAiResourceNames(footprint.removed) }),
      } satisfies GentleAiStatus;
    }
    // Older gentle-ai: read its state file.
    const home = hostUserHome(environment, hostPlatform);
    const statePath = path.join(home, ".gentle-ai", "state.json");
    const state = (yield* fileSystem.exists(statePath).pipe(Effect.orElseSucceed(() => false)))
      ? yield* fileSystem.readFileString(statePath).pipe(
          Effect.flatMap(decodeStateFile),
          Effect.orElseSucceed(() => null),
        )
      : null;
    const agents = state?.installed_agents ?? [];
    return {
      apiVersion: describe?.apiVersion ?? null,
      oddFeatures: false,
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
  // Whatever made a refresh worthwhile (a job, a new binary, the user) can change any answer.
  const refresh = Effect.suspend(() => Cache.invalidateAll(queryCache)).pipe(
    Effect.andThen(readStatus),
    Effect.flatMap(publish),
    refreshLock.withPermits(1),
    Effect.ignoreCause({ log: true }),
  );

  /**
   * Installs the latest gentle-ai release where gentle-ai's own install scripts put it (see
   * gentleAiInstallPath), which the binary lookup checks after PATH. Nothing changes PATH.
   */
  const install = Effect.gen(function* () {
    const current = yield* Ref.get(stateRef);
    if (current.installed && current.apiVersion !== null) return;
    const fail = (detail: string) => new GentleAiError({ detail });
    const target = gentleAiInstallPath(path, hostPlatform, environment);
    if (target === null) return yield* fail("This system has no folder to install gentle-ai in.");
    const version = yield* releases.latestVersion(GENTLE_AI_RELEASE_REPOSITORY);
    if (version === null) {
      return yield* fail("The latest gentle-ai release could not be found. Check the connection.");
    }
    const asset = gentleAiReleaseAsset(version, hostPlatform, arch);
    if (asset === null) return yield* fail("gentle-ai has no build for this system.");
    yield* releases.withVerifiedRelease(
      { repository: GENTLE_AI_RELEASE_REPOSITORY, version, asset, label: "gentle-ai", fail },
      (unpacked) =>
        Effect.gen(function* () {
          const fresh = path.join(unpacked, asset.replace(/\.tar\.gz$/, ""), path.basename(target));
          if (!(yield* fileSystem.exists(fresh).pipe(Effect.orElseSucceed(() => false)))) {
            return yield* fail("The download does not contain the gentle-ai program.");
          }
          yield* fileSystem.makeDirectory(path.dirname(target), { recursive: true }).pipe(
            Effect.andThen(fileSystem.copyFile(fresh, target)),
            Effect.andThen(
              hostPlatform === "win32" ? Effect.void : fileSystem.chmod(target, 0o755),
            ),
            Effect.mapError(() =>
              fail(`gentle-ai could not be installed in ${path.dirname(target)}.`),
            ),
          );
        }),
    );
  }).pipe(installLock.withPermits(1));

  const action = (input: GentleAiActionInput) =>
    Effect.gen(function* () {
      if (input.action === "refresh") {
        yield* refresh;
        return { status: yield* Ref.get(stateRef) } satisfies GentleAiActionResult;
      }
      if (input.action === "install") {
        // Detached, so a client that leaves mid-install stops waiting without cancelling the
        // install or the status read that follows it.
        const installing = yield* install.pipe(Effect.andThen(refresh), Effect.forkDetach);
        yield* Fiber.join(installing);
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

  const apiBinary = Effect.gen(function* () {
    const status = yield* Ref.get(stateRef);
    if (status.binaryPath === null || status.apiVersion === null)
      return yield* new GentleAiError({
        detail: "This gentle-ai has no headless API. Update it to manage Gentle AI from T3 Code.",
      });
    return status.binaryPath;
  });

  /** Validates a method's params, runs it, and validates what gentle-ai answers. */
  const callMethod = (
    method: GentleAiQueryMethod | GentleAiJobMethod,
    params: unknown,
    timeout: Duration.Input,
    onEvent?: (event: GentleAiApiEvent) => Effect.Effect<void>,
  ) =>
    Effect.gen(function* () {
      const spec = GENTLE_AI_METHODS[method];
      const binaryPath = yield* apiBinary;
      const invalid = () => new GentleAiError({ detail: `Invalid parameters for ${method}.` });
      const encodedParams = yield* spec
        .decodeParams(params)
        .pipe(Effect.flatMap(spec.encodeParams), Effect.mapError(invalid));
      const data = yield* runGentleAiApi({
        binaryPath,
        method,
        // T3 Code applies Claude Code profiles itself, only to Claude Code it runs through a
        // proxy (see ClaudeGentleProfile), so gentle-ai leaves ~/.claude alone.
        params:
          HOSTED_PROFILE_METHODS.has(method) &&
          typeof encodedParams === "object" &&
          encodedParams !== null
            ? { ...encodedParams, host: GENTLE_AI_PROFILE_HOST }
            : encodedParams,
        environment,
        timeout,
        ...(onEvent ? { onEvent } : {}),
      }).pipe(provide);
      // Decoding checks gentle-ai's answer against the contract; the wire gets it re-encoded.
      return yield* spec.decodeResult(data).pipe(
        Effect.flatMap(spec.encodeResult),
        Effect.mapError(
          () =>
            new GentleAiError({
              detail: `gentle-ai answered ${method} in a form this T3 Code does not understand.`,
            }),
        ),
      );
    });

  // Every read starts a gentle-ai process, so a settings page opening at once would start a
  // dozen. Identical reads share one run and its answer for a while; anything that changes what
  // gentle-ai set up goes through a job or a refresh, which clears them all.
  const queryCache = yield* Cache.makeWith(
    ({ method, params }: QueryKey) => {
      const decoded: unknown = JSON.parse(params);
      // Model discovery asks the agents' own CLIs, which can take a while.
      return callMethod(method, decoded, method === "models.get" ? "2 minutes" : "30 seconds");
    },
    {
      capacity: 256,
      timeToLive: (exit, key) => (Exit.isSuccess(exit) ? queryTimeToLive(key) : Duration.zero),
    },
  );
  const query = (method: GentleAiQueryMethod, params: unknown) =>
    Cache.get(queryCache, queryKey(method, params));

  const serviceScope = yield* Effect.scope;
  const jobRef = yield* Ref.make<GentleAiJob | null>(null);
  const jobChanges = yield* Effect.acquireRelease(
    PubSub.unbounded<GentleAiJob | null>(),
    PubSub.shutdown,
  );
  const JOB_LOG_LINES = 500;
  const updateJob = (update: (job: GentleAiJob) => GentleAiJob) =>
    Ref.updateAndGet(jobRef, (job) => (job === null ? job : update(job))).pipe(
      Effect.flatMap((job) => PubSub.publish(jobChanges, job)),
    );
  const onJobEvent = (event: GentleAiApiEvent) =>
    updateJob((job) => {
      if (event.type === "log") {
        return { ...job, log: [...job.log, event.message].slice(-JOB_LOG_LINES) };
      }
      const step = {
        id: event.step,
        ...(event.label === undefined ? {} : { label: event.label }),
        status: event.status,
        ...(event.error === undefined ? {} : { error: event.error }),
      };
      const index = job.steps.findIndex((existing) => existing.id === event.step);
      return {
        ...job,
        steps: index === -1 ? [...job.steps, step] : job.steps.with(index, step),
      };
    });

  const startJob = (method: GentleAiJobMethod, params: unknown) =>
    Effect.gen(function* () {
      yield* apiBinary;
      const started: GentleAiJob = {
        id: yield* crypto.randomUUIDv4.pipe(
          Effect.mapError(
            () => new GentleAiError({ detail: "Could not start the Gentle AI task." }),
          ),
        ),
        method,
        phase: "running",
        startedAt: DateTime.formatIso(yield* DateTime.now),
        finishedAt: null,
        steps: [],
        log: [],
      };
      const claimed = yield* Ref.modify(jobRef, (job) =>
        job?.phase === "running" ? [false, job] : [true, started],
      );
      if (!claimed)
        return yield* new GentleAiError({
          detail: "Another Gentle AI task is running. Wait for it to finish.",
        });
      yield* PubSub.publish(jobChanges, started);
      yield* callMethod(method, params, "30 minutes", onJobEvent).pipe(
        Effect.exit,
        Effect.flatMap((exit) =>
          Effect.gen(function* () {
            const finishedAt = DateTime.formatIso(yield* DateTime.now);
            const failure = Exit.findErrorOption(exit);
            // Clients re-read as soon as they hear a job finished, so answers from before it go
            // first. The refresh below clears them again along with status.
            yield* Cache.invalidateAll(queryCache);
            yield* updateJob((job) =>
              Exit.isSuccess(exit)
                ? { ...job, phase: "succeeded", finishedAt, result: exit.value }
                : {
                    ...job,
                    phase: "failed",
                    finishedAt,
                    error: Option.isSome(failure)
                      ? failure.value.detail
                      : "The Gentle AI task stopped unexpectedly.",
                  },
            );
            // Jobs change what gentle-ai set up, which providers and settings reflect.
            yield* refresh;
          }),
        ),
        Effect.forkIn(serviceScope),
      );
      return started;
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
    query,
    startJob,
    get streamJob() {
      return Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(jobChanges);
          const snapshot = yield* Ref.get(jobRef);
          return Stream.concat(Stream.make(snapshot), Stream.fromSubscription(subscription));
        }),
      );
    },
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
