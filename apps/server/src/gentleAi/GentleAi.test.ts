import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderDriverKind, type GentleAiJob, type ServerProvider } from "@t3tools/contracts";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

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
else if (command === "help") process.stdout.write("  sdd-status [change]\\n");
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
          // This gentle-ai predates the headless API and still has SDD.
          apiVersion: null,
          sdd: true,
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

  it.effect("answers API queries and runs one job at a time, streaming its progress", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const platform = yield* HostProcessPlatform;
        const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-gentle-ai-api-" });
        const release = path.join(home, "release-sync");
        const script = path.join(home, "fake-gentle-ai.cjs");
        // Speaks the headless API: JSON params on stdin, NDJSON events and one final line out.
        yield* fileSystem.writeFileString(
          script,
          `const fs = require("node:fs");
const [command, method] = process.argv.slice(2);
if (command === "version") { process.stdout.write("gentle-ai 3.8.0\\n"); process.exit(0); }
if (command !== "api") process.exit(3);
const params = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
const line = (value) => process.stdout.write(JSON.stringify({ schema: "gentle-ai.api/v1", ...value }) + "\\n");
if (method === "describe") line({ type: "result", data: { version: "3.8.0", apiVersion: 1, methods: ["describe", "status"], features: ["odd"] } });
else if (method === "status") line({ type: "result", data: { version: "3.8.0", system: { os: "linux", arch: "amd64", shell: "bash", supported: true }, agents: [{ id: "codex", name: "Codex", detected: true, installed: true, supported: true, configPath: "" }, { id: "claude-code", name: "Claude Code", detected: true, installed: false, supported: true, configPath: "" }], components: [{ id: "engram", name: "Engram", description: "", installed: true, requires: [] }], presets: [], personas: [], skills: [], state: { preset: "full-gentleman", pendingSync: false, syncNeeded: true, background: {} }, openCodeDetected: false, builderEngines: [] } });
else if (method === "backups.list") line({ type: "result", data: { backups: [{ id: "b1", createdAt: "2026-09-01T00:00:00Z", source: "install", description: params.note ?? "Before install", fileCount: 3, createdByVersion: "3.8.0", pinned: false }] } });
else if (method === "doctor") line({ type: "result", data: { checks: "not a list" } });
else if (method === "sync") {
  line({ type: "progress", step: "agent:codex", stage: "apply", status: "running" });
  line({ type: "log", message: "writing AGENTS.md" });
  // Waits for the test to observe the running job before finishing.
  const wait = () => fs.existsSync(${encodeJson(release)}) ? finish() : setTimeout(wait, 20);
  const finish = () => {
    line({ type: "progress", step: "agent:codex", stage: "apply", status: "succeeded" });
    line({ type: "result", data: { files: ["AGENTS.md"] } });
  };
  wait();
}
else if (method === "backups.delete") line({ type: "error", error: { code: "not_found", message: "No backup b9." } });
else line({ type: "error", error: { code: "unsupported", message: "unknown method" } });
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

        // Built into the test's scope: jobs run in the service's scope, which must stay open.
        const context = yield* Layer.build(
          layer.pipe(Layer.provide(ServerSettings.layerTest({ gentleAiBinaryPath: binary }))),
        ).pipe(
          Effect.provideService(HostProcessEnvironment, {
            ...process.env,
            HOME: home,
            USERPROFILE: home,
          }),
        );
        const service = Context.get(context, GentleAi);
        yield* service.refresh;
        // A gentle-ai with the API and without SDD (it moved to ODD) lists no SDD changes.
        // Everything comes from the API: no state file here, and SDD from describe's features.
        expect(yield* service.current).toMatchObject({
          apiVersion: 1,
          sdd: false,
          agents: ["codex"],
          components: ["engram"],
          preset: "full-gentleman",
          syncNeeded: true,
        });
        expect((yield* Effect.flip(service.sddChanges(home))).detail).toContain("uses ODD");

        expect(yield* service.query("backups.list", {})).toEqual({
          backups: [
            {
              id: "b1",
              createdAt: "2026-09-01T00:00:00Z",
              source: "install",
              description: "Before install",
              fileCount: 3,
              createdByVersion: "3.8.0",
              pinned: false,
            },
          ],
        });
        // An answer that breaks the contract fails instead of reaching clients.
        expect(
          (yield* service.query("doctor", {}).pipe(Effect.asVoid, Effect.flip)).detail,
        ).toContain("does not understand");
        // Params are checked before gentle-ai runs.
        expect(
          (yield* service.query("models.get", {}).pipe(Effect.asVoid, Effect.flip)).detail,
        ).toBe("Invalid parameters for models.get.");

        const updates: Array<GentleAiJob | null> = [];
        const logged = yield* Deferred.make<void>();
        const watching = yield* service.streamJob.pipe(
          Stream.tap((job) =>
            Effect.gen(function* () {
              updates.push(job);
              if (job?.log.length === 1) yield* Deferred.succeed(logged, undefined);
            }),
          ),
          Stream.takeUntil((job) => job !== null && job.phase !== "running"),
          Stream.runDrain,
          Effect.forkScoped,
        );
        const started = yield* service.startJob("sync", {});
        expect(started.phase).toBe("running");
        // While it runs, a second job is refused.
        expect(
          (yield* Effect.flip(service.startJob("backups.delete", { id: "b9" }))).detail,
        ).toContain("Another Gentle AI task is running");
        // Progress reaches subscribers while the job runs.
        yield* Deferred.await(logged);
        expect(updates.at(-1)).toMatchObject({
          phase: "running",
          steps: [{ id: "agent:codex", status: "running" }],
        });
        yield* fileSystem.writeFileString(release, "");
        yield* Fiber.join(watching);
        const finished = updates.at(-1);
        expect(finished).toMatchObject({
          phase: "succeeded",
          steps: [{ id: "agent:codex", status: "succeeded" }],
          log: ["writing AGENTS.md"],
          result: { files: ["AGENTS.md"] },
        });

        // A failed job carries gentle-ai's own message, and the next one can start.
        const failures: Array<GentleAiJob | null> = [];
        const watchingFailure = yield* service.streamJob.pipe(
          Stream.tap((job) => Effect.sync(() => failures.push(job))),
          Stream.takeUntil(
            (job) => job !== null && job.method === "backups.delete" && job.phase !== "running",
          ),
          Stream.runDrain,
          Effect.forkScoped,
        );
        yield* service.startJob("backups.delete", { id: "b9" });
        yield* Fiber.join(watchingFailure);
        expect(failures.at(-1)).toMatchObject({ phase: "failed", error: "No backup b9." });
      }),
    ),
  );
});
