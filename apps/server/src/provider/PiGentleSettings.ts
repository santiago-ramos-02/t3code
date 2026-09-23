import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";
import {
  PiGentleActionInput,
  PiGentleRouting,
  PiGentleRoutingEntry,
  PiGentleSddPreferences,
  type PiGentleState,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

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

  const installed = Effect.gen(function* () {
    const packagePath = path.join(agentHome, "npm", "node_modules", "gentle-pi", "package.json");
    const settingsPath = path.join(agentHome, "settings.json");
    if (!(yield* fileSystem.exists(packagePath)) || !(yield* fileSystem.exists(settingsPath)))
      return false;
    const manifest = yield* decodeManifest(yield* readJson(packagePath));
    const settings = yield* decodePackageSettings(yield* readJson(settingsPath));
    const parts = manifest.version.split(".").map(Number);
    const major = parts[0] ?? 0;
    const minor = parts[1] ?? 0;
    return (
      (major > 3 || (major === 3 && minor >= 5)) &&
      settings.packages.some((entry) => /^npm:gentle-pi(?:@|$)/.test(entry))
    );
  }).pipe(Effect.orElseSucceed(() => false));

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

  const read = (cwd?: string) =>
    Effect.gen(function* () {
      if (!(yield* installed))
        return {
          available: false,
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
      return {
        available: true,
        profiles: Object.entries(store.profiles).map(([name, routing]) => ({ name, routing })),
        active: store.active ?? null,
        project: paths
          ? {
              pinAvailable: paths.localPin !== null,
              pinned,
              pinSource:
                pinned === local ? ("local" as const) : pinned === repo ? ("repo" as const) : null,
              sdd: storedSdd?.preferences ?? null,
            }
          : null,
      } satisfies PiGentleState;
    }).pipe(Effect.mapError(toGentleError));

  const action = (command: PiGentleAction) =>
    Effect.gen(function* () {
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
        yield* writeAtomic(profilesPath, {
          ...store,
          profiles: { ...store.profiles, [command.name]: routing },
        });
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
      } else {
        const preferences = yield* decodePreferences(command.preferences);
        const paths = yield* projectPaths(command.cwd);
        const engramAvailable = (yield* readSdd(paths.sdd))?.engramAvailable ?? false;
        yield* writeAtomic(paths.sdd, { ...preferences, engramAvailable, prompted: false });
      }
      return yield* read(command.cwd);
    }).pipe(Effect.mapError(toGentleError));

  return { read, action };
}
