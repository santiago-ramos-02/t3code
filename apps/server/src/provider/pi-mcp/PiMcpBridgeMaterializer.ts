// @effect-diagnostics nodeBuiltinImport:off - node:crypto provides the content digest and unique temporary names.
import * as NodeCrypto from "node:crypto";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";

import { PI_MCP_EXTENSION_SOURCE } from "./PiMcpBridgeSource.ts";

export const PI_MCP_EXTENSION_DIGEST = NodeCrypto.createHash("sha256")
  .update(PI_MCP_EXTENSION_SOURCE)
  .digest("hex");
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

export class PiMcpBridgeError extends Data.TaggedError("PiMcpBridgeError")<{
  readonly detail: string;
}> {}

/**
 * Writes the T3 MCP bridge where Pi can load it and returns its path. Pi runs this file as code
 * with the thread's MCP credential, so it lives in a private folder under the server state
 * directory, is replaced atomically, and is reused only while its content is exactly this build's
 * source. The file name carries the source digest, so each build gets its own file.
 */
export const materializePiMcpExtension = Effect.fn("PiMcpBridge.materialize")(function* (
  stateDir: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.join(stateDir, "runtime", "pi-mcp");
  const extensionPath = path.join(directory, `t3-mcp-${PI_MCP_EXTENSION_DIGEST}.mjs`);

  yield* fileSystem.makeDirectory(directory, { recursive: true, mode: DIRECTORY_MODE });
  // A link below the state directory would send the credential-bearing bridge somewhere else.
  const expected = path.join(yield* fileSystem.realPath(stateDir), "runtime", "pi-mcp");
  if ((yield* fileSystem.realPath(directory)) !== expected) {
    return yield* new PiMcpBridgeError({
      detail: "The Pi MCP bridge folder is a link; refusing to use it.",
    });
  }
  // Windows has no POSIX permission bits; the user profile folder is private there instead.
  if (HostProcessPlatform.defaultValue() !== "win32") {
    yield* fileSystem.chmod(directory, DIRECTORY_MODE);
  }

  const published = fileSystem.readFileString(extensionPath).pipe(
    Effect.map((current) => current === PI_MCP_EXTENSION_SOURCE),
    Effect.orElseSucceed(() => false),
  );
  if (yield* published) return extensionPath;

  // Rename replaces whatever sits at the path (including a planted link) without following it,
  // and concurrent writers publish identical content, so the last rename is always correct.
  const temporaryPath = path.join(
    directory,
    `.t3-mcp-${PI_MCP_EXTENSION_DIGEST}.${NodeCrypto.randomUUID()}.tmp`,
  );
  yield* fileSystem.writeFileString(temporaryPath, PI_MCP_EXTENSION_SOURCE, { mode: FILE_MODE });
  yield* fileSystem.rename(temporaryPath, extensionPath).pipe(
    // Windows refuses a rename while another writer is replacing the same file. Its content is
    // identical, so the publish succeeded if the file now matches; otherwise try again shortly.
    Effect.catch((error) =>
      Effect.flatMap(published, (done) => (done ? Effect.void : Effect.fail(error))),
    ),
    Effect.retry({ times: 3, schedule: Schedule.spaced("10 millis") }),
    Effect.ensuring(fileSystem.remove(temporaryPath, { force: true }).pipe(Effect.ignore)),
  );
  return extensionPath;
});
