import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderInstanceId, ThreadId, type ServerProvider } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as ServerConfig from "../../config.ts";
import { asRecord, recordString, type PiRpcRecord } from "../PiRpc.ts";
import { PiDriver } from "./PiDriver.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const JsonText = Schema.fromJsonString(Schema.Unknown);
const decodeJson = Schema.decodeUnknownSync(JsonText);
const encodeJson = Schema.encodeUnknownSync(JsonText);
const PiDriverTestLayer = Layer.mergeAll(
  ServerConfig.ServerConfig.layerTest(process.cwd(), {
    prefix: "t3-pi-driver-test-",
  }).pipe(Layer.provide(NodeServices.layer)),
  NodeServices.layer,
);

function processHandle(input: {
  readonly stdout?: Stream.Stream<Uint8Array, PlatformError.PlatformError>;
  readonly stderr?: Stream.Stream<Uint8Array, PlatformError.PlatformError>;
  readonly exitCode?: Effect.Effect<ChildProcessSpawner.ExitCode, PlatformError.PlatformError>;
  readonly stdin?: ChildProcessSpawner.ChildProcessHandle["stdin"];
  readonly onKill?: (options: ChildProcess.KillOptions | undefined) => void;
}) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(101),
    exitCode: input.exitCode ?? Effect.never,
    isRunning: Effect.succeed(true),
    kill: (options) => Effect.sync(() => input.onKill?.(options)),
    unref: Effect.succeed(Effect.void),
    stdin: input.stdin ?? Sink.drain,
    stdout: input.stdout ?? Stream.fromEffect(Effect.never),
    stderr: input.stderr ?? Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

function versionHandle(stdout: string, exitCode = 0) {
  return processHandle({
    stdout: Stream.encodeText(Stream.make(stdout)),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
  });
}

function jsonLine(record: PiRpcRecord): Uint8Array {
  return encoder.encode(`${encodeJson(record)}\n`);
}

function rpcHandle(input: {
  readonly respond: (request: PiRpcRecord) => PiRpcRecord;
  readonly requests: PiRpcRecord[];
  readonly events?: (request: PiRpcRecord) => ReadonlyArray<PiRpcRecord>;
  readonly onKill?: () => void;
}) {
  return Effect.gen(function* () {
    const stdout = yield* Queue.unbounded<Uint8Array>();
    const stdin = Sink.forEach((chunk: Uint8Array) => {
      const parsed = asRecord(decodeJson(decoder.decode(chunk).replace(/\n$/, "")));
      if (parsed === undefined) return Effect.die("Expected an outbound RPC object");
      input.requests.push(parsed);
      return Effect.gen(function* () {
        yield* Queue.offer(stdout, jsonLine(input.respond(parsed)));
        yield* Effect.forEach(input.events?.(parsed) ?? [], (event) =>
          Queue.offer(stdout, jsonLine(event)),
        );
      }).pipe(Effect.asVoid);
    });
    return processHandle({
      stdin,
      stdout: Stream.fromQueue(stdout),
      onKill: () => input.onKill?.(),
    });
  });
}

function successResponse(request: PiRpcRecord, data: unknown): PiRpcRecord {
  return {
    id: recordString(request, "id"),
    type: "response",
    command: recordString(request, "type"),
    success: true,
    data,
  };
}

function makeInstance(
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  input: {
    readonly enabled?: boolean;
    readonly binaryPath?: string;
    readonly customModels?: ReadonlyArray<string>;
  } = {},
) {
  return PiDriver.create({
    instanceId: ProviderInstanceId.make("pi-test"),
    displayName: "Pi Test",
    accentColor: "#123456",
    environment: [{ name: "PI_TEST", value: "configured", sensitive: false }],
    enabled: input.enabled ?? true,
    config: {
      enabled: input.enabled ?? true,
      binaryPath: input.binaryPath ?? "pi-test",
      customModels: input.customModels ?? [],
    },
  }).pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Effect.provideService(HostProcessPlatform, "linux"),
    Effect.provide(PiDriverTestLayer),
  );
}

