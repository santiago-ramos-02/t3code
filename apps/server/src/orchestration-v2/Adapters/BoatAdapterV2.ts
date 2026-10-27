/**
 * Turns that run on a Boat machine's own T3 Code server. The host thread stays an ordinary local
 * thread, so task completion, waking the parent, status and cancel need nothing special.
 */
import {
  BoatError,
  ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TrimmedNonEmptyString,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2TurnItemStatus,
  type ProviderTurnId,
  type TurnItemId,
} from "@t3tools/contracts";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import { derive } from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  isMachineRunTerminal,
  type MachineRun,
  type MachineRunItem,
  type MachineThreads,
} from "../../boat/machineThreads.ts";

export const BOAT_DRIVER = ProviderDriverKind.make("boat");

const INSTANCE_PREFIX = "boat-";

/** The provider instance id of the Boat machine `sandboxId`; it has no settings entry. */
export const boatInstanceId = (sandboxId: string) =>
  ProviderInstanceId.make(`${INSTANCE_PREFIX}${sandboxId}`);

/** The machine behind a `boat-<sandboxId>` instance id, or undefined for any other id. */
export const sandboxIdOfBoatInstance = (instanceId: ProviderInstanceId) =>
  instanceId.startsWith(INSTANCE_PREFIX) && instanceId.length > INSTANCE_PREFIX.length
    ? instanceId.slice(INSTANCE_PREFIX.length)
    : undefined;

// A host thread's model selection can only name instances and options this server knows, so the
// machine-side selection and the repository ride in one option that only this adapter reads.
const BOAT_TARGET_OPTION = "boat.target";
const BoatTarget = Schema.Struct({
  /** The provider instance and model, as the machine knows them. */
  remote: ModelSelection,
  remoteUrl: TrimmedNonEmptyString,
  /** The branch, as on origin, the machine's worktree starts from. */
  branch: TrimmedNonEmptyString,
});
const BoatTargetJson = Schema.fromJsonString(BoatTarget);
const encodeBoatTarget = Schema.encodeSync(BoatTargetJson);
const decodeBoatTarget = Schema.decodeUnknownOption(BoatTargetJson);

/** The model selection of a host thread whose turns run on the Boat machine `sandboxId`. */
export const boatDelegateModelSelection = (input: {
  readonly sandboxId: string;
  readonly remote: ModelSelection;
  readonly remoteUrl: string;
  readonly branch: string;
}): ModelSelection => ({
  instanceId: boatInstanceId(input.sandboxId),
  model: input.remote.model,
  options: [
    {
      id: BOAT_TARGET_OPTION,
      value: encodeBoatTarget({
        remote: input.remote,
        remoteUrl: input.remoteUrl,
        branch: input.branch,
      }),
    },
  ],
});

/** Where a selection made by `boatDelegateModelSelection` sends its turns. */
export const boatTargetOf = (selection: ModelSelection) => {
  const encoded = selection.options?.find((option) => option.id === BOAT_TARGET_OPTION)?.value;
  return typeof encoded === "string" ? Option.getOrUndefined(decodeBoatTarget(encoded)) : undefined;
};

