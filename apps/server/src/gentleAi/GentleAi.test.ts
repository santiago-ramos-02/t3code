import * as NodeCrypto from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderDriverKind, type GentleAiJob, type ServerProvider } from "@t3tools/contracts";
import {
  HostProcessArchitecture,
  HostProcessEnvironment,
  HostProcessPlatform,
} from "@t3tools/shared/hostProcess";
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
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/unstable/http";

import * as ServerSettings from "../serverSettings.ts";
import {
  GentleAi,
  gentleAiDrivers,
  gentleAiResourceNames,
  layer,
  NOT_INSTALLED,
  withGentleAi,
} from "./GentleAi.ts";
import { gentleAiReleaseAsset } from "./GentleAiBinary.ts";

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

it.layer(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer))("GentleAi service", (it) => {
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
          // This gentle-ai predates the headless API.
          apiVersion: null,
          oddFeatures: false,
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
        // Everything comes from the API: there is no state file here.
        expect(yield* service.current).toMatchObject({
          apiVersion: 1,
          agents: ["codex"],
          components: ["engram"],
          preset: "full-gentleman",
          syncNeeded: true,
        });

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

  it.effect(
    "installs gentle-ai from its release where its install scripts do, checksum first",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const platform = yield* HostProcessPlatform;
          const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-gentle-install-" });
          const asset = gentleAiReleaseAsset("9.9.9", platform, yield* HostProcessArchitecture);
          if (asset === null) return;
          const program = platform === "win32" ? "gentle-ai.exe" : "gentle-ai";
          const folder = asset.replace(/\.tar\.gz$/, "");
          yield* fileSystem.makeDirectory(path.join(home, "build", folder), { recursive: true });
          yield* fileSystem.writeFileString(path.join(home, "build", folder, program), "program");
          const tar =
            platform === "win32"
              ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
              : "tar";
          const archive = path.join(home, asset);
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          yield* spawner.string(
            ChildProcess.make(tar, ["-czf", archive, "-C", path.join(home, "build"), folder]),
          );
          const bytes = yield* fileSystem.readFile(archive);
          const digest = NodeCrypto.createHash("sha256").update(bytes).digest("hex");

          // A release server: the latest tag, its checksums, and the archive.
          const release = (checksum: string) =>
            HttpClient.make((request) => {
              const url = request.url;
              const body = url.endsWith("/releases/latest")
                ? '{"tag_name":"v9.9.9"}'
                : url.endsWith("/checksums.txt")
                  ? `${checksum}  ${asset}\n`
                  : url.endsWith(`/${asset}`)
                    ? bytes
                    : null;
              return Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  new Response(body, { status: body === null ? 404 : 200 }),
                ),
              );
            });
          const environment = {
            ...process.env,
            PATH: home,
            Path: home,
            HOME: home,
            USERPROFILE: home,
            LOCALAPPDATA: path.join(home, "local"),
          };
          const target =
            platform === "win32"
              ? path.join(home, "local", "Programs", "gentle-ai", program)
              : path.join(home, ".local", "bin", program);
          const installWith = (checksum: string) =>
            Effect.gen(function* () {
              const gentleAi = yield* GentleAi;
              return yield* gentleAi.action({ action: "install" });
            }).pipe(
              Effect.provide(
                layer.pipe(Layer.provide(ServerSettings.layerTest({ gentleAiBinaryPath: "" }))),
              ),
              Effect.provideService(HttpClient.HttpClient, release(checksum)),
              Effect.provideService(HostProcessEnvironment, environment),
            );

          const tampered = yield* Effect.flip(installWith("0".repeat(64)));
          expect(tampered).toMatchObject({
            detail: expect.stringContaining("does not match its checksum"),
          });
          expect(yield* fileSystem.exists(target)).toBe(false);

          yield* installWith(digest);
          expect(yield* fileSystem.readFileString(target)).toBe("program");
        }),
      ),
  );
});

it("names the skills and commands in a footprint", () => {
  expect(
    gentleAiResourceNames([
      "C:\\Users\\me\\.claude\\skills\\judgment-day",
      "/home/me/.config/opencode/commands/skill-registry.md",
      "/home/me/.config/opencode/skills/_shared/README.md",
      "/home/me/.claude/settings.json",
    ]),
  ).toEqual(["judgment-day", "skill-registry"]);
});

it("tags only what gentle-ai's footprint names, when it has one", () => {
  const skills: ServerProvider["skills"] = ["judgment-day", "sdd-apply", "mine"].map((name) => ({
    name,
    path: name,
    enabled: true,
  }));
  const status = { ...NOT_INSTALLED, installed: true, drivers: gentleAiDrivers(["claude-code"]) };
  const claude = {
    ...provider("claudeAgent"),
    skills,
  };
  // Without a footprint the built-in list decides; with one, only its names count.
  const [fromList] = withGentleAi([claude], status);
  const [fromFootprint] = withGentleAi([claude], { ...status, resources: ["judgment-day"] });
  expect(fromList?.skills?.filter((skill) => skill.package).map((skill) => skill.name)).toEqual([
    "judgment-day",
    "sdd-apply",
  ]);
  expect(
    fromFootprint?.skills?.filter((skill) => skill.package).map((skill) => skill.name),
  ).toEqual(["judgment-day"]);
});
