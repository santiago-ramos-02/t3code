import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import {
  PiGentleActionInput,
  PiGentlePersona,
  PiGentleRouting,
  PiGentleRoutingEntry,
  PiGentleSddPreferences,
  PiGentleSddStatus,
  type PiGentleComposerState,
  type PiGentleState,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

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
const decodeManifest = Schema.decodeUnknownEffect(PackageManifest);
const decodePackageSettings = Schema.decodeUnknownEffect(PiPackageSettings);
const decodePin = Schema.decodeUnknownEffect(ProfilePin);
const decodeSdd = Schema.decodeUnknownEffect(StoredSdd);
const decodePreferences = Schema.decodeUnknownEffect(PiGentleSddPreferences);
const decodeNativeSddStatus = Schema.decodeUnknownEffect(
  Schema.Struct({
    schemaName: Schema.Literal("gentle-ai.sdd-status"),
    schemaVersion: Schema.Literal(2),
    ...PiGentleSddStatus.fields,
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
  const routing: Record<string, typeof PiGentleRoutingEntry.Type> = {};
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

export function makePiGentleSettings(input: {
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

  const readJson = (filePath: string) =>
    fileSystem.readFileString(filePath).pipe(Effect.flatMap(decodeJson));

  const writeAtomic = (filePath: string, value: unknown) =>
    Effect.gen(function* () {
      yield* fileSystem.makeDirectory(path.dirname(filePath), { recursive: true });
      const temporary = `${filePath}.${NodeCrypto.randomUUID()}.tmp`;
      yield* fileSystem.writeFileString(temporary, `${yield* encodeJson(value)}\n`);
      yield* fileSystem
        .rename(temporary, filePath)
        .pipe(Effect.ensuring(fileSystem.remove(temporary, { force: true }).pipe(Effect.ignore)));
    });

  const installedVersion = Effect.gen(function* () {
    const packagePath = path.join(agentHome, "npm", "node_modules", "gentle-pi", "package.json");
    const settingsPath = path.join(agentHome, "settings.json");
    if (!(yield* fileSystem.exists(packagePath)) || !(yield* fileSystem.exists(settingsPath)))
      return null;
    const manifest = yield* decodeManifest(yield* readJson(packagePath));
    const settings = yield* decodePackageSettings(yield* readJson(settingsPath));
    const parts = manifest.version.split(".").map(Number);
    const major = parts[0] ?? 0;
    const minor = parts[1] ?? 0;
    return (major > 3 || (major === 3 && minor >= 5)) &&
      settings.packages.some((entry) => /^npm:gentle-pi(?:@|$)/.test(entry))
      ? manifest.version
      : null;
  }).pipe(Effect.orElseSucceed(() => null));
  const installed = installedVersion.pipe(Effect.map((version) => version !== null));

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

  const projectPaths = (cwd: string) =>
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

  const readPin = (filePath: string) =>
    Effect.gen(function* () {
      if (!(yield* fileSystem.exists(filePath))) return null;
      return yield* readJson(filePath).pipe(
        Effect.flatMap(decodePin),
        Effect.map((pin) => (validProfileName(pin.profile) ? pin.profile : null)),
        Effect.orElseSucceed(() => null),
      );
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

  const readSddStatus = (cwd: string) =>
    Effect.gen(function* () {
      if (
        environment.GENTLE_PI_GENTLE_AI_DEV_BINARY !== undefined ||
        (yield* fileSystem.exists(path.join(configHome, "dev-binary.json")))
      ) {
        return null;
      }
      const packageHome = path.join(agentHome, "npm", "node_modules", "gentle-pi");
      const manifest = yield* decodeManifest(
        yield* readJson(path.join(packageHome, "package.json")),
      );
      const bundledBinary = yield* bundledBinaryPath(manifest.version);
      const binary = input.binaryPath || bundledBinary;
      if (!input.binaryPath && !(yield* fileSystem.exists(binary))) return null;
      const output = yield* spawner
        .string(
          ChildProcess.make(binary, ["sdd-status", "--cwd", cwd, "--json"], {
            cwd,
            stdin: "ignore",
            stderr: "ignore",
          }),
        )
        .pipe(Effect.timeout("5 seconds"));
      const status = yield* decodeNativeSddStatus(yield* decodeJson(output));
      return {
        changeName: status.changeName,
        artifactStore: status.artifactStore,
        nextRecommended: status.nextRecommended,
        blockedReasons: status.blockedReasons,
        dependencies: status.dependencies,
        actionContext: status.actionContext,
        ...(status.remediationState === undefined
          ? {}
          : { remediationState: status.remediationState }),
        taskProgress: status.taskProgress,
      } satisfies PiGentleSddStatus;
    }).pipe(Effect.orElseSucceed(() => null));

  const read = (cwd?: string) =>
    Effect.gen(function* () {
      const version = yield* installedVersion;
      if (version === null)
        return {
          available: false,
          version: null,
          globalPersona: "gentleman",
          profiles: [],
          active: null,
          project: null,
        } satisfies PiGentleState;
      const store = yield* loadProfiles;
      const paths = cwd ? yield* projectPaths(cwd) : null;
      const local = paths?.localPin ? yield* readPin(paths.localPin) : null;
      const repo = paths?.repoPin ? yield* readPin(paths.repoPin) : null;
      const pinned =
        local && Object.hasOwn(store.profiles, local)
          ? local
          : repo && Object.hasOwn(store.profiles, repo)
            ? repo
            : null;
      const storedSdd = paths ? yield* readSdd(paths.sdd) : null;
      const globalPersona = (yield* readPersona(globalPersonaPath)) ?? "gentleman";
      const personaOverride = cwd
        ? yield* readPersona(path.join(path.resolve(cwd), ".pi", "gentle-ai", "persona.json"))
        : null;
      return {
        available: true,
        version,
        globalPersona,
        profiles: Object.entries(store.profiles).map(([name, routing]) => ({ name, routing })),
        active: store.active ?? null,
        project: paths
          ? {
              pinAvailable: paths.localPin !== null,
              pinned,
              pinSource:
                pinned === null ? null : pinned === local ? ("local" as const) : ("repo" as const),
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

  const readComposer = (cwd: string) =>
    Effect.gen(function* () {
      if (!(yield* installed))
        return {
          available: false,
          sddStatus: null,
          projectInitNeeded: false,
        } satisfies PiGentleComposerState;
      if (!path.isAbsolute(cwd))
        return yield* new PiGentleSettingsError({ detail: "Choose an absolute project folder." });
      const sddStatus = yield* readSddStatus(cwd);
      const persistedSdd = yield* readSdd((yield* projectPaths(cwd)).sdd);
      const artifactStore = persistedSdd?.preferences.artifactStore ?? "openspec";
      return {
        available: true,
        sddStatus,
        projectInitNeeded:
          (artifactStore === "openspec" || artifactStore === "hybrid") &&
          !(yield* fileSystem.exists(path.join(cwd, "openspec", "config.yaml"))),
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
      const resolved = yield* resolveSpawnCommand(input.piBinaryPath ?? "pi", args, {
        env: spawnEnv,
      });
      yield* spawner
        .string(
          ChildProcess.make(resolved.command, resolved.args, {
            cwd,
            env: spawnEnv,
            extendEnv: false,
            shell: resolved.shell,
            stdin: "ignore",
            stderr: "ignore",
          }),
        )
        .pipe(Effect.timeout("60 seconds"));
    }).pipe(Effect.mapError(toGentleError));

  const applyGlobalProfile = (store: ProfileStore, name: string) =>
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
      yield* writeAtomic(modelsPath, nextModels);
      yield* writeAtomic(profilesPath, { ...store, active: name }).pipe(
        Effect.onError(() =>
          (hadModels
            ? writeAtomic(modelsPath, previousModels)
            : fileSystem.remove(modelsPath, { force: true })
          ).pipe(Effect.ignore),
        ),
      );
    });

  const action = (command: PiGentleAction) =>
    Effect.gen(function* () {
      if (command.type === "install" || command.type === "update") {
        if (command.type === "update" && !(yield* installed))
          return yield* new PiGentleSettingsError({ detail: "Install Gentle AI first." });
        const spawnEnv = { ...environment, PI_CODING_AGENT_DIR: agentHome };
        const args = [command.type, "npm:gentle-pi"];
        const resolved = yield* resolveSpawnCommand(input.piBinaryPath ?? "pi", args, {
          env: spawnEnv,
        });
        yield* spawner
          .string(
            ChildProcess.make(resolved.command, resolved.args, {
              env: spawnEnv,
              extendEnv: false,
              shell: resolved.shell,
              stdin: "ignore",
              stderr: "pipe",
            }),
          )
          .pipe(Effect.timeout("2 minutes"));
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
        if (store.active === command.name) yield* applyGlobalProfile(updated, command.name);
        else yield* writeAtomic(profilesPath, updated);
      } else if (command.type === "activate") {
        yield* applyGlobalProfile(store, command.name);
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
        yield* writeAtomic(paths.sdd, { ...preferences, engramAvailable, prompted: false });
      }
      return yield* read(command.cwd);
    }).pipe(Effect.mapError(toGentleError));

  return { read, readComposer, action, initializeSdd };
}
