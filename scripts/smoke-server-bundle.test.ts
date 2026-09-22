import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import {
  buildFakePiResponseLine,
  buildSmokeChildEnv,
  DEFAULT_BUNDLE,
  FAKE_PI_MODELS,
  FAKE_PI_VERSION,
  isServerRunning,
  isSmokePiProviderReady,
  parsePairCredential,
  parseSmokeArgs,
  redactSecrets,
  renderFakePiSource,
  smokeFail,
  stopServer,
  withAcquiredSmokeServer,
  type SpawnedServer,
} from "./smoke-server-bundle.ts";

describe("smoke-server-bundle args", () => {
  it("defaults to the built server bundle", () => {
    assert.deepStrictEqual(parseSmokeArgs([]), { bundle: DEFAULT_BUNDLE });
    assert.equal(DEFAULT_BUNDLE, "apps/server/dist/bin.mjs");
  });

  it("accepts --bundle in both forms", () => {
    assert.deepStrictEqual(parseSmokeArgs(["--bundle", "out/bin.mjs"]), {
      bundle: "out/bin.mjs",
    });
    assert.deepStrictEqual(parseSmokeArgs(["--bundle=out/bin.mjs"]), {
      bundle: "out/bin.mjs",
    });
  });

  it("rejects unknown flags and missing values", () => {
    assert.throws(() => parseSmokeArgs(["--nope"]), /Unknown argument/);
    assert.throws(() => parseSmokeArgs(["--bundle"]), /Missing value/);
    assert.throws(() => parseSmokeArgs(["--bundle="]), /Missing value/);
    assert.throws(() => parseSmokeArgs(["--bundle", "--bundle", "x"]), /Missing value/);
  });
});

describe("fake Pi responses", () => {
  it("emits a correlated success envelope for get_available_models", () => {
    const line = buildFakePiResponseLine({ id: "t3-pi-1", command: "get_available_models" });
    assert.isTrue(line.endsWith("\n"));
    const record = JSON.parse(line) as Record<string, unknown>;
    assert.equal(record["type"], "response");
    assert.equal(record["id"], "t3-pi-1");
    assert.equal(record["command"], "get_available_models");
    assert.equal(record["success"], true);
    const data = record["data"] as { models: ReadonlyArray<unknown> };
    assert.isTrue(data.models.length > 0);
  });

  it("ships models matching the Pi discovery shape", () => {
    for (const model of FAKE_PI_MODELS) {
      assert.isTrue(model.id.length > 0);
      assert.isTrue(model.name.length > 0);
      assert.isTrue(model.provider.length > 0);
      assert.typeOf(model.reasoning, "boolean");
      assert.isTrue(model.input.length > 0);
    }
  });

  it("renders a fake executable that reports the version and answers RPC", () => {
    const source = renderFakePiSource();
    assert.include(source, "#!/usr/bin/env node");
    assert.include(source, JSON.stringify(FAKE_PI_VERSION));
    assert.include(source, "--version");
    assert.include(source, "--mode");
    assert.include(source, '"response"');
    assert.include(source, "success");
    assert.equal(FAKE_PI_VERSION, "0.99.0");
  });
});

describe("pairing credential handling", () => {
  it("parses the Token line without the caller logging output", () => {
    const credential = parsePairCredential(
      ["Pairing with smoke (http://127.0.0.1:1).", "", "Token: secret-abc-123", ""].join("\n"),
    );
    assert.equal(credential, "secret-abc-123");
  });

  it("returns undefined when no Token line is present", () => {
    assert.isUndefined(parsePairCredential("no token here\n"));
  });

  it("redacts token material before output is logged", () => {
    assert.equal(
      redactSecrets("url=http://x/?token=secret-abc-123 done"),
      "url=http://x/?token=REDACTED done",
    );
    assert.equal(redactSecrets("Token: secret-abc-123"), "Token: REDACTED");
  });
});

describe("Pi readiness contract", () => {
  it("requires driver pi, enabled, installed, ready, the fake version, and not unavailable", () => {
    const ready = {
      driver: "pi",
      enabled: true,
      installed: true,
      version: FAKE_PI_VERSION,
      status: "ready",
    };
    assert.isTrue(isSmokePiProviderReady(ready));
    assert.isTrue(isSmokePiProviderReady({ ...ready, availability: "available" }));
    assert.isFalse(isSmokePiProviderReady({ ...ready, driver: "codex" }));
    assert.isFalse(isSmokePiProviderReady({ ...ready, enabled: false }));
    assert.isFalse(isSmokePiProviderReady({ ...ready, installed: false }));
    assert.isFalse(isSmokePiProviderReady({ ...ready, version: "0.1.0" }));
    assert.isFalse(isSmokePiProviderReady({ ...ready, version: null }));
    assert.isFalse(isSmokePiProviderReady({ ...ready, status: "error" }));
    assert.isFalse(isSmokePiProviderReady({ ...ready, availability: "unavailable" }));
  });
});

