import { inspect } from "node:util";

import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId, TextGenerationError } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import {
  PiRpcError,
  type PiRpcClient,
  type PiRpcCommand,
  type PiRpcEvent,
  type PiRpcOptions,
  type PiRpcResponse,
  recordString,
} from "../provider/PiRpc.ts";
import { makePiTextGeneration } from "./PiTextGeneration.ts";

interface FakeProcess {
  readonly options: PiRpcOptions;
  readonly events: Queue.Queue<PiRpcEvent>;
  readonly requests: PiRpcCommand[];
}

function successfulResponse(command: PiRpcCommand): PiRpcResponse {
  return {
    id: "fake-response",
    type: "response",
    command: command.type,
    success: true,
  };
}

function assistantMessage(text: string, stopReason = "stop"): PiRpcEvent {
  return {
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      stopReason,
    },
  };
}

function makeHarness(
  onRequest: (
    process: FakeProcess,
    command: PiRpcCommand,
  ) => Effect.Effect<void, PiRpcError> = () => Effect.void,
) {
  const processes: FakeProcess[] = [];
  let closed = 0;
  let pid = 100;

  const rpcFactory = (options: PiRpcOptions) =>
    Effect.acquireRelease(
      Effect.gen(function* () {
        const events = yield* Queue.unbounded<PiRpcEvent>();
        const requests: PiRpcCommand[] = [];
        const process = { options, events, requests } satisfies FakeProcess;
        processes.push(process);
        const client: PiRpcClient = {
          request: (command) =>
            Effect.sync(() => {
              process.requests.push(command);
            }).pipe(
              Effect.andThen(onRequest(process, command)),
              Effect.as(successfulResponse(command)),
            ),
          notify: () => Effect.void,
          events: Stream.fromQueue(events),
          pendingRequestCount: Effect.succeed(0),
          pid: ChildProcessSpawner.ProcessId(++pid),
        };
        return client;
      }),
      () =>
        Effect.sync(() => {
          closed += 1;
        }),
    );

  return {
    processes,
    rpcFactory,
    get closed() {
      return closed;
    },
  };
}

function expectBoundedError(error: TextGenerationError, forbidden: ReadonlyArray<string>): void {
  expect(error.cause).toBeUndefined();
  expect(error.detail.length).toBeLessThan(200);
  const rendered = [String(error), JSON.stringify(error), inspect(error, { depth: null })].join(
    "\n",
  );
  for (const privateValue of forbidden) {
    expect(rendered).not.toContain(privateValue);
  }
}

const instanceId = ProviderInstanceId.make("pi-test");
const selectedModel = {
  instanceId,
  model: "openai/gpt-5.2",
  options: [{ id: "thinkingLevel", value: "high" }],
} as const;

function completeWith(process: FakeProcess, output: string) {
  return Effect.gen(function* () {
    yield* Queue.offer(process.events, assistantMessage(output));
    yield* Queue.offer(process.events, { type: "agent_settled" });
  });
}

