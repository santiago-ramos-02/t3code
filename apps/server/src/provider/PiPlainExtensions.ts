import { PI_GENTLE_PACKAGES } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { hostUserHome } from "../hostUserHome.ts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

const PackageEntry = Schema.Union([Schema.String, Schema.Struct({ source: Schema.String })]);
const PiResourceSettings = Schema.Struct({
  packages: Schema.optional(Schema.Array(PackageEntry)),
  extensions: Schema.optional(Schema.Array(Schema.String)),
  skills: Schema.optional(Schema.Array(Schema.String)),
  prompts: Schema.optional(Schema.Array(Schema.String)),
});
const decodeSettings = Schema.decodeUnknownEffect(Schema.fromJsonString(PiResourceSettings));
const ExtensionPackage = Schema.Struct({
  name: Schema.optional(Schema.String),
  version: Schema.optional(Schema.String),
  pi: Schema.optional(Schema.Struct({ extensions: Schema.optional(Schema.Array(Schema.String)) })),
});
const decodePackage = Schema.decodeUnknownEffect(Schema.fromJsonString(ExtensionPackage));

export class PiPlainExtensionError extends Data.TaggedError("PiPlainExtensionError")<{
  readonly detail: string;
  readonly cause?: unknown;
}> {}

function packagePath(source: string, settingsDir: string, path: Path.Path) {
  if (source.startsWith("npm:")) {
    const name = source.slice(4).replace(/@[^/@]+$/, "");
    if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name)) {
      throw new Error(`Pi package source is unsupported for plain threads: ${source}`);
    }
    return path.join(settingsDir, "npm", "node_modules", name);
  }
  if (source.startsWith("git:") || source.startsWith("https://")) {
    const location = source.startsWith("git:") ? source.slice(4) : source;
    const withoutRef = location.replace(/@[^/]+$/, "");
    const normalized = withoutRef.replace(/^https?:\/\//, "").replace(/\.git$/, "");
    if (!/^[a-z0-9.-]+\/[a-z0-9._/-]+$/i.test(normalized)) {
      throw new Error(`Pi package source is unsupported for plain threads: ${source}`);
    }
    return path.join(settingsDir, "git", ...normalized.split("/"));
  }
  if (source.startsWith("path:")) return path.resolve(settingsDir, source.slice(5));
  return path.resolve(settingsDir, source);
}

/** Pi's agent home: an unset or empty PI_CODING_AGENT_DIR falls back to ~/.pi/agent. */
export function piAgentHome(environment: NodeJS.ProcessEnv, userHome: string, path: Path.Path) {
  return environment.PI_CODING_AGENT_DIR || path.join(userHome, ".pi", "agent");
}

/** One entry of Pi's `packages` settings, resolved to where Pi installs it. */
export interface PiPackage {
  readonly source: string;
  /** The settings directory that declares it: Pi's agent home, or a project's `.pi`. */
  readonly root: string;
  readonly directory: string;
  /** Null when the package is declared but not installed, or its source is unsupported. */
  readonly manifest: typeof ExtensionPackage.Type | null;
}

/**
 * Packages Pi loads for a workspace, global first then project, resolved the way Pi's own
 * package manager lays them out. Without a cwd only global packages are listed.
 */