function commandArgs(command: ChildProcess.Command): ReadonlyArray<string> {
  return command._tag === "StandardCommand" ? command.args : [];
}

function commandCwd(command: ChildProcess.Command): string | undefined {
  return command._tag === "StandardCommand" ? command.options.cwd : undefined;
}

const STARTUP_INITIAL_MESSAGE = "Pi version has not been checked yet.";

function isVersionCommand(command: ChildProcess.Command): boolean {
  return commandArgs(command).includes("--version");
}

type StartupSnapshotSource = {
  readonly getSnapshot: Effect.Effect<ServerProvider, never, never>;
  readonly streamChanges: Stream.Stream<ServerProvider, never, never>;
};

function awaitStartupSnapshot(
  instance: { readonly snapshot: StartupSnapshotSource },
  predicate: (snapshot: ServerProvider) => boolean,
  failureMessage: string,
): Effect.Effect<ServerProvider, never, never> {
  return Stream.concat(
    Stream.fromEffect(instance.snapshot.getSnapshot),
    instance.snapshot.streamChanges,
  ).pipe(
    Stream.filter(predicate),
    Stream.runHead,
    Effect.flatMap((head) =>
      head._tag === "Some" ? Effect.succeed(head.value) : Effect.die(new Error(failureMessage)),
    ),
  );
}

function awaitStartupVersionCheck(instance: {
  readonly snapshot: StartupSnapshotSource;
}): Effect.Effect<void, never, never> {
  return Effect.asVoid(
    awaitStartupSnapshot(
      instance,
      (snapshot) => snapshot.message !== STARTUP_INITIAL_MESSAGE,
      "Pi startup version check did not settle",
    ),
  );
}

function awaitStartupReady(
  instance: {
    readonly snapshot: StartupSnapshotSource;
  },
  options: { readonly expectedVersion: string; readonly expectedModelSlug: string },
): Effect.Effect<ServerProvider, never, never> {
  return awaitStartupSnapshot(
    instance,
    (snapshot) =>
      snapshot.status === "ready" &&
      snapshot.version === options.expectedVersion &&
      snapshot.models.some((model) => model.slug === options.expectedModelSlug),
    "Pi startup discovery did not reach ready",
  );
}

