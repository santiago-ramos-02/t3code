import { expect, it } from "@effect/vitest";
import {
  BoatError,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type BoatMachine,
  type BoatSpawnInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as BoatMachines from "../../../boat/BoatMachines.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as BoatHandlers from "./handlers.ts";
import { BoatToolkit } from "./tools.ts";

const threadId = ThreadId.make("thread:boat");
const machine: BoatMachine = {
  sandboxId: "sbx_01abcd",
  size: "default",
  state: "running",
  httpBaseUrl: "https://sbx-01abcd-3773.boat.dev",
  createdAt: "2026-10-22T00:00:00.000Z",
  problem: null,
  projectId: null,
  stoppedAt: null,
  report: null,
  snapshot: null,
  notice: null,
  startSteps: [],
};

const run = (boat: Partial<BoatMachines.BoatMachines["Service"]>) =>
  Effect.gen(function* () {
    const toolkit = yield* BoatToolkit;
    return yield* toolkit
      .handle("t3_boat_machine_start", { size: "default" })
      .pipe(Stream.unwrap, Stream.runCollect);
  }).pipe(
    Effect.provide(
      McpToolAccess.HandlersLayer.layer(BoatHandlers.layer).pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            Layer.succeed(McpInvocationContext.McpInvocationContext, {
              environmentId: EnvironmentId.make("environment:boat"),
              requestNamespace: "provider:boat",
              thread: {
                threadId,
                providerSessionId: "provider:boat",
                providerInstanceId: ProviderInstanceId.make("codex"),
              },
              client: undefined,
              capabilities: new Set(["orchestration" as const]),
              issuedAt: 0,
            }),
            Layer.mock(ThreadManagement.ThreadManagementService)({
              getThreadShell: () => Effect.succeed(liveThreadShell(threadId)),
            }),
            Layer.mock(BoatMachines.BoatMachines)(boat),
          ),
        ),
      ),
    ),
  );

it.effect("returns a one-time pairing link for a new Boat machine", () =>
  Effect.gen(function* () {
    const spawned: Array<BoatSpawnInput> = [];
    const result = yield* run({
      spawn: (input) =>
        Effect.sync(() => spawned.push(input)).pipe(
          Effect.as({
            machine,
            httpBaseUrl: "https://sbx-01abcd-3773.boat.dev",
            pairingCredential: "PAIR-CODE",
          }),
        ),
    });
    // The calling thread's project decides which worktree cleanup rules apply.
    expect(spawned).toEqual([{ size: "default", projectId: liveThreadShell(threadId).projectId }]);
    expect(result.at(-1)?.result).toEqual({
      machine: { ...machine, label: "Boat · default · abcd" },
      pairingUrl: "https://sbx-01abcd-3773.boat.dev/pair#token=PAIR-CODE",
    });
  }),
);

it.effect("returns Boat's reason when a machine cannot start", () =>
  Effect.gen(function* () {
    const result = yield* run({
      spawn: () => Effect.fail(new BoatError({ detail: "Add a Boat API key in Settings first." })),
    });
    expect(result.at(-1)?.result).toMatchObject({
      code: "orchestration_error",
      message: "Add a Boat API key in Settings first.",
    });
  }),
);
