import * as NodeServices from "@effect/platform-node/NodeServices";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { makePiGentleSettings } from "./PiGentleSettings.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown));
// npm reports gentle-pi 3.9.0 as its latest release.
const httpClient = HttpClient.make((request) =>
  Effect.succeed(
    HttpClientResponse.fromWeb(
      request,
      new Response(encodeJson({ version: "3.9.0" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ),
  ),
);

it.layer(NodeServices.layer)("Pi Gentle settings", (it) => {
  it.effect("detects and updates gentle-pi through an isolated Pi executable", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const platform = yield* HostProcessPlatform;
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-pi-gentle-cli-" });
        const cwd = path.join(root, "project");
        const agentHome = path.join(root, "agent");
        const script = path.join(root, "fake-pi.cjs");
        const binary = path.join(root, platform === "win32" ? "fake-pi.cmd" : "fake-pi");
        yield* fileSystem.makeDirectory(cwd);
        yield* fileSystem.writeFileString(
          script,
          `
const fs = require("node:fs");
const path = require("node:path");
const home = process.env.PI_CODING_AGENT_DIR;
if (process.env.FAKE_PI_FAIL) {
  process.stderr.write("npm ERR! 404 gentle-pi is not in this registry\\n");
  process.exit(1);
}
if (process.argv[2] === "update" && process.argv[3] === "npm:gentle-pi") {
  const packageDir = path.join(home, "npm", "node_modules", "gentle-pi");
  fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({ name: "gentle-pi", version: "3.8.0" }));
} else {
  process.exit(2);
}
`,
        );
        yield* fileSystem.writeFileString(
          binary,
          platform === "win32"
            ? `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`
            : `#!/bin/sh\nexec '${process.execPath}' '${script}' "$@"\n`,
        );
        if (platform !== "win32") yield* fileSystem.chmod(binary, 0o755);
        const environment = {
          PI_CODING_AGENT_DIR: agentHome,
          GENTLE_PI_CONFIG_HOME: path.join(root, "config"),
        };
        const gentle = yield* makePiGentleSettings({
          environment,
          piBinaryPath: binary,
          fileSystem,
          path,
          spawner,
          httpClient,
        });
        // Without gentle-pi, clients show nothing Gentle-related, so updating is refused too.
        expect(yield* gentle.read()).toMatchObject({ available: false, version: null });
        expect((yield* Effect.flip(gentle.action({ type: "update" }))).detail).toBe(
          "Gentle AI is not installed for Pi.",
        );
        // Users install gentle-pi with Pi; an object-form entry counts like a plain source.
        const packageDir = path.join(agentHome, "npm", "node_modules", "gentle-pi");
        yield* fileSystem.makeDirectory(packageDir, { recursive: true });
        yield* fileSystem.writeFileString(
          path.join(packageDir, "package.json"),
          encodeJson({ name: "gentle-pi", version: "3.4.0" }),
        );
        yield* fileSystem.writeFileString(
          path.join(agentHome, "settings.json"),
          encodeJson({ packages: [{ source: "npm:gentle-pi" }] }),
        );
        // An install older than the supported minimum is reported so it can be updated in place.
        expect(yield* gentle.read()).toMatchObject({ available: false, version: "3.4.0" });
        const failing = yield* makePiGentleSettings({
          environment: { ...environment, FAKE_PI_FAIL: "1" },
          piBinaryPath: binary,
          fileSystem,
          path,
          spawner,
          httpClient,
        });
        const updateFailure = yield* Effect.flip(failing.action({ type: "update" }));
        expect(updateFailure.detail).toContain("Gentle AI update failed.");
        expect(updateFailure.detail).toContain("npm ERR! 404");
        // 3.8 is past the newest tested minor release, so settings carry a warning, and npm's
        // 3.9.0 is still an update.
        expect(yield* gentle.action({ type: "update" })).toMatchObject({
          available: true,
          version: "3.8.0",
          updateAvailable: true,
          compatibilityWarning: expect.stringContaining("Gentle AI 3.8 is newer"),
        });
        expect(yield* gentle.readComposer(cwd)).toEqual({
          available: true,
          profiles: [],
          effectiveProfile: null,
        });
      }),
    ),
  );

  it.effect("finds gentle-pi wherever Pi loads it, including a project-scoped install", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-pi-gentle-scope-" });
        const cwd = path.join(root, "project");
        const vendored = path.join(cwd, ".pi", "vendor", "gentle");
        yield* fileSystem.makeDirectory(vendored, { recursive: true });
        yield* fileSystem.writeFileString(
          path.join(vendored, "package.json"),
          encodeJson({ name: "gentle-pi", version: "3.7.0" }),
        );
        yield* fileSystem.writeFileString(
          path.join(cwd, ".pi", "settings.json"),
          encodeJson({ packages: ["./vendor/gentle"] }),
        );
        const gentle = yield* makePiGentleSettings({
          environment: {
            PI_CODING_AGENT_DIR: path.join(root, "agent"),
            GENTLE_PI_CONFIG_HOME: path.join(root, "config"),
          },
          fileSystem,
          path,
          spawner,
          httpClient,
        });
        // Only the project loads it, so it counts there and nowhere else.
        expect(yield* gentle.read()).toMatchObject({ available: false, version: null });
        const projectState = yield* gentle.read(cwd);
        expect(projectState).toMatchObject({ available: true, version: "3.7.0" });
        // A local folder is not Pi's to update, so no update is ever offered for it.
        expect(projectState).not.toHaveProperty("updateAvailable");
        expect(yield* gentle.readComposer(cwd)).toMatchObject({ available: true });
      }),
    ),
  );

  it.effect("creates, edits, pins and clears a profile in isolated state", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-pi-gentle-" });
        const cwd = path.join(root, "project");
        const agentHome = path.join(root, "agent");
        const configHome = path.join(root, "gentle-config");
        yield* fileSystem.makeDirectory(cwd);
        yield* fileSystem.makeDirectory(path.join(agentHome, "npm", "node_modules", "gentle-pi"), {
          recursive: true,
        });
        yield* fileSystem.writeFileString(
          path.join(agentHome, "npm", "node_modules", "gentle-pi", "package.json"),
          encodeJson({ name: "gentle-pi", version: "3.7.0" }),
        );
        yield* fileSystem.writeFileString(
          path.join(agentHome, "settings.json"),
          encodeJson({ packages: ["npm:gentle-pi"] }),
        );
        yield* spawner.string(
          ChildProcess.make("git", ["init", "-q"], {
            cwd,
            stdin: "ignore",
            stderr: "ignore",
          }),
        );

        const gentle = yield* makePiGentleSettings({
          environment: {
            PI_CODING_AGENT_DIR: agentHome,
            GENTLE_PI_CONFIG_HOME: configHome,
          },
          fileSystem,
          path,
          spawner,
          httpClient,
        });
        expect(yield* gentle.read(cwd)).toMatchObject({
          available: true,
          version: "3.7.0",
          profiles: [],
          project: {
            pinned: null,
            persona: { effective: "gentleman", global: "gentleman", override: null },
          },
        });
        const persona = yield* gentle.action({ type: "setPersona", cwd, mode: "neutral" });
        expect(persona.project?.persona).toEqual({
          effective: "neutral",
          global: "gentleman",
          override: "neutral",
        });
        expect(
          yield* fileSystem.readFileString(path.join(cwd, ".pi", "gentle-ai", "persona.json")),
        ).toContain('"mode":"neutral"');
        const globalPersona = yield* gentle.action({ type: "setPersona", cwd, mode: null });
        expect(globalPersona.project?.persona).toEqual({
          effective: "gentleman",
          global: "gentleman",
          override: null,
        });
        const changedGlobalPersona = yield* gentle.action({
          type: "setGlobalPersona",
          mode: "neutral",
          cwd,
        });
        expect(changedGlobalPersona.globalPersona).toBe("neutral");
        expect(changedGlobalPersona.project?.persona).toEqual({
          effective: "neutral",
          global: "neutral",
          override: null,
        });
        expect(yield* gentle.readComposer(cwd)).toEqual({
          available: true,
          profiles: [],
          effectiveProfile: null,
        });

        const created = yield* gentle.action({ type: "create", name: "review-fast", cwd });
        expect(created.project).toMatchObject({
          pinned: null,
          pinSource: null,
          pinAvailable: true,
        });
        const saved = yield* gentle.action({
          type: "save",
          name: "review-fast",
          routing: { "gentle-ai-worker": { model: "openai/gpt-5.2", thinking: "medium" } },
          cwd,
        });
        expect(saved.project).toMatchObject({ pinned: null, pinAvailable: true });
        const pinned = yield* gentle.action({ type: "pin", cwd, name: "review-fast" });
        expect(pinned.project).toMatchObject({ pinned: "review-fast", pinSource: "local" });
        expect(pinned.profiles[0]).toMatchObject({
          name: "review-fast",
          routing: { "gentle-ai-worker": { model: "openai/gpt-5.2", thinking: "medium" } },
        });
        const active = yield* gentle.action({ type: "activate", name: "review-fast", cwd });
        expect(active.active).toBe("review-fast");
        expect(yield* fileSystem.readFileString(path.join(configHome, "models.json"))).toContain(
          '"gentle-ai-worker"',
        );
        yield* gentle.action({
          type: "save",
          name: "review-fast",
          cwd,
          routing: { "gentle-ai-worker": { model: "openai/gpt-5.3" } },
        });
        expect(yield* fileSystem.readFileString(path.join(configHome, "models.json"))).toContain(
          "openai/gpt-5.3",
        );
        yield* gentle.action({ type: "create", name: "minimal", cwd });
        const switched = yield* gentle.action({ type: "activate", name: "minimal", cwd });
        expect(switched.active).toBe("minimal");
        expect(yield* fileSystem.readFileString(path.join(configHome, "models.json"))).toContain(
          '"gentle-ai-worker":{}',
        );

        const cleared = yield* gentle.action({ type: "clearPin", cwd });
        expect(cleared.project?.pinned).toBeNull();
        expect(cleared.profiles[0]?.name).toBe("review-fast");
      }),
    ),
  );

  it.effect("applies a profile's orchestrator the way Gentle AI does", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-pi-gentle-orch-" });
        const cwd = path.join(root, "project");
        const agentHome = path.join(root, "agent");
        const configHome = path.join(root, "gentle-config");
        const piSettingsPath = path.join(agentHome, "settings.json");
        yield* fileSystem.makeDirectory(cwd);
        yield* fileSystem.makeDirectory(path.join(agentHome, "npm", "node_modules", "gentle-pi"), {
          recursive: true,
        });
        yield* fileSystem.writeFileString(
          path.join(agentHome, "npm", "node_modules", "gentle-pi", "package.json"),
          encodeJson({ name: "gentle-pi", version: "3.7.0" }),
        );
        yield* fileSystem.writeFileString(
          piSettingsPath,
          encodeJson({ packages: ["npm:gentle-pi"], theme: "dark" }),
        );
        yield* fileSystem.makeDirectory(configHome);
        yield* fileSystem.writeFileString(
          path.join(configHome, "profiles.json"),
          encodeJson({
            kind: "gentle-pi.agent_model_profiles",
            version: 1,
            profiles: {
              deep: {
                orchestrator: { model: "anthropic/claude-opus-5-5", thinking: "xhigh" },
                "sdd-apply": { model: "anthropic/claude-opus-5-5", thinking: "high" },
              },
              cheap: { orchestrator: { model: "openai-codex/gpt-6-luna" } },
              plain: { "sdd-apply": { model: "openai-codex/gpt-6-sol" } },
              broken: { orchestrator: { model: "gpt-6" } },
            },
          }),
        );
        yield* spawner.string(
          ChildProcess.make("git", ["init", "-q"], { cwd, stdin: "ignore", stderr: "ignore" }),
        );
        const gentle = yield* makePiGentleSettings({
          environment: { PI_CODING_AGENT_DIR: agentHome, GENTLE_PI_CONFIG_HOME: configHome },
          fileSystem,
          path,
          spawner,
          httpClient,
        });
        const readPiSettings = fileSystem
          .readFileString(piSettingsPath)
          .pipe(Effect.map(decodeJson));

        expect(yield* gentle.readComposer(cwd)).toMatchObject({
          profiles: [
            {
              name: "deep",
              orchestrator: { model: "anthropic/claude-opus-5-5", thinking: "xhigh" },
            },
            { name: "cheap", orchestrator: { model: "openai-codex/gpt-6-luna" } },
            { name: "plain" },
            { name: "broken", orchestrator: { model: "gpt-6" } },
          ],
          effectiveProfile: null,
        });

        // Without a pin, applying activates globally and moves Pi's default model with it.
        expect((yield* gentle.action({ type: "apply", name: "deep", cwd })).active).toBe("deep");
        expect(yield* readPiSettings).toEqual({
          packages: ["npm:gentle-pi"],
          theme: "dark",
          defaultProvider: "anthropic",
          defaultModel: "claude-opus-5-5",
          defaultThinkingLevel: "xhigh",
        });
        expect(yield* gentle.readComposer(cwd)).toMatchObject({
          effectiveProfile: { name: "deep", pinned: false },
        });
        // An orchestrator without a thinking level clears the previous one.
        yield* gentle.action({ type: "apply", name: "cheap", cwd });
        expect(yield* readPiSettings).toEqual({
          packages: ["npm:gentle-pi"],
          theme: "dark",
          defaultProvider: "openai-codex",
          defaultModel: "gpt-6-luna",
        });
        // A profile that names no orchestrator never moves it.
        expect((yield* gentle.action({ type: "apply", name: "plain", cwd })).active).toBe("plain");
        expect(yield* readPiSettings).toMatchObject({ defaultModel: "gpt-6-luna" });

        // An invalid orchestrator fails the whole apply and restores the previous profile.
        const failure = yield* Effect.flip(gentle.action({ type: "activate", name: "broken" }));
        expect(failure.detail).toContain("not a provider/model pair");
        expect((yield* gentle.read(cwd)).active).toBe("plain");
        expect(yield* fileSystem.readFileString(path.join(configHome, "models.json"))).toContain(
          "openai-codex/gpt-6-sol",
        );

        // With a pin, applying moves only the pin, as Gentle AI's repo-scoped apply does.
        yield* gentle.action({ type: "pin", name: "deep", cwd });
        expect(yield* gentle.readComposer(cwd)).toMatchObject({
          effectiveProfile: { name: "deep", pinned: true },
        });
        const pinnedApply = yield* gentle.action({ type: "apply", name: "cheap", cwd });
        expect(pinnedApply.active).toBe("plain");
        expect(pinnedApply.project).toMatchObject({ pinned: "cheap", pinSource: "local" });
        expect(yield* readPiSettings).toMatchObject({ defaultModel: "gpt-6-luna" });
      }),
    ),
  );

  it.effect("goes through gentle-pi's own API when the installed release ships one", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-pi-gentle-api-" });
        const cwd = path.join(root, "project");
        const agentHome = path.join(root, "agent");
        const configHome = path.join(root, "gentle-config");
        const packageDir = path.join(agentHome, "npm", "node_modules", "gentle-pi");
        const calls = path.join(root, "calls.ndjson");
        yield* fileSystem.makeDirectory(cwd);
        yield* fileSystem.makeDirectory(path.join(packageDir, "bin"), { recursive: true });
        yield* fileSystem.writeFileString(
          path.join(packageDir, "package.json"),
          encodeJson({ name: "gentle-pi", version: "3.7.0" }),
        );
        yield* fileSystem.writeFileString(
          path.join(agentHome, "settings.json"),
          encodeJson({ packages: ["npm:gentle-pi"] }),
        );
        // Records each call and answers like gentle-pi: a fixed state, and an error for "missing".
        yield* fileSystem.writeFileString(
          path.join(packageDir, "bin", "gentle-pi-api.mjs"),
          `
import fs from "node:fs";
let body = "";
for await (const chunk of process.stdin) body += chunk;
const method = process.argv[2];
const params = JSON.parse(body || "{}");
fs.appendFileSync(${encodeJson(calls)}, JSON.stringify({ method, params, configHome: process.env.GENTLE_PI_CONFIG_HOME }) + "\\n");
const line = params.name === "missing"
  ? { type: "error", error: { code: "missing_profile", message: "Profile does not exist: missing." } }
  : { type: "result", data: method !== "state" ? {} : {
      profiles: [{ name: "deep", routing: { orchestrator: { model: "anthropic/opus" }, worker: { thinking: "high" } } }],
      active: "deep",
      persona: "neutral",
      project: params.cwd ? { pinAvailable: true, pinned: { profile: "deep", source: "repo" }, persona: { effective: "gentleman", override: "gentleman" } } : null,
    } };
process.stdout.write(JSON.stringify({ schema: "gentle-pi.api/v1", ...line }) + "\\n");
`,
        );
        const gentle = yield* makePiGentleSettings({
          environment: { PI_CODING_AGENT_DIR: agentHome, GENTLE_PI_CONFIG_HOME: configHome },
          fileSystem,
          path,
          spawner,
          httpClient,
        });
        const recorded = fileSystem.readFileString(calls).pipe(
          Effect.map((text) =>
            text
              .trim()
              .split("\n")
              .map((line) => decodeJson(line)),
          ),
        );

        expect(yield* gentle.read(cwd)).toEqual({
          available: true,
          version: "3.7.0",
          updateAvailable: true,
          globalPersona: "neutral",
          profiles: [
            {
              name: "deep",
              routing: { orchestrator: { model: "anthropic/opus" }, worker: { thinking: "high" } },
            },
          ],
          active: "deep",
          project: {
            pinAvailable: true,
            pinned: "deep",
            pinSource: "repo",
            persona: { effective: "gentleman", global: "neutral", override: "gentleman" },
          },
        });
        expect(yield* gentle.readComposer(cwd)).toMatchObject({
          profiles: [{ name: "deep", orchestrator: { model: "anthropic/opus" } }],
          effectiveProfile: { name: "deep", pinned: true },
        });
        const stateReads = recorded.pipe(
          Effect.map(
            (all) =>
              all.filter(
                (call) =>
                  typeof call === "object" &&
                  call !== null &&
                  "method" in call &&
                  call.method === "state",
              ).length,
          ),
        );
        // Settings pages and composers read this often; repeat reads reuse the last answer.
        const settled = yield* stateReads;
        yield* gentle.read(cwd);
        yield* gentle.readComposer(cwd);
        expect(yield* stateReads).toBe(settled);

        yield* gentle.action({ type: "apply", name: "deep", cwd });
        // A change reads gentle-pi again rather than answering from before it.
        expect(yield* stateReads).toBe(settled + 1);
        yield* gentle.action({ type: "activate", name: "deep", cwd });
        yield* gentle.action({ type: "setPersona", cwd, mode: null });
        const failure = yield* Effect.flip(gentle.action({ type: "pin", name: "missing", cwd }));
        expect(failure.detail).toBe("Profile does not exist: missing.");
        const actions = (yield* recorded).filter(
          (call) =>
            typeof call === "object" &&
            call !== null &&
            "method" in call &&
            call.method !== "state",
        );
        expect(actions).toEqual([
          { method: "profiles.apply", params: { name: "deep", cwd }, configHome },
          { method: "profiles.apply", params: { name: "deep", cwd, global: true }, configHome },
          { method: "persona.set", params: { mode: null, cwd }, configHome },
          { method: "pin.set", params: { name: "missing", cwd }, configHome },
        ]);
      }),
    ),
  );
});
