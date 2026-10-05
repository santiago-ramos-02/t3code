// @effect-diagnostics nodeBuiltinImport:off -- CLIProxyAPI runs as a detached program that outlives the server, which Effect's scoped ChildProcess cannot start, and its files live outside any project.
/**
 * CLIProxyAPI on this environment: installing and updating it, running it, starting it with
 * the user's login, routing Claude Code through it, and passing management calls to it.
 *
 * T3 Code keeps CLIProxyAPI in one folder per system (see `installDir`): the program, its
 * `config.yaml`, its `auth` folder, and `management-key.secret`, the management key in plain
 * text, since the proxy stores only a hash of it in its config.
 *
 * @module cliProxy/CliProxy
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  CliProxyError,
  ProviderDriverKind,
  ProviderInstanceId,
  UsageLimitSourceId,
  type CliProxyAction,
  type CliProxyStatus,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Clock from "effect/Clock";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest } from "effect/http";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Yaml from "yaml";
import {
  HostProcessArchitecture,
  HostProcessEnvironment,
  HostProcessPlatform,
} from "@t3tools/shared/hostProcess";

import { makeGitHubReleases } from "../githubRelease.ts";
import { ServerSettingsService } from "../serverSettings.ts";

const REPOSITORY = "router-for-me/CLIProxyAPI";
const KEY_FILE = "management-key.secret";
const WINDOWS_TASK_PREFIX = "CLIProxyAPI";
const MAC_AGENT = "com.t3code.cliproxyapi";
const LINUX_UNIT = "cliproxyapi.service";
const DEFAULT_PORT = 8317;
// The proxy as a T3 Code provider and usage source, one each per environment.
const PROVIDER_ID = ProviderInstanceId.make("cliproxy");
const USAGE_SOURCE_ID = UsageLimitSourceId.make("cliproxy-local");
// The newest release is checked at most this often, and after every update.
const LATEST_TTL_MS = 60 * 60 * 1000;
const SLOW_TTL_MS = 30 * 1000;

export class CliProxy extends Context.Service<
  CliProxy,
  {
    readonly current: Effect.Effect<CliProxyStatus>;
    /** The current status, then every change; checks whether the proxy runs every few seconds. */
    readonly streamChanges: Stream.Stream<CliProxyStatus>;
    readonly action: (action: CliProxyAction) => Effect.Effect<CliProxyStatus, CliProxyError>;
    /** One call to the proxy's management API or model list; see `CliProxyManagementInput`. */
    readonly management: (input: {
      readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
      readonly path: string;
      readonly body?: unknown;
    }) => Effect.Effect<{ readonly status: number; readonly data: unknown }, CliProxyError>;
  }
>()("t3/cliProxy/CliProxy") {}

const decodeJsonText = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const fail = (detail: string) => new CliProxyError({ detail });
const attempt = <A>(detail: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      fail(`${detail}${cause instanceof Error && cause.message ? `: ${cause.message}` : "."}`),
  });

/** Where T3 Code keeps CLIProxyAPI on this system. */
export function installDir(platform: NodeJS.Platform, environment: NodeJS.ProcessEnv): string {
  if (platform === "win32") {
    return NodePath.join(
      environment.LOCALAPPDATA ?? NodePath.join(NodeOS.homedir(), "AppData", "Local"),
      "CLIProxyAPI",
    );
  }
  return NodePath.join(NodeOS.homedir(), ".local", "share", "CLIProxyAPI");
}

/** The release asset for this system, or null when CLIProxyAPI publishes none for it. */
export function releaseAssetName(
  version: string,
  platform: NodeJS.Platform,
  arch: string,
): string | null {
  const os =
    platform === "win32"
      ? "windows"
      : platform === "darwin"
        ? "darwin"
        : platform === "linux"
          ? "linux"
          : null;
  const cpu = arch === "x64" ? "amd64" : arch === "arm64" ? "aarch64" : null;
  if (os === null || cpu === null) return null;
  return `CLIProxyAPI_${version.replace(/^v/, "")}_${os}_${cpu}.${os === "windows" ? "zip" : "tar.gz"}`;
}

