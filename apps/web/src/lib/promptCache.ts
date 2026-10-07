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

/** Why the last measured turn rebuilt the cache instead of reusing it. */
export type PromptCacheMiss =
  | { readonly kind: "expired"; readonly idleSeconds: number }
  | { readonly kind: "model" }
  | { readonly kind: "context" };

/** One measured turn's cache use. */
export interface PromptCacheTurnRow {
  /** Its place among the session's measured turns, from 1. */
  readonly number: number;
  readonly readTokens: number;
  readonly writtenTokens: number | null;
  readonly uncachedTokens: number;
  readonly hitRate: number;
}

/**
 * The active provider session's prompt cache: whether the next message still finds it, and how
 * the last turns used it.
 */
export interface PromptCacheSnapshot {
  /** The last measured turn's input tokens read from the cache. */
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
  /** A turn is running, so its requests keep the cache warm. */
  readonly working: boolean;
  readonly miss: PromptCacheMiss | null;
  /** The session's latest measured turns, oldest first, the last one being the turn above. */
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
 * The active provider session's prompt cache, read from what its turns reported: when a request
 * last used it and how long the provider keeps it, the last measured turn's cache use, and why
 * that turn rebuilt the cache when it did. Null when the provider reports no cache use.
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
  // The latest request counts even from a turn without cache use, as a compaction leaves a cache
  // the next message reads.
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
  | { readonly kind: "unknown"; readonly idleSeconds: number };

/** Whether the cache is still there at `nowMs`, and for how long. */
export function promptCacheState(cache: PromptCacheSnapshot, nowMs: number): PromptCacheState {
  if (cache.working) return { kind: "working" };
  if (cache.ttlSeconds === null) {
    return {
      kind: "unknown",
      idleSeconds: Math.max(0, Math.floor((nowMs - cache.lastUsedAt) / 1000)),
    };
  }
  const left = Math.ceil((cache.lastUsedAt + cache.ttlSeconds * 1000 - nowMs) / 1000);
  return left > 0 ? { kind: "expiresIn", seconds: left } : { kind: "expired", secondsAgo: -left };
}

// The cache reads as critical in its last minute.
const SOON_SECONDS = 60;
// From here on the readout counts minutes and seconds.
const CLOSE_SECONDS = 300;

export type PromptCacheTone = "good" | "warning" | "critical" | "neutral";

/**
 * Whether the next message finds the cache, as a colour reads it: good, warning once less than
 * 40% of its life is left, critical in its last minute and once expired, neutral when the
 * provider does not say how long it keeps it.
 */
export function promptCacheTone(
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
      return "neutral";
  }
}

/** A turn's hit rate as a colour reads it: good from 80%, warning from 40%, critical below. */
export function promptCacheHitTone(hitRate: number): Exclude<PromptCacheTone, "neutral"> {
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

/** Whether the next message reuses the cache or rebuilds it, and how many tokens that is. */
export function promptCacheNextMessage(state: PromptCacheState, contextTokens: number | null) {
  const tokens =
    contextTokens === null ? "the cache" : `${formatContextWindowTokens(contextTokens)} tokens`;
  switch (state.kind) {
    case "working":
      return "Kept warm while the agent works";
    case "expiresIn":
      return `Next message reuses ${tokens}`;
    case "expired":
      return `Next message rebuilds ${tokens}`;
    case "unknown":
      return "This provider doesn't say how long it keeps the cache";
  }
}

/** Why the last turn rebuilt the cache, shown under its token split. */
export function promptCacheMissReason(miss: PromptCacheMiss) {
  switch (miss.kind) {
    case "expired":
      return `Rebuilt the cache: it expired after ${formatPromptCacheDuration(miss.idleSeconds)} idle`;
    case "model":
      return "Rebuilt the cache: the model changed";
    case "context":
      return "Rebuilt the cache";
  }
}

/** A share such as `98%`. */
export function formatPromptCacheShare(share: number) {
  return `${Math.round(share * 100)}%`;
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

/** Time left as the readout shows it: `43m`, then `4:12` in the last five minutes. */
function formatTimeLeft(seconds: number) {
  return seconds <= CLOSE_SECONDS
    ? formatPromptCacheCountdown(seconds)
    : `${Math.ceil(seconds / 60)}m`;
}

/**
 * The composer readout's timer: the time left, or its full lifetime while the agent keeps it warm.
 * Null once expired, where the readout's colour already says so, and when the provider gives no
 * lifetime, as there is no time left to count.
 */
export function promptCacheClockLabel(cache: PromptCacheSnapshot, state: PromptCacheState) {
  switch (state.kind) {
    case "working":
      return cache.ttlSeconds === null ? null : formatTimeLeft(cache.ttlSeconds);
    case "expiresIn":
      return formatTimeLeft(state.seconds);
    case "expired":
    case "unknown":
      return null;
  }
}

/** Milliseconds until the label reads differently, or null when only new usage changes it. */
export function msUntilPromptCacheLabelChanges(state: PromptCacheState) {
  switch (state.kind) {
    case "working":
    case "expired":
    case "unknown":
      return null;
    case "expiresIn":
      if (state.seconds <= CLOSE_SECONDS) return 1000;
      return Math.min(((state.seconds - 1) % 60) + 1, state.seconds - CLOSE_SECONDS) * 1000;
  }
}
