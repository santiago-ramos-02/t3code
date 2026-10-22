import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse, type HttpClientRequest } from "effect/http";
import * as Layer from "effect/Layer";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
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

const makeService = (client: HttpClient.HttpClient) =>
  BoatMachines.make.pipe(Effect.provideService(HttpClient.HttpClient, client));

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
      // T3 was not running yet, so it was started in the background.
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

  it.effect("removing the API key marks Boat as not configured", () =>
    Effect.gen(function* () {
      const service = yield* makeService(makeFakeBoat({}).client);
      yield* service.configure({ apiKey: "boat_test_key" });
      const removed = yield* service.configure({ apiKey: null });
      assert.strictEqual(removed.configured, false);
    }).pipe(Effect.provide(layerEnvironment)),
  );
});