describe("PiDriver status", () => {
  it.effect("keeps disabled instances side-effect free", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let spawnCount = 0;
        const spawner = ChildProcessSpawner.make(() => {
          spawnCount += 1;
          return Effect.succeed(versionHandle("pi 0.86.1"));
        });
        const instance = yield* makeInstance(spawner, { enabled: false });

        const initial = yield* instance.snapshot.getSnapshot;
        const refreshed = yield* instance.snapshot.refresh;

        expect(initial.status).toBe("disabled");
        expect(refreshed.status).toBe("disabled");
        expect(spawnCount).toBe(0);
      }),
    ),
  );

  it.effect("reports a missing binary without starting RPC", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const commands: ChildProcess.Command[] = [];
        const spawner = ChildProcessSpawner.make((command) => {
          commands.push(command);
          return Effect.fail(
            PlatformError.systemError({
              _tag: "NotFound",
              module: "ChildProcess",
              method: "spawn",
              description: "missing test binary",
            }),
          );
        });
        const instance = yield* makeInstance(spawner);
        yield* awaitStartupVersionCheck(instance);
        commands.length = 0;

        const snapshot = yield* instance.snapshot.refresh;

        expect(snapshot).toMatchObject({ installed: false, status: "error", version: null });
        expect(snapshot.message).toContain("not installed");
        expect(commands).toHaveLength(1);
        expect(commandArgs(commands[0]!)).toEqual(["--version"]);
        if (commands[0]?._tag === "StandardCommand") {
          expect(commands[0].options.env?.PI_TEST).toBe("configured");
        }
      }),
    ),
  );

  it.effect("parses healthy versions and applies the minimum version", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const outputs = ["pi version 0.86.1\n", "pi version 0.86.1\n", "pi v0.86.0\n"];
        const spawner = ChildProcessSpawner.make((command) =>
          isVersionCommand(command)
            ? Effect.succeed(versionHandle(outputs.shift() ?? ""))
            : Effect.fail(
                PlatformError.systemError({
                  _tag: "NotFound",
                  module: "ChildProcess",
                  method: "spawn",
                  description: "startup model discovery is out of scope for this version test",
                }),
              ),
        );
        const instance = yield* makeInstance(spawner);
        yield* awaitStartupVersionCheck(instance);

        const healthy = yield* instance.snapshot.refresh;
        const outdated = yield* instance.snapshot.refresh;

        expect(healthy).toMatchObject({ installed: true, version: "0.86.1", status: "ready" });
        expect(outdated).toMatchObject({ installed: true, version: "0.86.0", status: "error" });
        expect(outdated.message).toContain("0.86.1 or newer");
      }),
    ),
  );

  it.effect("reports malformed and non-zero version results without RPC", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const handles = [
          versionHandle("Pi unknown\n"),
          versionHandle("Pi unknown\n"),
          versionHandle("", 7),
        ];
        const commands: ChildProcess.Command[] = [];
        const spawner = ChildProcessSpawner.make((command) => {
          commands.push(command);
          if (!isVersionCommand(command)) {
            return Effect.fail(
              PlatformError.systemError({
                _tag: "NotFound",
                module: "ChildProcess",
                method: "spawn",
                description: "startup model discovery is out of scope for this version test",
              }),
            );
          }
          return Effect.succeed(handles.shift()!);
        });
        const instance = yield* makeInstance(spawner);
        yield* awaitStartupVersionCheck(instance);
        commands.length = 0;
        handles.length = 0;
        handles.push(versionHandle("Pi unknown\n"), versionHandle("", 7));

        const malformed = yield* instance.snapshot.refresh;
        const failed = yield* instance.snapshot.refresh;

        expect(malformed.message).toContain("unrecognized version");
        expect(failed.message).toContain("code 7");
        expect(commands.map(commandArgs)).toEqual([["--version"], ["--version"]]);
      }),
    ),
  );

  it.effect("constructs the stateful adapter without spawning until a session starts", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const instance = yield* makeInstance(
          ChildProcessSpawner.make(() => Effect.die("stopAll must not spawn Pi")),
        );

        expect(instance.adapter.capabilities).toEqual({
          sessionModelSwitch: "in-session",
          supportsConversationRollback: true,
        });
        yield* instance.adapter.stopAll();
        expect(yield* instance.adapter.listSessions()).toEqual([]);
      }),
    ),
  );

  it.effect("constructs runtime sessions without the discovery-only no-session flag", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const cwd = path.resolve("/work/runtime");
        const requests: PiRpcRecord[] = [];
        const commands: ChildProcess.Command[] = [];
        const handle = yield* rpcHandle({
          requests,
          respond: (request) =>
            successResponse(request, {
              sessionId: "pi-runtime-session",
              sessionFile: "/private/pi-runtime-session.jsonl",
              model: { id: "gpt-5.2", name: "GPT 5.2", provider: "openai" },
              thinkingLevel: "medium",
              isStreaming: false,
              isCompacting: false,
            }),
        });
        const instance = yield* makeInstance(
          ChildProcessSpawner.make((command) => {
            commands.push(command);
            return isVersionCommand(command)
              ? Effect.succeed(versionHandle("pi 0.86.1"))
              : Effect.succeed(handle);
          }),
        );
        yield* awaitStartupVersionCheck(instance);
        commands.length = 0;
        requests.length = 0;

        const session = yield* instance.adapter.startSession({
          threadId: ThreadId.make("pi-driver-runtime"),
          cwd,
          runtimeMode: "full-access",
        });

        expect(commandArgs(commands[0]!)).toEqual(["--mode", "rpc"]);
        expect(commandCwd(commands[0]!)).toBe(cwd);
        expect(requests.map((request) => recordString(request, "type"))).toEqual(["get_state"]);
        expect(session).toMatchObject({
          providerInstanceId: "pi-test",
          threadId: "pi-driver-runtime",
          model: "openai/gpt-5.2",
          resumeCursor: {
            version: 2,
            sessionId: "pi-runtime-session",
            providerInstanceId: "pi-test",
            cwd,
          },
        });
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("launches a validated resume cursor with --session and no host path", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const cwd = path.resolve("/work/runtime");
        const requests: PiRpcRecord[] = [];
        const commands: ChildProcess.Command[] = [];
        const handle = yield* rpcHandle({
          requests,
          respond: (request) =>
            successResponse(request, {
              sessionId: "pi-resumed-session",
              sessionFile: "/private/internal-only.jsonl",
              model: { id: "gpt-5.2", name: "GPT 5.2", provider: "openai" },
              thinkingLevel: "medium",
              isStreaming: false,
              isCompacting: false,
            }),
        });
        const instance = yield* makeInstance(
          ChildProcessSpawner.make((command) => {
            commands.push(command);
            return isVersionCommand(command)
              ? Effect.succeed(versionHandle("pi 0.86.1"))
              : Effect.succeed(handle);
          }),
        );
        yield* awaitStartupVersionCheck(instance);
        commands.length = 0;
        requests.length = 0;

        const session = yield* instance.adapter.startSession({
          threadId: ThreadId.make("pi-driver-resume"),
          cwd,
          runtimeMode: "full-access",
          resumeCursor: {
            version: 2,
            sessionId: "pi-resumed-session",
            providerInstanceId: ProviderInstanceId.make("pi-test"),
            cwd,
          },
        });

        expect(commandArgs(commands[0]!)).toEqual([
          "--mode",
          "rpc",
          "--session",
          "pi-resumed-session",
        ]);
        expect(commandCwd(commands[0]!)).toBe(cwd);
        expect(requests.map((request) => recordString(request, "type"))).toEqual(["get_state"]);
        expect(session.resumeCursor).toEqual({
          version: 2,
          sessionId: "pi-resumed-session",
          providerInstanceId: "pi-test",
          cwd,
        });
        expect(session.resumeCursor).not.toHaveProperty("sessionFile");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("wires isolated Pi text generation to the configured instance", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const requests: PiRpcRecord[] = [];
        const commands: ChildProcess.Command[] = [];
        let killCount = 0;
        const handle = yield* rpcHandle({
          requests,
          onKill: () => {
            killCount += 1;
          },
          respond: (request) => successResponse(request, null),
          events: (request) =>
            recordString(request, "type") === "prompt"
              ? [
                  {
                    type: "message_end",
                    message: {
                      role: "assistant",
                      content: [{ type: "text", text: '{"branch":"pi-text-generation"}' }],
                      stopReason: "stop",
                    },
                  },
                  { type: "agent_settled" },
                ]
              : [],
        });
        const instance = yield* makeInstance(
          ChildProcessSpawner.make((command) => {
            commands.push(command);
            return isVersionCommand(command)
              ? Effect.succeed(versionHandle("pi 0.86.1"))
              : Effect.succeed(handle);
          }),
          { binaryPath: "pi-custom" },
        );
        yield* awaitStartupVersionCheck(instance);
        commands.length = 0;
        requests.length = 0;
        killCount = 0;

        const result = yield* instance.textGeneration.generateBranchName({
          cwd: "/work/text-generation",
          message: "Add isolated Pi text generation",
          modelSelection: {
            instanceId: ProviderInstanceId.make("pi-test"),
            model: "openai/gpt-5.2",
            options: [{ id: "thinkingLevel", value: "high" }],
          },
        });

        expect(result).toEqual({ branch: "pi-text-generation" });
        expect(commandArgs(commands[0]!)).toEqual([
          "--mode",
          "rpc",
          "--no-session",
          "--no-tools",
          "--no-extensions",
          "--no-skills",
          "--no-prompt-templates",
          "--no-context-files",
          "--no-approve",
          "--provider",
          "openai",
          "--model",
          "gpt-5.2",
          "--thinking",
          "high",
        ]);
        expect(commandCwd(commands[0]!)).toBe("/work/text-generation");
        expect(requests.map((request) => recordString(request, "type"))).toEqual(["prompt"]);
        expect(requests[0]).not.toHaveProperty("cwd");
        expect(killCount).toBe(1);
      }),
    ),
  );
});

