#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off
/**
 * Release smoke test for the built server bundle.
 *
 * Boots `apps/server/dist/bin.mjs` from a scratch T3 home (temp base, home,
 * and workspace) with a fake `pi` executable as the only provider, then
 * drives the same path a browser client takes:
 *
 * 1. `serve` from the exact bundle until `/.well-known/t3/environment` answers.
 * 2. `pair` from the exact bundle and parse the credential without logging it.
 * 3. POST `browser-session`, then POST `websocket-ticket`.
 * 4. Connect typed WebSocket RPC with `?wsTicket=` and poll `server.getConfig`
 *    until Pi reports driver pi, enabled, installed, ready, version 0.99.0,
 *    and not unavailable.
 *
 * The server is spawned with plain `node:child_process` in the same process
 * group (matching how a shell launches it). Cleanup always sends SIGTERM to
 * the captured server PID with a SIGKILL fallback to the same PID, then
 * removes the temp directory. Nothing here kills by pattern or touches live
 * state (`~/.t3`).
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as Socket from "effect/unstable/socket/Socket";
import {
  FetchHttpClient,
  Headers,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";

import * as NetService from "@t3tools/shared/Net";

export const DEFAULT_BUNDLE = "apps/server/dist/bin.mjs";
export const FAKE_PI_VERSION = "0.99.0";
const WELL_KNOWN_ENVIRONMENT_PATH = "/.well-known/t3/environment";
const SERVER_READY_TIMEOUT = Duration.seconds(60);
const SERVER_STOP_TIMEOUT = Duration.seconds(10);
const PAIR_TIMEOUT = Duration.seconds(30);
const HTTP_TIMEOUT = Duration.seconds(10);
const PROVIDER_READY_TIMEOUT = Duration.seconds(90);
const PROBE_TIMEOUT = Duration.seconds(2);
const OUTPUT_TAIL_CHARS = 2_000;

export interface SmokeArgs {
  readonly bundle: string;
}

/**
 * Pure argv parser: `--bundle <path>` or `--bundle=<path>`, defaulting to the
 * checked-in server bundle. Throws on unknown flags or a missing value.
 */
export function parseSmokeArgs(argv: ReadonlyArray<string>): SmokeArgs {
  let bundle = DEFAULT_BUNDLE;
  let index = 0;
  while (index < argv.length) {
    const arg = argv[index];
    if (arg === "--bundle") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(
          "Missing value for --bundle. Usage: smoke-server-bundle.ts [--bundle <path>]",
        );
      }
      bundle = value;
      index += 2;
      continue;
    }
    if (arg !== undefined && arg.startsWith("--bundle=")) {
      const value = arg.slice("--bundle=".length);
      if (value.length === 0) {
        throw new Error(
          "Missing value for --bundle. Usage: smoke-server-bundle.ts [--bundle <path>]",
        );
      }
      bundle = value;
      index += 1;
      continue;
    }
    throw new Error(
      `Unknown argument: ${arg ?? "<missing>"}. Usage: smoke-server-bundle.ts [--bundle <path>]`,
    );
  }
  return { bundle };
}

export const FakePiModelSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  provider: Schema.String,
  reasoning: Schema.Boolean,
  input: Schema.Array(Schema.String),
});
export type FakePiModel = typeof FakePiModelSchema.Type;

export const FAKE_PI_MODELS: ReadonlyArray<FakePiModel> = [
  {
    id: "smoke-model",
    name: "Smoke Model",
    provider: "smoke",
    reasoning: false,
    input: ["text"],
  },
];

const FakePiModelsJsonCodec = Schema.fromJsonString(Schema.Array(FakePiModelSchema));
const FakePiVersionJsonCodec = Schema.fromJsonString(Schema.String);
const fakePiModelsJson = Schema.encodeSync(FakePiModelsJsonCodec)([...FAKE_PI_MODELS]);
const fakePiVersionJson = Schema.encodeSync(FakePiVersionJsonCodec)(FAKE_PI_VERSION);

/**
 * Build one correlated fake-Pi JSONL response line: `type: "response"` echoing
 * the request id and command with `success: true`. Pi requires the envelope
 * (`id`, `command`, `success`) to correlate; `data` carries the models and an
 * empty command list so both `get_available_models` and command inventory
 * decode.
 */
