import * as NodeServices from "@effect/platform-node/NodeServices";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { makePiGentleSettings } from "./PiGentleSettings.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

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
if (process.argv.includes("/gentle-sdd-init")) {
  const target = path.join(process.cwd(), "openspec", "config.yaml");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, "project: test\\n");
} else {
  const packageDir = path.join(home, "npm", "node_modules", "gentle-pi");
  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({ version: process.argv.includes("update") ? "3.8.0" : "3.7.0" }));
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
        const gentle = makePiGentleSettings({
          environment: {
            PI_CODING_AGENT_DIR: agentHome,
            GENTLE_PI_CONFIG_HOME: path.join(root, "config"),
          },
          piBinaryPath: binary,
          fileSystem,
          path,
          spawner,
        });
        expect((yield* gentle.read()).available).toBe(false);
        expect((yield* gentle.action({ type: "install" })).version).toBe("3.7.0");
        expect((yield* gentle.action({ type: "update" })).version).toBe("3.8.0");
        yield* gentle.initializeSdd(cwd);
        expect(yield* fileSystem.exists(path.join(cwd, "openspec", "config.yaml"))).toBe(true);
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

        const gentle = makePiGentleSettings({
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
        expect(yield* gentle.readComposer(cwd)).toMatchObject({
          available: true,
          sddStatus: null,
          projectInitNeeded: true,
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
        expect(storedSdd).toContain('"prompted":false');

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
});
