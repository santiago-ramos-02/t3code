import * as NodeServices from "@effect/platform-node/NodeServices";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import type { PiGentleComposerState } from "@t3tools/contracts";

import { makePiGentleSettings } from "./PiGentleSettings.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown));

it.layer(NodeServices.layer)("Pi Gentle settings", (it) => {
  it.effect("installs, updates, and sets up SDD through an isolated Pi executable", () =>
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
if (process.argv.includes("/gentle-sdd-init")) {
  const target = path.join(process.cwd(), "openspec", "config.yaml");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, "project: test\\n");
} else {
  const packageDir = path.join(home, "npm", "node_modules", "gentle-pi");
  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({ version: process.argv.includes("update") ? "3.8.0" : "3.4.0" }));
  fs.writeFileSync(path.join(home, "settings.json"), JSON.stringify({ packages: ["npm:gentle-pi"] }));
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
        const failing = yield* makePiGentleSettings({
          environment: { ...environment, FAKE_PI_FAIL: "1" },
          piBinaryPath: binary,
          fileSystem,
          path,
          spawner,
        });
        const installFailure = yield* Effect.flip(failing.action({ type: "install" }));
        expect(installFailure.detail).toContain("Gentle AI install failed.");
        expect(installFailure.detail).toContain("npm ERR! 404");

        const gentle = yield* makePiGentleSettings({
          environment,
          piBinaryPath: binary,
          fileSystem,
          path,
          spawner,
        });
        expect(yield* gentle.read()).toMatchObject({ available: false, version: null });
        // An install older than the supported minimum is reported so it can be updated in place.
        expect(yield* gentle.action({ type: "install" })).toMatchObject({
          available: false,
          version: "3.4.0",
        });
        // 3.8 is past the newest tested minor release, so settings carry a warning.
        expect(yield* gentle.action({ type: "update" })).toMatchObject({
          available: true,
          version: "3.8.0",
          compatibilityWarning: expect.stringContaining("Gentle AI 3.8 is newer"),
        });
        yield* gentle.initializeSdd(cwd);
        expect(yield* fileSystem.exists(path.join(cwd, "openspec", "config.yaml"))).toBe(true);
      }),
    ),
  );

  it.effect("lists each active SDD change with its own native status", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const platform = yield* HostProcessPlatform;
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-pi-gentle-sdd-" });
        const cwd = path.join(root, "project");
        const agentHome = path.join(root, "agent");
        const changes = path.join(cwd, "openspec", "changes");
        yield* fileSystem.makeDirectory(path.join(changes, "archive", "2026-01-01-old"), {
          recursive: true,
        });
        yield* fileSystem.makeDirectory(path.join(changes, "fix-export"));
        yield* fileSystem.makeDirectory(path.join(changes, "add-login"));
        yield* fileSystem.writeFileString(path.join(changes, "notes.md"), "not a change\n");
        yield* fileSystem.writeFileString(path.join(cwd, "openspec", "config.yaml"), "x: 1\n");
        yield* fileSystem.makeDirectory(path.join(agentHome, "npm", "node_modules", "gentle-pi"), {
          recursive: true,
        });
        yield* fileSystem.writeFileString(
          path.join(agentHome, "npm", "node_modules", "gentle-pi", "package.json"),
          encodeJson({ version: "3.7.0" }),
        );
        yield* fileSystem.writeFileString(
          path.join(agentHome, "settings.json"),
          encodeJson({ packages: ["npm:gentle-pi"] }),
        );
        // Mirrors the native `sdd-status [change] --cwd <dir> --json` output shape.
        const script = path.join(root, "fake-gentle.cjs");
        yield* fileSystem.writeFileString(
          script,
          `
const path = require("node:path");
if (process.env.FAKE_GENTLE_BROKEN) {
  process.stdout.write("not json");
  process.exit(0);
}
const args = process.argv.slice(3);
const change = args[0] === "--cwd" ? null : args[0];
const cwd = args[args.indexOf("--cwd") + 1];
const next = { "add-login": "apply", "fix-export": "spec" };
const deps = (value) => Object.fromEntries(["proposal", "specs", "design", "tasks", "apply", "verify", "archive"].map((key) => [key, value]));
process.stdout.write(JSON.stringify({
  schemaName: "gentle-ai.sdd-status",
  schemaVersion: 2,
  changeName: change,
  artifactStore: "openspec",
  planningHome: { mode: "repo-local", path: path.join(cwd, "openspec") },
  nextRecommended: change ? next[change] : "select-change",
  blockedReasons: [],
  dependencies: deps(change === "add-login" ? "ready" : "blocked"),
  actionContext: { mode: "repo-local", allowedEditRoots: [cwd] },
  taskProgress: change === "add-login" ? { total: 3, completed: 1, pending: 2 } : { total: 0, completed: 0, pending: 0 },
}));
`,
        );
        const binary = path.join(root, platform === "win32" ? "fake-gentle.cmd" : "fake-gentle");
        yield* fileSystem.writeFileString(
          binary,
          platform === "win32"
            ? `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`
            : `#!/bin/sh\nexec '${process.execPath}' '${script}' "$@"\n`,
        );
        if (platform !== "win32") yield* fileSystem.chmod(binary, 0o755);

        const gentle = yield* makePiGentleSettings({
          environment: {
            PI_CODING_AGENT_DIR: agentHome,
            GENTLE_PI_CONFIG_HOME: path.join(root, "config"),
          },
          binaryPath: binary,
          fileSystem,
          path,
          spawner,
        });
        expect(yield* gentle.readComposer(cwd)).toMatchObject({
          available: true,
          projectInitNeeded: false,
        });
        const listed: PiGentleComposerState = yield* gentle.readComposer(cwd, {
          includeChanges: true,
        });
        expect(
          listed.changes?.map((change) => [
            change.changeName,
            change.nextRecommended,
            change.taskProgress.completed,
          ]),
        ).toEqual([
          ["add-login", "apply", 1],
          ["fix-export", "spec", 0],
        ]);

        const broken = yield* makePiGentleSettings({
          environment: {
            PI_CODING_AGENT_DIR: agentHome,
            GENTLE_PI_CONFIG_HOME: path.join(root, "config"),
            FAKE_GENTLE_BROKEN: "1",
          },
          binaryPath: binary,
          fileSystem,
          path,
          spawner,
        });
        // A listing failure is reported in the payload, not as a failed read.
        expect(yield* broken.readComposer(cwd, { includeChanges: true })).toMatchObject({
          available: true,
          projectInitNeeded: false,
          changesError: "Gentle AI could not report SDD status.",
        });
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
          encodeJson({ version: "3.7.0" }),
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
          projectInitNeeded: true,
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

        const withSdd = yield* gentle.action({
          type: "saveSdd",
          cwd,
          preferences: {
            executionMode: "interactive",
            artifactStore: "openspec",
            chainedPrStrategy: "ask-on-risk",
            reviewBudgetLines: 350,
          },
        });
        expect(withSdd.project?.sdd).toMatchObject({
          executionMode: "interactive",
          reviewBudgetLines: 350,
        });
        const storedSdd = yield* fileSystem.readFileString(
          path.join(cwd, ".pi", "gentle-ai", "sdd-preflight.json"),
        );
        // Byte-identical to Gentle AI's own writer, so a committed copy stays clean in git.
        expect(storedSdd).toBe(
          [
            "{",
            '  "executionMode": "interactive",',
            '  "artifactStore": "openspec",',
            '  "chainedPrStrategy": "ask-on-risk",',
            '  "reviewBudgetLines": 350,',
            '  "engramAvailable": false,',
            '  "prompted": false',
            "}",
          ].join("\n"),
        );

        yield* fileSystem.writeFileString(
          path.join(cwd, ".pi", "gentle-ai", "sdd-preflight.json"),
          encodeJson({
            executionMode: "interactive",
            artifactStore: "both",
            chainedPrStrategy: "force-chained",
            reviewBudgetLines: 350,
            engramAvailable: false,
            prompted: true,
          }),
        );
        expect((yield* gentle.read(cwd)).project).toMatchObject({
          sdd: { artifactStore: "hybrid", chainedPrStrategy: "auto-chain" },
        });

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
          encodeJson({ version: "3.7.0" }),
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
});
