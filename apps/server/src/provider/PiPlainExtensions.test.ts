import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { plainPiExtensionArgs } from "./PiPlainExtensions.ts";

it.layer(NodeServices.layer)("plain Pi extension loading", (it) => {
  it.effect("keeps other Pi packages and loose extensions without loading gentle-pi", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-plain-pi-" });
        const agentHome = path.join(root, "agent");
        const cwd = path.join(root, "project");
        const other = path.join(agentHome, "npm", "node_modules", "pi-web-access");
        const projectPackage = path.join(cwd, ".pi", "npm", "node_modules", "project-tools");
        const localPackage = path.join(cwd, ".pi", "local-tools");
        const gitPackage = path.join(agentHome, "git", "github.com", "example", "shared-tools");
        const loose = path.join(cwd, ".pi", "extensions", "local.ts");
        yield* fileSystem.makeDirectory(other, { recursive: true });
        yield* fileSystem.makeDirectory(projectPackage, { recursive: true });
        yield* fileSystem.makeDirectory(localPackage, { recursive: true });
        yield* fileSystem.makeDirectory(gitPackage, { recursive: true });
        yield* fileSystem.makeDirectory(path.dirname(loose), { recursive: true });
        yield* fileSystem.writeFileString(path.join(other, "package.json"), "{}");
        yield* fileSystem.writeFileString(path.join(projectPackage, "package.json"), "{}");
        yield* fileSystem.writeFileString(path.join(localPackage, "package.json"), "{}");
        yield* fileSystem.writeFileString(path.join(gitPackage, "package.json"), "{}");
        yield* fileSystem.writeFileString(loose, "export default () => {};");
        yield* fileSystem.writeFileString(
          path.join(agentHome, "settings.json"),
          '{"packages":["npm:gentle-pi","npm:pi-web-access","git:github.com/example/shared-tools@v1"]}',
        );
        yield* fileSystem.writeFileString(
          path.join(cwd, ".pi", "settings.json"),
          '{"packages":["npm:project-tools","./local-tools"]}',
        );
        const args = yield* plainPiExtensionArgs({
          cwd,
          environment: { PI_CODING_AGENT_DIR: agentHome },
          bridgePath: path.join(root, "t3-bridge.mjs"),
        });
        expect(args.slice(0, 3)).toEqual([
          "--no-extensions",
          "--no-skills",
          "--no-prompt-templates",
        ]);
        expect(args).toContain(other);
        expect(args).toContain(projectPackage);
        expect(args).toContain(localPackage);
        expect(args).toContain(gitPackage);
        expect(args).toContain(loose);
        expect(args.slice(-2)).toEqual(["--extension", path.join(root, "t3-bridge.mjs")]);
        expect(args.some((arg) => arg.includes("gentle-pi"))).toBe(false);
      }),
    ),
  );
});