describe("PiDriver explicit discovery", () => {
  it.effect("discovers each model's exact thinking levels, then closes RPC", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const requests: PiRpcRecord[] = [];
        let killCount = 0;
        const handle = yield* rpcHandle({
          requests,
          onKill: () => {
            killCount += 1;
          },
          respond: (request) =>
            successResponse(request, {
              models: [
                {
                  id: "reasoning-defaults",
                  name: "Reasoning Defaults",
                  provider: "openai",
                  reasoning: true,
                  input: ["text", "image"],
                },
                {
                  id: "reasoning-mapped",
                  name: "Reasoning Mapped",
                  provider: "anthropic",
                  reasoning: true,
                  thinkingLevelMap: {
                    off: null,
                    minimal: null,
                    high: null,
                    xhigh: "xhigh",
                    max: "max",
                  },
                  input: ["text"],
                },
                {
                  id: "fast-test",
                  name: "Fast Test",
                  provider: "example",
                  reasoning: false,
                  input: ["text"],
                },
              ],
            }),
        });
        const commands: ChildProcess.Command[] = [];
        const spawner = ChildProcessSpawner.make((command) => {
          commands.push(command);
          return isVersionCommand(command)
            ? Effect.succeed(versionHandle("pi 0.86.1"))
            : Effect.succeed(handle);
        });
        const instance = yield* makeInstance(spawner, {
          customModels: ["custom/provider-model"],
        });
        yield* awaitStartupVersionCheck(instance);
        commands.length = 0;
        requests.length = 0;
        killCount = 0;

        yield* instance.refreshModels!();
        const snapshot = yield* instance.snapshot.getSnapshot;

        expect(requests.map((request) => recordString(request, "type"))).toEqual([
          "get_available_models",
        ]);
        expect(commandArgs(commands[0]!)).toEqual(["--mode", "rpc", "--no-session"]);
        expect(commandCwd(commands[0]!)).toMatch(/pi-discovery$/);
        expect(snapshot.models.map((model) => model.slug)).toEqual([
          "openai/reasoning-defaults",
          "anthropic/reasoning-mapped",
          "example/fast-test",
          "custom/provider-model",
        ]);
        expect(snapshot.auth.status).toBe("unknown");
        expect(snapshot.message).toBe("3 model providers available through Pi.");
        expect(snapshot.models[0]?.capabilities?.optionDescriptors?.[0]).toMatchObject({
          id: "thinkingLevel",
          currentValue: "medium",
          options: [
            { id: "off", label: "Off" },
            { id: "minimal", label: "Minimal" },
            { id: "low", label: "Low" },
            { id: "medium", label: "Medium", isDefault: true },
            { id: "high", label: "High" },
          ],
        });
        expect(snapshot.models[1]?.capabilities?.optionDescriptors?.[0]).toMatchObject({
          id: "thinkingLevel",
          currentValue: "medium",
          options: [
            { id: "low", label: "Low" },
            { id: "medium", label: "Medium", isDefault: true },
            { id: "xhigh", label: "Xhigh" },
            { id: "max", label: "Max" },
          ],
        });
        expect(snapshot.models[2]?.capabilities).toBeNull();
        expect(killCount).toBe(1);
      }),
    ),
  );

  it.effect("retains the prior model catalog and returns a typed error on failure", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let rpcRun = 0;
        let killCount = 0;
        const requests: PiRpcRecord[] = [];
        const spawner = ChildProcessSpawner.make((command) => {
          if (isVersionCommand(command)) {
            return Effect.succeed(versionHandle("pi 0.86.1"));
          }
          return Effect.gen(function* () {
            rpcRun += 1;
            return yield* rpcHandle({
              requests,
              onKill: () => {
                killCount += 1;
              },
              respond: (request) => {
                const method = recordString(request, "type");
                if (method === "get_available_models") {
                  return successResponse(
                    request,
                    rpcRun <= 2
                      ? {
                          models: [
                            {
                              id: "stable",
                              name: "Stable",
                              provider: "test",
                              reasoning: false,
                              input: ["text"],
                            },
                          ],
                        }
                      : { models: "invalid" },
                  );
                }
                return successResponse(request, { levels: ["off"] });
              },
            });
          });
        });
        const instance = yield* makeInstance(spawner);
        yield* awaitStartupVersionCheck(instance);
        requests.length = 0;
        killCount = 0;

        yield* instance.refreshModels!();
        const before = yield* instance.snapshot.getSnapshot;
        const error = yield* instance.refreshModels!().pipe(Effect.flip);
        const after = yield* instance.snapshot.getSnapshot;

        expect(error).toMatchObject({
          _tag: "ProviderDriverError",
          driver: "pi",
          detail: "Pi model discovery failed.",
        });
        expect(after.models).toEqual(before.models);
        expect(killCount).toBe(2);
      }),
    ),
  );

  it.effect("discovers commands and skills in the exact workspace and closes RPC", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const requests: PiRpcRecord[] = [];
        const cwd = "/workspaces/pi-project";
        let killCount = 0;
        const handle = yield* rpcHandle({
          requests,
          onKill: () => {
            killCount += 1;
          },
          respond: (request) =>
            recordString(request, "type") === "get_available_models"
              ? successResponse(request, {
                  models: [
                    {
                      id: "project-model",
                      name: "Project Model",
                      provider: "project-provider",
                      reasoning: false,
                      input: ["text"],
                    },
                  ],
                })
              : successResponse(request, {
                  commands: [
                    {
                      name: "compact",
                      description: "Workspace duplicate must not replace the shared command",
                      source: "prompt",
                      sourceInfo: {
                        path: "/workspaces/pi-project/.pi/agent/prompts/compact.md",
                        source: "project",
                        scope: "project",
                        origin: "top-level",
                        baseDir: "/workspaces/pi-project/.pi/agent/prompts",
                      },
                    },
                    {
                      name: "review",
                      description: "Review changes",
                      source: "prompt",
                      sourceInfo: {
                        path: "/workspaces/pi-project/.pi/agent/prompts/review.md",
                        source: "project",
                        scope: "project",
                        origin: "top-level",
                        baseDir: "/workspaces/pi-project/.pi/agent/prompts",
                      },
                    },
                    {
                      name: "skill:deploy",
                      description: "Deploy the app",
                      source: "skill",
                      sourceInfo: {
                        path: "/home/dev/.pi/agent/skills/deploy/SKILL.md",
                        source: "user",
                        scope: "user",
                        origin: "top-level",
                      },
                    },
                  ],
                }),
        });
        const commands: ChildProcess.Command[] = [];
        const spawner = ChildProcessSpawner.make((command) => {
          commands.push(command);
          return isVersionCommand(command)
            ? Effect.succeed(versionHandle("pi 0.86.1"))
            : Effect.succeed(handle);
        });
        const instance = yield* makeInstance(spawner, {
          customModels: ["custom/model"],
        });
        yield* awaitStartupVersionCheck(instance);
        commands.length = 0;
        requests.length = 0;
        killCount = 0;
        const baseBefore = yield* instance.snapshot.getSnapshot;

        const scoped = yield* instance.snapshotForCwd!(cwd);
        const baseAfter = yield* instance.snapshot.getSnapshot;

        expect(commandCwd(commands[0]!)).toBe(cwd);
        expect(requests.map((request) => recordString(request, "type"))).toEqual([
          "get_commands",
          "get_available_models",
        ]);
        expect(baseBefore.slashCommands).toEqual([
          {
            name: "compact",
            description: "Summarize the conversation and reduce context usage",
          },
        ]);
        expect(scoped.slashCommands).toEqual([
          {
            name: "compact",
            description: "Summarize the conversation and reduce context usage",
          },
          { name: "review", description: "Review changes" },
        ]);
        expect(scoped.skills).toEqual([
          {
            name: "deploy",
            description: "Deploy the app",
            path: "/home/dev/.pi/agent/skills/deploy/SKILL.md",
            scope: "user",
            enabled: true,
          },
        ]);
        expect(scoped.models.map((model) => model.slug)).toContain(
          "project-provider/project-model",
        );
        expect(baseAfter).toEqual(baseBefore);
        expect(killCount).toBe(1);
      }),
    ),
  );

  it.effect("closes workspace RPC and bounds malformed command failures", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let killCount = 0;
        const handle = yield* rpcHandle({
          requests: [],
          onKill: () => {
            killCount += 1;
          },
          respond: (request) => successResponse(request, { commands: [{ private: "payload" }] }),
        });
        const instance = yield* makeInstance(
          ChildProcessSpawner.make((command) =>
            isVersionCommand(command)
              ? Effect.succeed(versionHandle("pi 0.86.1"))
              : Effect.succeed(handle),
          ),
        );
        yield* awaitStartupVersionCheck(instance);
        killCount = 0;

        const error = yield* instance.snapshotForCwd!("/workspaces/private").pipe(Effect.flip);

        expect(error).toMatchObject({
          _tag: "ProviderDriverError",
          detail: "Pi workspace discovery failed for '/workspaces/private'.",
        });
        expect(error.message).not.toContain("payload");
        expect(killCount).toBe(1);
      }),
    ),
  );
});

