import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as TestClock from "effect/testing/TestClock";

import {
  buildTemplate,
  DEFAULT_TEMPLATE_NAME,
  parsePrepSummary,
  saveNamedSnapshotAndWait,
  templateNameFor,
  templatePrepScript,
  type TemplateBoat,
} from "./boatTemplate.ts";

describe("templateNameFor", () => {
  it("saves over the configured template, but never over a share code", () => {
    assert.strictEqual(templateNameFor("my-template"), "my-template");
    assert.strictEqual(templateNameFor(null), DEFAULT_TEMPLATE_NAME);
    assert.strictEqual(templateNameFor("bsh_abc123"), DEFAULT_TEMPLATE_NAME);
  });
});

describe("templatePrepScript", () => {
  // Runs the script in bash against a scratch home with a PATH of stubs only, so it can never
  // reach a real tool. Each named tool succeeds unless listed in `failing`; curl always fails, so
  // nothing downloads; the few system commands the script needs pass through to the real ones.
  const runScript = (tools: ReadonlyArray<string>, failing: ReadonlyArray<string> = []) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-template-" });
      const bin = path.join(root, "bin");
      const home = path.join(root, "home");
      const userdata = path.join(home, ".t3", "userdata");
      yield* fileSystem.makeDirectory(bin);
      yield* fileSystem.makeDirectory(path.join(userdata, "secrets"), { recursive: true });
      for (const file of [
        "environment-id",
        "statev2.sqlite",
        "statev2.sqlite-wal",
        "settings.json",
        "secrets/server-signing-key.bin",
        "secrets/boat-api-key.bin",
        "secrets/cloud-cli-oauth-token.bin",
        "secrets/source-control-github-token.bin",
        "secrets/provider-auth-claude.bin",
      ]) {
        yield* fileSystem.writeFileString(path.join(userdata, file), "x");
      }
      const stub = Effect.fn(function* (name: string, body: string) {
        yield* fileSystem.writeFileString(path.join(bin, name), `#!/bin/sh\n${body}\n`);
        yield* fileSystem.chmod(path.join(bin, name), 0o755);
      });
      for (const tool of ["npm", ...tools]) {
        yield* stub(tool, `exit ${failing.includes(tool) ? 1 : 0}`);
      }
      yield* stub("curl", "exit 1");
      for (const command of ["rm", "sed", "head", "mktemp", "install", "tar", "cat"]) {
        yield* stub(command, `PATH=/usr/bin:/bin exec ${command} "$@"`);
      }
      const script = templatePrepScript("0.1.3-nightly.20261026.1100");
      assert.isNotNull(script);
      const output = yield* spawner.string(
        ChildProcess.make("bash", ["-c", `PATH="$(pwd)/bin"\n${script!}`], {
          cwd: root,
          env: { HOME: home, PATH: process.env.PATH },
        }),
      );
      const kept = (yield* fileSystem.readDirectory(userdata, { recursive: true }))
        .map((file) => file.replaceAll("\\", "/"))
        .toSorted();
      return { summary: parsePrepSummary(output), kept };
    }).pipe(Effect.scoped);

  it.effect("updates the tools it finds and reports each one that failed", () =>
    Effect.gen(function* () {
      const { summary } = yield* runScript(["claude", "pi"], ["pi"]);
      assert.deepStrictEqual(summary, {
        updated: ["Claude Code"],
        failed: ["T3 Code 0.1.3-nightly.20261026.1100", "Pi with Gentle AI"],
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("forgets the install's identity and credentials and keeps its settings", () =>
    Effect.gen(function* () {
      const { kept } = yield* runScript([]);
      assert.deepStrictEqual(kept, [
        "secrets",
        "secrets/provider-auth-claude.bin",
        "settings.json",
      ]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it("refuses a version that is not safe in a command", () => {
    assert.isNull(templatePrepScript("1.0; rm -rf /"));
  });
});

const makeBoat = (options: { readonly log: string }) => {
  const calls: string[] = [];
  let state = "provisioning";
  type Snapshot = {
    name: string;
    createdAt: string;
    status: string;
    snapshotId: string;
    sourceSandboxId: string;
  };
  let snapshot: Snapshot | null = {
    name: "my-template",
    createdAt: "2026-10-01T00:00:00.000Z",
    status: "ready",
    snapshotId: "snap_0",
    sourceSandboxId: "bx_old",
  };
  let saving: string | null = null;
  let saves = 0;
  const boat: TemplateBoat = {
    createSandbox: (input) => {
      calls.push(`create from ${input.from}`);
      state = "ready";
      return Effect.succeed({ id: "bx_build", state: "provisioning" } as never);
    },
    getSandbox: () => Effect.succeedSome({ id: "bx_build", state } as never),
    runCommand: (_id, input) => {
      if (input.command.startsWith("tail")) {
        return Effect.succeed({ exitCode: 0, stdout: options.log, stderr: "" });
      }
      if (input.command.startsWith("cat")) {
        return Effect.succeed({ exitCode: 0, stdout: "0\n", stderr: "" });
      }
      calls.push("write script");
      return Effect.succeed({ exitCode: 0, stdout: "", stderr: "" });
    },
    startDetached: () => Effect.sync(() => void calls.push("run script")),
    stopSandbox: () =>
      Effect.sync(() => {
        calls.push("stop");
        state = "stopped";
      }),
    deleteSandbox: () => Effect.sync(() => void calls.push("delete build machine")),
    // Boat lists a save as soon as it starts, and says when it is ready a check later.
    listNamedSnapshots: () =>
      Effect.sync(() => {
        const listed = snapshot === null ? [] : [snapshot];
        if (snapshot?.status === "saving") snapshot = { ...snapshot, status: "ready" };
        else if (saving !== null) {
          calls.push(`saw ${saving} ready`);
          saving = null;
        }
        return { snapshots: listed, free: 10 };
      }),
    saveNamedSnapshot: (sandboxId, name) =>
      Effect.sync(() => {
        calls.push(`save as ${name}`);
        saving = name;
        saves += 1;
        // Boat keeps a replaced snapshot's creation time.
        const createdAt = snapshot?.name === name ? snapshot.createdAt : "2026-10-26T00:00:00.000Z";
        snapshot = {
          name,
          createdAt,
          status: "saving",
          snapshotId: `snap_${saves}`,
          sourceSandboxId: sandboxId,
        };
      }),
  };
  return { boat, calls };
};

describe("saveNamedSnapshotAndWait", () => {
  it.effect("returns only once Boat has finished saving", () =>
    Effect.gen(function* () {
      const { boat, calls } = makeBoat({ log: "" });
      const fiber = yield* saveNamedSnapshotAndWait(boat, "bx_source", "my-template-source").pipe(
        Effect.forkChild,
      );
      yield* TestClock.adjust("1 minute");
      yield* Fiber.join(fiber);
      assert.deepStrictEqual(calls, ["save as my-template-source", "saw my-template-source ready"]);
    }),
  );
});

describe("buildTemplate", () => {
  it.effect("saves the updated build machine under the template's name, then deletes it", () =>
    Effect.gen(function* () {
      const { boat, calls } = makeBoat({ log: "== Codex\nupdated=Codex;failed=\n" });
      const fiber = yield* buildTemplate({
        boat,
        from: "my-template",
        name: "my-template",
        t3Version: "0.1.3",
      }).pipe(Effect.forkChild);
      yield* TestClock.adjust("30 minutes");
      const summary = yield* Fiber.join(fiber);
      assert.deepStrictEqual(summary, { updated: ["Codex"], failed: [] });
      assert.deepStrictEqual(calls, [
        "create from my-template",
        "write script",
        "run script",
        "stop",
        "save as my-template",
        "saw my-template ready",
        "delete build machine",
      ]);
    }),
  );

  it.effect("deletes the build machine and saves nothing when the script did not finish", () =>
    Effect.gen(function* () {
      const { boat, calls } = makeBoat({ log: "npm ERR! killed\n" });
      const exit = yield* Effect.exit(
        buildTemplate({ boat, from: null, name: "my-template", t3Version: "0.1.3" }),
      );
      assert.isTrue(Exit.isFailure(exit));
      assert.notInclude(calls, "save as my-template");
      assert.strictEqual(calls.at(-1), "delete build machine");
    }),
  );
});