const binaryName = (platform: NodeJS.Platform) =>
  platform === "win32" ? "cli-proxy-api.exe" : "cli-proxy-api";

/**
 * What T3 Code reads from the proxy's config: where it listens and its first client key. It
 * accepts both the v7 layout (top-level `port`, `api-keys` list) and v8 (`server`, `access`).
 */
export function readProxyConfig(text: string) {
  const doc: unknown = Yaml.parse(text);
  const record = (value: unknown): Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const root = record(doc);
  const server = record(root.server);
  const access = record(root.access);
  const port = Number(server.port ?? root.port ?? DEFAULT_PORT);
  const rawHost = String(server.host ?? root.host ?? "127.0.0.1");
  const host = rawHost === "" || rawHost === "0.0.0.0" ? "127.0.0.1" : rawHost;
  const keys = [access["api-keys"], root["api-keys"]].find(Array.isArray) ?? [];
  const clientKey = keys.find((key): key is string => typeof key === "string" && key !== "");
  return {
    host,
    port: Number.isInteger(port) && port > 0 ? port : DEFAULT_PORT,
    clientKey: clientKey ?? null,
  };
}

/** A fresh config: local only, one client key, and the management key T3 Code keeps. */
export function freshConfig(input: {
  readonly port: number;
  readonly authDir: string;
  readonly clientKey: string;
  readonly managementKey: string;
}): string {
  return Yaml.stringify({
    host: "127.0.0.1",
    port: input.port,
    "auth-dir": input.authDir,
    "api-keys": [input.clientKey],
    "remote-management": { "secret-key": input.managementKey, "disable-control-panel": false },
    routing: { strategy: "round-robin", "session-affinity": true },
  });
}

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const LOOPBACK_V1 = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/v1\/?$/;

/**
 * The models the proxy provider lists in T3 Code beyond Claude Code's own: every model the
 * proxy serves that Anthropic does not make, by the ID Claude Code sends and its name, then
 * the failover pools. Image models are left out; they cannot run an agent.
 */
export function proxyCustomModels(modelList: unknown, proxyConfig: unknown) {
  // Pools by alias, named by their display name where a member gives one.
  const groups = asRecord(asRecord(proxyConfig)["api-keys"])["openai-compatibility"];
  const pools = new Map<string, string>();
  for (const group of Array.isArray(groups) ? groups : []) {
    const baseUrl = asRecord(group)["base-url"];
    if (typeof baseUrl !== "string" || !LOOPBACK_V1.test(baseUrl)) continue;
    const groupModels = asRecord(group).models;
    for (const entry of Array.isArray(groupModels) ? groupModels : []) {
      const model = asRecord(entry);
      if (typeof model.alias !== "string") continue;
      const label = model["display-name"];
      if (typeof label === "string") pools.set(model.alias, label);
      else if (!pools.has(model.alias)) pools.set(model.alias, model.alias);
    }
  }
  const listed = new Set<string>();
  const list = asRecord(modelList).data;
  const models = (Array.isArray(list) ? list : []).flatMap((entry) => {
    const model = asRecord(entry);
    const slug = typeof model.id === "string" ? model.id : null;
    const shown = typeof model.display_name === "string" ? model.display_name : slug;
    if (slug === null || shown === null || model.owned_by === "anthropic" || /image/i.test(shown)) {
      return [];
    }
    // A pool is listed under its alias or its name; either way it takes the name of the pool.
    const pool = [...pools].find(([alias, label]) => shown === alias || shown === label);
    if (pool !== undefined) listed.add(pool[0]);
    return [{ slug, name: pool?.[1] ?? shown }];
  });
  const unlisted = [...pools].filter(([alias]) => !listed.has(alias));
  return [...models, ...unlisted.map(([slug, name]) => ({ slug, name }))];
}