const FakePiResponseJsonCodec = Schema.fromJsonString(
  Schema.Struct({
    id: Schema.String,
    type: Schema.Literal("response"),
    command: Schema.String,
    success: Schema.Literal(true),
    data: Schema.Struct({
      models: Schema.Array(FakePiModelSchema),
      commands: Schema.Array(Schema.String),
    }),
  }),
);

const encodeFakePiResponseLine = Schema.encodeSync(FakePiResponseJsonCodec);

export function buildFakePiResponseLine(input: {
  readonly id: string;
  readonly command: string;
}): string {
  return `${encodeFakePiResponseLine({
    id: input.id,
    type: "response",
    command: input.command,
    success: true,
    data: { models: [...FAKE_PI_MODELS], commands: [] },
  })}\n`;
}

/**
 * Render the fake `pi` executable (a dependency-free Node script with a
 * shebang). It answers `--version` with the fake version and otherwise speaks
 * enough JSONL RPC to satisfy Pi discovery: every well-formed `{id, type}`
 * record gets a correlated success envelope.
 */
export function renderFakePiSource(): string {
  const versionJson = fakePiVersionJson;
  const modelsJson = fakePiModelsJson;
  return `#!/usr/bin/env node
const VERSION = ${versionJson};
const MODELS = ${modelsJson};
const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write(\`\${VERSION}\\n\`);
  process.exit(0);
}
if (args.includes("--mode") && args.includes("rpc")) {
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let index = buffer.indexOf("\\n");
    while (index >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.trim().length > 0) {
        let request = null;
        try {
          request = JSON.parse(line);
        } catch {
          request = null;
        }
        if (request !== null && typeof request === "object" && !Array.isArray(request)) {
          const id = request.id;
          const command = request.type;
          if (typeof id === "string" && typeof command === "string") {
            process.stdout.write(JSON.stringify({
              id,
              type: "response",
              command,
              success: true,
              data: { models: MODELS, commands: [] },
            }) + "\\n");
          }
        }
      }
      index = buffer.indexOf("\\n");
    }
  });
  process.stdin.resume();
  return;
}
process.exit(0);
`;
}

/** Extract the pairing credential from `t3 pair` output without logging it. */
export function parsePairCredential(output: string): string | undefined {
  for (const line of output.split("\n")) {
    const match = /^Token:\s*(\S+)\s*$/.exec(line.trim());
    if (match?.[1] !== undefined) {
      return match[1];
    }
  }
  return undefined;
}

