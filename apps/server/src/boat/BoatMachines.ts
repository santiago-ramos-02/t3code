import {
  BoatError,
  BoatMachine,
  BoatMachineReport,
  BoatSettings,
  BoatStatus,
  DEFAULT_BOAT_SETTINGS,
  boatMachineLabel,
  type BoatConfigureInput,
  type BoatStartStep,
  type BoatMachineActionInput,
  type BoatSpawnInput,
  type BoatSpawnResult,
  type ServerSettings,
} from "@t3tools/contracts";
import { resolveWorktreeCleanup } from "@t3tools/shared/projectSettings";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import type * as Duration from "effect/Duration";
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
import * as Socket from "effect/socket/Socket";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as GitHubCredentials from "@t3tools/source-control-github/server/GitHubCredentials";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { captureBoatUsage } from "./boatUsage.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as Settings from "../serverSettings.ts";
import {
  BOAT_READY_STATES,
  BOAT_START_FAILED_STATES,
  BOAT_TERMINAL_STATES,
  makeBoatApi,
  type BoatApi,
} from "./BoatApi.ts";
import { makeBoatCli } from "./BoatCli.ts";
import { giveMachineGitHubLogin } from "./machineGitHub.ts";
import {
  HostVersion,
  T3_COMMAND,
  forkRuntimeCommands,
  forkRuntimeUnavailableNotice,
  lastLine,
} from "./forkRuntime.ts";
import {
  BOAT_FREE_STOPPED_DAYS,
  BOAT_SETUP_GRACE_MS,
  BOAT_SNAPSHOT_AFTER_MS,
  BOAT_SNAPSHOT_WARNING_MS,
  boatCleanupRule,
  boatKeepReason,
  boatSnapshotName,
  parseReport,
  planBoatSnapshots,
  reportCommand,
} from "./machineReport.ts";

const API_KEY_SECRET = "boat-api-key";
// The ID of a key the Boat CLI made for T3 Code, revoked when that key is replaced or removed.
const CLI_KEY_ID_SECRET = "boat-api-key-cli-id";
// The port each machine's T3 Code server listens on, published through Boat's HTTPS route.
export const BOAT_T3_PORT = 3773;
// Boat stops a machine this long after T3 Code last renewed it, so one this server stops watching,
// such as while it is off, stops on its own; the idle rule stops machines much sooner. Boat's free
// trial refuses anything longer.
export const BOAT_MACHINE_TTL_SECONDS = 2 * 60 * 60;
const MINUTE_MS = 60 * 1000;
// How often a running machine's usage is copied to this server; stops and deletes copy first.
const USAGE_COPY_INTERVAL_MS = 15 * MINUTE_MS;
const DAY_MS = 24 * 60 * MINUTE_MS;
// Clients forget their pairings with the machines listed here.
const DELETED_RECORDS = 20;

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
  deleted: BoatStatus.fields.deleted,
});
type PersistedState = typeof PersistedState.Type;
const decodePersistedState = Schema.decodeUnknownOption(Schema.fromJsonString(PersistedState));
const encodePersistedState = Schema.encodeSync(Schema.fromJsonString(PersistedState));

const PairingCredential = Schema.Struct({ credential: Schema.String });
const decodePairingCredential = Schema.decodeUnknownOption(
  Schema.fromJsonString(PairingCredential),
);

const fail = (detail: string) => new BoatError({ detail });
const sameReport = Schema.toEquivalence(BoatMachineReport);

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
    /**
     * Applies the idle stop, the worktree cleanup rules, and the snapshots that keep stopped disks
     * past Boat's free days. The layer runs it every minute.
     */
    readonly checkMachines: Effect.Effect<void>;
  }
>()("t3/boat/BoatMachines") {}

