import * as NodeCrypto from "node:crypto";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { hostUserHome } from "../hostUserHome.ts";
import { compareSemverVersions } from "@t3tools/shared/semver";
import {
  PI_GENTLE_ORCHESTRATOR,
  PiGentleActionInput,
  PiGentlePersona,
  PiGentleRouting,
  PiGentleRoutingEntry,
  type PiGentleComposerState,
  type PiGentleState,
} from "@t3tools/contracts";
import * as Cache from "effect/Cache";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/http";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import { runGentleAiApi } from "../gentleAi/GentleAiApi.ts";
import { piPackages } from "./PiPlainExtensions.ts";
import { fetchNpmLatestVersion } from "./providerMaintenance.ts";
import { spawnAndCollect } from "./providerSnapshot.ts";

// Oldest gentle-pi whose profile and persona files T3 Code reads and writes.
const MINIMUM_GENTLE_VERSION = "3.5.0";
// Newest gentle-pi minor release T3 Code was verified against. Without gentle-pi's API, T3 Code
// writes Gentle AI's own config files, so a newer minor or major release may have changed what
// they mean. With the API, gentle-pi writes them itself and no warning applies.
const NEWEST_TESTED_GENTLE_MINOR = "3.7";

function gentleCompatibilityWarning(version: string): string | undefined {
  const [major = "0", minor = "0"] = version.split(".");
  return compareSemverVersions(`${major}.${minor}.0`, `${NEWEST_TESTED_GENTLE_MINOR}.0`) > 0
    ? `Gentle AI ${major}.${minor} is newer than the ${NEWEST_TESTED_GENTLE_MINOR} releases T3 Code was tested with. Profile and persona settings may not behave as expected.`
    : undefined;
}
const PROFILE_KIND = "gentle-pi.agent_model_profiles";
const PIN_KIND = "gentle-pi.agent_model_profile_pin";
const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const AGENT_NAME = /^[A-Za-z0-9._:@/+%-]+$/;
const MODEL_ID = /^[A-Za-z0-9._~:@/+%-]+$/;

export type GentleRouting = typeof PiGentleRouting.Type;

const RawRouting = Schema.Record(
  Schema.String,
  Schema.Union([Schema.String, PiGentleRoutingEntry]),
);
const ProfilesFile = Schema.Struct({
  kind: Schema.Literal(PROFILE_KIND),
  version: Schema.Literal(1),
  active: Schema.optionalKey(Schema.String),
  profiles: Schema.Record(Schema.String, RawRouting),
});
const ProfilePin = Schema.Struct({
  kind: Schema.Literal(PIN_KIND),
  version: Schema.Literal(1),
  profile: Schema.String,
});
const PersonaFile = Schema.Struct({ mode: PiGentlePersona });
const PiSettingsFile = Schema.Record(Schema.String, Schema.Unknown);
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
// Two-space JSON, the way Pi and Gentle AI write their own settings files.
const encodeGentleJson = Schema.encodeUnknownEffect(
  Schema.fromJsonString(Schema.Unknown, { space: 2 }),
);
const decodePin = Schema.decodeUnknownEffect(ProfilePin);
const decodePiSettings = Schema.decodeUnknownEffect(PiSettingsFile);
// What gentle-pi's API `state` reports.
const decodeApiState = Schema.decodeUnknownEffect(
  Schema.Struct({
    profiles: Schema.Array(Schema.Struct({ name: Schema.String, routing: PiGentleRouting })),
    active: Schema.NullOr(Schema.String),
    // Set when profiles.json cannot be read.
    profilesError: Schema.optionalKey(Schema.String),
    persona: PiGentlePersona,
    project: Schema.NullOr(
      Schema.Struct({
        pinAvailable: Schema.Boolean,
        pinned: Schema.NullOr(
          Schema.Struct({ profile: Schema.String, source: Schema.Literals(["local", "repo"]) }),
        ),
        persona: Schema.Struct({
          effective: PiGentlePersona,
          override: Schema.NullOr(PiGentlePersona),
        }),
      }),
    ),
  }),
);
export class PiGentleSettingsError extends Schema.TaggedError<PiGentleSettingsError>()(
  "PiGentleSettingsError",
  { detail: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return this.detail;
  }
}

