import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { compareSemverVersions } from "@t3tools/shared/semver";
import {
  PI_GENTLE_ORCHESTRATOR,
  PiGentleActionInput,
  PiGentlePersona,
  PiGentleRouting,
  PiGentleRoutingEntry,
  PiGentleSddPreferences,
  PiGentleSddStatus,
  type PiGentleComposerState,
  type PiGentleSddChange,
  type PiGentleState,
} from "@t3tools/contracts";
import * as Cache from "effect/Cache";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import { spawnAndCollect } from "./providerSnapshot.ts";

// Oldest gentle-pi whose profile, persona, and SDD files T3 Code reads and writes.
const MINIMUM_GENTLE_VERSION = "3.5.0";
// Newest gentle-pi minor release T3 Code was verified against. T3 Code writes Gentle AI's own
// config files, so a newer minor or major release may have changed what they mean.
const NEWEST_TESTED_GENTLE_MINOR = "3.7";

function gentleCompatibilityWarning(version: string): string | undefined {
  const [major = "0", minor = "0"] = version.split(".");
  return compareSemverVersions(`${major}.${minor}.0`, `${NEWEST_TESTED_GENTLE_MINOR}.0`) > 0
    ? `Gentle AI ${major}.${minor} is newer than the ${NEWEST_TESTED_GENTLE_MINOR} releases T3 Code was tested with. Profile, persona, and SDD settings may not behave as expected.`
    : undefined;
}
const PROFILE_KIND = "gentle-pi.agent_model_profiles";
const PIN_KIND = "gentle-pi.agent_model_profile_pin";
const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const AGENT_NAME = /^[A-Za-z0-9._:@/+%-]+$/;
const MODEL_ID = /^[A-Za-z0-9._~:@/+%-]+$/;

export type GentleRouting = typeof PiGentleRouting.Type;
export type GentleSddPreferences = typeof PiGentleSddPreferences.Type;

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
const PackageManifest = Schema.Struct({ version: Schema.String });
const PiPackageSettings = Schema.Struct({ packages: Schema.Array(Schema.String) });
const ProfilePin = Schema.Struct({
  kind: Schema.Literal(PIN_KIND),
  version: Schema.Literal(1),
  profile: Schema.String,
});
const PersonaFile = Schema.Struct({ mode: PiGentlePersona });
const PiSettingsFile = Schema.Record(Schema.String, Schema.Unknown);
const StoredSdd = Schema.Struct({
  executionMode: PiGentleSddPreferences.fields.executionMode,
  artifactStore: Schema.Literals(["openspec", "engram", "hybrid", "none", "both"]),
  chainedPrStrategy: Schema.Literals([
    "ask-on-risk",
    "auto-chain",
    "single-pr",
    "exception-ok",
    "auto-forecast",
    "ask-always",
    "single-pr-default",
    "force-chained",
  ]),
  reviewBudgetLines: PiGentleSddPreferences.fields.reviewBudgetLines,
  engramAvailable: Schema.Boolean,
  prompted: Schema.Boolean,
});
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
// Gentle AI's own serialization of sdd-preflight.json (two-space indent, no trailing newline).
const encodeGentleJson = Schema.encodeUnknownEffect(
  Schema.fromJsonString(Schema.Unknown, { space: 2 }),
);
const decodeManifest = Schema.decodeUnknownEffect(PackageManifest);
const decodePackageSettings = Schema.decodeUnknownEffect(PiPackageSettings);
const decodePin = Schema.decodeUnknownEffect(ProfilePin);
const decodePiSettings = Schema.decodeUnknownEffect(PiSettingsFile);
const decodeSdd = Schema.decodeUnknownEffect(StoredSdd);
const decodePreferences = Schema.decodeUnknownEffect(PiGentleSddPreferences);
const decodeNativeSddStatus = Schema.decodeUnknownEffect(
  Schema.Struct({
    schemaName: Schema.Literal("gentle-ai.sdd-status"),
    schemaVersion: Schema.Literal(2),
    ...PiGentleSddStatus.fields,
    planningHome: Schema.optionalKey(Schema.Struct({ path: Schema.String })),
  }),
);
// OpenSpec change folders are kebab-case names; anything else under `changes/` is not a change.
const CHANGE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

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

