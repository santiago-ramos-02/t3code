import {
  BoatError,
  BoatMachine,
  BoatSettings,
  DEFAULT_BOAT_SETTINGS,
  boatMachineLabel,
  type BoatConfigureInput,
  type BoatMachineActionInput,
  type BoatSpawnInput,
  type BoatSpawnResult,
  type BoatStatus,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { HttpClient } from "effect/http";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { BOAT_FAILED_STATES, BOAT_READY_STATES, makeBoatApi, type BoatApi } from "./BoatApi.ts";

const API_KEY_SECRET = "boat-api-key";
// The port each machine's T3 Code server listens on, published through Boat's HTTPS route.
export const BOAT_T3_PORT = 3773;
// Boat stops a machine this long after it starts or resumes, so one this server forgets about
// stops on its own; the idle rule stops machines much sooner.
export const BOAT_MACHINE_TTL_SECONDS = 2 * 60 * 60;

// A template installs the fork's `t3`; Boat's base image only has npm, so it runs the published one.
const T3_COMMAND = `$(command -v t3 >/dev/null 2>&1 && echo t3 || echo "npx -y t3@latest")`;
const T3_SERVE = `sh -lc 'exec ${T3_COMMAND} serve --host 0.0.0.0 --port ${BOAT_T3_PORT} --no-browser'`;
const T3_UP = `curl -sf -o /dev/null http://127.0.0.1:${BOAT_T3_PORT}/`;
const T3_WAIT = `for i in $(seq 1 120); do ${T3_UP} && exit 0; sleep 1; done; exit 1`;
const T3_PAIRING = `sh -lc '${T3_COMMAND} auth pairing create --json'`;

// T3 Code reads its name from /etc/machine-info at startup. Best effort: without it the machine
// keeps Boat's hostname as its name.
const setMachineLabel = (label: string) =>
  `printf 'PRETTY_HOSTNAME="%s"\\n' '${label}' | (sudo -n tee /etc/machine-info || tee /etc/machine-info) >/dev/null 2>&1; true`;

const PersistedState = Schema.Struct({
  settings: BoatSettings,
  machines: Schema.Array(BoatMachine),
});
type PersistedState = typeof PersistedState.Type;
const decodePersistedState = Schema.decodeUnknownOption(Schema.fromJsonString(PersistedState));
const encodePersistedState = Schema.encodeSync(Schema.fromJsonString(PersistedState));

const PairingCredential = Schema.Struct({ credential: Schema.String });
const decodePairingCredential = Schema.decodeUnknownOption(
  Schema.fromJsonString(PairingCredential),
);

const fail = (detail: string) => new BoatError({ detail });

export class BoatMachines extends Context.Service<
  BoatMachines,
  {
    readonly current: Effect.Effect<BoatStatus>;
    /** The current status, then every change. */
    readonly streamChanges: Stream.Stream<BoatStatus>;
    readonly configure: (input: BoatConfigureInput) => Effect.Effect<BoatStatus, BoatError>;
    /** Starts a machine running T3 Code and returns a one-time pairing credential for it. */
    readonly spawn: (input: BoatSpawnInput) => Effect.Effect<BoatSpawnResult, BoatError>;
    readonly machineAction: (input: BoatMachineActionInput) => Effect.Effect<BoatStatus, BoatError>;
  }
>()("t3/boat/BoatMachines") {}

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const httpClient = yield* HttpClient.HttpClient;

  const statePath = path.join(serverConfig.stateDir, "boat.json");
  const initial = yield* fileSystem.readFileString(statePath).pipe(
    Effect.map(decodePersistedState),
    Effect.map(
      Option.getOrElse((): PersistedState => ({ settings: DEFAULT_BOAT_SETTINGS, machines: [] })),
    ),
    Effect.orElseSucceed((): PersistedState => ({ settings: DEFAULT_BOAT_SETTINGS, machines: [] })),
  );
  const readApiKey = secrets.get(API_KEY_SECRET).pipe(
    Effect.map(Option.map((bytes) => new TextDecoder().decode(bytes))),
    Effect.orElseSucceed(() => Option.none<string>()),
  );
  const state = yield* SubscriptionRef.make<BoatStatus>({
    configured: Option.isSome(yield* readApiKey),
    ...initial,
  });
  // One writer at a time, so a slow spawn cannot overwrite a newer machine list.
  const writes = yield* Semaphore.make(1);

  const persist = (status: BoatStatus) =>
    fileSystem
      .writeFileString(
        statePath,
        encodePersistedState({ settings: status.settings, machines: status.machines }),
      )
      .pipe(Effect.mapError(() => fail("T3 Code could not save its Boat machines.")));

  const update = (f: (status: BoatStatus) => BoatStatus) =>
    writes.withPermits(1)(
      Effect.gen(function* () {
        const next = f(yield* SubscriptionRef.get(state));
        yield* persist(next);
        yield* SubscriptionRef.set(state, next);
        return next;
      }),
    );

  const putMachine = (machine: BoatMachine) =>
    update((status) => ({
      ...status,
      machines: [...status.machines.filter((m) => m.sandboxId !== machine.sandboxId), machine],
    }));

  const dropMachine = (sandboxId: string) =>
    update((status) => ({
      ...status,
      machines: status.machines.filter((m) => m.sandboxId !== sandboxId),
    }));

  const api = Effect.gen(function* () {
    const key = yield* readApiKey;
    if (Option.isNone(key)) return yield* fail("Add a Boat API key in Settings first.");
    return makeBoatApi(httpClient, key.value);
  });

  const waitUntilReady = (boat: BoatApi, sandboxId: string) =>
    boat.getSandbox(sandboxId).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(fail("The Boat machine disappeared while starting.")),
          onSome: (sandbox) =>
            BOAT_READY_STATES.has(sandbox.state)
              ? Effect.void
              : BOAT_FAILED_STATES.has(sandbox.state)
                ? Effect.fail(fail(`The Boat machine stopped while starting (${sandbox.state}).`))
                : Effect.fail(fail("The Boat machine is still starting.")),
        }),
      ),
      Effect.retry({
        while: (error) => error.detail === "The Boat machine is still starting.",
        schedule: Schedule.spaced("2 seconds"),
        times: 90,
      }),
    );

  const startT3 = Effect.fn("BoatMachines.startT3")(function* (
    boat: BoatApi,
    machine: BoatMachine,
  ) {
    const { sandboxId } = machine;
    const probe = yield* boat.runCommand(sandboxId, {
      command: `${T3_UP} && echo up || echo down`,
    });
    if (probe.stdout.trim() !== "up") {
      yield* boat.runCommand(sandboxId, { command: setMachineLabel(boatMachineLabel(machine)) });
      yield* boat.startDetached(sandboxId, T3_SERVE);
    }
    const waited = yield* boat.runCommand(sandboxId, { command: T3_WAIT, timeoutSeconds: 150 });
    if (waited.exitCode !== 0) {
      return yield* fail("T3 Code did not start on the Boat machine within two minutes.");
    }
    const pairing = yield* boat.runCommand(sandboxId, { command: T3_PAIRING, timeoutSeconds: 120 });
    const json = pairing.stdout.slice(pairing.stdout.indexOf("{"));
    const credential = decodePairingCredential(json);
    if (pairing.exitCode !== 0 || Option.isNone(credential)) {
      return yield* fail("T3 Code on the Boat machine did not create a pairing link.");
    }
    const httpBaseUrl = yield* boat.hostPublicPort(sandboxId, BOAT_T3_PORT);
    return { httpBaseUrl, pairingCredential: credential.value.credential };
  });

  // A machine no client can reach would bill until Boat's TTL stops it, so it is deleted. When
  // Boat refuses, the user sees why and can delete it from Settings.
  const discard = (boat: BoatApi, machine: BoatMachine, reason: string) =>
    boat.deleteSandbox(machine.sandboxId).pipe(
      Effect.andThen(dropMachine(machine.sandboxId)),
      Effect.catch((error) =>
        putMachine({
          ...machine,
          state: "failed",
          problem: `${reason} T3 Code could not delete it (${error.detail}); Boat stops it within two hours.`,
        }),
      ),
      Effect.ignore,
    );

  const spawn = Effect.fn("BoatMachines.spawn")(function* (input: BoatSpawnInput) {
    const boat = yield* api;
    const { settings } = yield* SubscriptionRef.get(state);
    const size = input.size ?? settings.defaultSize;
    const sandbox = yield* boat.createSandbox({
      type: size,
      from: settings.template,
      ttlSeconds: BOAT_MACHINE_TTL_SECONDS,
    });
    const starting: BoatMachine = {
      sandboxId: sandbox.id,
      size,
      state: "starting",
      httpBaseUrl: null,
      createdAt: DateTime.formatIso(yield* DateTime.now),
      problem: null,
    };
    // onError also covers interruption, such as the client disconnecting mid-start, since only
    // this call's caller ever receives the pairing credential.
    return yield* Effect.gen(function* () {
      yield* putMachine(starting);
      yield* waitUntilReady(boat, sandbox.id);
      const started = yield* startT3(boat, starting);
      const machine: BoatMachine = {
        ...starting,
        state: "running",
        httpBaseUrl: started.httpBaseUrl,
      };
      yield* putMachine(machine);
      return { machine, ...started };
    }).pipe(
      Effect.onError(() => discard(boat, starting, "The Boat machine did not finish starting.")),
    );
  });

  // A start this server was running when it stopped can never hand out its pairing credential.
  const unfinished = initial.machines.filter((machine) => machine.state === "starting");
  if (unfinished.length > 0) {
    const reason = "T3 Code restarted while this machine was starting.";
    yield* api.pipe(
      Effect.flatMap((boat) =>
        Effect.forEach(unfinished, (machine) => discard(boat, machine, reason)),
      ),
      Effect.catch(() =>
        Effect.forEach(unfinished, (machine) =>
          putMachine({ ...machine, state: "failed", problem: reason }),
        ),
      ),
      Effect.ignore,
      Effect.forkScoped,
    );
  }

  const configure = Effect.fn("BoatMachines.configure")(function* (input: BoatConfigureInput) {
    if (input.apiKey !== undefined) {
      const key = input.apiKey?.trim() ?? "";
      yield* (
        key.length === 0
          ? secrets.remove(API_KEY_SECRET)
          : secrets.set(API_KEY_SECRET, new TextEncoder().encode(key))
      ).pipe(Effect.mapError(() => fail("T3 Code could not save the Boat API key.")));
    }
    const configured = Option.isSome(yield* readApiKey);
    return yield* update((status) => ({
      ...status,
      configured,
      settings: input.settings ?? status.settings,
    }));
  });

  const machineAction = Effect.fn("BoatMachines.machineAction")(function* (
    input: BoatMachineActionInput,
  ) {
    const boat = yield* api;
    const machine = (yield* SubscriptionRef.get(state)).machines.find(
      (m) => m.sandboxId === input.sandboxId,
    );
    if (machine === undefined) return yield* fail("That Boat machine is not one of this server's.");
    // A machine deleted outside T3 Code, such as from Boat's dashboard, is forgotten here too.
    const unlessGone = <A>(effect: Effect.Effect<A, BoatError>) =>
      effect.pipe(
        Effect.catch((error) =>
          boat
            .getSandbox(machine.sandboxId)
            .pipe(
              Effect.flatMap((sandbox) =>
                Option.isSome(sandbox)
                  ? Effect.fail(error)
                  : dropMachine(machine.sandboxId).pipe(
                      Effect.andThen(Effect.fail(fail("That Boat machine no longer exists."))),
                    ),
              ),
            ),
        ),
      );
    switch (input.action) {
      case "stop":
        yield* unlessGone(boat.stopSandbox(machine.sandboxId));
        return yield* putMachine({ ...machine, state: "stopped", problem: null });
      case "resume":
        yield* unlessGone(boat.resumeSandbox(machine.sandboxId, BOAT_MACHINE_TTL_SECONDS));
        return yield* putMachine({ ...machine, state: "running", problem: null });
      case "delete":
        yield* boat.deleteSandbox(machine.sandboxId);
        return yield* dropMachine(machine.sandboxId);
    }
  });

  return BoatMachines.of({
    current: SubscriptionRef.get(state),
    streamChanges: SubscriptionRef.changes(state),
    configure,
    spawn,
    machineAction,
  });
});

export const layer = Layer.effect(BoatMachines, make);
