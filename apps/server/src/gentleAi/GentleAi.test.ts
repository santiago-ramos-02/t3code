import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderDriverKind } from "@t3tools/contracts";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerSettings from "../serverSettings.ts";
import { GentleAi, gentleAiDrivers, layer, NOT_INSTALLED, withGentleAi } from "./GentleAi.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const provider = (
  driver: string,
  extra: { readonly installed?: boolean; readonly gentleAi?: boolean } = {},
) => ({ driver: ProviderDriverKind.make(driver), installed: true, ...extra });

it("maps the agents gentle-ai set up to the providers that run them", () => {
  expect(gentleAiDrivers(["claude-code", "opencode", "kiro-ide"])).toEqual([
    "claudeAgent",
    "opencode",
  ]);
});

it("marks installed providers whose agent Gentle AI set up, keeping a driver's own answer", () => {
  const status = { ...NOT_INSTALLED, installed: true, drivers: gentleAiDrivers(["codex", "pi"]) };
  const marked = withGentleAi(
    [
      provider("codex"),
      provider("claudeAgent"),
      provider("codex", { installed: false }),
      // Pi decides through its own packages, so gentle-ai's record never overrides it.
      provider("pi", { gentleAi: false }),
    ],
    status,
  );
  expect(marked.map((entry) => entry.gentleAi)).toEqual([true, undefined, undefined, false]);
});

it.layer(NodeServices.layer)("GentleAi service", (it) => {
  it.effect("reads the binary's version and what gentle-ai recorded", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const platform = yield* HostProcessPlatform;
        const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-gentle-ai-" });
        const script = path.join(home, "fake-gentle-ai.cjs");
        yield* fileSystem.writeFileString(
          script,
          `const command = process.argv[2];
if (command === "version") process.stdout.write("gentle-ai 3.7.0\\n");
else if (command === "doctor") { process.stdout.write("Summary: 7 passed, 0 failed\\n"); process.exit(1); }
else if (command === "sync") process.stdout.write("synced\\n");
else process.exit(3);
`,
        );
        const binary = path.join(home, platform === "win32" ? "gentle-ai.cmd" : "gentle-ai");
        yield* fileSystem.writeFileString(
          binary,
          platform === "win32"
            ? `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`
            : `#!/bin/sh\nexec '${process.execPath}' '${script}' "$@"\n`,
        );
        if (platform !== "win32") yield* fileSystem.chmod(binary, 0o755);
        yield* fileSystem.makeDirectory(path.join(home, ".gentle-ai"));
        yield* fileSystem.writeFileString(
          path.join(home, ".gentle-ai", "state.json"),
          encodeJson({
            installed_agents: ["claude-code", "codex"],
            installed_binary_version: "3.4.0",
            components: ["sdd", "engram"],
            preset: "full-gentleman",
            persona: "neutral",
          }),
        );

        const service = yield* Effect.gen(function* () {
          const gentleAi = yield* GentleAi;
          yield* gentleAi.refresh;
          return gentleAi;
        }).pipe(
          Effect.provide(
            layer.pipe(Layer.provide(ServerSettings.layerTest({ gentleAiBinaryPath: binary }))),
          ),
          Effect.provideService(HostProcessEnvironment, {
            ...process.env,
            HOME: home,
            USERPROFILE: home,
          }),
        );

        expect(yield* service.current).toEqual({
          installed: true,
          version: "3.7.0",
          binaryPath: binary,
          agents: ["claude-code", "codex"],
          drivers: ["claudeAgent", "codex"],
          preset: "full-gentleman",
          persona: "neutral",
          components: ["sdd", "engram"],
          // Assets were last synced by 3.4.0, so the running 3.7.0 needs a sync.
          syncNeeded: true,
        });
        // doctor reports problems through its exit code; its report is the result either way.
        expect((yield* service.action({ action: "doctor" })).output).toContain("7 passed");
        expect((yield* Effect.flip(service.action({ action: "upgrade" }))).detail).toContain(
          "gentle-ai upgrade failed.",
        );
      }),
    ),
  );
});
