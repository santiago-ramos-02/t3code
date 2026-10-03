import type {
  OrchestrationV2ProviderTurn,
  OrchestrationV2Run,
  OrchestrationV2RunAttempt,
  ProviderThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

export type PromptCacheTurn = Pick<
  OrchestrationV2ProviderTurn,
  | "providerThreadId"
  | "runAttemptId"
  | "ordinal"
  | "status"
  | "startedAt"
  | "completedAt"
  | "tokenUsage"
  | "turnTokenUsage"
>;

/** Why the last turn rebuilt the cache instead of reusing it. */
export type PromptCacheMiss =
  | { readonly kind: "expired"; readonly idleSeconds: number }
  | { readonly kind: "model" }
  | { readonly kind: "context" };

export interface PromptCacheSnapshot {
  /** The last finished turn's input tokens read from the cache. */
  readonly readTokens: number;
  /** Its input tokens written to the cache; null for providers that do not say. */
  readonly writtenTokens: number | null;
  /** Its input tokens neither read from nor written to the cache. */
  readonly uncachedTokens: number;
  /** The share of its input read from the cache, from 0 to 1. */
  readonly hitRate: number;
  /** How long the provider keeps the cache after a request, when it says. */
  readonly ttlSeconds: number | null;
  /** When a request last used the cache, in epoch milliseconds. */
  readonly lastUsedAt: number;
  /** A turn is running, so the cache stays warm. */
  readonly working: boolean;
  readonly miss: PromptCacheMiss | null;
}

// Writing at least this share of the previous context again means the old cache went unused.
const REWRITE_SHARE = 0.5;

/** When a turn's requests last used the cache: its latest usage report, else when it ended. */
function lastUsedAt(turn: PromptCacheTurn) {
  const reported =
    turn.tokenUsage === undefined ? Number.NaN : Date.parse(turn.tokenUsage.updatedAt);
  if (!Number.isNaN(reported)) return reported;
  const ended = turn.completedAt ?? turn.startedAt;
  return ended === null ? null : DateTime.toEpochMillis(ended);
}

/**
 * How the active provider session's prompt cache is doing, read from what its turns reported:
 * the last finished turn's cache use, how long the cache lives, and why the turn missed it when
 * it did. Null when the provider reports no cache use.
 */
export function derivePromptCache(input: {
  readonly providerTurns: ReadonlyArray<PromptCacheTurn>;
  readonly providerThreadId: ProviderThreadId | null;
  readonly attempts: ReadonlyArray<Pick<OrchestrationV2RunAttempt, "id" | "runId">>;
  readonly runs: ReadonlyArray<Pick<OrchestrationV2Run, "id" | "modelSelection">>;
}): PromptCacheSnapshot | null {
  // The cache belongs to one provider session.
  const turns = input.providerTurns
    .filter((turn) => turn.providerThreadId === input.providerThreadId)
    .toSorted((left, right) => left.ordinal - right.ordinal);
  const measured = turns.filter(
    (turn) =>
      turn.turnTokenUsage?.cachedInputTokens !== undefined &&
      (turn.turnTokenUsage.inputTokens ?? 0) > 0,
  );
  const last = measured.at(-1);
  const latest = turns.at(-1);
  const usage = last?.turnTokenUsage;
  if (last === undefined || latest === undefined || usage === undefined) return null;
  const latestUsedAt = lastUsedAt(latest);
  if (latestUsedAt === null) return null;

  const inputTokens = usage.inputTokens ?? 0;
  const readTokens = usage.cachedInputTokens ?? 0;
  const writtenTokens = usage.cacheCreationTokens ?? null;
  const ttlSeconds =
    turns.findLast((turn) => turn.tokenUsage?.cacheTtlSeconds !== undefined)?.tokenUsage
      ?.cacheTtlSeconds ?? null;

  const modelOf = (turn: PromptCacheTurn) => {
    const runId = input.attempts.find((attempt) => attempt.id === turn.runAttemptId)?.runId;
    const selection = input.runs.find((run) => run.id === runId)?.modelSelection;
    return selection === undefined ? null : `${selection.instanceId}:${selection.model}`;
  };
  const miss = (): PromptCacheMiss | null => {
    // Only a provider that reports writes shows the cache being rebuilt.
    const previous = measured.at(-2);
    const previousContext = previous?.tokenUsage?.inputTokens ?? 0;
    if (previous === undefined || writtenTokens === null || previousContext === 0) return null;
    if (writtenTokens < previousContext * REWRITE_SHARE) return null;
    const previousUsedAt = lastUsedAt(previous);
    const idleSeconds =
      previousUsedAt === null || last.startedAt === null
        ? null
        : Math.round((DateTime.toEpochMillis(last.startedAt) - previousUsedAt) / 1000);
    if (ttlSeconds !== null && idleSeconds !== null && idleSeconds > ttlSeconds) {
      return { kind: "expired", idleSeconds };
    }
    const model = modelOf(last);
    if (model !== null && modelOf(previous) !== null && model !== modelOf(previous)) {
      return { kind: "model" };
    }
    return { kind: "context" };
  };

  return {
    readTokens,
    writtenTokens,
    uncachedTokens: Math.max(0, inputTokens - readTokens - (writtenTokens ?? 0)),
    hitRate: readTokens / inputTokens,
    ttlSeconds,
    lastUsedAt: latestUsedAt,
    working: latest.status === "running" || latest.status === "pending",
    miss: miss(),
  };
}

export type PromptCacheState =
  | { readonly kind: "warm" }
  | { readonly kind: "expiresIn"; readonly seconds: number }
  | { readonly kind: "expired"; readonly secondsAgo: number }
  | { readonly kind: "unknown" };

/** Whether the cache is still there at `nowMs`, and for how long. */
export function promptCacheState(cache: PromptCacheSnapshot, nowMs: number): PromptCacheState {
  if (cache.working) return { kind: "warm" };
  if (cache.ttlSeconds === null) return { kind: "unknown" };
  const left = Math.ceil((cache.lastUsedAt + cache.ttlSeconds * 1000 - nowMs) / 1000);
  return left > 0 ? { kind: "expiresIn", seconds: left } : { kind: "expired", secondsAgo: -left };
}

/** A countdown such as `4:05`, or `1:00:00` from an hour up. */
export function formatPromptCacheCountdown(seconds: number) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = String(seconds % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}

/** A length of time such as `12 min` or `2 h 5 min`, rounded to minutes past the first one. */
export function formatPromptCacheDuration(seconds: number) {
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 === 0 ? `${hours} h` : `${hours} h ${minutes % 60} min`;
}

/** The composer's short cache readout, such as `Cache 54m`, `Cache expired` or `Cache 96%`. */
export function promptCacheLabel(cache: PromptCacheSnapshot, state: PromptCacheState) {
  switch (state.kind) {
    case "warm":
      return "Cache warm";
    case "expiresIn":
      return `Cache ${Math.ceil(state.seconds / 60)}m`;
    case "expired":
      return "Cache expired";
    case "unknown":
      return `Cache ${Math.round(cache.hitRate * 100)}%`;
  }
}

/** Milliseconds until `promptCacheLabel` reads differently, or null when only new usage changes it. */
export function msUntilPromptCacheLabelChanges(state: PromptCacheState) {
  return state.kind === "expiresIn" ? (((state.seconds - 1) % 60) + 1) * 1000 : null;
}
