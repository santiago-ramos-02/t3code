// @effect-diagnostics nodeBuiltinImport:off - Effect FileSystem does not expose O_NOFOLLOW, exclusive descriptor opens, hard links, or descriptor-scoped chmod required for safe publication.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";

import { PI_MCP_EXTENSION_SOURCE } from "./PiMcpBridgeSource.ts";

const digest = NodeCrypto.createHash("sha256").update(PI_MCP_EXTENSION_SOURCE).digest("hex");
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

export const PI_MCP_EXTENSION_DIGEST = digest;

function hasCode(cause: unknown, code: string): boolean {
  return typeof cause === "object" && cause !== null && "code" in cause && cause.code === code;
}

function sameIdentity(
  left: Pick<NodeFS.Stats, "dev" | "ino">,
  right: Pick<NodeFS.Stats, "dev" | "ino">,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertOwnedByCurrentUser(info: NodeFS.Stats, description: string): void {
  const uid = process.getuid?.();
  if (uid !== undefined && info.uid !== uid) {
    throw new Error(`${description} is not owned by the current user.`);
  }
}

async function assertPathIdentity(path: string, expected: NodeFS.Stats): Promise<void> {
  const observed = await NodeFSP.lstat(path);
  if (observed.isSymbolicLink() || !sameIdentity(observed, expected)) {
    throw new Error("Pi MCP bridge path identity changed during materialization.");
  }
}

async function ensureDirectory(path: string, mode?: number): Promise<NodeFSP.FileHandle> {
  try {
    await NodeFSP.mkdir(path, { mode });
  } catch (cause) {
    if (!hasCode(cause, "EEXIST")) throw cause;
  }

  const pathInfo = await NodeFSP.lstat(path);
  if (pathInfo.isSymbolicLink() || !pathInfo.isDirectory()) {
    throw new Error("Pi MCP bridge directory is not a real directory.");
  }
  const handle = await NodeFSP.open(
    path,
    NodeFS.constants.O_RDONLY | NodeFS.constants.O_DIRECTORY | NodeFS.constants.O_NOFOLLOW,
  );
  try {
    const info = await handle.stat();
    if (!info.isDirectory() || !sameIdentity(pathInfo, info)) {
      throw new Error("Pi MCP bridge directory identity changed before it was secured.");
    }
    assertOwnedByCurrentUser(info, "Pi MCP bridge directory");
    if (mode !== undefined) await handle.chmod(mode);
    const secured = await handle.stat();
    if (mode !== undefined && (secured.mode & 0o777) !== mode) {
      throw new Error("Pi MCP bridge directory permissions are not private.");
    }
    await assertPathIdentity(path, secured);
    return handle;
  } catch (cause) {
    await handle.close();
    throw cause;
  }
}

async function validatePublishedExtension(path: string): Promise<NodeFS.Stats> {
  const pathInfo = await NodeFSP.lstat(path);
  if (pathInfo.isSymbolicLink() || !pathInfo.isFile()) {
    throw new Error("Pi MCP bridge target is not a real regular file.");
  }
  const handle = await NodeFSP.open(
    path,
    NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW | NodeFS.constants.O_NONBLOCK,
  );
  try {
    const info = await handle.stat();
    if (!info.isFile() || !sameIdentity(pathInfo, info)) {
      throw new Error("Pi MCP bridge target identity changed before validation.");
    }
    assertOwnedByCurrentUser(info, "Pi MCP bridge target");
    if ((info.mode & 0o777) !== FILE_MODE) {
      throw new Error("Pi MCP bridge target permissions are not private.");
    }
    const contents = await handle.readFile({ encoding: "utf8" });
    if (contents !== PI_MCP_EXTENSION_SOURCE) {
      throw new Error("Pi MCP bridge target content does not match its digest.");
    }
    await assertPathIdentity(path, info);
    return info;
  } finally {
    await handle.close();
  }
}

async function unlinkIfIdentityMatches(path: string, expected: NodeFS.Stats): Promise<void> {
  try {
    const observed = await NodeFSP.lstat(path);
    if (!observed.isSymbolicLink() && sameIdentity(observed, expected)) {
      await NodeFSP.unlink(path);
    }
  } catch (cause) {
    if (!hasCode(cause, "ENOENT")) throw cause;
  }
}

async function materialize(stateDir: string): Promise<string> {
  const root = NodePath.resolve(stateDir);
  await NodeFSP.mkdir(root, { recursive: true, mode: DIRECTORY_MODE });
  const rootHandle = await ensureDirectory(root);
  const runtimeDirectory = NodePath.join(root, "runtime");
  let runtimeHandle: NodeFSP.FileHandle | undefined;
  let bridgeDirectoryHandle: NodeFSP.FileHandle | undefined;

  try {
    runtimeHandle = await ensureDirectory(runtimeDirectory);
    const bridgeDirectory = NodePath.join(runtimeDirectory, "pi-mcp");
    bridgeDirectoryHandle = await ensureDirectory(bridgeDirectory, DIRECTORY_MODE);
    const bridgeDirectoryInfo = await bridgeDirectoryHandle.stat();
    const extensionPath = NodePath.join(bridgeDirectory, `t3-mcp-${digest}.mjs`);

    try {
      await validatePublishedExtension(extensionPath);
      return extensionPath;
    } catch (cause) {
      if (!hasCode(cause, "ENOENT")) throw cause;
    }

    const temporaryPath = NodePath.join(
      bridgeDirectory,
      `.t3-mcp-${digest}.${process.pid}.${NodeCrypto.randomUUID()}.tmp`,
    );
    const temporaryHandle = await NodeFSP.open(
      temporaryPath,
      NodeFS.constants.O_WRONLY |
        NodeFS.constants.O_CREAT |
        NodeFS.constants.O_EXCL |
        NodeFS.constants.O_NOFOLLOW,
      FILE_MODE,
    );
    let temporaryInfo: NodeFS.Stats | undefined;
    try {
      temporaryInfo = await temporaryHandle.stat();
      if (!temporaryInfo.isFile()) {
        throw new Error("Pi MCP bridge temporary target is not a regular file.");
      }
      assertOwnedByCurrentUser(temporaryInfo, "Pi MCP bridge temporary target");
      await temporaryHandle.writeFile(PI_MCP_EXTENSION_SOURCE, { encoding: "utf8" });
      await temporaryHandle.sync();
      await temporaryHandle.chmod(FILE_MODE);
      temporaryInfo = await temporaryHandle.stat();
      await assertPathIdentity(temporaryPath, temporaryInfo);
      await assertPathIdentity(bridgeDirectory, bridgeDirectoryInfo);

      let publishedByThisCall = false;
      try {
        await NodeFSP.link(temporaryPath, extensionPath);
        publishedByThisCall = true;
      } catch (cause) {
        if (!hasCode(cause, "EEXIST")) throw cause;
      }

      const publishedInfo = await validatePublishedExtension(extensionPath);
      await assertPathIdentity(bridgeDirectory, bridgeDirectoryInfo);
      if (publishedByThisCall && !sameIdentity(publishedInfo, temporaryInfo)) {
        throw new Error("Pi MCP bridge publication lost its file identity.");
      }
      return extensionPath;
    } finally {
      try {
        if (temporaryInfo !== undefined) {
          await unlinkIfIdentityMatches(temporaryPath, temporaryInfo);
        }
      } finally {
        await temporaryHandle.close();
      }
    }
  } finally {
    await bridgeDirectoryHandle?.close();
    await runtimeHandle?.close();
    await rootHandle.close();
  }
}

export const materializePiMcpExtension = Effect.fn("PiMcpBridge.materialize")((stateDir: string) =>
  Effect.tryPromise(() => materialize(stateDir)),
);