const isPiGentleSettingsError = Schema.is(PiGentleSettingsError);
const decodeRawRouting = Schema.decodeUnknownSync(RawRouting);
const decodeProfilesFile = Schema.decodeUnknownSync(ProfilesFile);

function toGentleError(cause: unknown): PiGentleSettingsError {
  return isPiGentleSettingsError(cause)
    ? cause
    : new PiGentleSettingsError({
        detail: cause instanceof Error ? cause.message : "Gentle AI settings are unavailable.",
        cause,
      });
}

type ProfileStore = {
  kind: typeof PROFILE_KIND;
  version: 1;
  active?: string;
  profiles: Record<string, GentleRouting>;
};

function validProfileName(name: string): boolean {
  return PROFILE_NAME.test(name) && !["__proto__", "constructor", "prototype"].includes(name);
}

function parseRouting(value: unknown): GentleRouting {
  const decoded = decodeRawRouting(value);
  const routing: Record<string, PiGentleRoutingEntry> = {};
  for (const [agent, rawEntry] of Object.entries(decoded)) {
    if (!AGENT_NAME.test(agent))
      throw new PiGentleSettingsError({ detail: `Invalid Gentle agent name: ${agent}.` });
    const entry = typeof rawEntry === "string" ? { model: rawEntry } : rawEntry;
    if (entry.model !== undefined && !MODEL_ID.test(entry.model)) {
      throw new PiGentleSettingsError({ detail: `Invalid model for ${agent}.` });
    }
    routing[agent] = entry;
  }
  return routing;
}

function parseProfiles(value: unknown): ProfileStore {
  const decoded = decodeProfilesFile(value);
  const profiles: Record<string, GentleRouting> = {};
  for (const [name, routing] of Object.entries(decoded.profiles)) {
    if (!validProfileName(name))
      throw new PiGentleSettingsError({ detail: `Invalid Gentle profile name: ${name}.` });
    profiles[name] = parseRouting(routing);
  }
  if (decoded.active !== undefined && !Object.hasOwn(profiles, decoded.active)) {
    throw new PiGentleSettingsError({
      detail: "Gentle profiles.json has an invalid active profile.",
    });
  }
  return {
    kind: PROFILE_KIND,
    version: 1,
    profiles,
    ...(decoded.active === undefined ? {} : { active: decoded.active }),
  };
}

export type PiGentleAction = typeof PiGentleActionInput.Type.action;

/** The gentle-pi API call that performs an action. */
function apiCall(
  command: Exclude<PiGentleAction, { readonly type: "update" }>,
  userHome: string,
): readonly [method: string, params: unknown] {
  const cwd = command.cwd === undefined ? {} : { cwd: command.cwd };
  switch (command.type) {
    case "create":
      return ["profiles.create", { name: command.name }];
    case "save":
      return ["profiles.save", { name: command.name, routing: command.routing, ...cwd }];
    case "activate":
      // Activating applies everywhere, even in a project a pin governs.
      return ["profiles.apply", { name: command.name, cwd: command.cwd ?? userHome, global: true }];
    case "apply":
      return ["profiles.apply", { name: command.name, ...cwd }];
    case "pin":
      return ["pin.set", { name: command.name, ...cwd }];
    case "clearPin":
      return ["pin.clear", cwd];
    case "setGlobalPersona":
      return ["persona.set", { mode: command.mode }];
    case "setPersona":
      return ["persona.set", { mode: command.mode, ...cwd }];
  }
}

/** What a Pi provider instance offers for gentle-pi: its settings, read and changed through its API. */
export type PiGentleInstance = Effect.Success<ReturnType<typeof makePiGentleSettings>>;

