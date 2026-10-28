import { assert, describe, it } from "@effect/vitest";
import type { ServerSettings } from "@t3tools/contracts";
import * as GitHubCredentials from "@t3tools/source-control-github/server/GitHubCredentials";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";

import * as ProcessRunner from "../processRunner.ts";
import * as Settings from "../serverSettings.ts";
import * as MachineGitTools from "./machineGitTools.ts";

const TOKEN = "ghp_machine_token";

interface Call {
  readonly line: string;
  readonly stdin: string;
}

const makeRunner = Effect.gen(function* () {
  const calls = yield* Queue.unbounded<Call>();
  const runner = ProcessRunner.ProcessRunner.of({
    run: (input) =>
      Queue.offer(calls, {
        line: [input.command, ...input.args].join(" "),
        stdin: input.stdin ?? "",
      }).pipe(
        Effect.as({
          stdout: "",
          stderr: "",
          code: ChildProcessSpawner.ExitCode(0),
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
          stdoutInvalidUtf8: false,
          stderrInvalidUtf8: false,
        }),
      ),
  });
  return { calls, runner };
});

const takeLines = (calls: Queue.Queue<Call>, count: number) =>
  Effect.forEach(Array.from({ length: count }), () => Queue.take(calls));

const SIGN_IN = [
  "git credential-store store",
  "git config --global credential.https://github.com.helper store",
  "gh auth login --hostname github.com --with-token",
];

describe("signInGitTools", () => {
  it.effect("gives git and gh the token on stdin only", () =>
    Effect.gen(function* () {
      const { calls, runner } = yield* makeRunner;
      yield* MachineGitTools.signInGitTools(TOKEN).pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, runner),
      );
      const made = yield* takeLines(calls, 3);

      assert.deepStrictEqual(
        made.map((call) => call.line),
        SIGN_IN,
      );
      assert.include(
        made[0]!.stdin,
        `host=github.com\nusername=x-access-token\npassword=${TOKEN}\n`,
      );
      assert.strictEqual(made[2]!.stdin, TOKEN);
      assert.isFalse(made.some((call) => call.line.includes(TOKEN)));
    }),
  );

  it.effect("signs git and gh out when the token is gone", () =>
    Effect.gen(function* () {
      const { calls, runner } = yield* makeRunner;
      yield* MachineGitTools.signInGitTools(null).pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, runner),
      );
      const made = yield* takeLines(calls, 3);

      assert.deepStrictEqual(
        made.map((call) => call.line),
        [
          "git credential-store erase",
          "git config --global --unset-all credential.https://github.com.helper",
          "gh auth logout --hostname github.com",
        ],
      );
      assert.notInclude(made[0]!.stdin, "password=");
    }),
  );
});

describe("layer", () => {
  // Builds the layer against a saved token the test changes, announcing each change itself.
  const startLayer = (environment: NodeJS.ProcessEnv) =>
    Effect.gen(function* () {
      const { calls, runner } = yield* makeRunner;
      const changes = yield* Queue.unbounded<ServerSettings>();
      const saved = { token: TOKEN as string | null, source: "settings" as const };
      const settings = yield* Settings.ServerSettingsService;
      const credentials = GitHubCredentials.GitHubCredentials.of({
        get: (host) =>
          saved.token === null
            ? Effect.fail(new GitHubCredentials.GitHubNotSignedInError({ host }))
            : Effect.succeed({
                host,
                token: Redacted.make(saved.token),
                source: saved.source,
                fingerprint: "fp",
              }),
        saved: () => Effect.succeedNone,
        fingerprint: () => Effect.succeed("fp"),
        invalidate: () => Effect.void,
      });
      yield* Layer.build(MachineGitTools.layer).pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, runner),
        Effect.provideService(GitHubCredentials.GitHubCredentials, credentials),
        Effect.provideService(Settings.ServerSettingsService, {
          ...settings,
          subscribeChanges: Effect.succeed(Stream.fromQueue(changes)),
        }),
        Effect.provideService(HostProcess.Environment, environment),
      );
      const announce = Effect.flatMap(settings.getSettings, (next) => Queue.offer(changes, next));
      return { calls, saved, announce };
    });

  it.effect("signs the tools in with the saved token, and out once it is removed", () =>
    Effect.gen(function* () {
      const { calls, saved, announce } = yield* startLayer({
        [MachineGitTools.BOAT_MACHINE_ENV]: "1",
      });
      assert.deepStrictEqual(
        (yield* takeLines(calls, 3)).map((call) => call.line),
        SIGN_IN,
      );

      saved.token = null;
      yield* announce;
      assert.deepStrictEqual(
        (yield* takeLines(calls, 3)).map((call) => call.line),
        [
          "git credential-store erase",
          "git config --global --unset-all credential.https://github.com.helper",
          "gh auth logout --hostname github.com",
        ],
      );
    }).pipe(Effect.scoped, Effect.provide(Settings.layerTest())),
  );

  it.effect("leaves the tools alone outside a Boat machine", () =>
    Effect.gen(function* () {
      const { calls } = yield* startLayer({});
      assert.strictEqual(yield* Queue.size(calls), 0);
    }).pipe(Effect.scoped, Effect.provide(Settings.layerTest())),
  );
});
