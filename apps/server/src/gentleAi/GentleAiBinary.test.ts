import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { gentleAiInstallPath, resolveGentleAiBinary } from "./GentleAiBinary.ts";

// Windows PATH lookup spells the extension its own way, and its paths ignore case.
const comparable = (platform: string, path: string | null) =>
  platform === "win32" ? path?.toLowerCase() : path;

it.layer(NodeServices.layer)("resolveGentleAiBinary", (it) => {
  it.effect("prefers the fork build T3 Code installed over a gentle-ai on PATH that is not", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const platform = yield* HostProcess.Platform;
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-gentle-ai-binary-" });
        const executable = platform === "win32" ? "gentle-ai.exe" : "gentle-ai";
        // Each gentle-ai is a link to node; a preload script answers `version` for the copy it
        // runs as, so these are real executables on every platform.
        const versions = path.join(root, "versions.json");
        const preload = path.join(root, "version.cjs");
        yield* fileSystem.writeFileString(
          preload,
          `const versions = require(${JSON.stringify(versions)});
process.stdout.write("gentle-ai " + versions[process.execPath] + "\\n");
process.exit(0);
`,
        );
        const pathDir = path.join(root, "bin");
        const home = path.join(root, "home");
        const environment = {
          PATH: pathDir,
          ...(platform === "win32"
            ? { PATHEXT: ".exe", LOCALAPPDATA: path.join(home, "local") }
            : {}),
          HOME: home,
          USERPROFILE: home,
          NODE_OPTIONS: `--require ${JSON.stringify(preload)}`,
        };
        const onPath = path.join(pathDir, executable);
        const installed = gentleAiInstallPath(path, platform, environment)!;
        const place = (target: string) =>
          Effect.gen(function* () {
            yield* fileSystem.makeDirectory(path.dirname(target), { recursive: true });
            yield* fileSystem
              .link(process.execPath, target)
              .pipe(Effect.catch(() => fileSystem.copyFile(process.execPath, target)));
          });
        yield* place(onPath);
        yield* place(installed);
        const resolve = (pathVersion: string) =>
          Effect.gen(function* () {
            yield* fileSystem.writeFileString(
              versions,
              JSON.stringify({ [onPath]: pathVersion, [installed]: "4.2.0-t3.d1dbfe0" }),
            );
            // A new version file means a new probe; the binaries themselves did not change.
            return yield* resolveGentleAiBinary("").pipe(
              Effect.provideService(HostProcess.Environment, environment),
            );
          });

        expect(comparable(platform, yield* resolve("4.2.0"))).toBe(comparable(platform, installed));
        // A configured path always wins.
        expect(
          yield* resolveGentleAiBinary("/custom/gentle-ai").pipe(
            Effect.provideService(HostProcess.Environment, environment),
          ),
        ).toBe("/custom/gentle-ai");
      }),
    ),
  );

  it.effect("keeps a fork build on PATH, and PATH when T3 Code installed nothing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const platform = yield* HostProcess.Platform;
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-gentle-ai-binary-" });
        const executable = platform === "win32" ? "gentle-ai.exe" : "gentle-ai";
        const preload = path.join(root, "version.cjs");
        yield* fileSystem.writeFileString(
          preload,
          `process.stdout.write("gentle-ai 4.2.0-t3.d1dbfe0\\n");\nprocess.exit(0);\n`,
        );
        const pathDir = path.join(root, "bin");
        const home = path.join(root, "home");
        const environment = {
          PATH: pathDir,
          ...(platform === "win32"
            ? { PATHEXT: ".exe", LOCALAPPDATA: path.join(home, "local") }
            : {}),
          HOME: home,
          USERPROFILE: home,
          NODE_OPTIONS: `--require ${JSON.stringify(preload)}`,
        };
        const onPath = path.join(pathDir, executable);
        yield* fileSystem.makeDirectory(pathDir, { recursive: true });
        yield* fileSystem
          .link(process.execPath, onPath)
          .pipe(Effect.catch(() => fileSystem.copyFile(process.execPath, onPath)));
        const resolve = resolveGentleAiBinary("").pipe(
          Effect.provideService(HostProcess.Environment, environment),
        );

        expect(comparable(platform, yield* resolve)).toBe(comparable(platform, onPath));
        const installed = gentleAiInstallPath(path, platform, environment)!;
        yield* fileSystem.makeDirectory(path.dirname(installed), { recursive: true });
        yield* fileSystem
          .link(process.execPath, installed)
          .pipe(Effect.catch(() => fileSystem.copyFile(process.execPath, installed)));
        // Both are fork builds, so PATH keeps winning.
        expect(comparable(platform, yield* resolve)).toBe(comparable(platform, onPath));
      }),
    ),
  );
});