/** Management and model-list paths the passthrough allows; nothing else on the proxy. */
export function isAllowedManagementPath(path: string): boolean {
  if (path.includes("..") || path.includes("\\") || /%2e|%2f|%5c/i.test(path)) return false;
  const pathname = path.split("?")[0] ?? "";
  return /^\/(v0|v8)\/management(\/|$)/.test(pathname) || pathname === "/v1/models";
}

const writeFileAtomic = async (path: string, text: string) => {
  await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true });
  const temporary = `${path}.${NodeCrypto.randomUUID()}.tmp`;
  await NodeFSP.writeFile(temporary, text);
  await NodeFSP.rename(temporary, path);
};

const exists = (path: string) =>
  NodeFSP.access(path).then(
    () => true,
    () => false,
  );

const isListening = (host: string, port: number) =>
  new Promise<boolean>((resolve) => {
    const socket = NodeNet.connect({ host, port });
    const done = (value: boolean) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(800, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });

const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const changes = yield* Effect.acquireRelease(PubSub.unbounded<CliProxyStatus>(), PubSub.shutdown);
  const platform = yield* HostProcessPlatform;
  const arch = yield* HostProcessArchitecture;
  const environment = yield* HostProcessEnvironment;
  const serverSettings = yield* ServerSettingsService;
  const httpClient = yield* HttpClient.HttpClient;
  const releases = yield* makeGitHubReleases;

  /** One HTTP request; its status and body are read by the caller. */
  const request = (input: {
    readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    readonly url: string;
    readonly headers?: Record<string, string>;
    readonly json?: unknown;
    readonly timeout: `${number} seconds`;
    readonly failure: string;
  }) =>
    httpClient
      .execute(
        HttpClientRequest.make(input.method)(input.url).pipe(
          HttpClientRequest.setHeaders(input.headers ?? {}),
          (built) =>
            input.json === undefined
              ? built
              : HttpClientRequest.bodyText(built, JSON.stringify(input.json), "application/json"),
        ),
      )
      .pipe(
        Effect.timeout(input.timeout),
        Effect.mapError(() => fail(input.failure)),
      );
  const dir = installDir(platform, environment);
  const binary = NodePath.join(dir, binaryName(platform));
  const configPath = NodePath.join(dir, "config.yaml");
  const keyPath = NodePath.join(dir, KEY_FILE);
  const supported = releaseAssetName("0.0.0", platform, arch) !== null;
  const latest = yield* Ref.make<{ readonly version: string | null; readonly at: number }>({
    version: null,
    at: 0,
  });
  // Slow to read, so refreshed after actions and every half minute rather than on every poll.
  const slow = yield* Ref.make<{
    readonly version: string | null;
    readonly startAtLogin: boolean | null;
    readonly managementReady: boolean;
    readonly at: number;
  } | null>(null);

  /** Runs a command to completion; its standard output, or null when it could not run. */
  const run = (command: string, args: ReadonlyArray<string>) =>
    spawner.string(ChildProcess.make(command, args, { stdin: "ignore", stderr: "ignore" })).pipe(
      Effect.timeout("20 seconds"),
      Effect.map((output) => output.trim()),
      Effect.orElseSucceed(() => null),
    );
  const powershell = (script: string) =>
    run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);

  const config = Effect.promise(async () =>
    (await exists(configPath))
      ? readProxyConfig(await NodeFSP.readFile(configPath, "utf8"))
      : { host: "127.0.0.1", port: DEFAULT_PORT, clientKey: null },
  ).pipe(Effect.orElseSucceed(() => ({ host: "127.0.0.1", port: DEFAULT_PORT, clientKey: null })));
  const managementKey = Effect.promise(async () =>
    (await exists(keyPath)) ? (await NodeFSP.readFile(keyPath, "utf8")).trim() || null : null,
  ).pipe(Effect.orElseSucceed(() => null));

  const readVersion = Effect.gen(function* () {
    if (!(yield* Effect.promise(() => exists(binary)))) return null;
    // Any argument makes it print its version line before anything else.
    const output = yield* Effect.promise(
      () =>
        new Promise<string>((resolve) => {
          NodeChildProcess.execFile(
            binary,
            ["-version"],
            { timeout: 10_000, windowsHide: true },
            (_e, out, err) => resolve(`${out}${err}`),
          );
        }),
    );
    return /Version:\s*v?([0-9][^\s,]*)/.exec(output)?.[1] ?? null;
  });

  const quotePs = (value: string) => value.replace(/'/g, "''");
  /**
   * The Windows login task that runs this install, found by the program it runs rather than
   * its name, so another install's task is never started or removed from here.
   */
  const windowsTask = Effect.gen(function* () {
    const output = yield* powershell(
      [
        `$binary = '${quotePs(binary.toLowerCase())}'`,
        `Get-ScheduledTask -TaskName '${WINDOWS_TASK_PREFIX}*' -ErrorAction SilentlyContinue | Where-Object { @($_.Actions | Where-Object { "$($_.Execute) $($_.Arguments)".ToLower().Contains($binary) }).Count -gt 0 } | Select-Object -First 1 | ForEach-Object { "$($_.TaskName)|$($_.State)" }`,
      ].join("; "),
    );
    const [name, state] = (output ?? "").split("|");
    return name && state ? { name, state } : null;
  });
  // A new task is named for its install, so several installs never share one.
  const newTaskName = `${WINDOWS_TASK_PREFIX} ${NodeCrypto.createHash("sha256").update(dir.toLowerCase()).digest("hex").slice(0, 8)}`;

  const readStartAtLogin = Effect.gen(function* () {
    if (platform === "win32") {
      const task = yield* windowsTask;
      return task !== null && task.state !== "Disabled";
    }
    if (platform === "darwin") {
      return yield* Effect.promise(() =>
        exists(NodePath.join(NodeOS.homedir(), "Library", "LaunchAgents", `${MAC_AGENT}.plist`)),
      );
    }
    if (platform === "linux") {
      const state = yield* run("systemctl", ["--user", "is-enabled", LINUX_UNIT]);
      if (state === null && (yield* run("systemctl", ["--user", "--version"])) === null)
        return null;
      return state === "enabled";
    }
    return null;
  });

  /** A management call with the key T3 Code holds. */
  const call = (input: {
    readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    readonly path: string;
    readonly body?: unknown;
    /** The model list as Claude Code sees it: names and the IDs it sends. */
    readonly claudeListing?: boolean;
  }) =>
    Effect.gen(function* () {
      if (!isAllowedManagementPath(input.path)) {
        return yield* fail("That is not a CLIProxyAPI management path.");
      }
      const { host, port, clientKey } = yield* config;
      const models = input.path.split("?")[0] === "/v1/models";
      const key = models ? clientKey : yield* managementKey;
      if (key === null) {
        return yield* fail(
          models
            ? "CLIProxyAPI has no client key in its config."
            : "T3 Code does not have this proxy's management key yet.",
        );
      }
      const response = yield* request({
        method: input.method,
        url: `http://${host}:${port}${input.path}`,
        headers: {
          Authorization: `Bearer ${key}`,
          ...(models && input.claudeListing ? { "anthropic-version": "2023-06-01" } : {}),
        },
        json: input.body,
        timeout: "60 seconds",
        failure: "CLIProxyAPI did not answer.",
      });
      const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
      // Logs and YAML come back as text; everything else is JSON.
      const data: unknown =
        text === "" ? null : Option.getOrElse(decodeJsonText(text), (): unknown => text);
      return { status: response.status, data };
    });

  const readManagementReady = Effect.gen(function* () {
    if ((yield* managementKey) === null) return false;
    const { host, port } = yield* config;
    if (!(yield* Effect.promise(() => isListening(host, port)))) return true;
    const result = yield* call({ method: "GET", path: "/v8/management/config" }).pipe(
      Effect.orElseSucceed(() => null),
    );
    return result !== null && result.status !== 401 && result.status !== 403;
  });

  const refreshSlow = Effect.gen(function* () {
    const next = {
      version: yield* readVersion,
      startAtLogin: yield* readStartAtLogin,
      managementReady: yield* readManagementReady,
      at: yield* Clock.currentTimeMillis,
    };
    yield* Ref.set(slow, next);
    return next;
  });

  const latestRelease = Effect.gen(function* () {
    const cached = yield* Ref.get(latest);
    const now = yield* Clock.currentTimeMillis;
    if (cached.version !== null && now - cached.at < LATEST_TTL_MS) return cached.version;
    const version = (yield* releases.latestVersion(REPOSITORY)) ?? cached.version;
    yield* Ref.set(latest, { version, at: now });
    return version;
  });

  const readConnected = serverSettings.getSettings.pipe(
    Effect.map((settings) => Object.hasOwn(settings.providerInstances, PROVIDER_ID)),
    Effect.orElseSucceed(() => false),
  );

  const current: Effect.Effect<CliProxyStatus> = Effect.gen(function* () {
    const installed = yield* Effect.promise(() => exists(binary));
    const { host, port } = yield* config;
    const url = `http://${host}:${port}`;
    const running = installed && (yield* Effect.promise(() => isListening(host, port)));
    const cachedSlow = yield* Ref.get(slow);
    const slowState =
      cachedSlow !== null && (yield* Clock.currentTimeMillis) - cachedSlow.at < SLOW_TTL_MS
        ? cachedSlow
        : yield* refreshSlow;
    return {
      supported,
      installed,
      installDir: dir,
      version: slowState.version,
      latestVersion: yield* latestRelease,
      running,
      url: installed ? url : null,
      controlPanelUrl: installed ? `${url}/management.html` : null,
      managementReady: slowState.managementReady,
      startAtLogin: installed ? slowState.startAtLogin : null,
      connected: installed && (yield* readConnected),
    } satisfies CliProxyStatus;
  });

  /** The process listening on the proxy's port, when it is this install's program. */
  const ownProcess = Effect.gen(function* () {
    const { port } = yield* config;
    if (platform === "win32") {
      const output = yield* powershell(
        `$c = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if ($c) { $p = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue; if ($p) { "$($p.Id)|$($p.Path)" } }`,
      );
      const [pid, path] = (output ?? "").split("|");
      return pid && path && NodePath.resolve(path).toLowerCase() === binary.toLowerCase()
        ? Number(pid)
        : null;
    }
    const pid = Number(
      (yield* run("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]))?.split("\n")[0],
    );
    if (!Number.isInteger(pid) || pid <= 0) return null;
    const path =
      platform === "linux"
        ? yield* Effect.promise(() => NodeFSP.readlink(`/proc/${pid}/exe`).catch(() => ""))
        : ((yield* run("ps", ["-o", "comm=", "-p", String(pid)])) ?? "");
    return NodePath.resolve(path) === binary ? pid : null;
  });

  const waitFor = (listening: boolean) =>
    Effect.gen(function* () {
      const { host, port } = yield* config;
      for (let tries = 0; tries < 80; tries++) {
        if ((yield* Effect.promise(() => isListening(host, port))) === listening) return true;
        yield* Effect.sleep("250 millis");
      }
      return false;
    });

  const start = Effect.gen(function* () {
    if (!(yield* Effect.promise(() => exists(binary)))) {
      return yield* fail("CLIProxyAPI is not installed.");
    }
    const { host, port } = yield* config;
    if (yield* Effect.promise(() => isListening(host, port))) return;
    const task = platform === "win32" ? yield* windowsTask : null;
    if (task !== null && task.state !== "Disabled") {
      // The login task runs it hidden, as it will at the next login. A task Windows still
      // counts as running ignores a start, so wait for the previous run to end first.
      let state = task.state;
      for (let tries = 0; state === "Running" && tries < 20; tries++) {
        yield* Effect.sleep("250 millis");
        state = (yield* windowsTask)?.state ?? "Ready";
      }
      yield* powershell(`Start-ScheduledTask -TaskName '${quotePs(task.name)}'`);
    } else {
      yield* Effect.sync(() => {
        const child = NodeChildProcess.spawn(binary, ["-config", configPath], {
          cwd: dir,
          detached: true,
          stdio: "ignore",
          windowsHide: true,
        });
        child.unref();
      });
    }
    if (!(yield* waitFor(true))) {
      return yield* fail(`CLIProxyAPI did not start listening on port ${port}.`);
    }
  });

  const stop = Effect.gen(function* () {
    const pid = yield* ownProcess;
    if (pid === null) {
      const { host, port } = yield* config;
      if (yield* Effect.promise(() => isListening(host, port))) {
        return yield* fail(
          `Something other than this CLIProxyAPI is using port ${port}, so T3 Code left it alone.`,
        );
      }
      return;
    }
    if (platform === "win32") {
      // The login task runs the proxy under a hidden console host. Ending the host with it
      // ends the task too, so the next start runs it again instead of being ignored.
      const stopped = yield* powershell(
        [
          `$proxy = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"`,
          `$parent = if ($proxy) { Get-CimInstance Win32_Process -Filter "ProcessId=$($proxy.ParentProcessId)" }`,
          `if ($parent -and $parent.Name -eq 'conhost.exe' -and $parent.CommandLine -like '*cli-proxy-api*') { Stop-Process -Id $parent.ProcessId -Force -ErrorAction SilentlyContinue }`,
          `Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`,
          `'ok'`,
        ].join("; "),
      );
      if (stopped !== "ok") return yield* fail("CLIProxyAPI could not be stopped.");
    } else {
      yield* Effect.try({
        try: () => process.kill(pid),
        catch: () => fail("CLIProxyAPI could not be stopped."),
      });
    }
    if (!(yield* waitFor(false))) return yield* fail("CLIProxyAPI did not stop.");
  });

  const setStartAtLogin = (enabled: boolean) =>
    Effect.gen(function* () {
      if (platform === "win32") {
        const quote = quotePs;
        const task = yield* windowsTask;
        const taskName = quote(task?.name ?? newTaskName);
        const script = enabled
          ? [
              `$action = New-ScheduledTaskAction -Execute 'conhost.exe' -Argument '--headless "${quote(binary)}" -config "${quote(configPath)}"' -WorkingDirectory '${quote(dir)}'`,
              `$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME`,
              `$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) -Hidden`,
              `Register-ScheduledTask -TaskName '${taskName}' -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null`,
              `'ok'`,
            ].join("; ")
          : task === null
            ? "'ok'"
            : `Unregister-ScheduledTask -TaskName '${taskName}' -Confirm:$false -ErrorAction SilentlyContinue; 'ok'`;
        if ((yield* powershell(script)) !== "ok") {
          return yield* fail("Windows did not accept the login task.");
        }
        return;
      }
      if (platform === "darwin") {
        const plist = NodePath.join(
          NodeOS.homedir(),
          "Library",
          "LaunchAgents",
          `${MAC_AGENT}.plist`,
        );
        if (enabled) {
          const escape = (value: string) =>
            value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
          yield* attempt("The login item could not be written", () =>
            writeFileAtomic(
              plist,
              `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>${MAC_AGENT}</string>\n<key>ProgramArguments</key><array><string>${escape(binary)}</string><string>-config</string><string>${escape(configPath)}</string></array>\n<key>WorkingDirectory</key><string>${escape(dir)}</string>\n<key>RunAtLoad</key><true/>\n<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>\n</dict></plist>\n`,
            ),
          );
        } else {
          yield* run("launchctl", ["unload", "-w", plist]);
          yield* Effect.promise(() => NodeFSP.rm(plist, { force: true }));
        }
        return;
      }
      const unit = NodePath.join(NodeOS.homedir(), ".config", "systemd", "user", LINUX_UNIT);
      if (enabled) {
        yield* attempt("The login service could not be written", () =>
          writeFileAtomic(
            unit,
            `[Unit]\nDescription=CLIProxyAPI\n\n[Service]\nExecStart="${binary}" -config "${configPath}"\nWorkingDirectory=${dir}\nRestart=on-failure\n\n[Install]\nWantedBy=default.target\n`,
          ),
        );
        yield* run("systemctl", ["--user", "daemon-reload"]);
        if ((yield* run("systemctl", ["--user", "enable", LINUX_UNIT])) === null) {
          return yield* fail("systemd did not enable the login service.");
        }
      } else {
        yield* run("systemctl", ["--user", "disable", LINUX_UNIT]);
        yield* Effect.promise(() => NodeFSP.rm(unit, { force: true }));
      }
    });

  /** Installs when missing, otherwise moves to the latest release; the previous one is kept. */
  const update = Effect.gen(function* () {
    yield* Ref.set(latest, { version: null, at: 0 });
    const version = yield* latestRelease;
    const asset = version === null ? null : releaseAssetName(version, platform, arch);
    if (version === null) return yield* fail("The latest CLIProxyAPI release could not be found.");
    if (asset === null) return yield* fail("CLIProxyAPI has no build for this system.");
    const installed = yield* Effect.promise(() => exists(binary));
    const previous = yield* readVersion;
    if (installed && previous === version) return;

    yield* releases.withVerifiedRelease(
      { repository: REPOSITORY, version, asset, label: "CLIProxyAPI", fail },
      (unpacked) =>
        Effect.gen(function* () {
          const fresh = NodePath.join(unpacked, binaryName(platform));
          if (!(yield* Effect.promise(() => exists(fresh)))) {
            return yield* fail("The download does not contain the CLIProxyAPI program.");
          }

          const wasRunning = installed && (yield* ownProcess) !== null;
          // Another proxy may already hold the default port; a fresh install takes the next free one.
          let freePort = DEFAULT_PORT;
          while (
            freePort < DEFAULT_PORT + 20 &&
            (yield* Effect.promise(() => isListening("127.0.0.1", freePort)))
          ) {
            freePort += 1;
          }
          if (wasRunning) yield* stop;
          yield* attempt("The new version could not be installed", async () => {
            await NodeFSP.mkdir(dir, { recursive: true });
            if (installed) {
              const keep = NodePath.join(dir, "previous");
              await NodeFSP.rm(keep, { recursive: true, force: true });
              await NodeFSP.mkdir(keep);
              await NodeFSP.copyFile(binary, NodePath.join(keep, binaryName(platform)));
              await NodeFSP.writeFile(NodePath.join(keep, "VERSION"), `${previous ?? "unknown"}\n`);
            }
            await NodeFSP.copyFile(fresh, binary);
            if (platform !== "win32") await NodeFSP.chmod(binary, 0o755);
            for (const extra of ["config.example.yaml", "README.md", "LICENSE"]) {
              const source = NodePath.join(unpacked, extra);
              if (await exists(source)) await NodeFSP.copyFile(source, NodePath.join(dir, extra));
            }
            if (!(await exists(configPath))) {
              const managementKey = `t3-${NodeCrypto.randomBytes(24).toString("hex")}`;
              await writeFileAtomic(
                configPath,
                freshConfig({
                  port: freePort,
                  authDir: NodePath.join(dir, "auth"),
                  clientKey: `sk-t3-${NodeCrypto.randomBytes(24).toString("hex")}`,
                  managementKey,
                }),
              );
              await writeFileAtomic(keyPath, `${managementKey}\n`);
            }
          });
          if (wasRunning || !installed) yield* start;
        }),
    );
  });

  /**
   * Adds the proxy as a T3 Code provider, a Claude Code instance whose requests go through it
   * and whose model list holds the proxy's other models and pools, and as a usage source for
   * its accounts' limits. Adding again re-reads the models. Removing takes both away.
   */
  const setConnected = (enabled: boolean) =>
    Effect.gen(function* () {
      const settings = yield* serverSettings.getSettings.pipe(
        Effect.mapError(() => fail("T3 Code's settings could not be read.")),
      );
      const { [PROVIDER_ID]: _previous, ...otherInstances } = settings.providerInstances;
      if (!enabled) {
        yield* serverSettings
          .updateSettings({
            providerInstances: otherInstances,
            usageLimitSources: { [USAGE_SOURCE_ID]: null },
          })
          .pipe(Effect.mapError(() => fail("T3 Code's settings could not be changed.")));
        return;
      }
      const { host, port, clientKey } = yield* config;
      const key = yield* managementKey;
      if (clientKey === null) return yield* fail("CLIProxyAPI has no client key in its config.");
      if (key === null)
        return yield* fail("T3 Code does not have this proxy's management key yet.");
      const url = `http://${host}:${port}`;
      const models = yield* call({ method: "GET", path: "/v1/models", claudeListing: true });
      const proxyConfig = yield* call({ method: "GET", path: "/v8/management/config" });
      if (models.status !== 200) return yield* fail("CLIProxyAPI did not list its models.");
      yield* serverSettings
        .updateSettings({
          providerInstances: {
            ...otherInstances,
            [PROVIDER_ID]: {
              driver: ProviderDriverKind.make("claudeAgent"),
              displayName: "CLIProxyAPI",
              environment: [
                { name: "ANTHROPIC_BASE_URL", value: url, sensitive: false },
                { name: "ANTHROPIC_AUTH_TOKEN", value: clientKey, sensitive: true },
              ],
              enabled: true,
              config: {
                customModels: proxyCustomModels(
                  models.data,
                  proxyConfig.status === 200 ? proxyConfig.data : null,
                ),
              },
            },
          },
          usageLimitSources: {
            [USAGE_SOURCE_ID]: {
              kind: "cliproxy",
              label: "CLIProxyAPI on this computer",
              url,
              managementKey: key,
              enabled: true,
            },
          },
        })
        .pipe(Effect.mapError(() => fail("T3 Code's settings could not be changed.")));
    });

  const setManagementKey = (key: string) =>
    Effect.gen(function* () {
      const trimmed = key.trim();
      if (trimmed === "") return yield* fail("Enter the management key.");
      yield* attempt("The key could not be saved", () => writeFileAtomic(keyPath, `${trimmed}\n`));
      const { host, port } = yield* config;
      if (yield* Effect.promise(() => isListening(host, port))) {
        const check = yield* call({ method: "GET", path: "/v8/management/config" });
        if (check.status === 401 || check.status === 403) {
          yield* Effect.promise(() => NodeFSP.rm(keyPath, { force: true }));
          return yield* fail("CLIProxyAPI did not accept that management key.");
        }
      }
    });

  // Actions and polls take turns, so a poll never reports a restart half done.
  const turns = yield* Semaphore.make(1);

  const action = (input: CliProxyAction) =>
    Effect.gen(function* () {
      switch (input.type) {
        case "update":
          yield* update;
          break;
        case "start":
          yield* start;
          break;
        case "stop":
          yield* stop;
          break;
        case "restart":
          yield* stop;
          yield* start;
          break;
        case "setStartAtLogin":
          yield* setStartAtLogin(input.enabled);
          break;
        case "setConnected":
          yield* setConnected(input.enabled);
          break;
        case "setManagementKey":
          yield* setManagementKey(input.key);
          break;
      }
      yield* refreshSlow;
      const next = yield* current;
      yield* PubSub.publish(changes, next);
      return next;
    }).pipe(
      // A failed action can still have changed something, such as stopping before a failed start.
      Effect.tapError(() =>
        refreshSlow.pipe(
          Effect.andThen(current),
          Effect.flatMap((next) => PubSub.publish(changes, next)),
        ),
      ),
      turns.withPermits(1),
    );

  // Polled for what changes outside T3 Code, such as the proxy exiting; actions publish at once.
  const streamChanges = Stream.unwrap(
    Effect.gen(function* () {
      const subscription = yield* PubSub.subscribe(changes);
      return Stream.merge(
        Stream.fromEffectSchedule(turns.withPermits(1)(current), Schedule.spaced("5 seconds")),
        Stream.fromSubscription(subscription),
      ).pipe(Stream.changesWith((left, right) => JSON.stringify(left) === JSON.stringify(right)));
    }),
  );

  return {
    current,
    streamChanges,
    action,
    management: (input) => call(input),
  } satisfies CliProxy["Service"];
});

export const layer = Layer.effect(CliProxy, make);
