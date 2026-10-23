import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { DEFAULT_BOAT_SETTINGS } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import { HttpClient, HttpClientResponse, type HttpClientRequest } from "effect/http";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Stream from "effect/Stream";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as BoatMachines from "./BoatMachines.ts";

const SANDBOX_ID = "bx_test0001";
const MACHINE_URL = "https://box-node-test-3773.on.boat.dev";

interface BoatCall {
  readonly method: string;
  readonly path: string;
  readonly body: Record<string, unknown> | undefined;
  readonly headers: Readonly<Record<string, string>>;
}

const requestBody = (request: HttpClientRequest.HttpClientRequest) =>
  request.body._tag === "Uint8Array"
    ? (JSON.parse(new TextDecoder().decode(request.body.body)) as Record<string, unknown>)
    : undefined;

/** A fake Boat API; `pairing` is the stdout of `t3 auth pairing create --json`. */
const makeFakeBoat = (options: {
  readonly pairing?: string;
  readonly createFailure?: { readonly status: number; readonly message: string };
  // Holds the pairing command open after completing this, as a slow first start does.
  readonly pairingReached?: Deferred.Deferred<void>;
  // Boat no longer has the sandbox, as after a delete from its dashboard.
  readonly gone?: boolean;
}) => {
  const calls: BoatCall[] = [];
  const json = (request: HttpClientRequest.HttpClientRequest, body: unknown, status = 200) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(body, { status })));
  const client = HttpClient.make((request) => {
    const url = new URL(request.url);
    const body = requestBody(request);
    calls.push({ method: request.method, path: url.pathname, body, headers: request.headers });
    const path = url.pathname.replace(/^\/api\/v1/, "");
    if (request.method === "POST" && path === "/sandboxes") {
      return options.createFailure
        ? json(request, { message: options.createFailure.message }, options.createFailure.status)
        : json(request, { sandbox: { id: SANDBOX_ID, state: "provisioning" } });
    }
    if (options.gone && path.startsWith(`/sandboxes/${SANDBOX_ID}`)) {
      return json(request, { message: "Sandbox not found." }, 404);
    }
    if (request.method === "GET" && path === `/sandboxes/${SANDBOX_ID}`) {
      return json(request, { id: SANDBOX_ID, state: "idle" });
    }
    if (path === `/sandboxes/${SANDBOX_ID}/commands`) {
      const command = String(body?.command ?? "");
      if (body?.detached === true) return json(request, { type: "command.started" });
      const result = (exitCode: number, stdout: string) =>
        json(request, { exitCode, stdout, stderr: "" });
      if (command.includes("echo up || echo down")) return result(0, "down\n");
      if (command.includes("seq 1 120")) return result(0, "");
      if (command.includes("auth pairing create")) {
        if (options.pairingReached) {
          return Deferred.succeed(options.pairingReached, undefined).pipe(
            Effect.andThen(Effect.never),
          );
        }
        return options.pairing === undefined ? result(1, "") : result(0, options.pairing);
      }
      return result(127, "");
    }
    if (path === `/sandboxes/${SANDBOX_ID}/host`) return json(request, { url: MACHINE_URL });
    if (path === `/sandboxes/${SANDBOX_ID}/stop` || path === `/sandboxes/${SANDBOX_ID}/resume`) {
      return json(request, { ok: true });
    }
    if (request.method === "DELETE" && path === `/sandboxes/${SANDBOX_ID}`) {
      return json(request, { ok: true });
    }
    return json(request, { message: `unexpected ${request.method} ${path}` }, 404);
  });
  return { calls, client };
};

const PAIRING_OUTPUT =
  'npm warn exec installing t3\n{"id":"p1","credential":"PAIR-CODE","scopes":[]}';

// A fresh environment per test; services built within one test share its state directory.
const layerEnvironment = Layer.mergeAll(ServerSecretStore.layer).pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-boat-test-" })),
  Layer.provideMerge(NodeServices.layer),
);