export const piPackages = Effect.fn("piPackages")(function* (input: {
  readonly cwd?: string;
  readonly environment: NodeJS.ProcessEnv;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const roots = [
    piAgentHome(
      input.environment,
      hostUserHome(input.environment, yield* HostProcess.Platform),
      path,
    ),
    ...(input.cwd === undefined ? [] : [path.join(input.cwd, ".pi")]),
  ];
  const packages: PiPackage[] = [];
  for (const root of roots) {
    const settingsPath = path.join(root, "settings.json");
    if (!(yield* fileSystem.exists(settingsPath))) continue;
    const settings = yield* decodeSettings(yield* fileSystem.readFileString(settingsPath));
    for (const item of settings.packages ?? []) {
      const source = typeof item === "string" ? item : item.source;
      const directory = yield* Effect.try({
        try: () => packagePath(source, root, path),
        catch: () => null,
      }).pipe(Effect.orElseSucceed(() => null));
      const manifestPath = directory === null ? null : path.join(directory, "package.json");
      const manifest =
        manifestPath !== null && (yield* fileSystem.exists(manifestPath))
          ? yield* decodePackage(yield* fileSystem.readFileString(manifestPath))
          : null;
      packages.push({ source, root, directory: directory ?? "", manifest });
    }
  }
  return packages;
});

/**
 * Settings list entries that name a resource. Others toggle one by name, such as
 * "-builtin:codemode", and are not paths Pi can load.
 */
const isResourcePath = (entry: string) => !/^[-+!]/.test(entry) && !entry.startsWith("builtin:");

/**
 * Pi launch arguments that load every installed extension, skill, and prompt template except
 * gentle-pi, for threads that run with Gentle AI disabled. Pi offers no per-package opt-out, so
 * this resolves resources the way Pi's own loader does and passes them explicitly.
 */
export const plainPiExtensionArgs = Effect.fn("plainPiExtensionArgs")(function* (input: {
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const userHome = hostUserHome(input.environment, yield* HostProcess.Platform);
  const roots = [piAgentHome(input.environment, userHome, path), path.join(input.cwd, ".pi")];
  const sources: string[] = [];
  const skills: string[] = [];
  const prompts: string[] = [];
  const addResource = (target: string, list: string[]) =>
    Effect.gen(function* () {
      if (yield* fileSystem.exists(target)) list.push(target);
    });
  const extensionEntries = (directory: string) =>
    Effect.gen(function* () {
      if (!(yield* fileSystem.exists(directory))) return [];
      const names = yield* fileSystem.readDirectory(directory);
      const entries: string[] = [];
      for (const name of names) {
        if (name.startsWith(".") || name.endsWith(".d.ts")) continue;
        const entryPath = path.join(directory, name);
        const info = yield* fileSystem.stat(entryPath);
        if (info.type === "File" && /\.(?:ts|js|mjs)$/.test(name)) {
          entries.push(entryPath);
          continue;
        }
        if (info.type !== "Directory") continue;
        const manifestPath = path.join(entryPath, "package.json");
        if (yield* fileSystem.exists(manifestPath)) {
          const manifest = yield* decodePackage(yield* fileSystem.readFileString(manifestPath));
          if (manifest.pi?.extensions?.length) {
            entries.push(entryPath);
            continue;
          }
        }
        for (const index of ["index.ts", "index.js", "index.mjs"]) {
          const candidate = path.join(entryPath, index);
          if (yield* fileSystem.exists(candidate)) {
            entries.push(candidate);
            break;
          }
        }
      }
      return entries;
    });
  for (const item of yield* piPackages(input)) {
    // A declared package that is not installed cannot load in Pi either.
    if (item.manifest === null) continue;
    if (item.manifest.name !== undefined && PI_GENTLE_PACKAGES.includes(item.manifest.name))
      continue;
    sources.push(item.directory);
    yield* addResource(path.join(item.directory, "skills"), skills);
    yield* addResource(path.join(item.directory, "prompts"), prompts);
  }
  for (const root of roots) {
    const settingsPath = path.join(root, "settings.json");
    if (yield* fileSystem.exists(settingsPath)) {
      const settings = yield* decodeSettings(yield* fileSystem.readFileString(settingsPath));
      for (const extension of (settings.extensions ?? []).filter(isResourcePath)) {
        const candidate = extension.startsWith("~")
          ? path.join(userHome, extension.slice(1))
          : path.resolve(root, extension);
        if (!candidate.includes(`${path.sep}gentle-pi${path.sep}`)) sources.push(candidate);
      }
      for (const skill of (settings.skills ?? []).filter(isResourcePath)) {
        const candidate = path.resolve(root, skill);
        if (!candidate.includes(`${path.sep}gentle-pi${path.sep}`))
          yield* addResource(candidate, skills);
      }
      for (const prompt of (settings.prompts ?? []).filter(isResourcePath)) {
        const candidate = path.resolve(root, prompt);
        if (!candidate.includes(`${path.sep}gentle-pi${path.sep}`))
          yield* addResource(candidate, prompts);
      }
    }
    sources.push(...(yield* extensionEntries(path.join(root, "extensions"))));
    yield* addResource(path.join(root, "skills"), skills);
    yield* addResource(path.join(root, "prompts"), prompts);
  }
  yield* addResource(path.join(userHome, ".agents", "skills"), skills);
  yield* addResource(path.join(input.cwd, ".agents", "skills"), skills);
  return [
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    ...[...new Set(sources)].flatMap((source) => ["--extension", source]),
    ...[...new Set(skills)].flatMap((source) => ["--skill", source]),
    ...[...new Set(prompts)].flatMap((source) => ["--prompt-template", source]),
  ];
});
