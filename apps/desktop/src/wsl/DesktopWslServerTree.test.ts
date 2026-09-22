import * as NodeCrypto from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopWslServerTree from "./DesktopWslServerTree.ts";

// The service reads packaged Windows roots through the (asar-aware, in
// Electron) fs, so a plain directory named server.asar exercises the full
// extraction path under plain Node.

const serverIdentityOf = (content: string): string =>
  `sha256-${NodeCrypto.createHash("sha256").update(content).digest("hex")}`;

const readMarkerJson = (
  raw: string,
): { readonly version?: unknown; readonly serverIdentity?: unknown } =>
  JSON.parse(raw) as { readonly version?: unknown; readonly serverIdentity?: unknown };

// Every entry violates the hardened marker contract exactly one way: wrong
// digest prefix, wrong digest length, or non-lowercase-hex digest bytes.
const MALFORMED_SERVER_IDENTITIES = [
  `sha512-${"a".repeat(64)}`,
  `sha256-${"b".repeat(63)}`,
  `sha256-${"c".repeat(65)}`,
  `sha256-${"Z".repeat(64)}`,
  `sha256-${"A".repeat(64)}`,
] as const;

const environmentLayer = (input: {
  readonly baseDir: string;
  readonly resourcesPath: string;
  readonly appVersion?: string;
  readonly isPackaged?: boolean;
  readonly platform?: NodeJS.Platform;
}) =>
  DesktopEnvironment.layer({
    dirname: "/repo/apps/desktop/src",
    homeDirectory: input.baseDir,
    platform: input.platform ?? "win32",
    processArch: "x64",
    appVersion: input.appVersion ?? "1.2.3",
    appPath: "/repo",
    isPackaged: input.isPackaged ?? true,
    resourcesPath: input.resourcesPath,
    runningUnderArm64Translation: false,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
        DesktopConfig.layerTest({
          T3CODE_HOME: input.baseDir,
          T3CODE_MODE: "desktop",
        }),
      ),
    ),
  );

const withTempDir = <A, E, R>(
  run: (tempDir: string) => Effect.Effect<A, E, R>,
): Effect.Effect<
  A,
  E | PlatformError.PlatformError,
  FileSystem.FileSystem | Exclude<R, Scope.Scope>
> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const tempDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-wsl-server-tree-test-",
    });
    return yield* run(tempDir);
  }).pipe(Effect.scoped);

const ensureWith = (input: {
  readonly baseDir: string;
  readonly resourcesPath: string;
  readonly appVersion?: string;
  readonly isPackaged?: boolean;
}) =>
  Effect.gen(function* () {
    const tree = yield* DesktopWslServerTree.DesktopWslServerTree;
    return yield* tree.ensure;
  }).pipe(
    Effect.provide(DesktopWslServerTree.layer.pipe(Layer.provideMerge(environmentLayer(input)))),
  );