describe("PiDriver startup discovery", () => {
  it.effect("reaches ready with version and models without blocking creation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const requests: PiRpcRecord[] = [];
        const commands: ChildProcess.Command[] = [];
        const handle = yield* rpcHandle({
          requests,
          respond: (request) =>
            successResponse(request, {
              models: [
                {
                  id: "startup-model",
                  name: "Startup Model",
                  provider: "test",
                  reasoning: false,
                  input: ["text"],
                },
              ],
            }),
        });
        const spawner = ChildProcessSpawner.make((command) => {
          commands.push(command);
          return isVersionCommand(command)
            ? Effect.succeed(versionHandle("pi 0.86.1"))
            : Effect.succeed(handle);
        });
        const instance = yield* makeInstance(spawner, { enabled: true });
        const snapshot = yield* awaitStartupReady(instance, {
          expectedVersion: "0.86.1",
          expectedModelSlug: "test/startup-model",
        });

        expect(snapshot.status).toBe("ready");
        expect(snapshot.auth.status).toBe("unknown");
        expect(snapshot.message).toBe("1 model provider available through Pi.");
        expect(snapshot.version).toBe("0.86.1");
        expect(snapshot.models.map((model) => model.slug)).toContain("test/startup-model");
        expect(commands.some(isVersionCommand)).toBe(true);
        expect(requests.map((request) => recordString(request, "type"))).toContain(
          "get_available_models",
        );
      }),
    ),
  );

  it.effect("spawns nothing on startup when disabled", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let spawnCount = 0;
        const spawner = ChildProcessSpawner.make(() => {
          spawnCount += 1;
          return Effect.succeed(versionHandle("pi 0.86.1"));
        });
        const instance = yield* makeInstance(spawner, { enabled: false });
        const snapshot = yield* awaitStartupSnapshot(
          instance,
          (candidate) => candidate.status === "disabled",
          "Pi disabled startup did not settle",
        );
        expect(snapshot.status).toBe("disabled");
        expect(spawnCount).toBe(0);
      }),
    ),
  );

  it.effect("publishes a warning when startup model discovery fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const requests: PiRpcRecord[] = [];
        const handle = yield* rpcHandle({
          requests,
          respond: (request) => successResponse(request, { models: "invalid" }),
        });
        const spawner = ChildProcessSpawner.make((command) =>
          isVersionCommand(command)
            ? Effect.succeed(versionHandle("pi 0.86.1"))
            : Effect.succeed(handle),
        );
        const instance = yield* makeInstance(spawner, {
          enabled: true,
          customModels: ["custom/keep"],
        });
        const snapshot = yield* awaitStartupSnapshot(
          instance,
          (candidate) =>
            candidate.status === "warning" &&
            candidate.version === "0.86.1" &&
            (candidate.message ?? "").includes("Pi model discovery failed."),
          "Pi startup discovery failure did not publish a warning",
        );

        expect(snapshot).toMatchObject({
          installed: true,
          status: "warning",
          version: "0.86.1",
        });
        expect(snapshot.message).toContain("Pi model discovery failed.");
        expect(snapshot.models.map((model) => model.slug)).toContain("custom/keep");
        expect(requests.map((request) => recordString(request, "type"))).toContain(
          "get_available_models",
        );
      }),
    ),
  );

  it.effect("reports missing upstream connections when startup discovery finds zero models", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const requests: PiRpcRecord[] = [];
        const handle = yield* rpcHandle({
          requests,
          respond: (request) => successResponse(request, { models: [] }),
        });
        const spawner = ChildProcessSpawner.make((command) =>
          isVersionCommand(command)
            ? Effect.succeed(versionHandle("pi 0.86.1"))
            : Effect.succeed(handle),
        );
        const instance = yield* makeInstance(spawner, { enabled: true });
        const snapshot = yield* awaitStartupSnapshot(
          instance,
          (candidate) =>
            candidate.status === "warning" &&
            candidate.version === "0.86.1" &&
            candidate.message !== STARTUP_INITIAL_MESSAGE &&
            requests.some((request) => recordString(request, "type") === "get_available_models"),
          "Pi startup zero-model discovery did not settle",
        );

        expect(snapshot.status).toBe("warning");
        expect(snapshot.auth.status).toBe("unknown");
        expect(snapshot.version).toBe("0.86.1");
        expect(snapshot.models).toEqual([]);
        expect(snapshot.message).toContain("Connect a model provider in Pi");
      }),
    ),
  );

  it.effect("preserves discovered models across concurrent refresh and discovery", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const requests: PiRpcRecord[] = [];
        const handle = yield* rpcHandle({
          requests,
          respond: (request) =>
            successResponse(request, {
              models: [
                {
                  id: "concurrent-model",
                  name: "Concurrent Model",
                  provider: "test",
                  reasoning: false,
                  input: ["text"],
                },
              ],
            }),
        });
        const spawner = ChildProcessSpawner.make((command) =>
          isVersionCommand(command)
            ? Effect.succeed(versionHandle("pi 0.86.1"))
            : Effect.succeed(handle),
        );
        const instance = yield* makeInstance(spawner, { enabled: true });
        yield* awaitStartupReady(instance, {
          expectedVersion: "0.86.1",
          expectedModelSlug: "test/concurrent-model",
        });

        yield* Effect.all([instance.snapshot.refresh, instance.refreshModels!()], {
          concurrency: "unbounded",
        });
        const snapshot = yield* instance.snapshot.getSnapshot;

        expect(snapshot.version).toBe("0.86.1");
        expect(snapshot.models.map((model) => model.slug)).toContain("test/concurrent-model");
      }),
    ),
  );
});
