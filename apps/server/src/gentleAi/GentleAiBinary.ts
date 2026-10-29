/**
 * Which gentle-ai binary T3 Code runs, shared by the GentleAi service and the providers that
 * ask gentle-ai what it added to their agent.
 *
 * @module gentleAi/GentleAiBinary
 */
import { spawnAndCollect } from "@t3tools/provider-core/server/snapshotProbe";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveCommandPath, resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";

import { piPackages } from "../provider/PiPlainExtensions.ts";

/** The GitHub repository whose releases T3 Code installs gentle-ai from. */
export const GENTLE_AI_RELEASE_REPOSITORY = "santiago-ramos-02/gentle-ai";

/** This system's archive in a gentle-ai release, or null when it publishes none for it. */
export function gentleAiReleaseAsset(
  version: string,
  platform: NodeJS.Platform,
  arch: string,
): string | null {
  const os =
    platform === "win32"
      ? "windows"
      : platform === "darwin" || platform === "linux"
        ? platform
        : null;
  const cpu = arch === "x64" ? "amd64" : arch === "arm64" ? "arm64" : null;
  if (os === null || cpu === null) return null;
  return `gentle-ai_${version.replace(/^v/, "")}_${os}_${cpu}.tar.gz`;
}

/**
 * Where T3 Code installs gentle-ai: the folder gentle-ai's own install scripts use, so either
 * install updates the other and gentle-ai's self-update replaces it in place.
 */
export function gentleAiInstallPath(
  path: Path.Path,
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
): string | null {
  if (platform === "win32") {
    const home = environment.USERPROFILE;
    const local = environment.LOCALAPPDATA ?? (home ? path.join(home, "AppData", "Local") : null);
    return local === null ? null : path.join(local, "Programs", "gentle-ai", "gentle-ai.exe");
  }
  return environment.HOME ? path.join(environment.HOME, ".local", "bin", "gentle-ai") : null;
}

/** Whether a gentle-ai version is a build of this fork, such as 4.2.0-t3.d1dbfe0. */
function isForkGentleAiVersion(version: string): boolean {
  return version.includes("-t3.");
}

// Keyed by the file's size and modification time: a self-update replaces the binary in place.
const forkBuilds = new Map<string, boolean>();

const isForkBuild = Effect.fn("GentleAiBinary.isForkBuild")(function* (binaryPath: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const info = yield* fileSystem.stat(binaryPath).pipe(Effect.option);
  if (Option.isNone(info)) return false;
  const key = [
    binaryPath,
    info.value.size,
    Option.match(info.value.mtime, { onNone: () => "", onSome: (date) => date.getTime() }),
  ].join(":");
  const known = forkBuilds.get(key);
  if (known !== undefined) return known;
  const environment = yield* HostProcess.Environment;
  const resolved = yield* resolveSpawnCommand(binaryPath, ["version"], { env: environment });
  const output = yield* spawnAndCollect(
    binaryPath,
    ChildProcess.make(resolved.command, resolved.args, {
      env: environment,
      extendEnv: false,
      shell: resolved.shell,
      stdin: "ignore",
    }),
  ).pipe(
    Effect.map((result) => result.stdout),
    Effect.timeoutOption("10 seconds"),
    Effect.map(Option.getOrElse(() => "")),
    Effect.orElseSucceed(() => ""),
  );
  const fork = isForkGentleAiVersion(output);
  forkBuilds.set(key, fork);
  return fork;
});

/**
 * The configured binary, else gentle-ai on PATH, else the copy T3 Code installed, else the
 * copy gentle-pi bundles, else null. A fork build T3 Code installed beats one on PATH that is
 * not, so installing from T3 Code takes effect over an upstream gentle-ai.
 */
export const resolveGentleAiBinary = Effect.fn("resolveGentleAiBinary")(function* (
  configured: string,
) {
  const trimmed = configured.trim();
  if (trimmed) return trimmed;
  const onPath = yield* resolveCommandPath("gentle-ai").pipe(Effect.orElseSucceed(() => null));
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const hostPlatform = yield* HostProcess.Platform;
  const environment = yield* HostProcess.Environment;
  const installPath = gentleAiInstallPath(path, hostPlatform, environment);
  const installed =
    installPath !== null &&
    (yield* fileSystem.exists(installPath).pipe(Effect.orElseSucceed(() => false)))
      ? installPath
      : null;
  // Windows paths ignore case, and PATH lookup spells the extension the way PATHEXT does.
  const samePath = (left: string, right: string) =>
    hostPlatform === "win32"
      ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
      : path.resolve(left) === path.resolve(right);
  if (onPath && installed && !samePath(onPath, installed)) {
    // Only both being present costs a version check.
    if (!(yield* isForkBuild(onPath)) && (yield* isForkBuild(installed))) return installed;
  }
  if (onPath) return onPath;
  if (installed) return installed;
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
});