export const makePiGentleSettings = Effect.fn("makePiGentleSettings")(function* (input: {
  readonly environment: NodeJS.ProcessEnv;
  readonly piBinaryPath?: string;
  readonly binaryPath?: string;
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
}) {
  const { environment, fileSystem, path, spawner } = input;
  const agentHome =
    environment.GENTLE_PI_AGENT_HOME ||
    environment.PI_CODING_AGENT_DIR ||
    path.join(NodeOS.homedir(), ".pi", "agent");
  const configHome =
    environment.GENTLE_PI_CONFIG_HOME || path.join(NodeOS.homedir(), ".pi", "gentle-ai");
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

  /** Version of gentle-pi registered with Pi, supported or not; null when it is not installed. */
  const packageVersion = Effect.gen(function* () {
    const packagePath = path.join(agentHome, "npm", "node_modules", "gentle-pi", "package.json");
    const settingsPath = path.join(agentHome, "settings.json");
    if (!(yield* fileSystem.exists(packagePath)) || !(yield* fileSystem.exists(settingsPath)))
      return null;
    const manifest = yield* decodeManifest(yield* readJson(packagePath));
    const settings = yield* decodePackageSettings(yield* readJson(settingsPath));
    return settings.packages.some((entry) => /^npm:gentle-pi(?:@|$)/.test(entry))
      ? manifest.version
      : null;
  }).pipe(Effect.orElseSucceed(() => null));
  const isSupported = (version: string | null): version is string =>
    version !== null && compareSemverVersions(version, MINIMUM_GENTLE_VERSION) >= 0;
  const installed = packageVersion.pipe(Effect.map(isSupported));

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

  const bundledBinaryPath = (version: string) =>
    Effect.gen(function* () {
      const platform = yield* HostProcessPlatform;
      return path.join(
        agentHome,
        "npm",
        "node_modules",
        "gentle-pi",
        ".gentle-ai",
        `v${version}`,
        platform === "win32" ? "gentle-ai.exe" : "gentle-ai",
      );
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
        sdd: path.join(path.resolve(cwd), ".pi", "gentle-ai", "sdd-preflight.json"),
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

  const readSdd = (filePath: string) =>
    Effect.gen(function* () {
      if (!(yield* fileSystem.exists(filePath))) return null;
      return yield* readJson(filePath).pipe(
        Effect.flatMap(decodeSdd),
        Effect.map((stored) => {
          const artifactStore = stored.artifactStore === "both" ? "hybrid" : stored.artifactStore;
          const chainedPrStrategy =
            stored.chainedPrStrategy === "single-pr-default"
              ? "single-pr"
              : stored.chainedPrStrategy === "force-chained"
                ? "auto-chain"
                : stored.chainedPrStrategy === "auto-chain" ||
                    stored.chainedPrStrategy === "single-pr"
                  ? stored.chainedPrStrategy
                  : "ask-on-risk";
          return {
            engramAvailable: stored.engramAvailable,
            preferences: {
              executionMode: stored.executionMode,
              artifactStore,
              chainedPrStrategy,
              reviewBudgetLines: stored.reviewBudgetLines,
            } satisfies GentleSddPreferences,
          };
        }),
        Effect.orElseSucceed(() => null),
      );
    });

  const sddBinary = Effect.gen(function* () {
    if (
      environment.GENTLE_PI_GENTLE_AI_DEV_BINARY !== undefined ||
      (yield* fileSystem.exists(path.join(configHome, "dev-binary.json")))
    ) {
      return yield* new PiGentleSettingsError({
        detail: "SDD status is unavailable while a Gentle AI dev binary override is active.",
      });
    }
    if (input.binaryPath) return input.binaryPath;
    const version = yield* packageVersion;
    const bundledBinary = version === null ? null : yield* bundledBinaryPath(version);
    if (bundledBinary === null || !(yield* fileSystem.exists(bundledBinary))) {
      return yield* new PiGentleSettingsError({
        detail: "Gentle AI's bundled binary is missing. Update Gentle AI or set its binary path.",
      });
    }
    return bundledBinary;
  });

  const nativeSddStatus = (binary: string, cwd: string, changeName?: string) =>
    Effect.gen(function* () {
      // Resolved like the Pi executable so a Windows .cmd shim works as a custom binary path.
      const resolved = yield* resolveSpawnCommand(
        binary,
        ["sdd-status", ...(changeName === undefined ? [] : [changeName]), "--cwd", cwd, "--json"],
        { env: environment },
      );
      const output = yield* spawner
        .string(
          ChildProcess.make(resolved.command, resolved.args, {
            cwd,
            // The instance environment, like every other Pi and Gentle process for this provider.
            env: environment,
            extendEnv: false,
            shell: resolved.shell,
            stdin: "ignore",
            stderr: "ignore",
          }),
        )
        .pipe(Effect.timeout("5 seconds"));
      return yield* decodeNativeSddStatus(yield* decodeJson(output));
    }).pipe(
      Effect.mapError(
        (cause) =>
          new PiGentleSettingsError({
            detail: `Gentle AI could not report SDD status${changeName === undefined ? "" : ` for ${changeName}`}.`,
            cause,
          }),
      ),
    );

  /**
   * Lists the project's active OpenSpec changes with their native status. Gentle AI reports one
   * change at a time, so this finds the change folders under its planning home first.
   */
  const readSddChanges = (cwd: string) =>
    Effect.gen(function* () {
      const binary = yield* sddBinary;
      const overview = yield* nativeSddStatus(binary, cwd);
      if (overview.planningHome === undefined) {
        return yield* new PiGentleSettingsError({
          detail: "SDD changes are listed only for projects that save artifacts as OpenSpec files.",
        });
      }
      const changesDirectory = path.join(overview.planningHome.path, "changes");
      if (!(yield* fileSystem.exists(changesDirectory))) return [];
      const names: Array<string> = [];
      for (const name of yield* fileSystem.readDirectory(changesDirectory)) {
        if (name === "archive" || !CHANGE_NAME.test(name)) continue;
        const info = yield* fileSystem.stat(path.join(changesDirectory, name));
        if (info.type === "Directory") names.push(name);
      }
      names.sort((left, right) => left.localeCompare(right));
      return yield* Effect.forEach(
        names,
        (name) =>
          nativeSddStatus(binary, cwd, name).pipe(
            Effect.map(
              (status) =>
                ({
                  changeName: name,
                  artifactStore: status.artifactStore,
                  nextRecommended: status.nextRecommended,
                  blockedReasons: status.blockedReasons,
                  dependencies: status.dependencies,
                  actionContext: status.actionContext,
                  ...(status.remediationState === undefined
                    ? {}
                    : { remediationState: status.remediationState }),
                  taskProgress: status.taskProgress,
                }) satisfies PiGentleSddChange,
            ),
          ),
        { concurrency: 4 },
      );
    });

  const read = (cwd?: string) =>
    Effect.gen(function* () {
      const version = yield* packageVersion;
      // An outdated install reports its version so clients offer an update rather than an install.
      if (!isSupported(version))
        return {
          available: false,
          version,
          globalPersona: "gentleman",
          profiles: [],
          active: null,
          project: null,
        } satisfies PiGentleState;
      const store = yield* loadProfiles;
      const pin = cwd ? yield* resolvePin(store, cwd) : null;
      const paths = pin?.paths ?? null;
      const storedSdd = paths ? yield* readSdd(paths.sdd) : null;
      const globalPersona = (yield* readPersona(globalPersonaPath)) ?? "gentleman";
      const personaOverride = cwd
        ? yield* readPersona(path.join(path.resolve(cwd), ".pi", "gentle-ai", "persona.json"))
        : null;
      const compatibilityWarning = gentleCompatibilityWarning(version);
      return {
        available: true,
        version,
        ...(compatibilityWarning === undefined ? {} : { compatibilityWarning }),
        globalPersona,
        profiles: Object.entries(store.profiles).map(([name, routing]) => ({ name, routing })),
        active: store.active ?? null,
        project: paths
          ? {
              pinAvailable: paths.localPin !== null,
              pinned: pin?.pinned ?? null,
              pinSource: pin?.source ?? null,
              sdd: storedSdd?.preferences ?? null,
              persona: {
                effective: personaOverride ?? globalPersona,
                global: globalPersona,
                override: personaOverride,
              },
            }
          : null,
      } satisfies PiGentleState;
    }).pipe(Effect.mapError(toGentleError));

  const readComposer = (cwd: string, options?: { readonly includeChanges?: boolean }) =>
    Effect.gen(function* () {
      if (!(yield* installed))
        return {
          available: false,
          projectInitNeeded: false,
        } satisfies PiGentleComposerState;
      if (!path.isAbsolute(cwd))
        return yield* new PiGentleSettingsError({ detail: "Choose an absolute project folder." });
      const persistedSdd = yield* readSdd((yield* projectPaths(cwd)).sdd);
      const artifactStore = persistedSdd?.preferences.artifactStore ?? "openspec";
      const projectInitNeeded =
        (artifactStore === "openspec" || artifactStore === "hybrid") &&
        !(yield* fileSystem.exists(path.join(cwd, "openspec", "config.yaml")));
      // A broken profiles.json hides only the profile list; SDD actions stay usable.
      const profiles = yield* loadProfiles.pipe(
        Effect.flatMap((store) =>
          resolvePin(store, cwd).pipe(
            Effect.map((pin) => ({
              profiles: Object.entries(store.profiles).map(([name, routing]) => {
                const orchestrator = routing[PI_GENTLE_ORCHESTRATOR];
                return orchestrator === undefined ? { name } : { name, orchestrator };
              }),
              effectiveProfile:
                pin.pinned !== null
                  ? { name: pin.pinned, pinned: true }
                  : store.active === undefined
                    ? null
                    : { name: store.active, pinned: false },
            })),
          ),
        ),
        Effect.orElseSucceed(() => ({})),
      );
      return {
        available: true,
        projectInitNeeded,
        ...profiles,
        ...(options?.includeChanges
          ? yield* (projectInitNeeded ? Effect.succeed([]) : readSddChanges(cwd)).pipe(
              Effect.map((changes) => ({ changes })),
              // Listing failures stay in the payload so the rest of the Gentle menu still works.
              Effect.catch((error) =>
                Effect.succeed({ changesError: toGentleError(error).detail }),
              ),
            )
          : {}),
      } satisfies PiGentleComposerState;
    }).pipe(Effect.mapError(toGentleError));

  const initializeSdd = (cwd: string, command: "setup" | "review" = "setup") =>
    Effect.gen(function* () {
      if (!path.isAbsolute(cwd))
        return yield* new PiGentleSettingsError({ detail: "Choose an absolute project folder." });
      if (command === "review")
        return yield* new PiGentleSettingsError({
          detail: "Edit SDD preferences in Pi provider settings, then run setup again.",
        });
      if (!(yield* installed))
        return yield* new PiGentleSettingsError({ detail: "Gentle AI is not installed for Pi." });
      const packageHome = path.join(agentHome, "npm", "node_modules", "gentle-pi");
      const args = [
        "--no-extensions",
        "--extension",
        packageHome,
        "--no-session",
        "-p",
        "/gentle-sdd-init",
      ];
      const spawnEnv = {
        ...environment,
        PI_CODING_AGENT_DIR: agentHome,
        GENTLE_PI_CONFIG_HOME: configHome,
      };
      yield* runPi(args, {
        cwd,
        env: spawnEnv,
        timeout: "60 seconds",
        failure: "SDD setup failed.",
      });
    }).pipe(Effect.mapError(toGentleError));

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
      if (command.type === "install" || command.type === "update") {
        // An outdated gentle-pi still counts as installed here, so it can be updated in place.
        if (command.type === "update" && (yield* packageVersion) === null)
          return yield* new PiGentleSettingsError({ detail: "Install Gentle AI first." });
        yield* runPi([command.type, "npm:gentle-pi"], {
          env: { ...environment, PI_CODING_AGENT_DIR: agentHome },
          timeout: "2 minutes",
          failure:
            command.type === "install" ? "Gentle AI install failed." : "Gentle AI update failed.",
        });
        return yield* read(command.cwd);
      }
      if (!(yield* installed))
        return yield* new PiGentleSettingsError({
          detail: "Gentle AI 3.5 or newer is not installed for this Pi instance.",
        });
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
      } else {
        const preferences = yield* decodePreferences(command.preferences);
        const paths = yield* projectPaths(command.cwd);
        const engramAvailable = (yield* readSdd(paths.sdd))?.engramAvailable ?? false;
        // Gentle AI rewrites this file on every SDD preflight. Matching its exact serialization
        // keeps a committed copy (the team's shared SDD choices) free of formatting churn.
        yield* writeAtomicText(
          paths.sdd,
          yield* encodeGentleJson({ ...preferences, engramAvailable, prompted: false }),
        );
      }
      return yield* read(command.cwd);
    }).pipe(Effect.mapError(toGentleError));

  return { read, readComposer, action, initializeSdd };
});