/** Redact pairing-style secrets before process output is logged or reported. */
export function redactSecrets(text: string): string {
  return text
    .replace(/(wsticket=)[^&\s"']+/gi, "$1REDACTED")
    .replace(/(ticket=)[^&\s"']+/gi, "$1REDACTED")
    .replace(/(token=)[^&\s"']+/gi, "$1REDACTED")
    .replace(/("ticket"\s*:\s*")[^"]+/g, "$1REDACTED")
    .replace(/('ticket'\s*:\s*')[^']+/g, "$1REDACTED")
    .replace(/("credential"\s*:\s*")[^"]+/g, "$1REDACTED")
    .replace(/([Bb]earer\s+)[^\s"']+/g, "$1REDACTED")
    .replace(/^(Token:\s*)\S+/gim, "$1REDACTED");
}

export interface SmokeScratchDirs {
  readonly baseDir: string;
  readonly tmpDir: string;
}

/**
 * Build an explicit minimal child env for the server/fake-Pi processes.
 *
 * Never spreads ambient `process.env`: only PATH-style executable resolution
 * (plus Windows SystemRoot/PATHEXT when present) is preserved, while home
 * and temp keys are pinned to the scratch dirs so ambient developer state
 * (including any ambient secrets/tokens) cannot leak into the child.
 */
export function buildSmokeChildEnv(
  ambient: NodeJS.ProcessEnv,
  scratch: SmokeScratchDirs,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const copyIfPresent = (key: string): void => {
    const value = ambient[key];
    if (value !== undefined) {
      env[key] = value;
    }
  };
  // Executable resolution for `#!/usr/bin/env node` and the bundle re-exec.
  copyIfPresent("PATH");
  copyIfPresent("Path");
  // Windows process/DLL basics; absent on POSIX.
  copyIfPresent("SystemRoot");
  copyIfPresent("SYSTEMROOT");
  copyIfPresent("PATHEXT");
  env["HOME"] = scratch.baseDir;
  env["USERPROFILE"] = scratch.baseDir;
  env["T3CODE_HOME"] = scratch.baseDir;
  env["TMPDIR"] = scratch.tmpDir;
  env["TEMP"] = scratch.tmpDir;
  env["TMP"] = scratch.tmpDir;
  return env;
}

export interface SmokePiProviderSnapshot {
  readonly driver: string;
  readonly enabled: boolean;
  readonly installed: boolean;
  readonly version: string | null;
  readonly status: string;
  readonly availability?: string | undefined;
}

/** The exact provider contract the smoke test polls for. */
export function isSmokePiProviderReady(provider: SmokePiProviderSnapshot): boolean {
  return (
    provider.driver === "pi" &&
    provider.enabled &&
    provider.installed &&
    provider.version === FAKE_PI_VERSION &&
    provider.status === "ready" &&
    provider.availability !== "unavailable"
  );
}

export class ServerBundleSmokeError extends Schema.TaggedError<ServerBundleSmokeError>()(
  "ServerBundleSmokeError",
  { step: Schema.String, detail: Schema.String },
) {
  override get message(): string {
    return `Server bundle smoke test failed while ${this.step}: ${this.detail}`;
  }
}

export const smokeFail = (step: string, detail: string): ServerBundleSmokeError =>
  new ServerBundleSmokeError({ step: redactSecrets(step), detail: redactSecrets(detail) });

const describeCause = (cause: unknown): string => {
  if (cause instanceof Error) {
    const inner = cause.cause instanceof Error ? ` | caused by: ${describeCause(cause.cause)}` : "";
    return `${cause.message}${inner}`;
  }
  return String(cause);
};

const SmokeProvider = Schema.Struct({
  driver: Schema.String,
  enabled: Schema.Boolean,
  installed: Schema.Boolean,
  version: Schema.NullOr(Schema.String),
  status: Schema.String,
  availability: Schema.optional(Schema.String),
});

const SmokeSettingsJsonCodec = Schema.fromJsonString(
  Schema.Struct({
    providers: Schema.Struct({
      pi: Schema.Struct({ enabled: Schema.Boolean, binaryPath: Schema.String }),
    }),
  }),
);
const encodeSmokeSettingsJson = Schema.encodeEffect(SmokeSettingsJsonCodec);

const SmokeServerGetConfigRpc = Rpc.make("server.getConfig", {
  payload: Schema.Struct({}),
  success: Schema.Struct({ providers: Schema.Array(SmokeProvider) }),
  // Server RPC errors are tagged; only the tag is read (a failure here means
  // the call did not succeed, whatever the detail). Never Unknown: the error
  // channel must stay concrete.
  error: Schema.Struct({ _tag: Schema.String }),
});

const SmokeRpcGroup = RpcGroup.make(SmokeServerGetConfigRpc);

const WebSocketTicketResponse = Schema.Struct({ ticket: Schema.String });

const tail = (text: string): string =>
  text.length > OUTPUT_TAIL_CHARS ? text.slice(-OUTPUT_TAIL_CHARS) : text;

export interface ServerOutput {
  text: string;
}

/** Minimal child surface the lifecycle helpers need (injectable fakes satisfy this). */
export interface SmokeSpawnedChild {
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  kill(signal: NodeJS.Signals): boolean;
}

export interface SpawnedServer {
  readonly child: SmokeSpawnedChild;
  readonly pid: number;
  readonly output: ServerOutput;
  readonly spawnError: { error: unknown };
}

const appendOutput = (output: ServerOutput, chunk: unknown): void => {
  output.text = (output.text + String(chunk)).slice(-OUTPUT_TAIL_CHARS);
};

export const isServerRunning = (server: SpawnedServer): boolean =>
  server.child.exitCode === null &&
  server.child.signalCode === null &&
  server.spawnError.error === undefined;

export const spawnServer = (input: {
  readonly node: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}): Effect.Effect<SpawnedServer, ServerBundleSmokeError> =>
  Effect.sync(() => {
    const output: ServerOutput = { text: "" };
    const spawnError: { error: unknown } = { error: undefined };
    const child = NodeChildProcess.spawn(input.node, [...input.args], {
      cwd: input.cwd,
      env: input.env,
      // Same process group as this script (like a shell launch): kills below
      // target the captured PID only, never the group.
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", (chunk) => {
      appendOutput(output, chunk);
    });
    child.stderr?.on("data", (chunk) => {
      appendOutput(output, chunk);
    });
    child.on("error", (error) => {
      spawnError.error = error;
    });
    return { child, output, spawnError };
  }).pipe(
    Effect.flatMap((server) =>
      server.child.pid === undefined
        ? Effect.fail(smokeFail("spawning the bundle", "spawn returned no pid"))
        : Effect.succeed({ ...server, pid: server.child.pid }),
    ),
  );

const waitForServerExit = (server: SpawnedServer): Effect.Effect<void> =>
  Effect.gen(function* () {
    const deadline = (yield* Clock.currentTimeMillis) + Duration.toMillis(SERVER_STOP_TIMEOUT);
    while (isServerRunning(server) && (yield* Clock.currentTimeMillis) < deadline) {
      yield* Effect.sleep(Duration.millis(100));
    }
  });

export const stopServer = (server: SpawnedServer): Effect.Effect<void> =>
  Effect.gen(function* () {
    yield* Effect.sync(() => {
      server.child.kill("SIGTERM");
    });
    yield* waitForServerExit(server);
    if (isServerRunning(server)) {
      // Same captured PID, escalated: never a pattern kill.
      yield* Effect.sync(() => {
        server.child.kill("SIGKILL");
      });
      yield* waitForServerExit(server);
    }
  });

export const withAcquiredSmokeServer = <A, E>(input: {
  readonly acquire: Effect.Effect<SpawnedServer, E>;
  readonly use: (server: SpawnedServer) => Effect.Effect<A, E>;
  readonly release: (server: SpawnedServer) => Effect.Effect<void>;
}): Effect.Effect<A, E> => Effect.acquireUseRelease(input.acquire, input.use, input.release);

const runBundleCommand = Effect.fn("smoke.runBundleCommand")(function* (input: {
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly timeout: Duration.Input;
  readonly step: string;
}) {
  const result = yield* Effect.sync(() =>
    NodeChildProcess.spawnSync(input.executable, [...input.args], {
      cwd: input.cwd,
      env: input.env,
      encoding: "utf8",
      timeout: Duration.toMillis(input.timeout),
      maxBuffer: 1024 * 1024,
    }),
  );
  if (result.error !== undefined) {
    return yield* smokeFail(
      input.step,
      `did not complete: ${describeCause(result.error)}. stderr tail: ${redactSecrets(tail(result.stderr))}`,
    );
  }
  if (result.status !== 0) {
    return yield* smokeFail(
      input.step,
      `exited with ${String(result.status)}. stderr tail: ${redactSecrets(tail(result.stderr))}`,
    );
  }
  return { stdout: result.stdout, stderr: result.stderr };
});

const smokeMain = Effect.fn("smoke.main")(function* (args: SmokeArgs) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const net = yield* NetService.NetService;
  const httpClient = yield* HttpClient.HttpClient;

  const bundle = path.resolve(process.cwd(), args.bundle);
  if (!(yield* fs.exists(bundle))) {
    return yield* smokeFail("resolving the bundle", `bundle not found: ${bundle}`);
  }

  const scratch = yield* fs.makeTempDirectoryScoped({ prefix: "t3-server-bundle-smoke-" });
  const baseDir = path.join(scratch, "home");
  const workspace = path.join(scratch, "workspace");
  const tmpDir = path.join(scratch, "tmp");
  yield* fs.makeDirectory(baseDir, { recursive: true });
  yield* fs.makeDirectory(workspace, { recursive: true });
  yield* fs.makeDirectory(tmpDir, { recursive: true });

  const fakePi = path.join(scratch, "pi-fake");
  yield* fs.writeFileString(fakePi, renderFakePiSource());
  yield* fs.chmod(fakePi, 0o755);

  const settingsDir = path.join(baseDir, "userdata");
  yield* fs.makeDirectory(settingsDir, { recursive: true });
  const settingsJson = yield* encodeSmokeSettingsJson({
    providers: { pi: { enabled: true, binaryPath: fakePi } },
  }).pipe(Effect.mapError((cause) => smokeFail("writing scratch settings", describeCause(cause))));
  yield* fs.writeFileString(path.join(settingsDir, "settings.json"), settingsJson);

  yield* Effect.log("[server-bundle-smoke] scratch ready.");
  const port = yield* net
    .reserveLoopbackPort("127.0.0.1")
    .pipe(Effect.mapError((cause) => smokeFail("allocating a loopback port", cause.message)));
  yield* Effect.log(`[server-bundle-smoke] reserved port ${String(port)}.`);
  const origin = `http://127.0.0.1:${String(port)}`;
  const node = process.execPath;
  // Explicit minimal child env (never spread ambient process.env): PATH for
  // `#!/usr/bin/env node` and the bundle re-exec, scratch home/temp dirs for
  // isolation. The explicit --base-dir still wins over T3CODE_HOME everywhere
  // flags apply; setting both keeps ambient developer state out of every path.
  const childEnv: NodeJS.ProcessEnv = buildSmokeChildEnv(process.env, { baseDir, tmpDir });

  const serveArgs = [
    bundle,
    "serve",
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--base-dir",
    baseDir,
    "--no-browser",
  ] as const;

  const runChecks = Effect.fn("smoke.checks")(function* (server: SpawnedServer) {
    const readServerTail = Effect.sync(() => redactSecrets(tail(server.output.text)));
    yield* Effect.log(
      `[server-bundle-smoke] spawned bundle (pid ${String(server.pid)}) on port ${String(port)}.`,
    );
    const probe = httpClient
      .execute(HttpClientRequest.get(`${origin}${WELL_KNOWN_ENVIRONMENT_PATH}`))
      .pipe(
        Effect.map((response) => response.status === 200),
        Effect.timeout(PROBE_TIMEOUT),
        Effect.orElseSucceed(() => false),
      );
    const readyDeadline =
      (yield* Clock.currentTimeMillis) + Duration.toMillis(SERVER_READY_TIMEOUT);
    while ((yield* Clock.currentTimeMillis) < readyDeadline) {
      if (server.spawnError.error !== undefined) {
        return yield* smokeFail("spawning the bundle", describeCause(server.spawnError.error));
      }
      if (!isServerRunning(server)) {
        const outputTail = yield* readServerTail;
        return yield* smokeFail(
          "waiting for server readiness",
          `the server exited (code ${String(server.child.exitCode)}, signal ${String(server.child.signalCode)}) before becoming ready. output tail: ${outputTail}`,
        );
      }
      if (yield* probe) {
        break;
      }
      yield* Effect.sleep(Duration.millis(250));
    }
    if (!(yield* probe)) {
      const outputTail = yield* readServerTail;
      return yield* smokeFail(
        "waiting for server readiness",
        `no 200 from ${WELL_KNOWN_ENVIRONMENT_PATH} within ${Duration.format(SERVER_READY_TIMEOUT)}. output tail: ${outputTail}`,
      );
    }
    yield* Effect.log(
      `[server-bundle-smoke] bundle is serving on ${origin} (pid ${String(server.pid)}).`,
    );

    // Pair only after readiness: the runtime state the pair command reads is
    // written once the server is answering.
    const pair = yield* runBundleCommand({
      executable: node,
      args: [bundle, "pair", "--base-dir", baseDir],
      cwd: workspace,
      env: childEnv,
      timeout: PAIR_TIMEOUT,
      step: "pairing with the bundle",
    });
    const credential = parsePairCredential(pair.stdout);
    if (credential === undefined) {
      return yield* smokeFail(
        "pairing with the bundle",
        "pair output did not include a Token line",
      );
    }

    const sessionResponse = yield* httpClient
      .execute(
        HttpClientRequest.post(`${origin}/api/auth/browser-session`).pipe(
          HttpClientRequest.bodyJsonUnsafe({ credential }),
        ),
      )
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.timeout(HTTP_TIMEOUT),
        Effect.mapError((cause) => smokeFail("creating a browser session", describeCause(cause))),
      );
    const setCookie = Headers.get(sessionResponse.headers, "set-cookie");
    if (Option.isNone(setCookie)) {
      return yield* smokeFail("creating a browser session", "response set no session cookie");
    }
    const cookiePair = setCookie.value.split(";")[0]?.trim();
    if (cookiePair === undefined || cookiePair.length === 0) {
      return yield* smokeFail("creating a browser session", "session cookie was empty");
    }

    const authed = (request: HttpClientRequest.HttpClientRequest) =>
      HttpClientRequest.setHeader(request, "cookie", cookiePair);
    const ticket = yield* httpClient
      .execute(authed(HttpClientRequest.post(`${origin}/api/auth/websocket-ticket`)))
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap(HttpClientResponse.schemaBodyJson(WebSocketTicketResponse)),
        Effect.timeout(HTTP_TIMEOUT),
        Effect.mapError((cause) => smokeFail("issuing a websocket ticket", describeCause(cause))),
        Effect.map((body) => body.ticket),
      );

    const fetchProviders = Effect.gen(function* () {
      const socketLayer = Socket.layerWebSocket(
        `${origin.replace("http://", "ws://")}/ws?wsTicket=${encodeURIComponent(ticket)}`,
        { openTimeout: "15 seconds" },
      ).pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal));
      const protocolLayer = Layer.effect(
        RpcClient.Protocol,
        RpcClient.makeProtocolSocket({
          retryTransientErrors: false,
          retryPolicy: Schedule.recurs(0),
        }),
      ).pipe(Layer.provide(Layer.mergeAll(socketLayer, RpcSerialization.layerJson)));
      // Build to a context first (the client-runtime session shape): the
      // protocol's reader loop must live in the built context, not in a
      // directly-provided layer.
      const protocolContext = yield* Layer.build(protocolLayer);
      const client = yield* RpcClient.make(SmokeRpcGroup).pipe(Effect.provide(protocolContext));
      return yield* client["server.getConfig"]({});
    }).pipe(
      Effect.scoped,
      Effect.timeout(HTTP_TIMEOUT),
      Effect.mapError((cause) => smokeFail("calling server.getConfig", describeCause(cause))),
    );

    const providerDeadline =
      (yield* Clock.currentTimeMillis) + Duration.toMillis(PROVIDER_READY_TIMEOUT);
    while (true) {
      const config = yield* fetchProviders;
      const pi = config.providers.find((provider) => provider.driver === "pi");
      if (pi !== undefined && isSmokePiProviderReady(pi)) {
        yield* Effect.log(
          `[server-bundle-smoke] Pi is ready: enabled/installed/version ${FAKE_PI_VERSION}.`,
        );
        return;
      }
      if ((yield* Clock.currentTimeMillis) >= providerDeadline) {
        const summary =
          pi === undefined
            ? "no pi provider in server.getConfig"
            : `driver=${pi.driver} enabled=${String(pi.enabled)} installed=${String(pi.installed)} version=${String(pi.version)} status=${pi.status} availability=${pi.availability ?? "available"}`;
        return yield* smokeFail(
          "waiting for Pi readiness",
          `Pi was not ready within ${Duration.format(PROVIDER_READY_TIMEOUT)} (${summary})`,
        );
      }
      yield* Effect.sleep(Duration.seconds(1));
    }
  });

  // Spawn lives in acquire so interruption cannot land between spawn and
  // finalizer registration; checks run as use(server).
  yield* withAcquiredSmokeServer({
    acquire: spawnServer({ node, args: [...serveArgs], cwd: workspace, env: childEnv }),
    use: (server) => runChecks(server),
    release: (server) => stopServer(server),
  });
  yield* Effect.log("[server-bundle-smoke] Server bundle smoke test passed.");
});

if (import.meta.main) {
  let args: SmokeArgs;
  try {
    args = parseSmokeArgs(process.argv.slice(2));
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    process.stderr.write(`${message}\n`);
    process.exit(2);
  }
  smokeMain(args).pipe(
    Effect.provide(
      Layer.mergeAll(
        Logger.layer([Logger.consolePretty()]),
        NodeServices.layer,
        NetService.layer,
        FetchHttpClient.layer,
      ),
    ),
    Effect.scoped,
    NodeRuntime.runMain,
  );
}
