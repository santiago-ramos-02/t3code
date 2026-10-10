/**
 * Which gentle-ai binary T3 Code runs, shared by the GentleAi service and the providers that
 * ask gentle-ai what it added to their agent.
 *
 * @module gentleAi/GentleAiBinary
 */
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveCommandPath } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

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

/**
 * The configured binary, else gentle-ai on PATH, else the copy T3 Code installed, else the
 * copy gentle-pi bundles, else null.
 */
export const resolveGentleAiBinary = Effect.fn("resolveGentleAiBinary")(function* (
  configured: string,
) {
  const trimmed = configured.trim();
  if (trimmed) return trimmed;
  const onPath = yield* resolveCommandPath("gentle-ai").pipe(Effect.orElseSucceed(() => null));
  if (onPath) return onPath;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const hostPlatform = yield* HostProcess.Platform;
  const environment = yield* HostProcess.Environment;
  const installed = gentleAiInstallPath(path, hostPlatform, environment);
  if (
    installed !== null &&
    (yield* fileSystem.exists(installed).pipe(Effect.orElseSucceed(() => false)))
  ) {
    return installed;
  }
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
