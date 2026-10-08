/**
 * Fork-owned extension points of the Pi adapter, which the server fills in for Gentle AI: the
 * session launch hook, Claude Code's cache lifetime, and gentle-pi's subagents and todo list.
 * The package cannot import the server, so the server provides them as one optional service;
 * without it the adapter behaves as upstream's.
 *
 * @module provider-pi/server/gentleHooks
 */
import type {
  OrchestrationV2Notification,
  OrchestrationV2ProviderThread,
  OrchestrationV2ProviderTurn,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import type * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

import type { PiRpcRecord } from "./rpc.ts";

/** The process launch of one Pi session. */
export interface PiSessionLaunch {
  readonly args: ReadonlyArray<string>;
  readonly environment: NodeJS.ProcessEnv;
  readonly cwd: string;
}

/** The parts of the Pi adapter's turn that gentle-pi activity is attributed to. */
export interface PiGentleTurn {
  readonly turnInput: ProviderAdapter.ProviderAdapterV2TurnInput;
  readonly providerTurn: OrchestrationV2ProviderTurn;
}

export interface PiGentleThreadState<Turn extends PiGentleTurn> {
  providerThread: OrchestrationV2ProviderThread;
  activeTurn: Turn | null;
}

export interface PiGentleDeps<Turn extends PiGentleTurn> {
  readonly driver: ProviderDriverKind;
  readonly instanceId: ProviderInstanceId;
  readonly idAllocator: IdAllocator.IdAllocatorV2["Service"];
  readonly emit: (event: ProviderAdapter.ProviderAdapterV2Event) => Effect.Effect<void>;
  readonly threadState: () => PiGentleThreadState<Turn> | null;
  readonly updateProviderThread: (
    state: PiGentleThreadState<Turn>,
    patch: Partial<OrchestrationV2ProviderThread>,
  ) => Effect.Effect<void>;
  /** The item's ordinal in its turn, the same for every update of one item. */
  readonly itemOrdinal: (turn: Turn, nativeItemId: string) => number;
}

/** What gentle-pi adds to one Pi session. */
export interface PiGentle<Turn extends PiGentleTurn> {
  /** Handles gentle-pi's own UI requests; false for every other one. */
  readonly onExtensionUiRequest: (event: PiRpcRecord) => Effect.Effect<boolean>;
  readonly onToolResult: (
    turn: Turn,
    toolName: string,
    details: unknown,
    completed: boolean,
  ) => Effect.Effect<void, IdAllocator.IdAllocatorV2AllocationError>;
  readonly onTurnFinalized: (turn: Turn) => void;
  /** Pi's native session changed, so nothing seen so far belongs to it. */
  readonly reset: () => void;
  /** The provider thread with gentle-pi's running subagents as its background roster. */
  readonly withRoster: (
    providerThread: OrchestrationV2ProviderThread,
  ) => OrchestrationV2ProviderThread;
  /** What woke Pi outside a turn, when gentle-pi did; null leaves the wake-up undescribed. */
  readonly describeWake: () => {
    readonly detail: string;
    readonly notification: OrchestrationV2Notification;
  } | null;
  readonly hasPendingBackgroundWork: Effect.Effect<boolean>;
  readonly hasPendingBackgroundWorkForThread: (
    providerThread: OrchestrationV2ProviderThread,
  ) => Effect.Effect<boolean>;
}

export interface PiGentleHooksShape {
  /** Adjusts the process launch for one session. */
  readonly prepareSession?: (
    input: ProviderAdapter.ProviderAdapterV2OpenSessionInput,
    launch: PiSessionLaunch,
  ) => Effect.Effect<PiSessionLaunch, ProviderAdapter.ProviderAdapterOpenSessionError, Scope.Scope>;
  /** How long the cache one model call wrote lives, when its usage says. */
  readonly callCacheTtlSeconds?: (
    usage: { readonly cacheWrite: number | undefined; readonly cacheWrite1h: number | undefined },
    call: { readonly provider: string | undefined; readonly model: string | undefined },
  ) => Effect.Effect<number | undefined>;
  readonly makeGentle?: <Turn extends PiGentleTurn>(deps: PiGentleDeps<Turn>) => PiGentle<Turn>;
}

/** Without gentle-pi: nothing handled, nothing pending. */
export const noPiGentle: PiGentle<PiGentleTurn> = {
  onExtensionUiRequest: () => Effect.succeed(false),
  onToolResult: () => Effect.void,
  onTurnFinalized: () => {},
  reset: () => {},
  withRoster: (providerThread) => providerThread,
  describeWake: () => null,
  hasPendingBackgroundWork: Effect.succeed(false),
  hasPendingBackgroundWorkForThread: () => Effect.succeed(false),
};

export class PiGentleHooks extends Context.Reference<PiGentleHooksShape>(
  "@t3tools/provider-pi/server/gentleHooks/PiGentleHooks",
  { defaultValue: () => ({}) },
) {}