export const BoatProviderCapabilitiesV2 = {
  sessions: {
    supportsMultipleProviderThreadsPerSession: false,
    supportsModelSwitchInSession: false,
    supportsProviderSwitchingViaHandoff: false,
    supportsRuntimeModeSwitchInSession: false,
    pendingRequestsSurviveRestart: false,
  },
  threads: {
    canCreateEmptyThread: true,
    canReadThreadSnapshot: false,
    canRollbackThread: false,
    canForkThread: false,
    canForkFromTurn: false,
    canForkFromSubagentThread: false,
    exposesNativeThreadId: true,
  },
  turns: {
    exposesNativeTurnId: false,
    emitsTurnStarted: true,
    emitsTurnCompleted: true,
    supportsInterrupt: true,
    supportsActiveSteering: false,
    supportsSteeringByInterruptRestart: false,
    supportsQueuedMessages: true,
    terminalStatusQuality: "strong",
  },
  streaming: {
    streamsAssistantText: true,
    streamsReasoning: false,
    streamsToolOutput: false,
    streamsPlanText: false,
    emitsMessageCompleted: true,
  },
  tools: {
    exposesToolItemIds: true,
    emitsToolStarted: true,
    emitsToolCompleted: true,
    emitsToolOutput: false,
    supportsMcpTools: false,
    supportsDynamicToolCallbacks: false,
  },
  approvals: {
    supportsCommandApproval: false,
    supportsFileReadApproval: false,
    supportsFileChangeApproval: false,
    supportsApplyPatchApproval: false,
    approvalsHaveNativeRequestIds: false,
    approvalCallbacksAreLiveOnly: false,
    approvalsCanOriginateFromSubagents: false,
  },
  planning: {
    emitsPlanUpdated: false,
    emitsTodoList: false,
    emitsProposedPlan: false,
    supportsStructuredQuestions: false,
    planDeltasHaveItemIds: false,
  },
  subagents: {
    supportsSubagents: false,
    exposesSubagentThreadIds: false,
    emitsSubagentLifecycle: false,
    canWaitForSubagents: false,
    canCloseSubagents: false,
    canForkSubagentThread: false,
  },
  context: {
    acceptsSystemContext: false,
    acceptsDeveloperContext: false,
    acceptsSyntheticUserContext: false,
    canGenerateSummaries: false,
    canConsumeHandoffSummaries: false,
    supportsDeltaHandoff: false,
    supportsFullThreadHandoff: false,
    maxRecommendedHandoffChars: null,
  },
  // The work happens in the machine's checkout, which this server cannot snapshot or restore.
  checkpointing: {
    appCanCheckpointFilesystem: false,
    supportsNestedCheckpointScopes: false,
    providerCanRollbackConversation: false,
    providerRollbackReturnsSnapshot: false,
    providerCanReadConversationSnapshot: false,
  },
  identity: {
    nativeThreadIds: "strong",
    nativeTurnIds: "none",
    nativeItemIds: "weak",
    nativeRequestIds: "none",
  },
  runtimePolicy: { enforcement: "native" },
} satisfies OrchestrationV2ProviderCapabilities;

const LOST_CONNECTION = "Lost the connection to the Boat machine before the task finished.";
const UNEXPECTED_STOP = "The task on the Boat machine stopped unexpectedly.";
const NO_ATTACHMENTS = "Boat machines cannot receive attachments yet.";

type Outcome =
  | { readonly status: "completed" | "interrupted" | "cancelled" }
  | { readonly status: "failed"; readonly message: string };

const outcomeOfRun = (run: MachineRun | undefined): Outcome => {
  if (run === undefined || !isMachineRunTerminal(run)) {
    return { status: "failed", message: LOST_CONNECTION };
  }
  switch (run.status) {
    case "completed":
    case "interrupted":
      return { status: run.status };
    case "failed":
      return { status: "failed", message: run.failure ?? "The task failed on the Boat machine." };
    default:
      return { status: "cancelled" };
  }
};

const SETTLED_ITEM_STATUSES: ReadonlyArray<OrchestrationV2TurnItemStatus> = [
  "completed",
  "failed",
  "cancelled",
  "interrupted",
];

interface PreparedTurn {
  readonly machineThreadId: ThreadId;
  readonly start: Effect.Effect<void>;
  /** Ends a turn the machine never received; false when the machine has it. */
  readonly cancelBeforeAccepted: Effect.Effect<boolean>;
}