describe("smoke child env isolation", () => {
  const scratch = { baseDir: "/scratch/home", tmpDir: "/scratch/tmp" };
  const ambientSecrets: Record<string, string> = {
    OPENAI_API_KEY: "sk-openai-secret",
    ANTHROPIC_API_KEY: "sk-ant-secret",
    GITHUB_TOKEN: "ghp-secret",
    GH_TOKEN: "ghp-secret-2",
    NPM_TOKEN: "npm-secret",
    AWS_SECRET_ACCESS_KEY: "aws-secret",
    T3_TOKEN: "t3-secret",
    PI_API_KEY: "pi-secret",
    SECRET_TOKEN: "shh",
  };

  it("excludes representative ambient secrets and tokens", () => {
    const env = buildSmokeChildEnv({ PATH: "/usr/bin", ...ambientSecrets }, scratch);
    for (const key of Object.keys(ambientSecrets)) {
      assert.isUndefined(env[key], `ambient secret ${key} must not leak into the child env`);
    }
    for (const value of Object.values(env)) {
      for (const secret of Object.values(ambientSecrets)) {
        assert.notInclude(String(value), secret);
      }
    }
  });

  it("preserves PATH and pins scratch home/temp dirs", () => {
    const env = buildSmokeChildEnv(
      { PATH: "/usr/bin:/bin", HOME: "/home/dev", TMPDIR: "/tmp", ...ambientSecrets },
      scratch,
    );
    assert.equal(env["PATH"], "/usr/bin:/bin");
    assert.equal(env["HOME"], scratch.baseDir);
    assert.equal(env["USERPROFILE"], scratch.baseDir);
    assert.equal(env["T3CODE_HOME"], scratch.baseDir);
    assert.equal(env["TMPDIR"], scratch.tmpDir);
    assert.equal(env["TEMP"], scratch.tmpDir);
    assert.equal(env["TMP"], scratch.tmpDir);
  });

  it("does not spread unrelated ambient keys", () => {
    const env = buildSmokeChildEnv(
      { PATH: "/usr/bin", EDITOR: "vim", SHELL: "/bin/zsh", MY_APP_TOKEN: "x" },
      scratch,
    );
    assert.isUndefined(env["EDITOR"]);
    assert.isUndefined(env["SHELL"]);
    assert.isUndefined(env["MY_APP_TOKEN"]);
  });
});

describe("smokeFail redaction", () => {
  it("redacts token/wsTicket/Token details centrally", () => {
    const ticket = "t3-ws-ticket-secret-123";
    const error = smokeFail(
      "calling server.getConfig",
      `failed with wsTicket=${ticket} and token=pair-secret-abc and "ticket": "${ticket}"`,
    );
    assert.notInclude(error.detail, ticket);
    assert.notInclude(error.detail, "pair-secret-abc");
    assert.include(error.detail, "REDACTED");
    assert.notInclude(error.message, ticket);
  });

  it("redacts Token lines and bearer material", () => {
    const error = smokeFail("pairing", "Token: super-secret-pair-token\nBearer abc123");
    assert.notInclude(error.detail, "super-secret-pair-token");
    assert.notInclude(error.detail, "abc123");
    assert.include(error.detail, "REDACTED");
  });

  it("redacts wsTicket query strings in diagnostics", () => {
    assert.equal(
      redactSecrets("/ws?wsTicket=ticket-secret-xyz&other=1"),
      "/ws?wsTicket=REDACTED&other=1",
    );
  });
});

describe("smoke server lifecycle", () => {
  const makeFakeServer = (overrides?: {
    readonly exitCode?: number | null;
    readonly exitOnKill?: boolean;
  }): { server: SpawnedServer; killed: Array<NodeJS.Signals> } => {
    const killed: Array<NodeJS.Signals> = [];
    const state = { exitCode: overrides?.exitCode ?? null };
    const server: SpawnedServer = {
      child: {
        get exitCode(): number | null {
          return state.exitCode;
        },
        signalCode: null,
        kill: (signal: NodeJS.Signals) => {
          killed.push(signal);
          if (overrides?.exitOnKill !== false) {
            state.exitCode = 0;
          }
          return true;
        },
      },
      pid: 424242,
      output: { text: "" },
      spawnError: { error: undefined },
    };
    return { server, killed };
  };

  it("reports running only while the child is alive without spawn errors", () => {
    const { server: running } = makeFakeServer();
    assert.isTrue(isServerRunning(running));
    assert.isFalse(isServerRunning(makeFakeServer({ exitCode: 0 }).server));
    const errored = makeFakeServer().server;
    errored.spawnError.error = new Error("spawn ENOENT");
    assert.isFalse(isServerRunning(errored));
  });

  it.effect("stopServer signals the exact injected child pid target", () =>
    Effect.gen(function* () {
      const { server, killed } = makeFakeServer();
      yield* stopServer(server);
      assert.deepStrictEqual(killed[0], "SIGTERM");
    }),
  );

  it.effect("acquired lifecycle releases the server when use fails", () =>
    Effect.gen(function* () {
      const { server } = makeFakeServer();
      let released = 0;
      let seenPid: number | undefined;
      const result = yield* withAcquiredSmokeServer({
        acquire: Effect.succeed(server),
        use: (acquired) =>
          Effect.gen(function* () {
            seenPid = acquired.pid;
            return yield* Effect.fail("boom");
          }),
        release: () =>
          Effect.sync(() => {
            released += 1;
          }),
      }).pipe(Effect.flip);
      assert.equal(result, "boom");
      assert.equal(seenPid, 424242);
      assert.equal(released, 1);
    }),
  );

  it.effect("acquired lifecycle releases the server on interruption", () =>
    Effect.gen(function* () {
      const { server } = makeFakeServer();
      let released = 0;
      const gate = yield* Deferred.make<void>();
      const program = withAcquiredSmokeServer({
        acquire: Effect.succeed(server),
        use: () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(gate, undefined);
            return yield* Effect.never;
          }),
        release: () =>
          Effect.sync(() => {
            released += 1;
          }),
      });
      const fiber = yield* program.pipe(Effect.forkChild);
      yield* Deferred.await(gate);
      yield* Fiber.interrupt(fiber);
      assert.equal(released, 1);
    }),
  );
});
