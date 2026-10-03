import type {
  OrchestrationV2ProviderTurn,
  OrchestrationV2Run,
  OrchestrationV2RunAttempt,
  ProviderThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { formatContextWindowTokens } from "./contextWindow";

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

/** One finished turn's cache use, for the per-turn table. */
export interface PromptCacheTurnRow {
  /** Its place among the session's measured turns, from 1. */
  readonly number: number;
  readonly readTokens: number;
  readonly writtenTokens: number | null;
  readonly uncachedTokens: number;
  readonly hitRate: number;
}

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
  /** The session's latest finished turns, oldest first, the last one being the turn above. */
  readonly turns: ReadonlyArray<PromptCacheTurnRow>;
}

const TURN_ROWS = 8;

function turnRow(usage: NonNullable<PromptCacheTurn["turnTokenUsage"]>, number: number) {
  const inputTokens = usage.inputTokens ?? 0;
  const readTokens = usage.cachedInputTokens ?? 0;
  const writtenTokens = usage.cacheCreationTokens ?? null;
  return {
    number,
    readTokens,
    writtenTokens,
    uncachedTokens: Math.max(0, inputTokens - readTokens - (writtenTokens ?? 0)),
    hitRate: inputTokens === 0 ? 0 : readTokens / inputTokens,
  } satisfies PromptCacheTurnRow;
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

  const rows = measured.flatMap((turn, index) =>
    turn.turnTokenUsage === undefined ? [] : [turnRow(turn.turnTokenUsage, index + 1)],
  );
  const { readTokens, writtenTokens, uncachedTokens, hitRate } = turnRow(usage, measured.length);
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
    uncachedTokens,
    hitRate,
    ttlSeconds,
    lastUsedAt: latestUsedAt,
    working: latest.status === "running" || latest.status === "pending",
    miss: miss(),
    turns: rows.slice(-TURN_ROWS),
  };
}

export type PromptCacheState =
  | { readonly kind: "working" }
  | { readonly kind: "expiresIn"; readonly seconds: number }
  | { readonly kind: "expired"; readonly secondsAgo: number }
  | { readonly kind: "unknown" };

/** Whether the cache is still there at `nowMs`, and for how long. */
export function promptCacheState(cache: PromptCacheSnapshot, nowMs: number): PromptCacheState {
  if (cache.working) return { kind: "working" };
  if (cache.ttlSeconds === null) return { kind: "unknown" };
  const left = Math.ceil((cache.lastUsedAt + cache.ttlSeconds * 1000 - nowMs) / 1000);
  return left > 0 ? { kind: "expiresIn", seconds: left } : { kind: "expired", secondsAgo: -left };
}

// The last minute is when to send a message.
const SOON_SECONDS = 60;
// From here on the readout counts minutes and seconds.
const CLOSE_SECONDS = 300;
// A context this large is worth compacting before its cache is rebuilt.
const COMPACT_AT_TOKENS = 100_000;

export type PromptCacheTone = "good" | "warning" | "critical";

/**
 * How much life the cache has left, as a colour reads it: good, warning once less than 40% is
 * left, critical in its last minute and once expired. A provider without a lifetime is read by
 * its hit rate.
 */
export function promptCacheLifeTone(
  cache: PromptCacheSnapshot,
  state: PromptCacheState,
): PromptCacheTone {
  switch (state.kind) {
    case "working":
      return "good";
    case "expired":
      return "critical";
    case "expiresIn":
      if (state.seconds <= SOON_SECONDS) return "critical";
      return cache.ttlSeconds !== null && state.seconds / cache.ttlSeconds <= 0.4
        ? "warning"
        : "good";
    case "unknown":
      return promptCacheHitTone(cache.hitRate);
  }
}

/** How the cache is doing overall: its life, except that a missed turn reads as critical. */
export function promptCacheTone(
  cache: PromptCacheSnapshot,
  state: PromptCacheState,
): PromptCacheTone {
  return cache.miss !== null && state.kind !== "working"
    ? "critical"
    : promptCacheLifeTone(cache, state);
}

/** A hit rate as a colour reads it: good from 80%, warning from 40%, critical below. */
export function promptCacheHitTone(hitRate: number): PromptCacheTone {
  return hitRate >= 0.8 ? "good" : hitRate >= 0.4 ? "warning" : "critical";
}

/** The share of the cache's life still left, from 0 to 1, or null when it has no known end. */
export function promptCacheLifeLeft(cache: PromptCacheSnapshot, state: PromptCacheState) {
  if (cache.ttlSeconds === null) return null;
  switch (state.kind) {
    case "working":
      return 1;
    case "expiresIn":
      return Math.min(1, state.seconds / cache.ttlSeconds);
    case "expired":
      return 0;
    case "unknown":
      return null;
  }
}

function missCause(miss: PromptCacheMiss) {
  switch (miss.kind) {
    case "expired":
      return `it had expired after ${formatPromptCacheDuration(miss.idleSeconds)} idle`;
    case "model":
      return "the model changed";
    case "context":
      return "the start of the conversation changed, such as its instructions or tools";
  }
}

/** Whether the cache has expired on a context large enough to compact before rebuilding it. */
export function promptCacheSuggestsCompact(state: PromptCacheState, contextTokens: number | null) {
  return state.kind === "expired" && contextTokens !== null && contextTokens >= COMPACT_AT_TOKENS;
}

/** What to do about the cache now: keep going, send a message soon, or compact first. */
export function promptCacheAdvice(
  cache: PromptCacheSnapshot,
  state: PromptCacheState,
  contextTokens: number | null,
) {
  switch (state.kind) {
    case "working":
      return "Warm while the agent works";
    case "expired": {
      if (contextTokens === null) return "Expired: the next message rebuilds the cache";
      const size = formatContextWindowTokens(contextTokens);
      return promptCacheSuggestsCompact(state, contextTokens)
        ? `Expired: the next message rewrites ${size} tokens. Compact first, or start a new thread if the task is done`
        : `Expired: only ${size} tokens to rebuild, just keep going`;
    }
    case "expiresIn":
      if (state.seconds <= SOON_SECONDS) return "Expires soon: any message refreshes it for free";
      return cache.miss === null ? "Warm: keep going" : `Cache missed: ${missCause(cache.miss)}`;
    case "unknown":
      return cache.miss === null
        ? "This provider does not say how long it keeps the cache"
        : `Cache missed: ${missCause(cache.miss)}`;
  }
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

/**
 * The composer readout's clock: `43m`, then `4:12` in the last five minutes, `expired`, or
 * `warm` while the agent works. Null for a provider without a lifetime.
 */
export function promptCacheClockLabel(state: PromptCacheState) {
  switch (state.kind) {
    case "working":
      return "warm";
    case "expiresIn":
      return state.seconds <= CLOSE_SECONDS
        ? formatPromptCacheCountdown(state.seconds)
        : `${Math.ceil(state.seconds / 60)}m`;
    case "expired":
      return "expired";
    case "unknown":
      return null;
  }
}

/** Milliseconds until the clock reads differently, or null when only new usage changes it. */
export function msUntilPromptCacheLabelChanges(state: PromptCacheState) {
  if (state.kind !== "expiresIn") return null;
  if (state.seconds <= CLOSE_SECONDS) return 1000;
  return Math.min(((state.seconds - 1) % 60) + 1, state.seconds - CLOSE_SECONDS) * 1000;
}