export const makeBoatAdapterV2 = (input: {
  readonly sandboxId: string;
  readonly machines: MachineThreads;
}) => {
  const instanceId = boatInstanceId(input.sandboxId);
  const driver = BOAT_DRIVER;
  const unsupported = (what: string) => `${what} is not available for Boat machine threads.`;

  return ProviderAdapter.ProviderAdapterV2.of({
    instanceId,
    driver,
    getCapabilities: Effect.fn("BoatAdapterV2.getCapabilities")(function () {
      return Effect.succeed(BoatProviderCapabilitiesV2);
    }),
    planSelectionTransition: Effect.fn("BoatAdapterV2.planSelectionTransition")(function () {
      return Effect.succeed({ type: "apply_on_next_turn" as const });
    }),
    openSession: Effect.fn("BoatAdapterV2.openSession")(function* (session) {
      const scope = yield* Effect.scope;
      const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
      const emit = (event: ProviderAdapter.ProviderAdapterV2Event) =>
        Queue.offer(events, event).pipe(Effect.asVoid);
      const openedAt = yield* DateTime.now;

      // The orchestrator hands a first turn a thread without a native ref, so the machine's thread
      // falls back to the host thread's id, which `ensureThread` uses as the native id.
      const machineThreadIdOf = (providerThread: OrchestrationV2ProviderThread) => {
        const nativeId = providerThread.nativeThreadRef?.nativeId ?? providerThread.appThreadId;
        return nativeId === null || nativeId === undefined ? undefined : ThreadId.make(nativeId);
      };

      const turns = new Map<ProviderTurnId, PreparedTurn>();

      /** Everything one turn needs, ready before it runs so an interrupt can reach it. */
      const prepareTurn = (
        turn: ProviderAdapter.ProviderAdapterV2TurnInput,
        target: NonNullable<ReturnType<typeof boatTargetOf>>,
        machineThreadId: ThreadId,
      ) => {
        const providerTurnId = derive.providerTurn({
          driver,
          nativeTurnId: String(turn.attemptId),
        });
        // Once the machine has the message, stopping its run is the machine's job.
        let accepted = false;
        let settled = false;
        let turnStartedAt = openedAt;
        let fiber: Fiber.Fiber<void> | undefined;
        const itemOrdinals = new Map<TurnItemId, number>();
        const firstSeen = new Map<TurnItemId, DateTime.Utc>();
        const lastSent = new Map<TurnItemId, string>();
        const ordinalOf = (id: TurnItemId) => {
          const known = itemOrdinals.get(id);
          if (known !== undefined) return known;
          const ordinal = turn.providerTurnOrdinal * 100 + itemOrdinals.size + 1;
          itemOrdinals.set(id, ordinal);
          return ordinal;
        };
        const providerTurn = (
          status: "running" | Outcome["status"],
          completedAt: DateTime.Utc | null,
        ) => ({
          id: providerTurnId,
          providerThreadId: turn.providerThread.id,
          nodeId: turn.rootNodeId,
          runAttemptId: turn.attemptId,
          nativeTurnRef: null,
          ordinal: turn.providerTurnOrdinal,
          status,
          startedAt: turnStartedAt,
          completedAt,
        });

        const mirrorItem = Effect.fnUntraced(function* (
          item: MachineRunItem,
          settledAs: Outcome["status"] | undefined,
        ) {
          const now = yield* DateTime.now;
          const created = firstSeen.get(item.id) ?? now;
          firstSeen.set(item.id, created);
          const rawStatus: OrchestrationV2TurnItemStatus =
            item.kind === "activity" ? item.status : item.streaming ? "running" : "completed";
          // A run that ended leaves no item running.
          const status =
            settledAs !== undefined && !SETTLED_ITEM_STATUSES.includes(rawStatus)
              ? settledAs
              : rawStatus;
          const streaming =
            item.kind === "assistant_message" && item.streaming && settledAs === undefined;
          const key =
            item.kind === "assistant_message"
              ? `${streaming} ${item.text}`
              : `${status} ${item.name} ${item.summary}`;
          if (lastSent.get(item.id) === key) return;
          lastSent.set(item.id, key);

          const base = {
            id: derive.turnItemFromProviderItem({ driver, nativeItemId: item.id }),
            threadId: turn.threadId,
            runId: turn.runId,
            nodeId: turn.rootNodeId,
            providerThreadId: turn.providerThread.id,
            providerTurnId,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: ordinalOf(item.id),
            status,
            title: null,
            startedAt: created,
            completedAt: SETTLED_ITEM_STATUSES.includes(status) ? now : null,
            updatedAt: now,
          };
          if (item.kind === "assistant_message") {
            const messageId = derive.messageFromProviderItem({
              driver,
              nativeItemId: item.messageId,
            });
            yield* emit({
              type: "message.updated",
              driver,
              message: {
                createdBy: "agent",
                creationSource: "provider",
                id: messageId,
                threadId: turn.threadId,
                runId: turn.runId,
                nodeId: turn.rootNodeId,
                role: "assistant",
                text: item.text,
                attachments: [],
                streaming,
                createdAt: created,
                updatedAt: now,
              },
            });
            yield* emit({
              type: "turn_item.updated",
              driver,
              turnItem: {
                ...base,
                type: "assistant_message",
                messageId,
                text: item.text,
                streaming,
              },
            });
            return;
          }
          yield* emit({
            type: "turn_item.updated",
            driver,
            turnItem: {
              ...base,
              type: "dynamic_tool",
              title: item.summary.length > 0 ? item.summary : null,
              toolName: item.name,
              input: { summary: item.summary },
            },
          });
        });

        const settle = Effect.fnUntraced(function* (outcome: Outcome) {
          if (settled) return;
          settled = true;
          turns.delete(providerTurnId);
          yield* emit({
            type: "provider_turn.updated",
            driver,
            threadId: turn.threadId,
            providerTurn: providerTurn(outcome.status, yield* DateTime.now),
          });
          yield* emit(
            outcome.status === "failed"
              ? {
                  type: "turn.terminal",
                  driver,
                  providerThreadId: turn.providerThread.id,
                  providerTurnId,
                  runOrdinal: turn.runOrdinal,
                  failureItemOrdinal: turn.providerTurnOrdinal * 100 + 99,
                  status: "failed",
                  failure: makeProviderFailure({
                    message: outcome.message,
                    class: "provider_error",
                  }),
                  threadDisposition: "reusable",
                }
              : {
                  type: "turn.terminal",
                  driver,
                  providerThreadId: turn.providerThread.id,
                  providerTurnId,
                  runOrdinal: turn.runOrdinal,
                  status: outcome.status,
                  failure: null,
                  threadDisposition: "reusable",
                },
          );
        });

        const markAccepted = Effect.fnUntraced(function* () {
          accepted = true;
          yield* emit({
            type: "provider_thread.updated",
            driver,
            providerThread: {
              ...turn.providerThread,
              providerSessionId: session.providerSessionId,
              status: "active",
              nativeConversationHeadRef: {
                driver,
                nativeId: turn.message.messageId,
                strength: "weak",
              },
              firstRunOrdinal: turn.providerThread.firstRunOrdinal ?? turn.runOrdinal,
              lastRunOrdinal: turn.runOrdinal,
              updatedAt: yield* DateTime.now,
            },
          });
        });

        const body = Effect.gen(function* () {
          if (turn.message.attachments.length > 0) {
            return yield* new BoatError({ detail: NO_ATTACHMENTS });
          }
          // Only the first turn has no thread on the machine yet.
          const project =
            turn.providerThread.nativeConversationHeadRef === null
              ? yield* input.machines.ensureProject({
                  sandboxId: input.sandboxId,
                  remoteUrl: target.remoteUrl,
                  branch: target.branch,
                })
              : undefined;
          const machine = yield* input.machines.connect(input.sandboxId);
          if (project === undefined) {
            yield* machine.dispatch({
              threadId: machineThreadId,
              messageId: turn.message.messageId,
              text: turn.message.text,
              modelSelection: target.remote,
            });
          } else {
            yield* machine.launch({
              projectId: project.projectId,
              threadId: machineThreadId,
              title: turn.appThread.title,
              modelSelection: target.remote,
              runtimeMode: turn.runtimePolicy.runtimeMode,
              interactionMode: turn.runtimePolicy.interactionMode,
              baseBranch: target.branch,
              message: { messageId: turn.message.messageId, text: turn.message.text },
            });
          }
          yield* markAccepted();

          let last: MachineRun | undefined;
          yield* machine
            .follow({ threadId: machineThreadId, messageId: turn.message.messageId })
            .pipe(
              Stream.runForEach((run) =>
                Effect.gen(function* () {
                  last = run;
                  const settledAs = isMachineRunTerminal(run)
                    ? outcomeOfRun(run).status
                    : undefined;
                  for (const item of run.items) yield* mirrorItem(item, settledAs);
                }),
              ),
            );
          return outcomeOfRun(last);
        }).pipe(
          Effect.scoped,
          Effect.catch((error: BoatError) =>
            Effect.succeed<Outcome>({ status: "failed", message: error.detail }),
          ),
          Effect.catchDefect(() =>
            Effect.succeed<Outcome>({ status: "failed", message: UNEXPECTED_STOP }),
          ),
        );

        const prepared: PreparedTurn = {
          machineThreadId,
          start: Effect.gen(function* () {
            turnStartedAt = yield* DateTime.now;
            turns.set(providerTurnId, prepared);
            yield* emit({
              type: "provider_turn.updated",
              driver,
              threadId: turn.threadId,
              providerTurn: providerTurn("running", null),
            });
            fiber = yield* body.pipe(Effect.flatMap(settle), Effect.forkIn(scope));
          }),
          cancelBeforeAccepted: Effect.gen(function* () {
            if (accepted || fiber === undefined) return false;
            yield* Fiber.interrupt(fiber);
            yield* settle({ status: "interrupted" });
            return true;
          }),
        };
        return prepared;
      };
      return {
        instanceId,
        driver,
        providerSessionId: session.providerSessionId,
        providerSession: {
          id: session.providerSessionId,
          driver,
          providerInstanceId: instanceId,
          status: "ready",
          cwd: session.runtimePolicy.cwd ?? `boat:${input.sandboxId}`,
          model: session.modelSelection.model,
          capabilities: BoatProviderCapabilitiesV2,
          createdAt: openedAt,
          updatedAt: openedAt,
          lastError: null,
        },
        events: Stream.fromEffectRepeat(Queue.take(events)),
        backgroundTasksEndWithProcess: true,
        ensureThread: Effect.fn("BoatAdapterV2.ensureThread")(function* (thread) {
          const now = yield* DateTime.now;
          // The machine's thread is named for the host thread, so a restart finds it again.
          const nativeThreadId = String(thread.threadId);
          return (
            thread.existingProviderThread ?? {
              id: derive.providerThread({
                driver,
                providerInstanceId: instanceId,
                nativeThreadId,
              }),
              driver,
              providerInstanceId: instanceId,
              providerSessionId: thread.providerSessionId ?? session.providerSessionId,
              appThreadId: thread.threadId,
              ownerNodeId: null,
              nativeThreadRef: { driver, nativeId: nativeThreadId, strength: "strong" },
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: null,
              lastRunOrdinal: null,
              handoffIds: [],
              forkedFrom: null,
              createdAt: now,
              updatedAt: now,
            }
          );
        }),
        resumeThread: (thread) => Effect.succeed(thread.providerThread),
        startTurn: Effect.fn("BoatAdapterV2.startTurn")(function* (turn) {
          const target = boatTargetOf(turn.modelSelection);
          const machineThreadId = machineThreadIdOf(turn.providerThread);
          if (target === undefined || machineThreadId === undefined) {
            return yield* new ProviderAdapter.ProviderAdapterProtocolError({
              driver,
              detail: "The thread does not say which Boat machine task it belongs to",
            });
          }
          yield* prepareTurn(turn, target, machineThreadId).start;
        }),
        steerTurn: (steer) =>
          Effect.fail(
            new ProviderAdapter.ProviderAdapterSteerRunUnsupportedError({
              driver,
              providerThreadId: steer.providerThread.id,
            }),
          ),
        interruptTurn: Effect.fn("BoatAdapterV2.interruptTurn")(function* (interrupt) {
          const active = turns.get(interrupt.providerTurnId);
          if (active !== undefined && (yield* active.cancelBeforeAccepted)) return;
          const machineThreadId =
            active?.machineThreadId ?? machineThreadIdOf(interrupt.providerThread);
          if (machineThreadId === undefined) return;
          yield* Effect.gen(function* () {
            const machine = yield* input.machines.connect(input.sandboxId);
            yield* machine.stop({ threadId: machineThreadId, requestId: interrupt.providerTurnId });
          }).pipe(
            Effect.scoped,
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterInterruptError({
                  driver,
                  providerThreadId: interrupt.providerThread.id,
                  providerTurnId: interrupt.providerTurnId,
                  cause,
                }),
            ),
          );
        }),
        respondToRuntimeRequest: (response) =>
          Effect.fail(
            new ProviderAdapter.ProviderAdapterRuntimeRequestResponseError({
              driver,
              requestId: response.requestId,
              cause: unsupported("Answering a request"),
            }),
          ),
        readThreadSnapshot: ({ providerThread }) =>
          Effect.succeed({ providerThread, providerTurns: [], messages: [], runtimeRequests: [] }),
        rollbackThread: ({ providerThread }) =>
          Effect.fail(
            new ProviderAdapter.ProviderAdapterRollbackThreadError({
              driver,
              providerThreadId: providerThread.id,
              cause: unsupported("Rolling back"),
            }),
          ),
        forkThread: ({ sourceProviderThread }) =>
          Effect.fail(
            new ProviderAdapter.ProviderAdapterForkThreadError({
              driver,
              providerThreadId: sourceProviderThread.id,
              cause: unsupported("Forking"),
            }),
          ),
      } satisfies ProviderAdapter.ProviderAdapterV2SessionRuntime;
    }),
  });
};