/** A fake Boat CLI; without `login` it is not installed. */
const makeFakeCli = (login?: { readonly signedIn: boolean }) => {
  const calls: Array<ReadonlyArray<string>> = [];
  const output = (code: number, stdout: string) => ({
    stdout,
    stderr: code === 0 ? "" : "boat: not signed in",
    code: ChildProcessSpawner.ExitCode(code),
    timedOut: false,
    stdoutTruncated: false,
    stderrTruncated: false,
    stdoutInvalidUtf8: false,
    stderrInvalidUtf8: false,
  });
  const runner = ProcessRunner.ProcessRunner.of({
    run: (input) => {
      calls.push(input.args);
      if (!login) return Effect.succeed(output(127, ""));
      const [command, action] = input.args;
      if (command === "status") {
        return Effect.succeed(
          output(
            0,
            JSON.stringify({ account: { signedIn: login.signedIn, identifier: "me@x.dev" } }),
          ),
        );
      }
      if (command === "api-key" && action === "create") {
        return Effect.succeed(
          login.signedIn
            ? output(0, JSON.stringify({ secret: "boat_cli_key", id: "key_cli" }))
            : output(1, ""),
        );
      }
      if (command === "api-key" && action === "revoke") return Effect.succeed(output(0, "{}"));
      return Effect.succeed(output(2, ""));
    },
  });
  return { calls, runner };
};

const makeService = (
  client: HttpClient.HttpClient,
  cli: ProcessRunner.ProcessRunner["Service"] = makeFakeCli().runner,
) =>
  BoatMachines.make.pipe(
    Effect.provideService(HttpClient.HttpClient, client),
    Effect.provideService(ProcessRunner.ProcessRunner, cli),
  );

const callsTo = (calls: ReadonlyArray<BoatCall>, method: string, suffix: string) =>
  calls.filter((call) => call.method === method && call.path.endsWith(suffix));

