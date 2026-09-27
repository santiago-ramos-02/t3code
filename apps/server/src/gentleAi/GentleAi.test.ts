import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
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

it("tags the skills and commands gentle-ai installed, so threads with it off can hide them", () => {
  const status = { ...NOT_INSTALLED, installed: true, drivers: gentleAiDrivers(["claude-code"]) };
  const skills: ServerProvider["skills"] = [
    { name: "judgment-day", path: "/s/judgment-day", enabled: true },
    { name: "mine", path: "/s/mine", enabled: true },
  ];
  const slashCommands: ServerProvider["slashCommands"] = [
    { name: "gentle-sdd-new" },
    { name: "ship" },
  ];
  const [claude] = withGentleAi([{ ...provider("claudeAgent"), skills, slashCommands }], status);
  expect(claude?.skills?.map((skill) => skill.package)).toEqual(["gentle-ai", undefined]);
  expect(claude?.slashCommands?.map((command) => command.package)).toEqual([
    "gentle-ai",
    undefined,
  ]);
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
          `const path = require("node:path");
const command = process.argv[2];
if (command === "sdd-status") {
  // Mirrors the native \`sdd-status [change] --cwd <dir> --json\` output shape.
  const args = process.argv.slice(3);
  const change = args[0] === "--cwd" ? null : args[0];
  const cwd = args[args.indexOf("--cwd") + 1];
  if (change === "broken") { process.stdout.write("not json"); process.exit(0); }
  const next = { "add-login": "apply", "fix-export": "spec" };
  const deps = (value) => Object.fromEntries(["proposal", "specs", "design", "tasks", "apply", "verify", "archive"].map((key) => [key, value]));
  const engram = path.basename(cwd) === "engram-project";
  process.stdout.write(JSON.stringify({
    schemaName: "gentle-ai.sdd-status",
    schemaVersion: 2,
    changeName: change,
    artifactStore: engram ? "engram" : "openspec",
    ...(engram ? {} : { planningHome: { mode: "repo-local", path: path.join(cwd, "openspec") } }),
    nextRecommended: change ? next[change] : "select-change",
    blockedReasons: [],
    dependencies: deps(change === "add-login" ? "ready" : "blocked"),
    actionContext: { mode: "repo-local", allowedEditRoots: [cwd] },
    taskProgress: change === "add-login" ? { total: 3, completed: 1, pending: 2 } : { total: 0, completed: 0, pending: 0 },
  }));
}
else if (command === "version") process.stdout.write("gentle-ai 3.7.0\\n");
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

        // Each active change gets its own native status; archives and stray files are skipped.
        const cwd = path.join(home, "project");
        const changes = path.join(cwd, "openspec", "changes");
        yield* fileSystem.makeDirectory(path.join(changes, "archive", "2026-01-01-old"), {
          recursive: true,
        });
        yield* fileSystem.makeDirectory(path.join(changes, "fix-export"));
        yield* fileSystem.makeDirectory(path.join(changes, "add-login"));
        yield* fileSystem.writeFileString(path.join(changes, "notes.md"), "not a change\n");
        const listed = yield* service.sddChanges(cwd);
        expect(listed.artifactStore).toBe("openspec");
        expect(
          listed.changes.map((change) => [
            change.changeName,
            change.nextRecommended,
            change.taskProgress.completed,
          ]),
        ).toEqual([
          ["add-login", "apply", 1],
          ["fix-export", "spec", 0],
        ]);
        // Engram keeps no change folders, so there is nothing to list.
        const engramProject = path.join(home, "engram-project");
        yield* fileSystem.makeDirectory(engramProject);
        expect(yield* service.sddChanges(engramProject)).toEqual({
          artifactStore: "engram",
          changes: [],
        });
        yield* fileSystem.makeDirectory(path.join(changes, "broken"));
        expect((yield* Effect.flip(service.sddChanges(cwd))).detail).toBe(
          "Gentle AI could not report SDD status for broken.",
        );
      }),
    ),
  );
});
