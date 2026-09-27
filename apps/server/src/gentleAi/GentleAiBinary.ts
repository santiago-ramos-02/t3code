/**
 * Which gentle-ai binary T3 Code runs, shared by the GentleAi service and the providers that
 * ask gentle-ai what it added to their agent.
 *
 * @module gentleAi/GentleAiBinary
 */
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { resolveCommandPath } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { piPackages } from "../provider/PiPlainExtensions.ts";

/** The configured binary, else gentle-ai on PATH, else the copy gentle-pi bundles, else null. */
export const resolveGentleAiBinary = Effect.fn("resolveGentleAiBinary")(function* (
  configured: string,
) {
  const trimmed = configured.trim();
  if (trimmed) return trimmed;
  const onPath = yield* resolveCommandPath("gentle-ai").pipe(Effect.orElseSucceed(() => null));
  if (onPath) return onPath;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const hostPlatform = yield* HostProcessPlatform;
  const environment = yield* HostProcessEnvironment;
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
