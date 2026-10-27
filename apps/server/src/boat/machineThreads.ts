/**
 * Runs a thread on a Boat machine's own T3 Code server and reports how its run is going. The
 * machine owns the thread, its worktree and its agent; this server only starts, follows and stops.
 *
 * @module boat/machineThreads
 */
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  BoatError,
  CommandId,
  EnvironmentAuthorizationError,
  ORCHESTRATION_V2_WS_METHODS,
  OrchestrationV2DispatchCommandError,
  OrchestrationV2GetThreadProjectionError,
  OrchestrationV2RpcSchemas,
  OrchestrationV2ThreadLaunchError,
  type MessageId,
  type ModelSelection,
  type OrchestrationV2RunStatus,
  type OrchestrationV2ThreadStreamItem,
  type OrchestrationV2TurnItem,
  type OrchestrationV2TurnItemStatus,
  type ProjectId,
  type ProviderInteractionMode,
  type RunId,
  type RuntimeMode,
  type ThreadId,
  type TurnItemId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Rpc from "effect/rpc/Rpc";
import type * as RpcClient from "effect/rpc/RpcClient";
import type { RpcClientError } from "effect/rpc/RpcClientError";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import type { BoatMachines } from "./BoatMachines.ts";
import type { MachineProject } from "./machineProject.ts";