describe("PiTextGeneration", () => {
  it.effect("runs all four operations in fresh isolated RPC processes with shared sanitizers", () =>
    Effect.gen(function* () {
      const outputs = [
        '{"subject":"Update generated text.","body":"  Details  ","branch":"pi-text-generation"}',
        '{"title":"  Add Pi text generation  ","body":"  ## Summary\\n- Added  "}',
        '{"branch":"Fix Login Timeout"}',
        '{"title":"  Fix   reconnect failures  ","needsRefinement":true}',
      ];
      const harness = makeHarness((process, command) =>
        command.type === "prompt" ? completeWith(process, outputs.shift() ?? "") : Effect.void,
      );
      const generation = yield* makePiTextGeneration({
        binaryPath: "pi-custom",
        environment: { PI_TEST: "configured" },
        rpcFactory: harness.rpcFactory,
      });

      const commit = yield* generation.generateCommitMessage({
        cwd: "/workspace/commit",
        branch: "main",
        stagedSummary: "M src/app.ts",
        stagedPatch: "+change",
        includeBranch: true,
        modelSelection: selectedModel,
      });
      const pr = yield* generation.generatePrContent({
        cwd: "/workspace/pr",
        baseBranch: "main",
        headBranch: "feature/pi",
        commitSummary: "feat: add pi",
        diffSummary: "1 file changed",
        diffPatch: "+change",
        modelSelection: selectedModel,
      });
      const branch = yield* generation.generateBranchName({
        cwd: "/workspace/branch",
        message: "Fix the login timeout",
        modelSelection: selectedModel,
      });
      const title = yield* generation.generateThreadTitle({
        cwd: "/workspace/title",
        message: "Fix reconnect failures",
        modelSelection: selectedModel,
      });

      expect(commit).toEqual({
        subject: "Update generated text",
        body: "Details",
        branch: "feature/pi-text-generation",
      });
      expect(pr).toEqual({
        title: "Add Pi text generation",
        body: "## Summary\n- Added",
      });
      expect(branch).toEqual({ branch: "fix-login-timeout" });
      expect(title).toEqual({ title: "Fix reconnect failures", needsRefinement: true });
      expect(harness.processes).toHaveLength(4);
      expect(harness.closed).toBe(4);
      for (const process of harness.processes) {
        expect(process.options).toMatchObject({
          binaryPath: "pi-custom",
          environment: { PI_TEST: "configured" },
        });
        expect(process.options.args).toEqual([
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
        expect(process.requests.map((request) => request.type)).toEqual(["prompt"]);
        expect(process.requests[0]).toEqual({
          type: "prompt",
          message: expect.any(String),
        });
      }
      expect(harness.processes.map((process) => process.options.cwd)).toEqual([
        "/workspace/commit",
        "/workspace/pr",
        "/workspace/branch",
        "/workspace/title",
      ]);
    }),
  );

  it.effect("uses only attachment metadata and never sends attachment paths", () =>
    Effect.gen(function* () {
      const harness = makeHarness((process, command) =>
        command.type === "prompt"
          ? completeWith(process, '{"branch":"image-layout"}')
          : Effect.void,
      );
      const generation = yield* makePiTextGeneration({
        binaryPath: "pi",
        rpcFactory: harness.rpcFactory,
      });

      yield* generation.generateBranchName({
        cwd: "/private/workspace-path",
        message: "Fix the screenshot layout",
        attachments: [
          {
            id: "image-1",
            type: "image",
            name: "layout.png",
            mimeType: "image/png",
            sizeBytes: 1234,
          },
        ],
        modelSelection: {
          instanceId,
          model: "openai/gpt-5.2",
        },
      });

      const prompt = harness.processes[0]?.requests[0];
      expect(prompt).toMatchObject({ type: "prompt" });
      if (prompt?.type === "prompt") {
        expect(prompt.message).toContain("layout.png (image/png, 1234 bytes)");
        expect(prompt.message).not.toContain("/private/workspace-path");
      }
      expect(harness.processes[0]?.options.args).not.toContain("--thinking");
    }),
  );

  it.effect("waits for agent_settled rather than agent_end and ignores duplicate terminals", () =>
    Effect.gen(function* () {
      const promptAccepted = yield* Deferred.make<void>();
      const harness = makeHarness((process, command) =>
        command.type === "prompt"
          ? Effect.gen(function* () {
              yield* Queue.offer(process.events, assistantMessage('{"branch":"first-result"}'));
              yield* Queue.offer(process.events, { type: "agent_end", messages: [] });
              yield* Deferred.succeed(promptAccepted, undefined);
            })
          : Effect.void,
      );
      const generation = yield* makePiTextGeneration({
        binaryPath: "pi",
        rpcFactory: harness.rpcFactory,
      });
      const resultFiber = yield* generation
        .generateBranchName({
          cwd: "/workspace",
          message: "First result",
          modelSelection: selectedModel,
        })
        .pipe(Effect.forkChild);

      yield* Deferred.await(promptAccepted);
      expect(resultFiber.pollUnsafe()).toBeUndefined();
      const process = harness.processes[0]!;
      yield* Queue.offer(process.events, { type: "agent_settled" });
      yield* Queue.offer(process.events, assistantMessage('{"branch":"second-result"}'));
      yield* Queue.offer(process.events, { type: "agent_settled" });

      expect(yield* Fiber.join(resultFiber)).toEqual({ branch: "first-result" });
      expect(harness.closed).toBe(1);
    }),
  );

  it.effect("keeps concurrent requests isolated by process and output", () =>
    Effect.gen(function* () {
      const harness = makeHarness((process, command) => {
        if (command.type !== "prompt") return Effect.void;
        const output = recordString(command, "message")?.includes("alpha")
          ? '{"branch":"alpha-branch"}'
          : '{"branch":"beta-branch"}';
        return completeWith(process, output);
      });
      const generation = yield* makePiTextGeneration({
        binaryPath: "pi",
        rpcFactory: harness.rpcFactory,
      });

      const [alpha, beta] = yield* Effect.all(
        [
          generation.generateBranchName({
            cwd: "/workspace/alpha",
            message: "alpha",
            modelSelection: selectedModel,
          }),
          generation.generateBranchName({
            cwd: "/workspace/beta",
            message: "beta",
            modelSelection: selectedModel,
          }),
        ],
        { concurrency: "unbounded" },
      );

      expect(alpha).toEqual({ branch: "alpha-branch" });
      expect(beta).toEqual({ branch: "beta-branch" });
      expect(harness.processes).toHaveLength(2);
      expect(harness.processes.map((process) => process.requests.length)).toEqual([1, 1]);
      expect(harness.closed).toBe(2);
    }),
  );

  it.effect("validates model and thinking selections before starting Pi", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const generation = yield* makePiTextGeneration({
        binaryPath: "pi",
        rpcFactory: harness.rpcFactory,
      });

      const invalidModel = yield* generation
        .generateBranchName({
          cwd: "/workspace",
          message: "test",
          modelSelection: { instanceId, model: "missing-provider" },
        })
        .pipe(Effect.flip);
      const invalidThinking = yield* generation
        .generateBranchName({
          cwd: "/workspace",
          message: "test",
          modelSelection: {
            instanceId,
            model: "openai/gpt-5.2",
            options: [{ id: "thinkingLevel", value: "impossible" }],
          },
        })
        .pipe(Effect.flip);

      expect(invalidModel).toMatchObject({
        _tag: "TextGenerationError",
        operation: "generateBranchName",
      });
      expect(invalidThinking).toMatchObject({
        _tag: "TextGenerationError",
        operation: "generateBranchName",
      });
      expect(harness.processes).toHaveLength(0);
    }),
  );

  it.effect("removes private startup failure data and closes acquired startup resources", () =>
    Effect.gen(function* () {
      const privateBinary = "/private/bin/pi-secret";
      const privateCwd = "/private/startup-workspace";
      const privateStderr = "stderr access_token=startup-secret";
      let closed = 0;
      const startupError = new PiRpcError({
        reason: "spawn-failed",
        detail: privateStderr,
        cause: new Error(`${privateBinary} failed in ${privateCwd}`),
      });
      const rpcFactory = (_options: PiRpcOptions) =>
        Effect.acquireRelease(Effect.void, () =>
          Effect.sync(() => {
            closed += 1;
          }),
        ).pipe(Effect.andThen(Effect.fail(startupError)));
      const generation = yield* makePiTextGeneration({
        binaryPath: privateBinary,
        rpcFactory,
      });

      const error = yield* generation
        .generateBranchName({
          cwd: privateCwd,
          message: "startup",
          modelSelection: selectedModel,
        })
        .pipe(Effect.flip);

      expect(error.detail).toBe("Failed to start isolated Pi text generation.");
      expectBoundedError(error, [privateBinary, privateCwd, privateStderr, "startup-secret"]);
      expect(closed).toBe(1);
    }),
  );

  it.effect("removes private prompt rejection data and closes the request process", () =>
    Effect.gen(function* () {
      const privateBinary = "/private/bin/pi-prompt";
      const privateCwd = "/private/prompt-workspace";
      const privateRemote = "remote rejection with api_key=prompt-secret";
      const harness = makeHarness((_process, command) =>
        command.type === "prompt"
          ? Effect.fail(
              new PiRpcError({
                reason: "remote-error",
                method: "prompt",
                detail: privateRemote,
                cause: new Error(`stderr from ${privateBinary} in ${privateCwd}`),
              }),
            )
          : Effect.void,
      );
      const generation = yield* makePiTextGeneration({
        binaryPath: privateBinary,
        rpcFactory: harness.rpcFactory,
      });

      const error = yield* generation
        .generateBranchName({
          cwd: privateCwd,
          message: "private prompt contents",
          modelSelection: selectedModel,
        })
        .pipe(Effect.flip);

      expect(error.detail).toBe("Pi rejected the text generation request.");
      expectBoundedError(error, [
        privateBinary,
        privateCwd,
        privateRemote,
        "prompt-secret",
        "private prompt contents",
      ]);
      expect(harness.processes[0]?.requests.map((request) => request.type)).toEqual(["prompt"]);
      expect(harness.closed).toBe(1);
    }),
  );

  it.effect("maps malformed, failed, tool, and transport outcomes to cause-free errors", () =>
    Effect.gen(function* () {
      const privateCwd = "/private/outcome-workspace";
      const privateBinary = "/private/bin/pi-outcome";
      const privateStderr = "stderr bearer=transport-secret";
      const outputs: ReadonlyArray<ReadonlyArray<PiRpcEvent>> = [
        [assistantMessage("private malformed model output"), { type: "agent_settled" }],
        [assistantMessage("private provider detail", "error"), { type: "agent_settled" }],
        [{ type: "tool_execution_start", toolCallId: "private-tool-id" }],
        [
          {
            type: "pi_rpc_transport_closed",
            error: new PiRpcError({
              reason: "process-exited",
              detail: privateStderr,
              cause: new Error(`${privateBinary} exited in ${privateCwd}`),
            }),
          },
        ],
      ];
      const harness = makeHarness((process, command) =>
        command.type === "prompt"
          ? Effect.forEach(outputs[harness.processes.indexOf(process)] ?? [], (event) =>
              Queue.offer(process.events, event),
            ).pipe(Effect.asVoid)
          : Effect.void,
      );
      const generation = yield* makePiTextGeneration({
        binaryPath: privateBinary,
        rpcFactory: harness.rpcFactory,
      });

      const errors: TextGenerationError[] = [];
      for (let index = 0; index < outputs.length; index += 1) {
        errors.push(
          yield* generation
            .generateBranchName({
              cwd: privateCwd,
              message: "test",
              modelSelection: selectedModel,
            })
            .pipe(Effect.flip),
        );
      }

      expect(errors.map((error) => error.detail)).toEqual([
        "Pi returned invalid structured output.",
        "Pi text generation failed.",
        "Pi attempted disabled work during text generation.",
        "Pi text generation ended before settling.",
      ]);
      for (const error of errors) {
        expectBoundedError(error, [
          privateCwd,
          privateBinary,
          privateStderr,
          "transport-secret",
          "private malformed model output",
          "private provider detail",
          "private-tool-id",
        ]);
      }
      expect(harness.closed).toBe(4);
    }),
  );

  it.effect("fails extension UI, over-limit output, and settlement without an assistant", () =>
    Effect.gen(function* () {
      const outputs: ReadonlyArray<ReadonlyArray<PiRpcEvent>> = [
        [
          {
            type: "extension_ui_request",
            id: "private-extension-id",
            method: "input",
            title: "private extension title",
          },
        ],
        [assistantMessage("x".repeat(128_001))],
        [{ type: "agent_settled" }],
      ];
      const harness = makeHarness((process, command) =>
        command.type === "prompt"
          ? Effect.forEach(outputs[harness.processes.indexOf(process)] ?? [], (event) =>
              Queue.offer(process.events, event),
            ).pipe(Effect.asVoid)
          : Effect.void,
      );
      const generation = yield* makePiTextGeneration({
        binaryPath: "pi",
        rpcFactory: harness.rpcFactory,
      });
      const errors: TextGenerationError[] = [];
      for (let index = 0; index < outputs.length; index += 1) {
        errors.push(
          yield* generation
            .generateBranchName({
              cwd: "/workspace",
              message: `failure ${index}`,
              modelSelection: selectedModel,
            })
            .pipe(Effect.flip),
        );
      }

      expect(errors.map((error) => error.detail)).toEqual([
        "Pi attempted disabled work during text generation.",
        "Pi text generation exceeded the output limit.",
        "Pi settled without an assistant response.",
      ]);
      for (const error of errors) {
        expectBoundedError(error, ["private-extension-id", "private extension title"]);
      }
      expect(harness.closed).toBe(3);
    }),
  );

  it.effect("preserves the bounded timeout when abort fails and still closes the process", () =>
    Effect.gen(function* () {
      const promptAccepted = yield* Deferred.make<void>();
      const privateAbortFailure = "abort failed with token=abort-secret";
      const harness = makeHarness((_process, command) => {
        if (command.type === "prompt") {
          return Deferred.succeed(promptAccepted, undefined).pipe(Effect.asVoid);
        }
        return Effect.fail(
          new PiRpcError({
            reason: "remote-error",
            method: "abort",
            detail: privateAbortFailure,
            cause: new Error("private abort stderr"),
          }),
        );
      });
      const generation = yield* makePiTextGeneration({
        binaryPath: "/private/bin/pi-timeout",
        rpcFactory: harness.rpcFactory,
        timeout: "1 second",
      });
      const fiber = yield* generation
        .generateBranchName({
          cwd: "/private/timeout-workspace",
          message: "private timeout prompt",
          modelSelection: selectedModel,
        })
        .pipe(Effect.forkChild);

      yield* Deferred.await(promptAccepted);
      yield* TestClock.adjust("1 second");
      const error = yield* Fiber.join(fiber).pipe(Effect.flip);

      expect(error.detail).toBe("Pi text generation timed out.");
      expectBoundedError(error, [
        privateAbortFailure,
        "abort-secret",
        "private abort stderr",
        "/private/bin/pi-timeout",
        "/private/timeout-workspace",
        "private timeout prompt",
      ]);
      expect(harness.processes[0]?.requests.map((request) => request.type)).toEqual([
        "prompt",
        "abort",
      ]);
      expect(harness.closed).toBe(1);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("bounds a stuck abort during interruption and still closes the process", () =>
    Effect.gen(function* () {
      const promptAccepted = yield* Deferred.make<void>();
      const abortStarted = yield* Deferred.make<void>();
      const harness = makeHarness((_process, command) => {
        if (command.type === "prompt") {
          return Deferred.succeed(promptAccepted, undefined).pipe(Effect.asVoid);
        }
        return Deferred.succeed(abortStarted, undefined).pipe(Effect.andThen(Effect.never));
      });
      const generation = yield* makePiTextGeneration({
        binaryPath: "/private/bin/pi-interrupt",
        rpcFactory: harness.rpcFactory,
        abortTimeout: "500 millis",
      });
      const fiber = yield* generation
        .generateBranchName({
          cwd: "/private/interrupt-workspace",
          message: "private interrupt prompt",
          modelSelection: selectedModel,
        })
        .pipe(Effect.forkChild);

      yield* Deferred.await(promptAccepted);
      const interruptFiber = yield* Fiber.interrupt(fiber).pipe(Effect.forkChild);
      yield* Deferred.await(abortStarted);
      expect(interruptFiber.pollUnsafe()).toBeUndefined();
      yield* TestClock.adjust("500 millis");
      yield* Fiber.join(interruptFiber);
      const interrupted = yield* Fiber.await(fiber);

      expect(interrupted._tag).toBe("Failure");
      const rendered = inspect(interrupted, { depth: null });
      expect(rendered).not.toContain("private interrupt prompt");
      expect(rendered).not.toContain("/private/interrupt-workspace");
      expect(rendered).not.toContain("/private/bin/pi-interrupt");
      expect(harness.processes[0]?.requests.map((request) => request.type)).toEqual([
        "prompt",
        "abort",
      ]);
      expect(harness.closed).toBe(1);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});