describe("BoatMachines", () => {
  it.effect("refuses to start a machine without an API key", () =>
    Effect.gen(function* () {
      const boat = makeFakeBoat({ pairing: PAIRING_OUTPUT });
      const service = yield* makeService(boat.client);
      const error = yield* service.spawn({}).pipe(Effect.flip);
      assert.strictEqual(error.detail, "Add a Boat API key in Settings first.");
      assert.strictEqual(boat.calls.length, 0);
      assert.strictEqual((yield* service.current).configured, false);
    }).pipe(Effect.provide(layerEnvironment)),
  );

  it.effect("starts T3 Code on a new machine and returns its pairing credential", () =>
    Effect.gen(function* () {
      const boat = makeFakeBoat({ pairing: PAIRING_OUTPUT });
      const service = yield* makeService(boat.client);
      const configured = yield* service.configure({
        apiKey: " boat_test_key ",
        settings: { template: "mappstock-template", defaultSize: "default", idleStopMinutes: 5 },
      });
      assert.strictEqual(configured.configured, true);

      const result = yield* service.spawn({ size: "large" });

      assert.strictEqual(result.httpBaseUrl, MACHINE_URL);
      assert.strictEqual(result.pairingCredential, "PAIR-CODE");
      assert.deepStrictEqual(
        {
          state: result.machine.state,
          size: result.machine.size,
          url: result.machine.httpBaseUrl,
        },
        { state: "running", size: "large", url: MACHINE_URL },
      );
      const [create] = callsTo(boat.calls, "POST", "/sandboxes");
      assert.deepStrictEqual(create?.body, {
        type: "large",
        ttlSeconds: BoatMachines.BOAT_MACHINE_TTL_SECONDS,
        from: "mappstock-template",
      });
      assert.strictEqual(create?.headers.authorization, "Bearer boat_test_key");
      // T3 was not running yet, so it was named and started in the background.
      const commands = boat.calls.map((call) => String(call.body?.command ?? ""));
      const named = commands.findIndex((command) => command.includes("Boat · large · 0001"));
      const startedAt = boat.calls.findIndex((call) => call.body?.detached === true);
      assert.isAbove(named, -1);
      assert.isAbove(startedAt, named);
      assert.strictEqual(boat.calls.filter((call) => call.body?.detached === true).length, 1);
      const [hosted] = callsTo(boat.calls, "POST", "/host");
      assert.deepStrictEqual(hosted?.body, { port: BoatMachines.BOAT_T3_PORT, public: true });

      // The machine list survives a restart; the key itself is never in the status.
      const restarted = yield* makeService(boat.client);
      const status = yield* restarted.current;
      assert.deepStrictEqual(
        status.machines.map((machine) => [machine.sandboxId, machine.state]),
        [[SANDBOX_ID, "running"]],
      );
      assert.notInclude(JSON.stringify(status), "boat_test_key");

      // Stop, resume and delete act on that machine through Boat.
      const stopped = yield* restarted.machineAction({ sandboxId: SANDBOX_ID, action: "stop" });
      assert.strictEqual(stopped.machines[0]?.state, "stopped");
      const resumed = yield* restarted.machineAction({ sandboxId: SANDBOX_ID, action: "resume" });
      assert.strictEqual(resumed.machines[0]?.state, "running");
      assert.deepStrictEqual(callsTo(boat.calls, "POST", "/resume")[0]?.body, {
        ttlSeconds: BoatMachines.BOAT_MACHINE_TTL_SECONDS,
      });
      const deleted = yield* restarted.machineAction({ sandboxId: SANDBOX_ID, action: "delete" });
      assert.deepStrictEqual(deleted.machines, []);
      const [deletion] = callsTo(boat.calls, "DELETE", `/sandboxes/${SANDBOX_ID}`);
      assert.strictEqual(deletion?.headers["x-ascii-confirm-delete"], SANDBOX_ID);
    }).pipe(Effect.provide(layerEnvironment)),
  );

  it.effect("deletes a machine whose T3 Code server never pairs", () =>
    Effect.gen(function* () {
      const boat = makeFakeBoat({});
      const service = yield* makeService(boat.client);
      yield* service.configure({ apiKey: "boat_test_key" });

      const error = yield* service.spawn({}).pipe(Effect.flip);

      assert.strictEqual(
        error.detail,
        "T3 Code on the Boat machine did not create a pairing link.",
      );
      assert.strictEqual(callsTo(boat.calls, "DELETE", `/sandboxes/${SANDBOX_ID}`).length, 1);
      assert.deepStrictEqual((yield* service.current).machines, []);
    }).pipe(Effect.provide(layerEnvironment)),
  );

  it.effect("deletes the machine when the client goes away while it starts", () =>
    Effect.gen(function* () {
      const pairingReached = yield* Deferred.make<void>();
      const boat = makeFakeBoat({ pairingReached });
      const service = yield* makeService(boat.client);
      yield* service.configure({ apiKey: "boat_test_key" });

      const spawning = yield* service.spawn({}).pipe(Effect.forkChild);
      yield* Deferred.await(pairingReached);
      yield* Fiber.interrupt(spawning);

      assert.strictEqual(callsTo(boat.calls, "DELETE", `/sandboxes/${SANDBOX_ID}`).length, 1);
      assert.deepStrictEqual((yield* service.current).machines, []);
    }).pipe(Effect.provide(layerEnvironment)),
  );

  it.effect("deletes a machine left starting when the server stopped", () =>
    Effect.gen(function* () {
      const boat = makeFakeBoat({ pairing: PAIRING_OUTPUT });
      yield* (yield* makeService(boat.client)).configure({ apiKey: "boat_test_key" });
      // What a server that exited mid-start leaves behind.
      const fileSystem = yield* FileSystem.FileSystem;
      const { stateDir } = yield* ServerConfig.ServerConfig;
      yield* fileSystem.writeFileString(
        `${stateDir}/boat.json`,
        JSON.stringify({
          settings: DEFAULT_BOAT_SETTINGS,
          machines: [
            {
              sandboxId: SANDBOX_ID,
              size: "default",
              state: "starting",
              httpBaseUrl: null,
              createdAt: "2026-10-22T00:00:00.000Z",
              problem: null,
            },
          ],
        }),
      );

      const restarted = yield* makeService(boat.client);
      yield* restarted.streamChanges.pipe(
        Stream.filter((status) => status.machines.length === 0),
        Stream.runHead,
      );
      assert.strictEqual(callsTo(boat.calls, "DELETE", `/sandboxes/${SANDBOX_ID}`).length, 1);
    }).pipe(Effect.provide(layerEnvironment)),
  );

  it.effect("forgets a machine deleted outside T3 Code", () =>
    Effect.gen(function* () {
      const service = yield* makeService(makeFakeBoat({ pairing: PAIRING_OUTPUT }).client);
      yield* service.configure({ apiKey: "boat_test_key" });
      yield* service.spawn({});

      const gone = yield* makeService(makeFakeBoat({ gone: true }).client);
      const error = yield* gone
        .machineAction({ sandboxId: SANDBOX_ID, action: "resume" })
        .pipe(Effect.flip);
      assert.strictEqual(error.detail, "That Boat machine no longer exists.");
      assert.deepStrictEqual((yield* gone.current).machines, []);
    }).pipe(Effect.provide(layerEnvironment)),
  );

  it.effect("reports Boat's own reason when it refuses a machine", () =>
    Effect.gen(function* () {
      const boat = makeFakeBoat({
        createFailure: { status: 402, message: "Your balance is empty." },
      });
      const service = yield* makeService(boat.client);
      yield* service.configure({ apiKey: "boat_test_key" });

      const error = yield* service.spawn({}).pipe(Effect.flip);

      assert.strictEqual(
        error.detail,
        "Boat could not create a machine (HTTP 402): Your balance is empty.",
      );
      assert.deepStrictEqual((yield* service.current).machines, []);
    }).pipe(Effect.provide(layerEnvironment)),
  );

  it.effect("signs in with the Boat CLI and revokes its key when removed", () =>
    Effect.gen(function* () {
      const boat = makeFakeBoat({ pairing: PAIRING_OUTPUT });
      const cli = makeFakeCli({ signedIn: true });
      const service = yield* makeService(boat.client, cli.runner);

      const detected = yield* service.streamChanges.pipe(
        Stream.filter((status) => status.cli !== null),
        Stream.runHead,
      );
      assert.deepStrictEqual(Option.getOrNull(detected)?.cli, {
        signedIn: true,
        account: "me@x.dev",
      });

      const connected = yield* service.configure({ useCliLogin: true });
      assert.strictEqual(connected.configured, true);
      const create = cli.calls.find((args) => args[0] === "api-key" && args[1] === "create");
      assert.deepStrictEqual(create, [
        "api-key",
        "create",
        "T3 Code",
        "--preset",
        "ci",
        "--ttl",
        "never",
        "--json",
      ]);
      yield* service.spawn({});
      const [created] = callsTo(boat.calls, "POST", "/sandboxes");
      assert.strictEqual(created?.headers.authorization, "Bearer boat_cli_key");

      const removed = yield* service.configure({ apiKey: null });
      assert.strictEqual(removed.configured, false);
      assert.deepStrictEqual(
        cli.calls.find((args) => args[1] === "revoke"),
        ["api-key", "revoke", "key_cli", "--json"],
      );
    }).pipe(Effect.provide(layerEnvironment)),
  );

  it.effect("asks to sign in to the Boat CLI before using it", () =>
    Effect.gen(function* () {
      const cli = makeFakeCli({ signedIn: false });
      const service = yield* makeService(makeFakeBoat({}).client, cli.runner);
      const error = yield* service.configure({ useCliLogin: true }).pipe(Effect.flip);
      assert.strictEqual(error.detail, "Sign in to the Boat CLI first: run `boat login`.");
      assert.isFalse(cli.calls.some((args) => args[1] === "create"));
      assert.strictEqual((yield* service.current).configured, false);
    }).pipe(Effect.provide(layerEnvironment)),
  );

  it.effect("removing the API key marks Boat as not configured", () =>
    Effect.gen(function* () {
      const service = yield* makeService(makeFakeBoat({}).client);
      yield* service.configure({ apiKey: "boat_test_key" });
      const removed = yield* service.configure({ apiKey: null });
      assert.strictEqual(removed.configured, false);
    }).pipe(Effect.provide(layerEnvironment)),
  );
});