export const make = Effect.gen(function* () {
  const hostVersion = yield* HostVersion;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const settingsService = yield* Settings.ServerSettingsService;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const httpClient = yield* HttpClient.HttpClient;
  const githubCredentials = yield* GitHubCredentials.GitHubCredentials;
  const webSocket = yield* Socket.WebSocketConstructor;
  const cli = makeBoatCli({
    runner: yield* ProcessRunner.ProcessRunner,
    path,
    environment: yield* HostProcess.Environment,
    platform: yield* HostProcess.Platform,
  });

  const statePath = path.join(serverConfig.stateDir, "boat.json");
  const initial = yield* fileSystem.readFileString(statePath).pipe(
    Effect.map(decodePersistedState),
    Effect.map(
      Option.getOrElse((): PersistedState => ({
        settings: DEFAULT_BOAT_SETTINGS,
        machines: [],
        deleted: [],
      })),
    ),
    Effect.orElseSucceed((): PersistedState => ({
      settings: DEFAULT_BOAT_SETTINGS,
      machines: [],
      deleted: [],
    })),
  );
  const readApiKey = secrets.get(API_KEY_SECRET).pipe(
    Effect.map(Option.map((bytes) => new TextDecoder().decode(bytes))),
    Effect.orElseSucceed(() => Option.none<string>()),
  );
  const state = yield* SubscriptionRef.make<BoatStatus>({
    configured: Option.isSome(yield* readApiKey),
    cli: null,
    ...initial,
  });
  // One writer at a time, so a slow spawn cannot overwrite a newer machine list.
  const writes = yield* Semaphore.make(1);

  const persist = (status: BoatStatus) =>
    fileSystem
      .writeFileString(
        statePath,
        encodePersistedState({
          settings: status.settings,
          machines: status.machines,
          deleted: status.deleted,
        }),
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

  // Changes a machine only while it is still listed, so a late change cannot bring back a deleted one.
  const changeMachine = (sandboxId: string, f: (machine: BoatMachine) => BoatMachine) =>
    update((status) => ({
      ...status,
      machines: status.machines.map((m) => (m.sandboxId === sandboxId ? f(m) : m)),
    }));

  // Drops a machine clients may be paired with and records why, so they forget it too.
  const forget = (machine: BoatMachine, reason: string) =>
    DateTime.now.pipe(
      Effect.flatMap((now) =>
        update((status) => ({
          ...status,
          machines: status.machines.filter((m) => m.sandboxId !== machine.sandboxId),
          deleted: [
            {
              sandboxId: machine.sandboxId,
              label: boatMachineLabel(machine),
              httpBaseUrl: machine.httpBaseUrl,
              reason,
              deletedAt: DateTime.formatIso(now),
            },
            ...status.deleted.filter((entry) => entry.sandboxId !== machine.sandboxId),
          ].slice(0, DELETED_RECORDS),
        })),
      ),
    );

  const detectCli = cli.login().pipe(
    Effect.map(Option.map(({ signedIn, account }) => ({ signedIn, account }))),
    Effect.map(Option.getOrNull),
    Effect.flatMap((login) =>
      writes.withPermits(1)(SubscriptionRef.update(state, (status) => ({ ...status, cli: login }))),
    ),
  );
  // Checked when someone opens a status stream, since the CLI can be installed or signed into at
  // any time; at most every few seconds, as each check starts a process.
  const refreshCli = yield* Effect.cachedWithTTL(detectCli, "10 seconds");
  const serviceScope = yield* Effect.scope;

  const readSecretText = (name: string) =>
    secrets.get(name).pipe(
      Effect.map(Option.map((bytes) => new TextDecoder().decode(bytes))),
      Effect.orElseSucceed(() => Option.none<string>()),
    );

  // Saves the new key (null removes it) and returns the ID of the CLI-created key it replaced.
  // The old key stays valid until the new one is saved, so a failed save never leaves T3 Code
  // holding a revoked key.
  const storeKey = Effect.fn("BoatMachines.storeKey")(
    function* (next: { readonly secret: string; readonly cliKeyId: string | null } | null) {
      const previousId = yield* readSecretText(CLI_KEY_ID_SECRET);
      const encode = (text: string) => new TextEncoder().encode(text);
      if (next === null) {
        yield* secrets.remove(API_KEY_SECRET);
      } else {
        yield* secrets.set(API_KEY_SECRET, encode(next.secret));
      }
      yield* next?.cliKeyId
        ? secrets.set(CLI_KEY_ID_SECRET, encode(next.cliKeyId))
        : secrets.remove(CLI_KEY_ID_SECRET);
      return Option.filter(previousId, (id) => id !== next?.cliKeyId);
    },
    (effect, next) =>
      Effect.mapError(effect, () =>
        fail(
          next === null
            ? "T3 Code could not remove the Boat API key."
            : "T3 Code could not save the Boat API key.",
        ),
      ),
  );

  // T3 Code no longer knows a replaced key after this, so a failure names it for the user.
  const revokeReplacedKey = Effect.fn("BoatMachines.revokeReplacedKey")(function* (id: string) {
    const login = yield* cli.login();
    const revoked = Option.isSome(login)
      ? yield* cli.revokeKey(login.value.command, id).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        )
      : false;
    if (!revoked) {
      return yield* fail(
        `T3 Code could not revoke its previous Boat key. Revoke it with \`boat api-key revoke ${id}\` or in Boat's dashboard.`,
      );
    }
  });

  const api = Effect.gen(function* () {
    const key = yield* readApiKey;
    if (Option.isNone(key)) return yield* fail("Add a Boat API key in Settings first.");
    return makeBoatApi(httpClient, key.value);
  });

  const waitUntilReady = (boat: BoatApi, sandboxId: string, failedStates: ReadonlySet<string>) =>
    boat.getSandbox(sandboxId).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(fail("The Boat machine disappeared while starting.")),
          onSome: (sandbox) =>
            BOAT_READY_STATES.has(sandbox.state)
              ? Effect.void
              : failedStates.has(sandbox.state)
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

  // Records the step a new machine is on, for clients to show. Resumes and restores are not starts,
  // so only a machine still listed as starting takes a step.
  const startStep = (sandboxId: string, step: BoatStartStep) =>
    changeMachine(sandboxId, (machine) =>
      machine.state === "starting"
        ? { ...machine, startSteps: [...machine.startSteps.filter((s) => s !== step), step] }
        : machine,
    ).pipe(Effect.ignore);

  // Makes the machine run this server's build, which the fork publishes. A build nobody published,
  // such as a local one, leaves the machine on the template's T3 Code. Returns the notice for that.
  const installForkRuntime = Effect.fn("BoatMachines.installForkRuntime")(function* (
    boat: BoatApi,
    sandboxId: string,
  ) {
    const unavailable = forkRuntimeUnavailableNotice(hostVersion);
    const commands = forkRuntimeCommands(hostVersion);
    if (commands === null) return unavailable;
    const probe = yield* boat.runCommand(sandboxId, { command: commands.probe });
    if (lastLine(probe.stdout) === "current") return null;
    yield* startStep(sandboxId, "installing");
    // A download that fails for any reason must not stop the machine from starting.
    const installed = yield* boat
      .runCommand(sandboxId, { command: commands.install, timeoutSeconds: 300 })
      .pipe(Effect.orElseSucceed(() => null));
    return installed !== null && lastLine(installed.stdout) === "installed" ? null : unavailable;
  });

  // Resolves to the notice for a machine that could not be signed in to GitHub, else null.
  const giveGitHubLogin = (boat: BoatApi, sandboxId: string) =>
    giveMachineGitHubLogin({ boat, sandboxId, t3Command: T3_COMMAND, port: BOAT_T3_PORT }).pipe(
      // The step shows only when there is a token to give, which the lookup is first to know.
      Effect.provideService(GitHubCredentials.GitHubCredentials, {
        ...githubCredentials,
        get: (host) =>
          githubCredentials.get(host).pipe(Effect.tap(() => startStep(sandboxId, "signing-in"))),
      }),
      Effect.provideService(HttpClient.HttpClient, httpClient),
      Effect.provideService(Socket.WebSocketConstructor, webSocket),
    );

  // A stopped machine keeps its disk but not its processes, so a resume starts T3 Code again.
  const serveT3 = Effect.fn("BoatMachines.serveT3")(function* (
    boat: BoatApi,
    machine: BoatMachine,
  ) {
    const { sandboxId } = machine;
    const probe = yield* boat.runCommand(sandboxId, {
      command: `${T3_UP} && echo up || echo down`,
    });
    let notice: string | null = null;
    if (probe.stdout.trim() !== "up") {
      notice = yield* installForkRuntime(boat, sandboxId);
      yield* boat.runCommand(sandboxId, { command: setMachineLabel(boatMachineLabel(machine)) });
      yield* boat.startDetached(sandboxId, T3_SERVE);
    }
    const waited = yield* boat.runCommand(sandboxId, { command: T3_WAIT, timeoutSeconds: 150 });
    if (waited.exitCode !== 0) {
      return yield* fail("T3 Code did not start on the Boat machine within two minutes.");
    }
    // The login lives on the machine's disk, but this server's token can change, so each start sends it.
    const loginNotice = yield* giveGitHubLogin(boat, sandboxId);
    return [notice, loginNotice].filter((text) => text !== null).join(" ") || null;
  });

  const startT3 = Effect.fn("BoatMachines.startT3")(function* (
    boat: BoatApi,
    machine: BoatMachine,
  ) {
    const { sandboxId } = machine;
    const notice = yield* serveT3(boat, machine);
    const pairing = yield* boat.runCommand(sandboxId, { command: T3_PAIRING, timeoutSeconds: 120 });
    const json = pairing.stdout.slice(pairing.stdout.indexOf("{"));
    const credential = decodePairingCredential(json);
    if (pairing.exitCode !== 0 || Option.isNone(credential)) {
      return yield* fail("T3 Code on the Boat machine did not create a pairing link.");
    }
    const httpBaseUrl = yield* boat.hostPublicPort(sandboxId, BOAT_T3_PORT);
    return { httpBaseUrl, pairingCredential: credential.value.credential, notice };
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
          startSteps: [],
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
      projectId: input.projectId ?? null,
      stoppedAt: null,
      report: null,
      snapshot: null,
      notice: null,
      startSteps: ["starting"],
      startId: input.startId ?? null,
    };
    // onError also covers interruption, such as the client disconnecting mid-start, since only
    // this call's caller ever receives the pairing credential.
    return yield* Effect.gen(function* () {
      yield* putMachine(starting);
      yield* waitUntilReady(boat, sandbox.id, BOAT_START_FAILED_STATES);
      const { notice, ...started } = yield* startT3(boat, starting);
      const { machines } = yield* SubscriptionRef.get(state);
      const steps =
        machines.find((m) => m.sandboxId === sandbox.id)?.startSteps ?? starting.startSteps;
      const machine: BoatMachine = {
        ...starting,
        state: "running",
        httpBaseUrl: started.httpBaseUrl,
        notice,
        startSteps: [],
      };
      yield* putMachine(machine);
      // The saved machine is past its start; the result keeps the steps for the client to show.
      return { machine: { ...machine, startSteps: steps }, ...started };
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
          putMachine({ ...machine, state: "failed", problem: reason, startSteps: [] }),
        ),
      ),
      Effect.ignore,
      Effect.forkScoped,
    );
  }

  const changeKey = Effect.fn("BoatMachines.changeKey")(function* (input: BoatConfigureInput) {
    if (input.useCliLogin === true) {
      const login = yield* cli.login();
      if (Option.isNone(login)) {
        return yield* fail("The Boat CLI is not installed on this machine.");
      }
      if (!login.value.signedIn) {
        return yield* fail("Sign in to the Boat CLI first: run `boat login`.");
      }
      const { command } = login.value;
      const created = yield* cli.createKey(command, "T3 Code");
      return yield* storeKey({ secret: created.secret, cliKeyId: created.id }).pipe(
        // A key T3 Code failed to save would otherwise stay valid with nobody holding it.
        Effect.tapError(() => cli.revokeKey(command, created.id).pipe(Effect.ignore)),
      );
    }
    if (input.apiKey === undefined) return Option.none<string>();
    const key = input.apiKey?.trim() ?? "";
    // Without a key T3 Code can no longer stop or delete its machines, and they leave the list.
    if (key.length === 0 && (yield* SubscriptionRef.get(state)).machines.length > 0) {
      return yield* fail("Delete your Boat machines before removing the key.");
    }
    return yield* storeKey(key.length === 0 ? null : { secret: key, cliKeyId: null });
  });

  const configure = Effect.fn("BoatMachines.configure")(function* (input: BoatConfigureInput) {
    const refresh = (settings: BoatSettings | undefined) =>
      readApiKey.pipe(
        Effect.flatMap((key) =>
          update((status) => ({
            ...status,
            configured: Option.isSome(key),
            settings: settings ?? status.settings,
          })),
        ),
      );
    // Status follows the secret store even when a step fails part way.
    const replaced = yield* changeKey(input).pipe(
      Effect.onError(() => Effect.ignore(refresh(undefined))),
    );
    const status = yield* refresh(input.settings);
    if (Option.isSome(replaced)) yield* revokeReplacedKey(replaced.value);
    return status;
  });

  // When each running machine last had a turn, or was started or resumed by this server.
  const lastBusy = new Map<string, number>();
  // One lifecycle change at a time, so a check cannot delete a machine the user is resuming.
  const lifecycle = yield* Semaphore.make(1);

  // A copy of each machine's usage stays on this server, so it still counts once the machine is gone.
  const usageCopiedAt = new Map<string, number>();
  // One copy per machine at a time: two would each write over the other's newest hours.
  const copyingUsage = new Set<string>();
  const copyUsage = (boat: BoatApi, machine: BoatMachine, timeout: Duration.Input) =>
    Effect.suspend(() => {
      if (copyingUsage.has(machine.sandboxId)) return Effect.void;
      copyingUsage.add(machine.sandboxId);
      return captureBoatUsage({
        boat,
        machine,
        stateDir: serverConfig.stateDir,
        t3Command: T3_COMMAND,
        timeout,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.provideService(HttpClient.HttpClient, httpClient),
        Effect.andThen(DateTime.now),
        Effect.map((now) => usageCopiedAt.set(machine.sandboxId, DateTime.toEpochMillis(now))),
        Effect.ensuring(Effect.sync(() => copyingUsage.delete(machine.sandboxId))),
        Effect.asVoid,
      );
    });
  // Stop and delete hold the lifecycle lock, so their last copy gets a short budget. A copy
  // already running for the machine saves as it reads, so they skip theirs.
  const keepUsage = (boat: BoatApi, machine: BoatMachine) => copyUsage(boat, machine, "1 minute");
  // A first copy reads the machine's whole history, so it runs beside the checks.
  const keepUsageInBackground = (boat: BoatApi, machine: BoatMachine, now: number) => {
    const copiedAt = usageCopiedAt.get(machine.sandboxId) ?? Number.NEGATIVE_INFINITY;
    if (now - copiedAt < USAGE_COPY_INTERVAL_MS) return Effect.void;
    return copyUsage(boat, machine, "30 minutes").pipe(Effect.forkDetach, Effect.asVoid);
  };

  const readReport = (boat: BoatApi, sandboxId: string, withCheckouts: boolean) =>
    boat
      .runCommand(sandboxId, {
        command: reportCommand(withCheckouts),
        timeoutSeconds: withCheckouts ? 120 : 30,
      })
      .pipe(
        Effect.map(parseReport),
        Effect.orElseSucceed(() => Option.none<BoatMachineReport>()),
      );

  const withoutCheckouts = (report: BoatMachineReport | null) =>
    report === null ? null : { ...report, checkouts: null };

  // Reads the checkouts first: a stopped disk does not change, so cleanup can trust them later.
  const stopMachine = Effect.fn("BoatMachines.stopMachine")(function* (
    boat: BoatApi,
    machine: BoatMachine,
  ) {
    const report = yield* readReport(boat, machine.sandboxId, true);
    yield* keepUsage(boat, machine);
    yield* boat.stopSandbox(machine.sandboxId);
    const stoppedAt = DateTime.formatIso(yield* DateTime.now);
    lastBusy.delete(machine.sandboxId);
    return yield* changeMachine(machine.sandboxId, (current) => ({
      ...current,
      state: "stopped",
      problem: null,
      notice: null,
      stoppedAt,
      report: Option.getOrElse(report, () => withoutCheckouts(current.report)),
    }));
  });

  // Boat deleted the stopped disk after its free days, and the named snapshot T3 Code saved holds
  // it. The new machine takes over the old one's subdomain, so its address and pairings still work.
  const restore = Effect.fn("BoatMachines.restore")(function* (
    boat: BoatApi,
    machine: BoatMachine,
    snapshot: string,
  ) {
    const subdomain = Option.getOrUndefined(yield* boat.getSandbox(machine.sandboxId))?.subdomain;
    const sandbox = yield* boat.createSandbox({
      type: machine.size,
      from: snapshot,
      ttlSeconds: BOAT_MACHINE_TTL_SECONDS,
    });
    const restored: BoatMachine = {
      ...machine,
      sandboxId: sandbox.id,
      state: "running",
      problem: null,
      notice: null,
      stoppedAt: null,
      snapshot: null,
    };
    const notice = yield* Effect.gen(function* () {
      yield* boat.deleteSandbox(machine.sandboxId);
      if (subdomain) {
        // Boat frees the old machine's subdomain in the background.
        yield* boat
          .renameSandbox(sandbox.id, subdomain)
          .pipe(Effect.retry({ schedule: Schedule.spaced("3 seconds"), times: 10 }));
      }
      yield* waitUntilReady(boat, sandbox.id, BOAT_START_FAILED_STATES);
      const serveNotice = yield* serveT3(boat, restored);
      const httpBaseUrl = yield* boat.hostPublicPort(sandbox.id, BOAT_T3_PORT);
      if (httpBaseUrl !== machine.httpBaseUrl) {
        return yield* fail("Boat gave the restored machine a different address.");
      }
      return serveNotice;
    }).pipe(
      Effect.tapError((error) =>
        boat.deleteSandbox(sandbox.id).pipe(
          Effect.ignore,
          Effect.andThen(
            changeMachine(machine.sandboxId, (current) => ({
              ...current,
              problem: `T3 Code could not bring it back from its snapshot (${error.detail}) Its history is kept in Boat's named snapshot ${snapshot}.`,
            })),
          ),
        ),
      ),
      Effect.onInterrupt(() => boat.deleteSandbox(sandbox.id).pipe(Effect.ignore)),
    );
    yield* boat.deleteNamedSnapshot(snapshot).pipe(Effect.ignore);
    lastBusy.set(sandbox.id, DateTime.toEpochMillis(yield* DateTime.now));
    return yield* update((status) => ({
      ...status,
      machines: status.machines.map((m) =>
        m.sandboxId === machine.sandboxId ? { ...restored, notice } : m,
      ),
    }));
  });

  const resumeMachine = Effect.fn("BoatMachines.resumeMachine")(function* (
    boat: BoatApi,
    machine: BoatMachine,
  ) {
    const resumed = yield* boat.resumeSandbox(machine.sandboxId, BOAT_MACHINE_TTL_SECONDS);
    if (resumed === "expired") {
      if (machine.snapshot !== null) return yield* restore(boat, machine, machine.snapshot);
      yield* forget(machine, "Boat no longer has its disk.");
      return yield* fail("Boat no longer has this machine's disk, so T3 Code removed it.");
    }
    const notice = yield* Effect.gen(function* () {
      yield* waitUntilReady(boat, machine.sandboxId, BOAT_TERMINAL_STATES);
      return yield* serveT3(boat, machine);
    }).pipe(
      // A machine no client can reach would bill for nothing; it stays stopped to retry.
      Effect.onError(() => boat.stopSandbox(machine.sandboxId).pipe(Effect.ignore)),
    );
    // The running disk replaces the saved one, freeing its slot.
    const snapshotKept =
      machine.snapshot !== null &&
      (yield* boat.deleteNamedSnapshot(machine.snapshot).pipe(
        Effect.as(false),
        Effect.orElseSucceed(() => true),
      ));
    lastBusy.set(machine.sandboxId, DateTime.toEpochMillis(yield* DateTime.now));
    return yield* changeMachine(machine.sandboxId, (current) => ({
      ...current,
      state: "running",
      problem: null,
      notice,
      stoppedAt: null,
      snapshot: snapshotKept ? current.snapshot : null,
    }));
  });

  const deleteMachine = Effect.fn("BoatMachines.deleteMachine")(function* (
    boat: BoatApi,
    machine: BoatMachine,
    reason: string,
  ) {
    if (machine.state === "running") yield* keepUsage(boat, machine);
    yield* boat.deleteSandbox(machine.sandboxId);
    if (machine.snapshot !== null) {
      yield* boat.deleteNamedSnapshot(machine.snapshot).pipe(Effect.ignore);
    }
    lastBusy.delete(machine.sandboxId);
    return yield* forget(machine, reason);
  });

  const machineAction = Effect.fn("BoatMachines.machineAction")(
    function* (input: BoatMachineActionInput) {
      const boat = yield* api;
      const machine = (yield* SubscriptionRef.get(state)).machines.find(
        (m) => m.sandboxId === input.sandboxId,
      );
      if (machine === undefined) {
        return yield* fail("That Boat machine is not one of this server's.");
      }
      switch (input.action) {
        case "stop":
          // A machine deleted outside T3 Code, such as from Boat's dashboard, is forgotten here too.
          return yield* stopMachine(boat, machine).pipe(
            Effect.catch((error) =>
              boat
                .getSandbox(machine.sandboxId)
                .pipe(
                  Effect.flatMap((sandbox) =>
                    Option.isSome(sandbox)
                      ? Effect.fail(error)
                      : forget(machine, "It no longer exists on Boat.").pipe(
                          Effect.andThen(Effect.fail(fail("That Boat machine no longer exists."))),
                        ),
                  ),
                ),
            ),
          );
        case "resume":
          return yield* resumeMachine(boat, machine);
        case "delete":
          return yield* deleteMachine(boat, machine, "It was deleted.");
      }
    },
    (effect) => lifecycle.withPermits(1)(effect),
  );

  // Applies the worktree cleanup rules of the project the machine was started for. A running
  // machine's checkouts change, so they are read again right before it is deleted.
  const applyCleanup = Effect.fn("BoatMachines.applyCleanup")(function* (
    boat: BoatApi,
    machine: BoatMachine,
    report: BoatMachineReport,
    settings: ServerSettings,
    now: number,
  ) {
    const rules = resolveWorktreeCleanup(settings, machine.projectId);
    if (boatCleanupRule(report, rules, now) === null) return false;
    const checked =
      machine.state === "running"
        ? Option.getOrElse(yield* readReport(boat, machine.sandboxId, true), () => ({
            ...report,
            checkouts: null,
          }))
        : report;
    const rule = boatCleanupRule(checked, rules, now);
    if (rule === null) return false;
    const keep = boatKeepReason(checked.checkouts, rules);
    if (keep === null) {
      yield* deleteMachine(boat, machine, `Worktree cleanup deleted it because ${rule}.`);
      return true;
    }
    const notice = `Kept by worktree cleanup: ${rule}, but ${keep}.`;
    if (machine.notice !== notice) {
      yield* changeMachine(machine.sandboxId, (current) => ({ ...current, notice }));
    }
    return false;
  });

  const checkRunning = Effect.fn("BoatMachines.checkRunning")(function* (
    boat: BoatApi,
    machine: BoatMachine,
    status: BoatStatus,
    settings: ServerSettings,
    now: number,
  ) {
    const { sandboxId } = machine;
    const read = yield* readReport(boat, sandboxId, false);
    if (Option.isNone(read)) {
      // Boat stops a machine itself once T3 Code stops renewing it, such as while this server was
      // off.
      const sandbox = yield* boat.getSandbox(sandboxId);
      if (Option.isNone(sandbox)) {
        lastBusy.delete(sandboxId);
        yield* forget(machine, "It no longer exists on Boat.");
        return;
      }
      if (sandbox.value.state === "archiving" || sandbox.value.state === "archived") {
        lastBusy.delete(sandboxId);
        yield* changeMachine(sandboxId, (current) => ({
          ...current,
          state: "stopped",
          stoppedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
          report: withoutCheckouts(current.report),
        }));
        return;
      }
      // Without a report T3 Code cannot tell whether a turn runs, so it neither stops nor renews
      // the machine, and Boat stops it when its life runs out.
      return yield* Effect.logWarning("Could not read a Boat machine's activity", { sandboxId });
    }
    const report = read.value;
    const settingUp =
      report.threads === 0 &&
      report.deletedThreads === 0 &&
      now - Date.parse(machine.createdAt) < BOAT_SETUP_GRACE_MS;
    if (report.activeTurns > 0 || settingUp || !lastBusy.has(sandboxId)) {
      lastBusy.set(sandboxId, now);
    }
    if (yield* applyCleanup(boat, machine, report, settings, now)) return;
    const busyAt = lastBusy.get(sandboxId) ?? now;
    if (now - busyAt >= status.settings.idleStopMinutes * MINUTE_MS) {
      yield* stopMachine(boat, machine);
      return;
    }
    yield* boat.extendSandbox(sandboxId, BOAT_MACHINE_TTL_SECONDS);
    yield* keepUsageInBackground(boat, machine, now);
    if (machine.report === null || !sameReport(machine.report, report)) {
      yield* changeMachine(sandboxId, (current) => ({ ...current, report }));
    }
  });

  let lastSnapshotCheck = Number.NEGATIVE_INFINITY;
  const checkSnapshots = Effect.fn("BoatMachines.checkSnapshots")(function* (
    boat: BoatApi,
    now: number,
  ) {
    const { machines } = yield* SubscriptionRef.get(state);
    const stoppedFor = (machine: BoatMachine) =>
      machine.stoppedAt === null ? 0 : now - Date.parse(machine.stoppedAt);
    const nearing = machines.some(
      (machine) =>
        machine.state === "stopped" &&
        machine.snapshot === null &&
        stoppedFor(machine) >= BOAT_SNAPSHOT_AFTER_MS - BOAT_SNAPSHOT_WARNING_MS,
    );
    // Days pass between these decisions, so an hourly look is plenty.
    if (!nearing || now - lastSnapshotCheck < 60 * MINUTE_MS) return;
    lastSnapshotCheck = now;
    const named = yield* boat.listNamedSnapshots();
    const plan = planBoatSnapshots({ machines, snapshots: named.snapshots, free: named.free, now });
    for (const machine of plan.free) {
      if (machine.snapshot === null) continue;
      yield* boat.deleteNamedSnapshot(machine.snapshot);
      if (machine.state === "stopped" && stoppedFor(machine) >= BOAT_FREE_STOPPED_DAYS * DAY_MS) {
        yield* forget(machine, "Its saved history was freed to keep a newer machine's free.");
      } else {
        yield* changeMachine(machine.sandboxId, (current) => ({ ...current, snapshot: null }));
      }
    }
    for (const machine of plan.save) {
      const name = boatSnapshotName(machine.sandboxId);
      yield* boat.saveNamedSnapshot(machine.sandboxId, name);
      yield* changeMachine(machine.sandboxId, (current) => ({
        ...current,
        snapshot: name,
        notice: null,
      }));
    }
    for (const machine of plan.full) {
      const deletesOn = DateTime.formatIso(
        DateTime.makeUnsafe(now - stoppedFor(machine) + BOAT_FREE_STOPPED_DAYS * DAY_MS),
      );
      const notice = `Boat deletes its disk on ${deletesOn.slice(0, 10)}: all ${named.free} free named snapshots are in use.`;
      yield* changeMachine(machine.sandboxId, (current) => ({ ...current, notice }));
    }
    for (const machine of plan.warn) {
      yield* changeMachine(machine.sandboxId, (current) => ({
        ...current,
        notice:
          "T3 Code frees its saved history within 3 days to keep a newer machine's free. Resume it to keep it.",
      }));
    }
  });

  const logFailure =
    (operation: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.asVoid,
        Effect.catchCause((cause) => Effect.logWarning(`Boat ${operation} failed`, cause)),
      );

  const checkMachines = Effect.gen(function* () {
    const status = yield* SubscriptionRef.get(state);
    if (!status.configured || status.machines.length === 0) return;
    const boat = yield* api;
    const settings = yield* settingsService.getSettings;
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    yield* Effect.forEach(
      status.machines,
      (machine) =>
        logFailure("machine check")(
          machine.state === "running"
            ? checkRunning(boat, machine, status, settings, now)
            : machine.state === "stopped" && machine.report !== null
              ? applyCleanup(boat, machine, machine.report, settings, now)
              : Effect.void,
        ),
      { concurrency: 4, discard: true },
    );
    yield* logFailure("snapshot check")(checkSnapshots(boat, now));
  }).pipe(logFailure("machine checks"), lifecycle.withPermits(1));

  return BoatMachines.of({
    current: SubscriptionRef.get(state),
    streamChanges: Stream.unwrap(
      refreshCli.pipe(Effect.forkIn(serviceScope), Effect.as(SubscriptionRef.changes(state))),
    ),
    configure,
    spawn,
    machineAction,
    checkMachines,
  });
});

export const layer = Layer.effect(
  BoatMachines,
  make.pipe(
    Effect.tap((boat) =>
      Effect.sleep("1 minute").pipe(
        Effect.andThen(Effect.repeat(boat.checkMachines, Schedule.spaced("1 minute"))),
        Effect.forkScoped,
      ),
    ),
  ),
);
