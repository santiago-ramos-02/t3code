import * as NodeOS from "node:os";
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

/** Preserve Pi's other extensions when Gentle is disabled for one thread. */
export const plainPiExtensionArgs = Effect.fn("plainPiExtensionArgs")(function* (input: {
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly bridgePath: string;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const agentHome =
    input.environment.PI_CODING_AGENT_DIR ?? path.join(NodeOS.homedir(), ".pi", "agent");
  const roots = [agentHome, path.join(input.cwd, ".pi")];
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
  for (const root of roots) {
    const settingsPath = path.join(root, "settings.json");
    if (yield* fileSystem.exists(settingsPath)) {
      const settings = yield* decodeSettings(yield* fileSystem.readFileString(settingsPath));
      for (const item of settings.packages ?? []) {
        const source = typeof item === "string" ? item : item.source;
        if (/^npm:(?:gentle-pi|gentle-engram)(?:@|$)/.test(source)) continue;
        const resolved = yield* Effect.try({
          try: () => packagePath(source, root, path),
          catch: (cause) =>
            new PiPlainExtensionError({ detail: "Unsupported Pi package source.", cause }),
        });
        const manifestPath = path.join(resolved, "package.json");
        if (!(yield* fileSystem.exists(manifestPath))) {
          return yield* Effect.fail(
            new PiPlainExtensionError({
              detail: `Pi package is unavailable for a plain thread: ${source}`,
            }),
          );
        }
        const manifest = yield* decodePackage(yield* fileSystem.readFileString(manifestPath));
        if (manifest.name === "gentle-pi" || manifest.name === "gentle-engram") continue;
        sources.push(resolved);
        yield* addResource(path.join(resolved, "skills"), skills);
        yield* addResource(path.join(resolved, "prompts"), prompts);
      }
      for (const extension of settings.extensions ?? []) {
        const candidate = extension.startsWith("~")
          ? path.join(NodeOS.homedir(), extension.slice(1))
          : path.resolve(root, extension);
        if (!candidate.includes(`${path.sep}gentle-pi${path.sep}`)) sources.push(candidate);
      }
      for (const skill of settings.skills ?? []) {
        const candidate = path.resolve(root, skill);
        if (!candidate.includes(`${path.sep}gentle-pi${path.sep}`))
          yield* addResource(candidate, skills);
      }
      for (const prompt of settings.prompts ?? []) {
        const candidate = path.resolve(root, prompt);
        if (!candidate.includes(`${path.sep}gentle-pi${path.sep}`))
          yield* addResource(candidate, prompts);
      }
    }
    sources.push(...(yield* extensionEntries(path.join(root, "extensions"))));
    yield* addResource(path.join(root, "skills"), skills);
    yield* addResource(path.join(root, "prompts"), prompts);
  }
  yield* addResource(path.join(NodeOS.homedir(), ".agents", "skills"), skills);
  yield* addResource(path.join(input.cwd, ".agents", "skills"), skills);
  const unique = [...new Set(sources.filter((source) => source !== input.bridgePath))];
  return [
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    ...unique.flatMap((source) => ["--extension", source]),
    ...[...new Set(skills)].flatMap((source) => ["--skill", source]),
    ...[...new Set(prompts)].flatMap((source) => ["--prompt-template", source]),
    "--extension",
    input.bridgePath,
  ];
});