describe("DesktopWslServerTree", () => {
  it.effect("bounds entry work across an eight-way nested tree", () =>
    Effect.gen(function* () {
      const active = yield* Ref.make(0);
      const maxActive = yield* Ref.make(0);
      const visited = yield* Ref.make(0);

      yield* DesktopWslServerTree.forEachBoundedTree([{ depth: 0, id: "root" }], (node) =>
        Effect.acquireUseRelease(
          Effect.gen(function* () {
            const current = yield* Ref.updateAndGet(active, (count) => count + 1);
            yield* Ref.update(maxActive, (maximum) => Math.max(maximum, current));
            yield* Ref.update(visited, (count) => count + 1);
          }),
          () =>
            Effect.gen(function* () {
              // Give every task in the current batch a chance to overlap.
              yield* Effect.yieldNow;
              if (node.depth === 4) return [];
              return Array.from({ length: 8 }, (_, index) => ({
                depth: node.depth + 1,
                id: `${node.id}.${String(index)}`,
              }));
            }),
          () => Ref.update(active, (count) => count - 1),
        ),
      );

      assert.equal(yield* Ref.get(active), 0);
      assert.equal(yield* Ref.get(maxActive), 8);
      assert.equal(yield* Ref.get(visited), 4_681);
    }),
  );

  it.effect("returns the server root unchanged when it is a plain directory (dev)", () =>
    withTempDir((tempDir) =>
      Effect.gen(function* () {
        const result = yield* ensureWith({
          baseDir: tempDir,
          resourcesPath: tempDir,
          isPackaged: false,
        });
        assert.isTrue(result.ok);
        assert.isFalse(result.ok && result.root.endsWith(".asar"));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("extracts an archive root into a version-keyed state directory", () =>
    withTempDir((tempDir) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const serverRoot = path.join(tempDir, "resources", "server.asar");
        yield* fileSystem.makeDirectory(path.join(serverRoot, "apps/server/dist"), {
          recursive: true,
        });
        yield* fileSystem.writeFileString(
          path.join(serverRoot, "apps/server/dist/bin.mjs"),
          "server-entry",
        );
        yield* fileSystem.makeDirectory(path.join(serverRoot, "node_modules/effect"), {
          recursive: true,
        });
        yield* fileSystem.writeFileString(
          path.join(serverRoot, "node_modules/effect/package.json"),
          "{}",
        );

        const result = yield* ensureWith({
          baseDir: tempDir,
          resourcesPath: path.join(tempDir, "resources"),
        });

        assert.isTrue(result.ok);
        const root = result.ok ? result.root : "";
        assert.include(root, path.join("wsl-server-tree", "1.2.3"));
        const entry = yield* fileSystem.readFileString(path.join(root, "apps/server/dist/bin.mjs"));
        assert.equal(entry, "server-entry");
        const dep = yield* fileSystem.exists(path.join(root, "node_modules/effect/package.json"));
        assert.isTrue(dep);
        const marker = yield* fileSystem.readFileString(
          path.join(root, "t3code-wsl-server-tree.json"),
        );
        assert.include(marker, '"version":"1.2.3"');
        assert.equal(readMarkerJson(marker).serverIdentity, serverIdentityOf("server-entry"));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("serializes concurrent extraction callers and publishes one complete tree", () =>
    withTempDir((tempDir) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const resourcesPath = path.join(tempDir, "resources");
        const serverRoot = path.join(resourcesPath, "server.asar");
        yield* fileSystem.makeDirectory(path.join(serverRoot, "apps/server/dist"), {
          recursive: true,
        });
        yield* fileSystem.writeFileString(
          path.join(serverRoot, "apps/server/dist/bin.mjs"),
          "server-entry",
        );

        const results = yield* Effect.gen(function* () {
          const tree = yield* DesktopWslServerTree.DesktopWslServerTree;
          return yield* Effect.all([tree.ensure, tree.ensure], { concurrency: "unbounded" });
        }).pipe(
          Effect.provide(
            DesktopWslServerTree.layer.pipe(
              Layer.provideMerge(environmentLayer({ baseDir: tempDir, resourcesPath })),
            ),
          ),
        );

        assert.isTrue(results.every((result) => result.ok));
        const roots = results.flatMap((result) => (result.ok ? [result.root] : []));
        assert.lengthOf(new Set(roots), 1);
        assert.equal(
          yield* fileSystem.readFileString(path.join(roots[0] ?? "", "apps/server/dist/bin.mjs")),
          "server-entry",
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reuses a completed extraction when the packaged backend entry is unchanged", () =>
    withTempDir((tempDir) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const serverRoot = path.join(tempDir, "resources", "server.asar");
        yield* fileSystem.makeDirectory(path.join(serverRoot, "apps/server/dist"), {
          recursive: true,
        });
        yield* fileSystem.writeFileString(path.join(serverRoot, "apps/server/dist/bin.mjs"), "v1");

        const first = yield* ensureWith({
          baseDir: tempDir,
          resourcesPath: path.join(tempDir, "resources"),
        });
        assert.isTrue(first.ok);
        const root = first.ok ? first.root : "";

        // A sentinel inside the extracted tree proves the second ensure reused
        // the directory instead of extracting again (extraction replaces the
        // version directory wholesale).
        yield* fileSystem.writeFileString(path.join(root, "reuse-sentinel"), "sentinel");

        const second = yield* ensureWith({
          baseDir: tempDir,
          resourcesPath: path.join(tempDir, "resources"),
        });
        assert.isTrue(second.ok);
        assert.equal(second.ok ? second.root : "", root);
        const entry = yield* fileSystem.readFileString(path.join(root, "apps/server/dist/bin.mjs"));
        assert.equal(entry, "v1");
        assert.equal(
          yield* fileSystem.readFileString(path.join(root, "reuse-sentinel")),
          "sentinel",
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("re-extracts when the packaged backend entry changes under the same app version", () =>
    withTempDir((tempDir) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const serverRoot = path.join(tempDir, "resources", "server.asar");
        yield* fileSystem.makeDirectory(path.join(serverRoot, "apps/server/dist"), {
          recursive: true,
        });
        yield* fileSystem.writeFileString(path.join(serverRoot, "apps/server/dist/bin.mjs"), "v1");

        const first = yield* ensureWith({
          baseDir: tempDir,
          resourcesPath: path.join(tempDir, "resources"),
        });
        assert.isTrue(first.ok);

        // Same app version, but the packaged server changed: the stale tree
        // must not be reused.
        yield* fileSystem.writeFileString(
          path.join(serverRoot, "apps/server/dist/bin.mjs"),
          "v2-same-version-rebuild",
        );
        const second = yield* ensureWith({
          baseDir: tempDir,
          resourcesPath: path.join(tempDir, "resources"),
        });
        assert.isTrue(second.ok);
        const root = second.ok ? second.root : "";
        const entry = yield* fileSystem.readFileString(path.join(root, "apps/server/dist/bin.mjs"));
        assert.equal(entry, "v2-same-version-rebuild");
        const marker = yield* fileSystem.readFileString(
          path.join(root, "t3code-wsl-server-tree.json"),
        );
        assert.equal(
          readMarkerJson(marker).serverIdentity,
          serverIdentityOf("v2-same-version-rebuild"),
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("treats legacy version-only markers as cache misses and migrates them", () =>
    withTempDir((tempDir) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const serverRoot = path.join(tempDir, "resources", "server.asar");
        yield* fileSystem.makeDirectory(path.join(serverRoot, "apps/server/dist"), {
          recursive: true,
        });
        yield* fileSystem.writeFileString(path.join(serverRoot, "apps/server/dist/bin.mjs"), "v1");

        const first = yield* ensureWith({
          baseDir: tempDir,
          resourcesPath: path.join(tempDir, "resources"),
        });
        assert.isTrue(first.ok);
        const root = first.ok ? first.root : "";

        // Simulate a marker written before the server-identity binding existed.
        yield* fileSystem.writeFileString(
          path.join(root, "t3code-wsl-server-tree.json"),
          '{"version":"1.2.3"}\n',
        );
        yield* fileSystem.writeFileString(
          path.join(serverRoot, "apps/server/dist/bin.mjs"),
          "v2-legacy-marker-migrate",
        );

        const second = yield* ensureWith({
          baseDir: tempDir,
          resourcesPath: path.join(tempDir, "resources"),
        });
        assert.isTrue(second.ok);
        const entry = yield* fileSystem.readFileString(path.join(root, "apps/server/dist/bin.mjs"));
        assert.equal(entry, "v2-legacy-marker-migrate");
        const marker = yield* fileSystem.readFileString(
          path.join(root, "t3code-wsl-server-tree.json"),
        );
        assert.equal(
          readMarkerJson(marker).serverIdentity,
          serverIdentityOf("v2-legacy-marker-migrate"),
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "fails safely instead of reusing stale code when the source identity is unreadable",
    () =>
      withTempDir((tempDir) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const serverRoot = path.join(tempDir, "resources", "server.asar");
          yield* fileSystem.makeDirectory(path.join(serverRoot, "apps/server/dist"), {
            recursive: true,
          });
          yield* fileSystem.writeFileString(
            path.join(serverRoot, "apps/server/dist/bin.mjs"),
            "v1",
          );

          const first = yield* ensureWith({
            baseDir: tempDir,
            resourcesPath: path.join(tempDir, "resources"),
          });
          assert.isTrue(first.ok);

          // The packaged backend entry vanished: its identity cannot be proven,
          // so the previously extracted tree must not be accepted as fresh.
          yield* fileSystem.remove(path.join(serverRoot, "apps/server/dist/bin.mjs"));
          const second = yield* ensureWith({
            baseDir: tempDir,
            resourcesPath: path.join(tempDir, "resources"),
          });
          assert.isFalse(second.ok);
          if (!second.ok) {
            assert.include(second.reason, "could not be extracted");
            assert.isFalse(second.fatal);
          }
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("sweeps stale version directories and leftover partials after extraction", () =>
    withTempDir((tempDir) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const serverRoot = path.join(tempDir, "resources", "server.asar");
        yield* fileSystem.makeDirectory(path.join(serverRoot, "apps/server/dist"), {
          recursive: true,
        });
        yield* fileSystem.writeFileString(path.join(serverRoot, "apps/server/dist/bin.mjs"), "x");

        // T3CODE_HOME is set to tempDir, so the desktop state dir resolves to
        // <tempDir>/userdata (no .t3 segment).
        const treeRoot = path.join(tempDir, "userdata", "wsl-server-tree");
        yield* fileSystem.makeDirectory(path.join(treeRoot, "1.0.0"), { recursive: true });
        yield* fileSystem.makeDirectory(path.join(treeRoot, "1.2.3.partial"), { recursive: true });

        const result = yield* ensureWith({
          baseDir: tempDir,
          resourcesPath: path.join(tempDir, "resources"),
        });
        assert.isTrue(result.ok);
        assert.isFalse(yield* fileSystem.exists(path.join(treeRoot, "1.0.0")));
        assert.isFalse(yield* fileSystem.exists(path.join(treeRoot, "1.2.3.partial")));
        assert.isTrue(yield* fileSystem.exists(path.join(treeRoot, "1.2.3")));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("re-extracts when the app version changes", () =>
    withTempDir((tempDir) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const serverRoot = path.join(tempDir, "resources", "server.asar");
        yield* fileSystem.makeDirectory(path.join(serverRoot, "apps/server/dist"), {
          recursive: true,
        });
        yield* fileSystem.writeFileString(path.join(serverRoot, "apps/server/dist/bin.mjs"), "old");

        const first = yield* ensureWith({
          baseDir: tempDir,
          resourcesPath: path.join(tempDir, "resources"),
          appVersion: "1.2.3",
        });
        assert.isTrue(first.ok);

        yield* fileSystem.writeFileString(path.join(serverRoot, "apps/server/dist/bin.mjs"), "new");
        const second = yield* ensureWith({
          baseDir: tempDir,
          resourcesPath: path.join(tempDir, "resources"),
          appVersion: "1.2.4",
        });
        assert.isTrue(second.ok);
        const root = second.ok ? second.root : "";
        assert.include(root, "1.2.4");
        const entry = yield* fileSystem.readFileString(path.join(root, "apps/server/dist/bin.mjs"));
        assert.equal(entry, "new");
        // The previous version's tree is gone.
        const treeRoot = path.dirname(root);
        assert.isFalse(yield* fileSystem.exists(path.join(treeRoot, "1.2.3")));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("removes the legacy Windows extraction tree without preparing a fallback", () =>
    withTempDir((tempDir) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const resourcesPath = path.join(tempDir, "resources");
        const treeRoot = path.join(tempDir, "userdata", "wsl-server-tree");
        yield* fileSystem.makeDirectory(path.join(treeRoot, "1.2.3"), { recursive: true });
        yield* fileSystem.writeFileString(path.join(treeRoot, "1.2.3", "legacy"), "old");

        yield* Effect.gen(function* () {
          const tree = yield* DesktopWslServerTree.DesktopWslServerTree;
          yield* tree.cleanupLegacy;
        }).pipe(
          Effect.provide(
            DesktopWslServerTree.layer.pipe(
              Layer.provideMerge(environmentLayer({ baseDir: tempDir, resourcesPath })),
            ),
          ),
        );

        assert.isFalse(yield* fileSystem.exists(treeRoot));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("re-extracts after legacy cleanup partially deletes the completed tree", () =>
    withTempDir((tempDir) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const resourcesPath = path.join(tempDir, "resources");
        const serverRoot = path.join(resourcesPath, "server.asar");
        const sourceEntryPath = path.join(serverRoot, "apps/server/dist/bin.mjs");
        yield* fileSystem.makeDirectory(path.dirname(sourceEntryPath), { recursive: true });
        yield* fileSystem.writeFileString(sourceEntryPath, "fresh-server-entry");

        const initial = yield* ensureWith({ baseDir: tempDir, resourcesPath });
        assert.isTrue(initial.ok);
        const versionDir = initial.ok ? initial.root : "";
        const treeRoot = path.dirname(versionDir);
        const extractedEntryPath = path.join(versionDir, "apps/server/dist/bin.mjs");
        let cleanupFailed = false;
        const partialCleanupFileSystem = Layer.effect(
          FileSystem.FileSystem,
          Effect.gen(function* () {
            const realFileSystem = yield* FileSystem.FileSystem;
            return {
              ...realFileSystem,
              remove: (target, options) =>
                String(target) === treeRoot && options?.recursive === true && !cleanupFailed
                  ? Effect.gen(function* () {
                      cleanupFailed = true;
                      yield* realFileSystem.remove(extractedEntryPath);
                      return yield* PlatformError.systemError({
                        _tag: "PermissionDenied",
                        module: "FileSystem",
                        method: "remove",
                        pathOrDescriptor: treeRoot,
                        description: "simulated partial legacy cleanup",
                      });
                    })
                  : realFileSystem.remove(target, options),
            } satisfies FileSystem.FileSystem;
          }),
        ).pipe(Layer.provide(NodeServices.layer));

        const result = yield* Effect.gen(function* () {
          const tree = yield* DesktopWslServerTree.DesktopWslServerTree;
          yield* tree.cleanupLegacy;
          return yield* tree.ensure;
        }).pipe(
          Effect.provide(
            DesktopWslServerTree.layer.pipe(
              Layer.provideMerge(environmentLayer({ baseDir: tempDir, resourcesPath })),
              Layer.provideMerge(partialCleanupFileSystem),
            ),
          ),
        );

        assert.isTrue(cleanupFailed);
        assert.isTrue(result.ok);
        assert.equal(yield* fileSystem.readFileString(extractedEntryPath), "fresh-server-entry");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reports a retryable failure when the archive cannot be read", () =>
    withTempDir((tempDir) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const result = yield* ensureWith({
          baseDir: tempDir,
          // resources dir exists but server.asar does not
          resourcesPath: path.join(tempDir, "resources"),
        });
        assert.isFalse(result.ok);
        if (!result.ok) {
          assert.include(result.reason, "could not be extracted");
          assert.isFalse(result.fatal);
        }
        const treeRoot = path.join(tempDir, "userdata", "wsl-server-tree");
        const leftovers = yield* fileSystem
          .readDirectory(treeRoot)
          .pipe(Effect.orElseSucceed(() => []));
        assert.deepStrictEqual(leftovers, []);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "cold extraction reads the backend entry for identity plus copy, warm ensures add one identity read each",
    () =>
      withTempDir((tempDir) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const resourcesPath = path.join(tempDir, "resources");
          const backendEntryPath = path.join(
            resourcesPath,
            "server.asar",
            "apps/server/dist/bin.mjs",
          );
          yield* fileSystem.makeDirectory(path.dirname(backendEntryPath), { recursive: true });
          yield* fileSystem.writeFileString(backendEntryPath, "v1");

          const backendEntryReads = yield* Ref.make(0);
          const countingFileSystem = Layer.effect(
            FileSystem.FileSystem,
            Effect.gen(function* () {
              const realFileSystem = yield* FileSystem.FileSystem;
              return {
                ...realFileSystem,
                readFile: (target) =>
                  Effect.gen(function* () {
                    if (target === backendEntryPath) {
                      yield* Ref.update(backendEntryReads, (count) => count + 1);
                    }
                    return yield* realFileSystem.readFile(target);
                  }),
              } satisfies FileSystem.FileSystem;
            }),
          ).pipe(Layer.provide(NodeServices.layer));

          yield* Effect.gen(function* () {
            const tree = yield* DesktopWslServerTree.DesktopWslServerTree;
            // Cold extraction hashes the packaged entry for identity once,
            // then copies it once: two backend-entry reads in total.
            const first = yield* tree.ensure;
            assert.isTrue(first.ok);
            assert.equal(yield* Ref.get(backendEntryReads), 2);
            // Each warm cached ensure re-hashes the packaged entry to
            // validate the marker instead of trusting it blindly.
            yield* Ref.set(backendEntryReads, 0);
            const second = yield* tree.ensure;
            assert.isTrue(second.ok);
            assert.equal(yield* Ref.get(backendEntryReads), 1);
            const third = yield* tree.ensure;
            assert.isTrue(third.ok);
            assert.equal(yield* Ref.get(backendEntryReads), 2);
          }).pipe(
            Effect.provide(
              DesktopWslServerTree.layer.pipe(
                Layer.provideMerge(environmentLayer({ baseDir: tempDir, resourcesPath })),
                Layer.provideMerge(countingFileSystem),
              ),
            ),
          );
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("packaged non-Windows fast path never reads the backend entry", () =>
    withTempDir((tempDir) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const resourcesPath = path.join(tempDir, "resources");
        // Deliberately no server.asar on disk: any backend-entry read is
        // counted instead of silently returning bytes.
        const backendEntrySuffix = path.join("apps/server/dist/bin.mjs");
        const backendEntryReads = yield* Ref.make(0);
        const countingFileSystem = Layer.effect(
          FileSystem.FileSystem,
          Effect.gen(function* () {
            const realFileSystem = yield* FileSystem.FileSystem;
            return {
              ...realFileSystem,
              readFile: (target) =>
                Effect.gen(function* () {
                  if (target.endsWith(backendEntrySuffix)) {
                    yield* Ref.update(backendEntryReads, (count) => count + 1);
                  }
                  return yield* realFileSystem.readFile(target);
                }),
            } satisfies FileSystem.FileSystem;
          }),
        ).pipe(Layer.provide(NodeServices.layer));

        const result = yield* Effect.gen(function* () {
          const tree = yield* DesktopWslServerTree.DesktopWslServerTree;
          return yield* tree.ensure;
        }).pipe(
          Effect.provide(
            DesktopWslServerTree.layer.pipe(
              Layer.provideMerge(
                environmentLayer({ baseDir: tempDir, resourcesPath, platform: "darwin" }),
              ),
              Layer.provideMerge(countingFileSystem),
            ),
          ),
        );

        assert.isTrue(result.ok);
        assert.isFalse(result.ok && result.root.includes("wsl-server-tree"));
        assert.equal(yield* Ref.get(backendEntryReads), 0);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects malformed marker server identities and re-extracts", () =>
    withTempDir((tempDir) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const resourcesPath = path.join(tempDir, "resources");
        const sourceEntryPath = path.join(resourcesPath, "server.asar", "apps/server/dist/bin.mjs");
        yield* fileSystem.makeDirectory(path.dirname(sourceEntryPath), { recursive: true });
        yield* fileSystem.writeFileString(sourceEntryPath, "v1");

        const first = yield* ensureWith({ baseDir: tempDir, resourcesPath });
        assert.isTrue(first.ok);
        const root = first.ok ? first.root : "";
        const markerPath = path.join(root, "t3code-wsl-server-tree.json");

        for (const serverIdentity of MALFORMED_SERVER_IDENTITIES) {
          // A sentinel inside the extracted tree proves the next ensure
          // replaced the directory instead of reusing it.
          yield* fileSystem.writeFileString(path.join(root, "malformed-sentinel"), serverIdentity);
          yield* fileSystem.writeFileString(
            markerPath,
            `{"version":"1.2.3","serverIdentity":"${serverIdentity}"}\n`,
          );
          const next = yield* ensureWith({ baseDir: tempDir, resourcesPath });
          assert.isTrue(next.ok);
          assert.equal(next.ok ? next.root : "", root);
          assert.isFalse(yield* fileSystem.exists(path.join(root, "malformed-sentinel")));
          assert.equal(
            yield* fileSystem.readFileString(path.join(root, "apps/server/dist/bin.mjs")),
            "v1",
          );
          assert.equal(
            readMarkerJson(yield* fileSystem.readFileString(markerPath)).serverIdentity,
            serverIdentityOf("v1"),
          );
        }
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});