export const MachineThreadRpcs = RpcGroup.make(
  Rpc.make(ORCHESTRATION_V2_WS_METHODS.launchThread, {
    payload: OrchestrationV2RpcSchemas.launchThread.input,
    success: OrchestrationV2RpcSchemas.launchThread.output,
    error: Schema.Union([OrchestrationV2ThreadLaunchError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(ORCHESTRATION_V2_WS_METHODS.dispatchCommand, {
    payload: OrchestrationV2RpcSchemas.dispatchCommand.input,
    success: OrchestrationV2RpcSchemas.dispatchCommand.output,
    error: Schema.Union([OrchestrationV2DispatchCommandError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(ORCHESTRATION_V2_WS_METHODS.subscribeThread, {
    payload: OrchestrationV2RpcSchemas.subscribeThread.input,
    success: OrchestrationV2RpcSchemas.subscribeThread.output,
    error: Schema.Union([OrchestrationV2GetThreadProjectionError, EnvironmentAuthorizationError]),
    stream: true,
  }),
);

/** Starting, stopping and following a thread. */
export const MACHINE_THREAD_SCOPES = [
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
] as const;

type MachineThreadRpcClient = RpcClient.FromGroup<typeof MachineThreadRpcs, RpcClientError>;

/** One thing the machine's agent did in a run, in the order it did it. */
export type MachineRunItem =
  | {
      readonly kind: "assistant_message";
      readonly id: TurnItemId;
      readonly messageId: MessageId;
      readonly text: string;
      readonly streaming: boolean;
    }
  | {
      readonly kind: "activity";
      readonly id: TurnItemId;
      readonly name: string;
      readonly summary: string;
      readonly status: OrchestrationV2TurnItemStatus;
      /** The agent waits for an approval or an answer that only the machine's own UI can give. */
      readonly needsAttention: boolean;
    };

/** How one run on the machine stands. */
export interface MachineRun {
  readonly status: OrchestrationV2RunStatus;
  readonly items: ReadonlyArray<MachineRunItem>;
  /** What the machine reported when the run failed; the machine's own words. */
  readonly failure: string | null;
}

const TERMINAL_STATUSES: ReadonlyArray<OrchestrationV2RunStatus> = [
  "completed",
  "interrupted",
  "failed",
  "cancelled",
  "rolled_back",
];

export const isMachineRunTerminal = (run: MachineRun) => TERMINAL_STATUSES.includes(run.status);

export interface MachineLaunchInput {
  readonly projectId: ProjectId;
  /** The id the thread gets on the machine; launching it again finds the same thread. */
  readonly threadId: ThreadId;
  readonly title: string;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  /** The branch, as on origin, the worktree starts from. */
  readonly baseBranch: string;
  readonly message: { readonly messageId: MessageId; readonly text: string };
}

export interface MachineMessageInput {
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly text: string;
  readonly modelSelection: ModelSelection;
}

/** A connection to one machine, open until the scope it was made in closes. */
export interface MachineThreadClient {
  readonly launch: (input: MachineLaunchInput) => Effect.Effect<void, BoatError>;
  readonly dispatch: (input: MachineMessageInput) => Effect.Effect<void, BoatError>;
  /** Stops the thread's run, and the machine's own delegated tasks under it. */
  readonly stop: (input: {
    readonly threadId: ThreadId;
    readonly requestId: string;
  }) => Effect.Effect<void, BoatError>;
  /**
   * The run that answers the message, from its first appearance until it ends. The stream ends
   * without a terminal run only when the connection to the machine ends.
   */
  readonly follow: (input: {
    readonly threadId: ThreadId;
    readonly messageId: MessageId;
  }) => Stream.Stream<MachineRun, BoatError>;
}

export interface MachineThreads {
  readonly ensureProject: (input: {
    readonly sandboxId: string;
    readonly remoteUrl: string;
    readonly branch: string;
  }) => Effect.Effect<MachineProject, BoatError>;
  readonly connect: (
    sandboxId: string,
  ) => Effect.Effect<MachineThreadClient, BoatError, Scope.Scope>;
}

const isBoatError = Schema.is(BoatError);
const isLaunchError = Schema.is(OrchestrationV2ThreadLaunchError);
const isDispatchError = Schema.is(OrchestrationV2DispatchCommandError);
const isProjectionError = Schema.is(OrchestrationV2GetThreadProjectionError);

// What the machine says about its own failures is for the caller; anything else could carry the
// connection's details, so it is not passed on.
const machineError = (error: unknown) =>
  isBoatError(error)
    ? error
    : new BoatError({
        detail:
          isLaunchError(error) || isDispatchError(error) || isProjectionError(error)
            ? error.message
            : "The Boat machine did not answer.",
      });

const clip = (text: string, length: number) => {
  const line = text.trim().split("\n")[0] ?? "";
  return line.length > length ? `${line.slice(0, length - 3)}...` : line;
};

const UNSETTLED: ReadonlyArray<OrchestrationV2TurnItemStatus> = ["idle", "pending", "waiting"];

const describeItem = (item: OrchestrationV2TurnItem): MachineRunItem | undefined => {
  const activity = (name: string, summary: string, needsAttention = false) =>
    ({
      kind: "activity",
      id: item.id,
      name,
      summary: clip(summary, 160),
      status: item.status,
      needsAttention,
    }) satisfies MachineRunItem;
  switch (item.type) {
    case "assistant_message":
      return {
        kind: "assistant_message",
        id: item.id,
        messageId: item.messageId,
        text: item.text,
        streaming: item.streaming,
      };
    case "command_execution":
      return activity("Command", item.input);
    case "file_change":
      return activity("File change", item.fileName);
    case "file_search":
      return activity("File search", item.pattern ?? "");
    case "web_search":
      return activity("Web search", item.patterns?.join(", ") ?? "");
    case "dynamic_tool":
      return activity(item.toolName ?? "Tool", item.title ?? "");
    case "subagent":
      return activity("Subagent", item.prompt);
    case "approval_request":
      return UNSETTLED.includes(item.status)
        ? activity(
            "Needs attention on the machine",
            `Approval requested: ${item.prompt ?? item.reason ?? item.requestKind}`,
            true,
          )
        : undefined;
    case "user_input_request":
      return UNSETTLED.includes(item.status)
        ? activity(
            "Needs attention on the machine",
            `Question asked: ${item.questions[0]?.question ?? "an answer is needed"}`,
            true,
          )
        : undefined;
    default:
      return undefined;
  }
};

/**
 * What the thread's stream says about the run started by `messageId`, kept up to date as items
 * arrive. Nothing is reported until that run exists.
 */
const followRun = (
  stream: Stream.Stream<OrchestrationV2ThreadStreamItem, BoatError>,
  messageId: MessageId,
) =>
  Stream.suspend(() => {
    const runs = new Map<
      RunId,
      {
        readonly id: RunId;
        readonly userMessageId: MessageId;
        readonly status: OrchestrationV2RunStatus;
      }
    >();
    const turnItems = new Map<TurnItemId, OrchestrationV2TurnItem>();
    return stream.pipe(
      Stream.filterMap((item) => {
        if (item.kind === "snapshot") {
          runs.clear();
          turnItems.clear();
          for (const run of item.projection.runs) runs.set(run.id, run);
          for (const turnItem of item.projection.turnItems) turnItems.set(turnItem.id, turnItem);
        } else if (item.kind === "event") {
          const { event } = item;
          if (event.type === "run.created" || event.type === "run.updated") {
            runs.set(event.payload.id, event.payload);
          } else if (event.type === "turn-item.updated") {
            turnItems.set(event.payload.id, event.payload);
          }
        } else {
          return Result.failVoid;
        }
        const run = [...runs.values()].findLast(
          (candidate) => candidate.userMessageId === messageId,
        );
        if (run === undefined) return Result.failVoid;
        const own = [...turnItems.values()]
          .filter((turnItem) => turnItem.runId === run.id)
          .toSorted((left, right) => left.ordinal - right.ordinal);
        const failure = own.findLast((turnItem) => turnItem.type === "error");
        return Result.succeed<MachineRun>({
          status: run.status,
          items: own.flatMap((turnItem) => describeItem(turnItem) ?? []),
          failure: failure?.type === "error" ? failure.failure.message : null,
        });
      }),
      Stream.takeUntil(isMachineRunTerminal),
    );
  });

const makeClient = (client: MachineThreadRpcClient): MachineThreadClient => ({
  launch: (input) =>
    client[ORCHESTRATION_V2_WS_METHODS.launchThread]({
      commandId: CommandId.make(`boat-launch:${input.threadId}`),
      threadId: input.threadId,
      projectId: input.projectId,
      title: input.title,
      modelSelection: input.modelSelection,
      runtimeMode: input.runtimeMode,
      interactionMode: input.interactionMode,
      workspaceStrategy: { type: "worktree", baseRef: input.baseBranch, startFromOrigin: true },
      initialMessage: {
        messageId: input.message.messageId,
        text: input.message.text,
        attachments: [],
      },
    }).pipe(Effect.asVoid, Effect.mapError(machineError)),
  dispatch: (input) =>
    client[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
      type: "message.dispatch",
      commandId: CommandId.make(`boat-message:${input.messageId}`),
      createdBy: "agent",
      creationSource: "server",
      threadId: input.threadId,
      messageId: input.messageId,
      text: input.text,
      attachments: [],
      modelSelection: input.modelSelection,
      dispatchMode: { type: "start_immediately" },
    }).pipe(Effect.asVoid, Effect.mapError(machineError)),
  stop: (input) =>
    client[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
      type: "thread.stop",
      commandId: CommandId.make(`boat-stop:${input.requestId}`),
      threadId: input.threadId,
      reason: "Stopped from the server that delegated this task.",
    }).pipe(Effect.asVoid, Effect.mapError(machineError)),
  follow: (input) =>
    followRun(
      client[ORCHESTRATION_V2_WS_METHODS.subscribeThread]({ threadId: input.threadId }).pipe(
        Stream.mapError(machineError),
      ),
      input.messageId,
    ),
});

/** The machine side of a thread, through the machine's own RPC server. */
export const makeMachineThreads = (boat: {
  readonly connect: (input: {
    readonly sandboxId: string;
    readonly scopes: typeof MACHINE_THREAD_SCOPES;
    readonly group: typeof MachineThreadRpcs;
  }) => Effect.Effect<MachineThreadRpcClient, BoatError, Scope.Scope>;
  readonly ensureProject: BoatMachines["Service"]["ensureProject"];
}): MachineThreads => ({
  ensureProject: boat.ensureProject,
  connect: (sandboxId) =>
    boat
      .connect({ sandboxId, scopes: MACHINE_THREAD_SCOPES, group: MachineThreadRpcs })
      .pipe(Effect.map(makeClient)),
});