export const makePiGentleSettings = Effect.fn("makePiGentleSettings")(function* (input: {
  readonly environment: NodeJS.ProcessEnv;
  readonly piBinaryPath?: string;
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly httpClient: HttpClient.HttpClient;
}) {
  const { environment, fileSystem, path, spawner } = input;
  const userHome = hostUserHome(environment, yield* HostProcessPlatform);
  const agentHome =
    environment.GENTLE_PI_AGENT_HOME ||
    environment.PI_CODING_AGENT_DIR ||
    path.join(userHome, ".pi", "agent");
  const configHome = environment.GENTLE_PI_CONFIG_HOME || path.join(userHome, ".pi", "gentle-ai");
  const profilesPath = path.join(configHome, "profiles.json");
  const modelsPath = path.join(configHome, "models.json");
  const globalPersonaPath = path.join(configHome, "persona.json");
  // Pi's own settings, where a profile's orchestrator entry becomes the default model.
  const piSettingsPath = path.join(agentHome, "settings.json");

  const readJson = (filePath: string) =>
    fileSystem.readFileString(filePath).pipe(Effect.flatMap(decodeJson));

  const writeAtomicText = (filePath: string, text: string) =>
    Effect.gen(function* () {
      yield* fileSystem.makeDirectory(path.dirname(filePath), { recursive: true });
      const temporary = `${filePath}.${NodeCrypto.randomUUID()}.tmp`;
      yield* fileSystem.writeFileString(temporary, text);
      yield* fileSystem
        .rename(temporary, filePath)
        .pipe(Effect.ensuring(fileSystem.remove(temporary, { force: true }).pipe(Effect.ignore)));
    });
  const writeAtomic = (filePath: string, value: unknown) =>
    Effect.flatMap(encodeJson(value), (json) => writeAtomicText(filePath, `${json}\n`));

  /**
   * The gentle-pi package Pi loads, from any source or scope Pi supports, supported or not;
   * null when Pi does not load it. A project's own install wins over the global one, as in Pi.
   */
  const gentlePackage = (cwd?: string) =>
    piPackages({ environment, ...(cwd === undefined ? {} : { cwd }) }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.map((packages) => {
        const found = packages.findLast((entry) => entry.manifest?.name === "gentle-pi");
        const version = found?.manifest?.version;
        return found === undefined || version === undefined
          ? null
          : { source: found.source, directory: found.directory, version };
      }),
      Effect.orElseSucceed(() => null),
    );
  const isSupported = (version: string | null | undefined): version is string =>
    typeof version === "string" && compareSemverVersions(version, MINIMUM_GENTLE_VERSION) >= 0;

  /**
   * Whether `pi update <source>` would install a newer gentle-pi, decided the way Pi updates
   * it: npm sources move to the latest release, git sources to the repository's current
   * commit. Pinned versions and refs never move, and a local folder is not Pi's to update, so
   * neither reports anything; neither does a check that cannot reach the registry or remote.
   */
  const git = (args: ReadonlyArray<string>, cwd?: string) =>
    spawner
      .string(
        ChildProcess.make("git", args, {
          ...(cwd === undefined ? {} : { cwd }),
          stdin: "ignore",
          stderr: "ignore",
        }),
      )
      .pipe(
        Effect.timeout("15 seconds"),
        Effect.map((output) => output.trim().split(/\s/)[0] ?? ""),
        Effect.orElseSucceed(() => ""),
      );
  const gitLocation = (source: string) =>
    source.startsWith("git:")
      ? source.slice("git:".length)
      : source.startsWith("https://")
        ? source.slice("https://".length)
        : null;
  /**
   * What `pi update <source>` would move gentle-pi to: npm's latest release, or the git
   * repository's current commit. Empty when that cannot be known, such as without a network.
   */
  const latestRemote = (source: string) =>
    source.startsWith("npm:")
      ? fetchNpmLatestVersion("gentle-pi").pipe(
          Effect.provideService(HttpClient.HttpClient, input.httpClient),
          Effect.map((latest) => latest ?? ""),
          Effect.orElseSucceed(() => ""),
        )
      : git(["ls-remote", `https://${(gitLocation(source) ?? "").split("@")[0]}`, "HEAD"]);
  // Settings re-read after every change, so the registry or remote is asked at most every few
  // minutes; an update clears it. What is installed is read fresh every time.
  const latestCache = yield* Cache.make({
    lookup: latestRemote,
    capacity: 8,
    timeToLive: "10 minutes",
  });
  /**
   * The installed commit for a git install, and whether `pi update <source>` would install a
   * newer gentle-pi. Pinned versions and refs never move, and a local folder is not Pi's to
   * update, so neither reports an update; neither does a check that cannot reach the remote.
   */
  const updateStatus = (found: { source: string; directory: string; version: string }) =>
    Effect.gen(function* () {
      const pinned = (gitLocation(found.source) ?? found.source.slice("npm:".length)).includes("@");
      if (found.source.startsWith("npm:")) {
        if (pinned) return {};
        const latest = yield* Cache.get(latestCache, found.source);
        return latest === ""
          ? {}
          : { updateAvailable: compareSemverVersions(latest, found.version) > 0 };
      }
      if (gitLocation(found.source) === null) return {};
      const commit = yield* git(["rev-parse", "HEAD"], found.directory);
      if (commit === "") return {};
      const installed = { commit: commit.slice(0, 7) };
      if (pinned) return installed;
      const latest = yield* Cache.get(latestCache, found.source);
      return latest === "" ? installed : { ...installed, updateAvailable: latest !== commit };
    });

  /**
   * gentle-pi's own API script, when the installed release ships one. Through it gentle-pi
   * reads and writes its files itself, so a profile applies exactly as it does in Pi, including
   * the routing in the agents' own files. Older releases get the file-based path below.
   */
  const apiScript = (found: Effect.Success<ReturnType<typeof gentlePackage>>) => {
    if (found === null || !isSupported(found.version)) return Effect.succeed(null);
    const script = path.join(found.directory, "bin", "gentle-pi-api.mjs");
    return fileSystem.exists(script).pipe(
      Effect.map((exists) => (exists ? script : null)),
      Effect.orElseSucceed(() => null),
    );
  };
  const callApi = (script: string, method: string, params: unknown) =>
    runGentleAiApi({
      // The API is a Node script. The server's own runtime runs it, as Node even under Electron.
      binaryPath: process.execPath,
      command: { name: "gentle-pi", leadingArgs: [script] },
      method,
      params,
      environment: {
        ...environment,
        ELECTRON_RUN_AS_NODE: "1",
        GENTLE_PI_AGENT_HOME: agentHome,
        GENTLE_PI_CONFIG_HOME: configHome,
      },
      timeout: "30 seconds",
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.mapError((cause) => new PiGentleSettingsError({ detail: cause.detail, cause })),
    );
  const readApiState = (script: string, cwd?: string) =>
    callApi(script, "state", cwd === undefined ? {} : { cwd }).pipe(
      Effect.flatMap(decodeApiState),
      Effect.mapError(toGentleError),
    );

  /**
   * Runs Pi to completion and fails with the tail of its output when it exits non-zero, so a
   * failed install or setup reaches the user instead of looking like success.
   */
  const runPi = (
    args: ReadonlyArray<string>,
    options: {
      readonly cwd?: string;
      readonly env: NodeJS.ProcessEnv;
      readonly timeout: Duration.Input;
      readonly failure: string;
    },
  ) =>
    Effect.gen(function* () {
      const binary = input.piBinaryPath ?? "pi";
      const resolved = yield* resolveSpawnCommand(binary, args, { env: options.env });
      const result = yield* spawnAndCollect(
        binary,
        ChildProcess.make(resolved.command, resolved.args, {
          ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
          env: options.env,
          extendEnv: false,
          shell: resolved.shell,
          stdin: "ignore",
        }),
      ).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.timeoutOrElse({
          duration: options.timeout,
          orElse: () =>
            Effect.fail(new PiGentleSettingsError({ detail: `${options.failure} Pi timed out.` })),
        }),
      );
      if (result.code === 0) return;
      const output = (result.stderr.trim() || result.stdout.trim()).split("\n").slice(-3);
      return yield* new PiGentleSettingsError({
        detail: `${options.failure} ${output.join(" ").slice(-400) || `Pi exited with code ${result.code}.`}`,
      });
    });

  const loadProfiles = Effect.gen(function* () {
    if (!(yield* fileSystem.exists(profilesPath))) {
      return { kind: PROFILE_KIND, version: 1, profiles: {} } satisfies ProfileStore;
    }
    const value = yield* readJson(profilesPath);
    return yield* Effect.try({ try: () => parseProfiles(value), catch: toGentleError });
  });

  const resolveProjectPaths = (cwd: string) =>
    Effect.gen(function* () {
      if (!path.isAbsolute(cwd))
        return yield* new PiGentleSettingsError({ detail: "Choose an absolute project folder." });
      const git = (args: ReadonlyArray<string>) =>
        spawner
          .string(ChildProcess.make("git", args, { cwd, stdin: "ignore", stderr: "ignore" }))
          .pipe(
            Effect.timeout("5 seconds"),
            Effect.map((output) => output.trim()),
          );
      const repository = yield* Effect.all([
        git(["rev-parse", "--show-toplevel"]),
        git(["rev-parse", "--path-format=absolute", "--git-common-dir"]),
      ]).pipe(Effect.orElseSucceed(() => null));
      return {
        localPin: repository
          ? path.join(path.resolve(repository[1]), "gentle-ai", "profile-pin.json")
          : null,
        repoPin: repository
          ? path.join(path.resolve(repository[0]), ".pi", "gentle-ai", "profile.json")
          : null,
      };
    });

  // Every Gentle read and action needs the project's git layout; composers re-read after each
  // turn, so the two git lookups are cached briefly instead of spawned every time.
  const projectPathsCache = yield* Cache.make({
    lookup: resolveProjectPaths,
    capacity: 64,
    timeToLive: "30 seconds",
  });
  const projectPaths = (cwd: string) => Cache.get(projectPathsCache, cwd);

  const readPin = (filePath: string) =>
    Effect.gen(function* () {
      if (!(yield* fileSystem.exists(filePath))) return null;
      return yield* readJson(filePath).pipe(
        Effect.flatMap(decodePin),
        Effect.map((pin) => (validProfileName(pin.profile) ? pin.profile : null)),
        Effect.orElseSucceed(() => null),
      );
    });

  /** The profile a project's pin selects: the checkout pin, then the repository declaration. */
  const resolvePin = (store: ProfileStore, cwd: string) =>
    Effect.gen(function* () {
      const paths = yield* projectPaths(cwd);
      const local = paths.localPin ? yield* readPin(paths.localPin) : null;
      const repo = paths.repoPin ? yield* readPin(paths.repoPin) : null;
      const pinned =
        local && Object.hasOwn(store.profiles, local)
          ? local
          : repo && Object.hasOwn(store.profiles, repo)
            ? repo
            : null;
      return {
        paths,
        pinned,
        source: pinned === null ? null : pinned === local ? ("local" as const) : ("repo" as const),
      };
    });

  const readPersona = (filePath: string) =>
    Effect.gen(function* () {
      if (!(yield* fileSystem.exists(filePath))) return null;
      return yield* readJson(filePath).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(PersonaFile)),
        Effect.map(({ mode }) => mode),
        Effect.orElseSucceed(() => null),
      );
    });

  const readFresh = (cwd?: string) =>
    Effect.gen(function* () {
      const found = yield* gentlePackage(cwd);
      const version = found?.version ?? null;
      // An outdated install reports its version so clients offer an update; clients show nothing
      // Gentle-related when there is no version at all.
      if (!isSupported(version))
        return {
          available: false,
          version,
          globalPersona: "gentleman",
          profiles: [],
          active: null,
          project: null,
        } satisfies PiGentleState;
      const update = found === null ? {} : yield* updateStatus(found);
      const script = yield* apiScript(found);
      if (script !== null) {
        const state = yield* readApiState(script, cwd);
        if (state.profilesError !== undefined)
          return yield* new PiGentleSettingsError({ detail: state.profilesError });
        return {
          available: true,
          version,
          ...update,
          globalPersona: state.persona,
          profiles: state.profiles,
          active: state.active,
          project: state.project
            ? {
                pinAvailable: state.project.pinAvailable,
                pinned: state.project.pinned?.profile ?? null,
                pinSource: state.project.pinned?.source ?? null,
                persona: { ...state.project.persona, global: state.persona },
              }
            : null,
        } satisfies PiGentleState;
      }
      const store = yield* loadProfiles;
      const pin = cwd ? yield* resolvePin(store, cwd) : null;
      const paths = pin?.paths ?? null;
      const globalPersona = (yield* readPersona(globalPersonaPath)) ?? "gentleman";
      const personaOverride = cwd
        ? yield* readPersona(path.join(path.resolve(cwd), ".pi", "gentle-ai", "persona.json"))
        : null;
      const compatibilityWarning = gentleCompatibilityWarning(version);
      return {
        available: true,
        version,
        ...update,
        ...(compatibilityWarning === undefined ? {} : { compatibilityWarning }),
        globalPersona,
        profiles: Object.entries(store.profiles).map(([name, routing]) => ({ name, routing })),
        active: store.active ?? null,
        project: paths
          ? {
              pinAvailable: paths.localPin !== null,
              pinned: pin?.pinned ?? null,
              pinSource: pin?.source ?? null,
              persona: {
                effective: personaOverride ?? globalPersona,
                global: globalPersona,
                override: personaOverride,
              },
            }
          : null,
      } satisfies PiGentleState;
    }).pipe(Effect.mapError(toGentleError));

  const readComposerFresh = (cwd: string) =>
    Effect.gen(function* () {
      const found = yield* gentlePackage(cwd);
      if (!isSupported(found?.version)) return { available: false } satisfies PiGentleComposerState;
      if (!path.isAbsolute(cwd))
        return yield* new PiGentleSettingsError({ detail: "Choose an absolute project folder." });
      const composerProfiles = (
        profiles: ReadonlyArray<{ readonly name: string; readonly routing: GentleRouting }>,
        pinned: string | null,
        active: string | null,
      ) => ({
        profiles: profiles.map(({ name, routing }) => {
          const orchestrator = routing[PI_GENTLE_ORCHESTRATOR];
          return orchestrator === undefined ? { name } : { name, orchestrator };
        }),
        effectiveProfile:
          pinned !== null
            ? { name: pinned, pinned: true }
            : active === null
              ? null
              : { name: active, pinned: false },
      });
      const script = yield* apiScript(found);
      // A broken profiles.json hides only the profile list.
      const profiles = yield* (
        script !== null
          ? readApiState(script, cwd).pipe(
              Effect.filterOrFail(
                (state) => state.profilesError === undefined,
                () => new PiGentleSettingsError({ detail: "Gentle profiles are unreadable." }),
              ),
              Effect.map((state) =>
                composerProfiles(
                  state.profiles,
                  state.project?.pinned?.profile ?? null,
                  state.active,
                ),
              ),
            )
          : loadProfiles.pipe(
              Effect.flatMap((store) =>
                resolvePin(store, cwd).pipe(
                  Effect.map((pin) =>
                    composerProfiles(
                      Object.entries(store.profiles).map(([name, routing]) => ({ name, routing })),
                      pin.pinned,
                      store.active ?? null,
                    ),
                  ),
                ),
              ),
            )
      ).pipe(Effect.orElseSucceed(() => ({})));
      return {
        available: true,
        ...profiles,
      } satisfies PiGentleComposerState;
    }).pipe(Effect.mapError(toGentleError));

  // Each read runs gentle-pi's API (Node) and git, and settings pages and composers read on
  // every open. Repeat reads reuse the answer briefly; T3's own changes clear it at once, and
  // changes made in Pi itself show up within the time to live. Without a usable gentle-pi a
  // read runs nothing, so that answer is never kept and an install shows up straight away.
  const keepAvailable = (exit: Exit.Exit<{ readonly available: boolean }, unknown>) =>
    Exit.isSuccess(exit) && exit.value.available ? Duration.seconds(30) : Duration.zero;
  const readCache = yield* Cache.makeWith(
    (cwd: string) => readFresh(cwd === "" ? undefined : cwd),
    { capacity: 64, timeToLive: keepAvailable },
  );
  const composerCache = yield* Cache.makeWith(readComposerFresh, {
    capacity: 64,
    timeToLive: keepAvailable,
  });
  /** gentle-pi's state for a folder; `refresh` skips a kept answer, as after a Gentle AI job. */
  const read = (cwd?: string, options?: { readonly refresh?: boolean }) =>
    (options?.refresh === true ? Cache.invalidate(readCache, cwd ?? "") : Effect.void).pipe(
      Effect.andThen(Cache.get(readCache, cwd ?? "")),
    );
  const readComposer = (cwd: string) => Cache.get(composerCache, cwd);
  const forgetReads = Effect.all([
    Cache.invalidateAll(readCache),
    Cache.invalidateAll(composerCache),
  ]).pipe(Effect.asVoid);
  /** What a change reads back: gentle-pi's state from after it, never a kept answer. */
  const readAfterChange = (cwd?: string) => forgetReads.pipe(Effect.andThen(read(cwd)));

  /**
   * Makes a profile's orchestrator entry Pi's default model, as Gentle AI's own apply does. A
   * profile without an orchestrator model leaves Pi's settings untouched.
   */
  const applyOrchestrator = (entry: PiGentleRoutingEntry | undefined) =>
    Effect.gen(function* () {
      const model = entry?.model;
      if (model === undefined) return;
      const separator = model.indexOf("/");
      if (separator <= 0 || separator === model.length - 1)
        return yield* new PiGentleSettingsError({
          detail: `The orchestrator model ${model} is not a provider/model pair.`,
        });
      // An unreadable settings file is refused rather than replaced, like Gentle AI does.
      const settings: Record<string, unknown> = (yield* fileSystem.exists(piSettingsPath))
        ? { ...(yield* readJson(piSettingsPath).pipe(Effect.flatMap(decodePiSettings))) }
        : {};
      settings.defaultProvider = model.slice(0, separator);
      settings.defaultModel = model.slice(separator + 1);
      if (entry?.thinking === undefined) delete settings.defaultThinkingLevel;
      else settings.defaultThinkingLevel = entry.thinking;
      // Gentle AI's serialization of Pi settings: two-space indent and a trailing newline.
      yield* writeAtomicText(piSettingsPath, `${yield* encodeGentleJson(settings)}\n`);
    }).pipe(
      Effect.mapError((cause) =>
        isPiGentleSettingsError(cause)
          ? cause
          : new PiGentleSettingsError({
              detail: `The orchestrator could not be set in ${piSettingsPath}.`,
              cause,
            }),
      ),
    );

  /**
   * Activates `name` everywhere Gentle AI reads it: subagent routing in models.json, the active
   * marker, and the orchestrator in Pi's settings. A failure puts back models.json and restores
   * `previous` as the profile store.
   */
  const applyGlobalProfile = (store: ProfileStore, name: string, previous: ProfileStore = store) =>
    Effect.gen(function* () {
      const selected = store.profiles[name];
      if (!Object.hasOwn(store.profiles, name) || selected === undefined)
        return yield* new PiGentleSettingsError({ detail: "The profile no longer exists." });
      const hadModels = yield* fileSystem.exists(modelsPath);
      const previousModels = hadModels
        ? yield* readJson(modelsPath).pipe(
            Effect.flatMap((value) =>
              Effect.try({ try: () => parseRouting(value), catch: toGentleError }),
            ),
          )
        : {};
      const knownAgents = new Set([
        ...Object.keys(previousModels),
        ...Object.values(store.profiles).flatMap(Object.keys),
      ]);
      const nextModels = Object.fromEntries(
        [...knownAgents].map((agent) => [agent, selected[agent] ?? {}]),
      );
      const restoreModels = hadModels
        ? writeAtomic(modelsPath, previousModels)
        : fileSystem.remove(modelsPath, { force: true });
      yield* writeAtomic(modelsPath, nextModels);
      yield* writeAtomic(profilesPath, { ...store, active: name }).pipe(
        Effect.onError(() => restoreModels.pipe(Effect.ignore)),
      );
      yield* applyOrchestrator(selected[PI_GENTLE_ORCHESTRATOR]).pipe(
        Effect.onError(() =>
          Effect.all([restoreModels, writeAtomic(profilesPath, previous)]).pipe(Effect.ignore),
        ),
      );
    });

  const action = (command: PiGentleAction) =>
    Effect.gen(function* () {
      if (command.type === "update") {
        // An outdated gentle-pi still counts as installed here, so it can be updated in place
        // from the same source and scope Pi installed it with.
        const found = yield* gentlePackage(command.cwd);
        if (found === null)
          return yield* new PiGentleSettingsError({ detail: "Gentle AI is not installed for Pi." });
        yield* runPi(["update", found.source], {
          ...(command.cwd === undefined ? {} : { cwd: command.cwd }),
          env: environment,
          timeout: "5 minutes",
          failure: "Gentle AI update failed.",
        });
        yield* Cache.invalidateAll(latestCache);
        return yield* readAfterChange(command.cwd);
      }
      const found = yield* gentlePackage(command.cwd);
      if (!isSupported(found?.version))
        return yield* new PiGentleSettingsError({
          detail: "Gentle AI 3.5 or newer is not installed for this Pi instance.",
        });
      const script = yield* apiScript(found);
      if (script !== null) {
        const [method, params] = apiCall(command, userHome);
        yield* callApi(script, method, params);
        return yield* readAfterChange(command.cwd);
      }
      const store = yield* loadProfiles;
      if (command.type === "create") {
        if (!validProfileName(command.name))
          return yield* new PiGentleSettingsError({
            detail: "Use 1–64 letters, numbers, dots, underscores or hyphens for a profile name.",
          });
        if (Object.hasOwn(store.profiles, command.name))
          return yield* new PiGentleSettingsError({
            detail: "A profile with that name already exists.",
          });
        yield* writeAtomic(profilesPath, {
          ...store,
          profiles: { ...store.profiles, [command.name]: {} },
        });
      } else if (command.type === "save") {
        if (!Object.hasOwn(store.profiles, command.name))
          return yield* new PiGentleSettingsError({ detail: "The profile no longer exists." });
        const routing = yield* Effect.try({
          try: () => parseRouting(command.routing),
          catch: toGentleError,
        });
        const updated = {
          ...store,
          profiles: { ...store.profiles, [command.name]: routing },
        };
        if (store.active === command.name) yield* applyGlobalProfile(updated, command.name, store);
        else yield* writeAtomic(profilesPath, updated);
      } else if (command.type === "activate") {
        yield* applyGlobalProfile(store, command.name);
      } else if (command.type === "apply") {
        if (!Object.hasOwn(store.profiles, command.name))
          return yield* new PiGentleSettingsError({ detail: "The profile no longer exists." });
        const pin = yield* resolvePin(store, command.cwd);
        // A pin governs this project's subagents, so applying moves the checkout pin and leaves
        // global routing and the orchestrator default to the projects that read them.
        if (pin.pinned !== null && pin.paths.localPin !== null) {
          yield* writeAtomic(pin.paths.localPin, {
            kind: PIN_KIND,
            version: 1,
            profile: command.name,
          });
        } else {
          yield* applyGlobalProfile(store, command.name);
        }
      } else if (command.type === "pin") {
        if (!Object.hasOwn(store.profiles, command.name))
          return yield* new PiGentleSettingsError({ detail: "The profile no longer exists." });
        const paths = yield* projectPaths(command.cwd);
        if (!paths.localPin)
          return yield* new PiGentleSettingsError({
            detail: "Profile pins require a Git repository.",
          });
        yield* writeAtomic(paths.localPin, { kind: PIN_KIND, version: 1, profile: command.name });
      } else if (command.type === "clearPin") {
        const paths = yield* projectPaths(command.cwd);
        if (!paths.localPin)
          return yield* new PiGentleSettingsError({
            detail: "Profile pins require a Git repository.",
          });
        yield* fileSystem.remove(paths.localPin, { force: true });
      } else if (command.type === "setGlobalPersona") {
        yield* writeAtomic(globalPersonaPath, { mode: command.mode });
      } else if (command.type === "setPersona") {
        if (!path.isAbsolute(command.cwd))
          return yield* new PiGentleSettingsError({ detail: "Choose an absolute project folder." });
        const personaPath = path.join(
          path.resolve(command.cwd),
          ".pi",
          "gentle-ai",
          "persona.json",
        );
        if (command.mode === null) {
          yield* fileSystem.remove(personaPath, { force: true });
        } else {
          yield* writeAtomic(personaPath, { mode: command.mode });
        }
      }
      return yield* readAfterChange(command.cwd);
    }).pipe(
      // A change that failed partway may still have written something.
      Effect.onError(() => forgetReads),
      Effect.mapError(toGentleError),
    );

  return { read, readComposer, action };
});
